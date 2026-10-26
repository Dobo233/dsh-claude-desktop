/**
 * dsh-claude-desktop —— 把 Claude 桌面端接成 DSH 工具。
 *
 * 和 dsh-claude-pilot（spawn CLI）不同：这里**不跑任何 CLI**，走的是桌面应用自己注册的
 * claude:// 深链协议。桌面端没有可供程序调用的本地端口/MCP 端点（实测 Get-NetTCPConnection
 * 里没有任何 claude 进程在 Listen，且 --remote-debugging-port 在应用的 Chromium 开关黑名单里），
 * 所以能力边界是：
 *   能     ┌ 投递任务：claude://code/new?q=<prompt>&folder=<dir>   → 桌面端开新会话并带上 prompt
 *          ├ 投递 Cowork 任务：claude://cowork/new?q=…&folder=…&file=…
 *          ├ 把 CLI 会话交回桌面端：claude://code/continue?session=<uuid|last>
 *          └ 打开面板：needs-input / agents / memory / hub / new-chat …
 *          ├ 代按发送键（SendKeys Ctrl+Enter；AppActivate 抢前台不稳，等不到新会话会自动重按）
 *          └ 读回回答：桌面端 CCD 内部跑的就是真 Claude Code，正文在 ~/.claude/projects/<cwd-slug>/<cliSessionId>.jsonl（明文）
 *   不能   └ 往已打开的对话里插话（没有 queue 式 IPC）
 */
import { spawn, spawnSync } from "node:child_process";
import { listAppSessions, parseTranscript, findTranscript, resolveSession, waitForNewSession, waitForNewSessionRow, slugFor, projectsRoot } from "./transcripts.js";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "claude-desktop";
export const inject = ["tools"];

const DEFAULTS = {
  dryRun: false,
  submit: false,
  submitKeys: "^{ENTER}",
  waitTimeoutMs: 180000,
  pollMs: 2000,
  focusDelayMs: 1200,
  maxPromptChars: 6000,
  protocol: "claude",
  appPackageId: "Claude_pzs8sxrjxfjjc",
};

/** 桌面端 claude:// 已知入口（从应用 app.asar 的 claudeURLHandler 里读出来的路由） */
const ENTRIES = {
  "new-chat": { url: "claude://claude.ai/new?surface=chat", what: "新聊天窗口（claude.ai 对话）" },
  "new-code": { url: "claude://code/new", what: "新 Claude Code 会话" },
  "cowork-new": { url: "claude://cowork/new", what: "新 Cowork 任务" },
  "continue-last": { url: "claude://code/continue?session=last", what: "继续最近一个 Claude Code 会话" },
  "needs-input": { url: "claude://code/needs-input", what: "等你处理的会话列表" },
  agents: { url: "claude://code/agents", what: "Agents 面板" },
  memory: { url: "claude://code/memory", what: "Memory 面板" },
  hub: { url: "claude://code/hub", what: "Claude Code Hub" },
  settings: { url: "claude://code/preview", what: "Preview 设置面板" },
};

function cfgOf(config) {
  return Object.assign({}, DEFAULTS, config || {});
}

function sanitizePrompt(text, max) {
  if (!text) return { value: "", truncated: false };
  let s = String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim();
  const truncated = s.length > max;
  if (truncated) s = s.slice(0, max);
  return { value: s, truncated };
}

/** 拼 claude:// 深链。只用应用真会解析的参数名：q / prompt / folder / file / session / source / surface */
function buildLink(opts, cfg) {
  const surface = opts.surface || "code";
  const route = (opts.route || "/new").replace(/^\/?/, "/");
  const params = new URLSearchParams();
  const notes = [];
  if (opts.prompt) {
    const p = sanitizePrompt(opts.prompt, cfg.maxPromptChars);
    if (p.value) params.set("q", p.value);
    if (p.truncated) notes.push("prompt 超过 " + cfg.maxPromptChars + " 字，已截断");
  }
  for (const f of opts.folders || []) {
    if (!f) continue;
    const abs = path.resolve(String(f));
    if (!existsSync(abs)) notes.push("目录不存在，仍然投递：" + abs);
    params.append("folder", abs);
  }
  for (const f of opts.files || []) {
    if (!f) continue;
    const abs = path.resolve(String(f));
    if (!existsSync(abs)) notes.push("文件不存在，仍然投递：" + abs);
    params.append("file", abs);
  }
  if (opts.session) params.set("session", opts.session);
  if (surface !== "claude.ai") params.set("source", "desktop_action");
  else if (!params.has("surface")) params.set("surface", "chat");
  const qs = params.toString();
  const url = cfg.protocol + "://" + surface + route + (qs ? "?" + qs : "");
  return { url: url, notes: notes };
}

function launch(url, cfg) {
  if (!url.startsWith(cfg.protocol + "://")) {
    return { launched: false, method: "none", error: "拒绝启动非 " + cfg.protocol + ":// 的 URL" };
  }
  if (cfg.dryRun) return { launched: false, method: "dry-run", url: url };
  const platform = process.platform;
  try {
    if (platform === "win32") {
      // rundll32 走 ShellExecute，不经过 shell 解析，URL 里的 & 不会被拆
      const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return { launched: true, method: "rundll32 url.dll,FileProtocolHandler", url: url };
    }
    const bin = platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(bin, [url], { detached: true, stdio: "ignore" });
    child.unref();
    return { launched: true, method: bin, url: url };
  } catch (err) {
    return { launched: false, method: "spawn", url: url, error: String(err && err.message || err) };
  }
}

/** 找已安装的桌面端：Get-AppxPackage → 运行中进程路径 → 扫 WindowsApps 目录（常常 EPERM） */
function findDesktopApp() {
  if (process.platform !== "win32") {
    return { found: false, why: "深链探测目前只覆盖 Windows 的安装布局" };
  }
  const ps = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Get-AppxPackage -Name '*Claude*' | Select -First 1 | ConvertTo-Json -Compress",
  ], { encoding: "utf8", timeout: 25000, windowsHide: true });
  const psText = (ps.stdout || "").trim();
  if (psText) {
    try {
      const o = JSON.parse(psText);
      if (o && o.InstallLocation) {
        return {
          found: true,
          source: "Get-AppxPackage",
          name: o.Name,
          version: o.Version,
          packageFamily: o.PackageFamilyName,
          installDir: o.InstallLocation,
          exe: path.join(o.InstallLocation, "app", "claude.exe"),
        };
      }
    } catch (err) { /* 落到下一个手段 */ }
  }
  const pr = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "(Get-Process claude -ErrorAction SilentlyContinue | Select -First 1 -ExpandProperty Path)",
  ], { encoding: "utf8", timeout: 20000, windowsHide: true });
  const exe = (pr.stdout || "").trim();
  if (exe && exe.toLowerCase().endsWith(".exe")) {
    return { found: true, source: "process path", version: "?", installDir: path.dirname(path.dirname(exe)), exe: exe };
  }
  const root = path.join(process.env["ProgramFiles"] || "C:\\Program Files", "WindowsApps");
  try {
    const names = readdirSync(root).filter(function (n) { return /^Claude_.*_x64__/.test(n); });
    if (names.length) {
      const m = /^Claude_([\d.]+)_x64__(.+)$/.exec(names[0]);
      return { found: true, source: "directory scan", version: m ? m[1] : "?", packageFamily: m ? m[2] : "?", installDir: path.join(root, names[0]), exe: path.join(root, names[0], "app", "claude.exe") };
    }
  } catch (err) { /* EPERM：正常的，MSIX 目录默认不可枚举 */ }
  return { found: false, why: "Get-AppxPackage 与进程路径都没拿到，且 " + root + " 不可枚举（EPERM）" };
}/** 尽力代按一次 Ctrl+Enter：把应用切到前台再 SendKeys。应用没有编程式提交接口，回车键在输入框里只换行，只有 Ctrl+Enter 才是发送。 */
function pressEnter(delayMs, keys) {
  const combo = String(keys || "^{ENTER}");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Start-Sleep -Milliseconds " + delayMs,
    "$p = Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    "if (-not $p) { Write-Output 'nowindow'; exit 0 }",
    "$ws = New-Object -ComObject WScript.Shell",
    "if (-not $ws.AppActivate($p.Id)) { Write-Output 'nofocus'; exit 0 }",
    "Start-Sleep -Milliseconds 250",
    "$ws.SendKeys(" + JSON.stringify(combo) + ")",
    "Write-Output 'sent'",
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout: 15000, windowsHide: true,
  });
  const out = (r.stdout || "").trim().split(/\r?\n/).pop();
  if (out === "sent") return { ok: true, why: "AppActivate + SendKeys(" + combo + ") 已发出" };
  if (out === "nowindow") return { ok: false, why: "找不到有主窗口的 claude.exe（应用可能在托盘或没启动）" };
  if (out === "nofocus") return { ok: false, why: "AppActivate 失败，窗口没抢到前台" };
  return { ok: false, why: "SendKeys 未执行: " + ((r.stderr || out || "unknown").toString().slice(0, 120)) };
}

function isRunning() {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq claude.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  const out = (r.stdout || "").trim();
  if (!out || /No tasks|没有运行/i.test(out)) return 0;
  return out.split(/\r?\n/).filter(function (l) { return l.indexOf("claude.exe") >= 0; }).length;
}

function protocolRegistered(cfg) {
  const key = "HKCU\\Software\\Classes\\" + cfg.protocol;
  const r = spawnSync("reg", ["query", key], { encoding: "utf8", timeout: 15000, windowsHide: true });
  return { key: key, registered: r.status === 0, stdout: (r.stdout || "").trim().split(/\r?\n/)[0] || "" };
}

function configPaths(cfg) {
  const local = process.env.LOCALAPPDATA;
  const cands = [];
  if (local) {
    // 实测：桌面端 userData 就是 Claude-Data\<packageId>（IndexedDB / Code Cache 都在这里）
    cands.push(path.join(local, "Claude-Data", cfg.appPackageId, "claude_desktop_config.json"));
    cands.push(path.join(local, "Claude", "claude_desktop_config.json"));
    cands.push(path.join(local, "Packages", cfg.appPackageId, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
  }
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json"));
  return cands.map(function (p) { return p + (existsSync(p) ? "  [存在]" : "  [不存在]"); });
}

function storePath(cfg) {
  const local = process.env.LOCALAPPDATA;
  if (!local) return "（非 Windows，未探测）";
  const p = path.join(local, "Claude-Data", cfg.appPackageId);
  return existsSync(p) ? p : p + "（不存在）";
}function line(k, v) {
  return k + ": " + v;
}

function renderSend(args, value) {
  const lines = [];
  lines.push("[desktop] " + (value.launched ? "已投递" : "未投递") + "（" + value.method + "）");
  lines.push(line("目标", value.what || "—"));
  lines.push(line("URL", value.url));
  for (const n of value.notes || []) lines.push(line("注意", n));
  if (value.error) lines.push(line("错误", value.error));
  if (value.answer) {
    if (value.answer.ok) {
      const a = value.answer.answer;
      lines.push(line("会话", value.answer.session.sessionId + "（cli " + value.answer.session.cliSessionId + "）"));
      lines.push(line("轮次", String(value.answer.session.completedTurns) + "，stop_reason=" + (a.stopReason || "—")));
      lines.push("");
      lines.push("【提问】" + (a.lastUser || "").replace(/\s+/g, " ").slice(0, 200));
      lines.push("【回答】" + (a.lastAssistant || ""));
    } else {
      lines.push(line("等待", "没等到回答：" + value.answer.reason + (value.answer.session ? "（session " + value.answer.session.sessionId + "）" : "")));
    }
  }
  if (value.submit) {
    const n = (value.attempts || []).length;
    lines.push(line("发送键", (value.submit.ok ? "已代按 Ctrl+Enter" : "没按成") + (n > 1 ? "（试了 " + n + " 次，最后一次 " + (value.submit.ok ? "成功" : "失败") + "）" : "") + "：" + value.submit.why));
  }
  else if (value.launched && !value.dryRun) lines.push(line("发送键", "没按 —— 文本只是预填在输入框里，需要你按 Ctrl+Enter 发送（回车只换行）；要自动按就传 submit: true"));
  if (value.launched) {
    lines.push("");
    if (value.answer && value.answer.ok) lines.push("回答见上面【回答】段。要再翻旧会话用 desktop_sessions / desktop_read。");
    else lines.push("投递完成。要拿回答：desktop_wait（等这一轮跑完）或 desktop_read（读最近会话）。");
  }
  return [{ type: "text", text: lines.join("\n") }];
}

function renderSessions(args, value) {
  const lines = ["[desktop sessions] " + value.rows.length + " 条（索引：应用 claude-code-sessions，正文：" + value.projectsRoot + "）"];
  for (const r of value.rows) {
    lines.push("");
    lines.push("· " + r.sessionId + (r.archived ? "（已归档）" : ""));
    lines.push("  cli  " + (r.cliSessionId || "—"));
    lines.push("  目录 " + (r.cwd || "—"));
    lines.push("  标题 " + (r.title || "—") + "  轮次 " + r.completedTurns + "  状态 " + (r.status || "—"));
    if (r.statusDetail) lines.push("  说明 " + r.statusDetail);
  }
  return [{ type: "text", text: lines.join("\n") }];
}

function renderRead(args, value) {
  if (!value.found) {
    const lines = ["[desktop read] 没读到：" + (value.reason || "找不到这个会话") + "（ref=" + value.ref + "）"];
    for (const r of value.sessions || []) lines.push("  可用：" + r.sessionId + "  " + (r.title || ""));
    return [{ type: "text", text: lines.join("\n") }];
  }
  const t = value.transcript;
  const lines = [];
  lines.push("[desktop read] " + value.session.sessionId + "（cli " + value.session.cliSessionId + "）");
  lines.push(line("目录", value.session.cwd || "—"));
  lines.push(line("轮次", value.session.completedTurns + "（user " + t.userCount + " / assistant " + t.assistantCount + "）stop_reason=" + (t.stopReason || "—")));
  lines.push(line("正文", t.file));
  for (const ex of t.exchanges) {
    if (ex.user) { lines.push(""); lines.push("【提问】" + ex.user.replace(/\s+/g, " ").slice(0, 400)); }
    if (ex.assistant) lines.push("【回答】" + ex.assistant.slice(0, 2000));
  }
  return [{ type: "text", text: lines.join("\n") }];
}

function renderWait(args, value) {
  if (!value.ok) {
    return [{ type: "text", text: "[desktop wait] 没等到（" + value.waitedMs + "ms）：" + value.reason + (value.session ? "，session=" + value.session.sessionId : "") }];
  }
  const t = value.transcript;
  const lines = ["[desktop wait] 等到了（" + Math.round(value.waitedMs / 1000) + "s）"];
  lines.push(line("会话", value.session.sessionId + "（cli " + value.session.cliSessionId + "）"));
  lines.push(line("状态", (value.session.status || "—") + " / stop_reason=" + (t.stopReason || "—")));
  lines.push("");
  lines.push("【提问】" + (t.lastUser || "").replace(/\s+/g, " ").slice(0, 300));
  lines.push("【回答】" + (t.lastAssistant || ""));
  return [{ type: "text", text: lines.join("\n") }];
}

function renderProbe(args, value) {
  const lines = [];
  lines.push("[desktop probe]");
  lines.push(line("平台", value.platform));
  lines.push(line("应用", value.app.found ? ("Claude " + value.app.version + "  " + value.app.installDir) : ("未找到 —— " + value.app.why)));
  lines.push(line("进程", value.running + " 个 claude.exe"));
  lines.push(line("claude:// 注册", value.protocol.registered ? "已注册（" + value.protocol.key + "）" : "未注册（" + value.protocol.key + "）"));
  lines.push(line("dryRun", value.config.dryRun));
  lines.push(line("桌面端数据目录", value.store));
  lines.push("");
  lines.push("MCP 配置文件候选：");
  for (const p of value.configPaths) lines.push("  " + p);
  lines.push("");
  lines.push("能力边界：");
  for (const c of value.capabilities) lines.push("  " + c);
  return [{ type: "text", text: lines.join("\n") }];
}

export function apply(ctx, config) {
  const cfg = cfgOf(config);

  ctx.tools.register(defineTool({
    name: "desktop_send",
    description: "把一条任务投递给 Claude 桌面端：用 claude://code/new?q=… 让应用开一个新会话并带上 prompt。默认只投递（文本被预填进输入框）；传 submit:true 代按 Ctrl+Enter 发送，再传 wait:true 就把这一轮的回答读回来。",
    parameters: {
      prompt: { type: "string", required: true, description: "要投递的任务文本" },
      folder: { type: "string", description: "工作目录（绝对路径，会作为 folder 参数带上）" },
      files: { type: "array", items: { type: "string" }, description: "要一起带上的文件路径" },
      submit: { type: "boolean", description: "尽力替用户按一次 Ctrl+Enter（opt-in，默认 false）" },
      wait: { type: "boolean", description: "投递后等这一轮跑完，把回答读回来（需要 submit）" },
      surface: { type: "string", enum: ["code", "cowork", "claude.ai"], description: "投递到哪个面：code（默认）/ cowork（带文件的 Cowork 任务）/ claude.ai（普通聊天）" },
    },
    output: { schema: { type: "string" }, render: renderSend },
    async execute(args) {
      const surface = args.surface || "code";
      const route = surface === "claude.ai" ? "/new" : "/new";
      const built = buildLink({
        surface: surface,
        route: route,
        prompt: args.prompt,
        folders: args.folder ? [args.folder] : [],
        files: args.files || [],
      }, cfg);
      const since = Date.now();
      const res = launch(built.url, cfg);
      const wantSubmit = args.submit === undefined ? cfg.submit : args.submit === true;
      const wantWait = args.wait === true;
      const attempts = [];
      const cwd = args.folder || null;
      const live = res.launched && !cfg.dryRun;
      const deadline = since + cfg.waitTimeoutMs;
      let row = null;

      const fireKeys = (delay) => {
        const r = pressEnter(delay, cfg.submitKeys);
        attempts.push({ ok: r.ok, why: r.why });
        res.submit = r;
        return r;
      };

      if (live && wantSubmit) fireKeys(cfg.focusDelayMs);

      if (live && wantWait) {
        // SendKeys 抢前台不稳：每轮按一次键 + 短轮询会话是否出现，最多 4 轮
        let tries = wantSubmit ? 1 : 0;
        while (Date.now() < deadline) {
          const slice = Math.min(8000, Math.max(1000, deadline - Date.now()));
          const got = await waitForNewSessionRow(since, { timeoutMs: slice, pollMs: cfg.pollMs, cwd });
          if (got.ok) { row = got.row; break; }
          if (!wantSubmit || tries >= 4) break;
          tries += 1;
          fireKeys(1500);
        }
        if (row) {
          res.answer = await waitForNewSession(since, { timeoutMs: Math.max(2000, deadline - Date.now()), pollMs: cfg.pollMs, cwd });
        } else {
          res.answer = { ok: false, reason: "没等到新会话（可能没提交成功）", waitedMs: Date.now() - since };
        }
      }
      if (attempts.length) res.attempts = attempts;
      return Object.assign({}, res, {
        what: ENTRIES[surface === "claude.ai" ? "new-chat" : "new-code"].what,
        notes: built.notes,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: "desktop_continue",
    description: "把一个 CLI 会话交回 Claude 桌面端继续：claude://code/continue?session=<id>（应用会 import 该 CLI 会话）。session 传 \"last\" 表示最近一个。",
    parameters: {
      session: { type: "string", required: true, description: "CLI 返回的 session_id（UUID），或 \"last\"" },
    },
    output: { schema: { type: "string" }, render: renderSend },
    async execute(args) {
      const s = String(args.session || "").trim();
      const isLast = s === "last";
      const looksUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
      const notes = [];
      if (!isLast && !looksUuid) notes.push("这不像 UUID —— 桌面端只接受 UUID 形态的会话 id 或 \"last\"");
      const built = buildLink({ surface: "code", route: "/continue", session: s }, cfg);
      const res = launch(built.url, cfg);
      return Object.assign({}, res, { what: isLast ? ENTRIES["continue-last"].what : "继续指定 CLI 会话", notes: notes.concat(built.notes) });
    },
  }));

  ctx.tools.register(defineTool({
    name: "desktop_open",
    description: "打开桌面端的某个入口：new-chat / new-code / cowork-new / continue-last / needs-input / agents / memory / hub / settings。不带 prompt。",
    parameters: {
      entry: { type: "string", required: true, description: "入口名，见工具描述；也可直接传 claude:// 开头的完整 URL" },
    },
    output: { schema: { type: "string" }, render: renderSend },
    async execute(args) {
      const key = String(args.entry || "").trim();
      if (key.startsWith(cfg.protocol + "://")) {
        const res = launch(key, cfg);
        return Object.assign({}, res, { what: "自定义深链", notes: ["原样投递，未做参数校验"] });
      }
      const e = ENTRIES[key];
      if (!e) {
        return { launched: false, method: "none", url: "", what: "未知入口", notes: ["可用：" + Object.keys(ENTRIES).join(" / ")], error: "unknown entry " + key };
      }
      const res = launch(e.url, cfg);
      return Object.assign({}, res, { what: e.what, notes: [] });
    },
  }));

  ctx.tools.register(defineTool({
    name: "desktop_sessions",
    description: "列出桌面端最近的会话（从应用的会话索引里读）：local_<uuid>、对应的 Claude Code session id、cwd、轮次、状态、标题。",
    parameters: {
      limit: { type: "integer", description: "返回几条，默认 10" },
      includeArchived: { type: "boolean", description: "是否包含已归档的，默认 false" },
    },
    output: { schema: { type: "string" }, render: renderSessions },
    async execute(args) {
      const limit = Math.max(1, Math.min(50, args.limit || 10));
      const rows = listAppSessions().filter((r) => args.includeArchived || !r.archived).slice(0, limit);
      return { rows, projectsRoot: projectsRoot() };
    },
  }));

  ctx.tools.register(defineTool({
    name: "desktop_read",
    description: "读回桌面端某个会话的对话内容（会话正文落在 ~/.claude/projects/<cwd-slug>/<cliSessionId>.jsonl，是明文）。接受 local_<uuid>、Claude Code session id，或 \"last\"。",
    parameters: {
      session: { type: "string", required: true, description: "local_<uuid> / Claude Code session id / \"last\"" },
      turns: { type: "integer", description: "返回最后几轮，默认 2" },
    },
    output: { schema: { type: "string" }, render: renderRead },
    async execute(args) {
      const { row } = resolveSession(args.session);
      if (!row) return { found: false, ref: args.session, sessions: listAppSessions().slice(0, 5) };
      const file = findTranscript(row.cliSessionId);
      if (!file) return { found: false, ref: args.session, session: row, reason: "会话索引里有，但 transcript 文件没找到（可能还没落盘或被清理）" };
      const parsed = parseTranscript(file, Math.max(1, Math.min(20, args.turns || 2)));
      return { found: true, session: row, transcript: parsed };
    },
  }));

  ctx.tools.register(defineTool({
    name: "desktop_wait",
    description: "等桌面端某个会话跑完一轮，把回答读回来。不传 session 就等最新那个新建的会话。",
    parameters: {
      session: { type: "string", description: "local_<uuid> / Claude Code session id；不传=等最新" },
      timeoutMs: { type: "integer", description: "最多等多久，默认 180000" },
    },
    output: { schema: { type: "string" }, render: renderWait },
    async execute(args) {
      const timeoutMs = args.timeoutMs || cfg.waitTimeoutMs;
      const started = Date.now();
      const ref = args.session;
      const baseline = ref ? null : Date.now();
      while (Date.now() - started < timeoutMs) {
        const { row } = ref ? resolveSession(ref) : { row: null };
        const target = ref ? row : listAppSessions()[0];
        if (target && target.cliSessionId) {
          const parsed = parseTranscript(findTranscript(target.cliSessionId) || "", 1);
          const settled = target.completedTurns > 0 && parsed && parsed.lastAssistant && parsed.stopReason;
          const fresh = !ref || !baseline || target.createdAt >= baseline - 3000;
          if (settled && fresh) return { ok: true, session: target, transcript: parsed, waitedMs: Date.now() - started };
        }
        await new Promise((r) => setTimeout(r, cfg.pollMs));
      }
      return { ok: false, session: (ref ? resolveSession(ref).row : listAppSessions()[0]) || null, waitedMs: Date.now() - started, reason: "超时没等到" };
    },
  }));

  ctx.tools.register(defineTool({
    name: "desktop_probe",
    description: "体检 Claude 桌面端：安装版本、是否在跑、claude:// 是否注册、MCP 配置文件在哪、以及这个桥能做什么/不能做什么。排错先跑它。",
    parameters: {},
    output: { schema: { type: "string" }, render: renderProbe },
    async execute() {
      const app = findDesktopApp();
      return {
        platform: process.platform + " " + os.release(),
        app: app,
        running: isRunning(),
        protocol: protocolRegistered(cfg),
        config: { dryRun: cfg.dryRun, maxPromptChars: cfg.maxPromptChars, protocol: cfg.protocol },
        configPaths: configPaths(cfg),
        store: storePath(cfg),
        capabilities: [
          "能：投递任务（claude://code/new?q=…），桌面端开新会话并带上 prompt",
          "能：投递 Cowork 任务（claude://cowork/new?q=…&folder=…&file=…）",
          "能：把 CLI 会话交回桌面端（claude://code/continue?session=<uuid|last>）",
          - "能：读回回答 —— 桌面端 CCD 跑的就是真 Claude Code，会话正文落在 ~/.claude/projects/<cwd-slug>/<cliSessionId>.jsonl（明文）；应用侧索引 local_<uuid>.json 给出 cliSessionId",
          "不能：往已打开的对话里插话 —— 没有 queue 式 IPC",
          "不能：CDP 驱动 —— --remote-debugging-port 在应用的黑名单里（app.asar 里 LY 数组）",
        ],
      };
    },
  }));
}