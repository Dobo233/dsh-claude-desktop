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
 *   不能   ┌ 读回桌面端会话的回答（没有对外接口；会话存在应用内部存储里）
 *          └ 往已打开的对话里插话（没有 queue 式 IPC）
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "claude-desktop";
export const inject = ["tools"];

const DEFAULTS = {
  dryRun: false,
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
}function isRunning() {
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
  if (value.launched) {
    lines.push("");
    lines.push("回答在桌面端里，本工具读不回来 —— 桌面端没有对外的会话读取接口。");
  }
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
    description: "把一条任务投递给 Claude 桌面端：用 claude://code/new?q=… 让应用开一个新会话并带上 prompt。只会投递，读不回结果。",
    parameters: {
      prompt: { type: "string", required: true, description: "要投递的任务文本" },
      folder: { type: "string", description: "工作目录（绝对路径，会作为 folder 参数带上）" },
      files: { type: "array", items: { type: "string" }, description: "要一起带上的文件路径" },
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
      const res = launch(built.url, cfg);
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
          "不能：读回桌面端的回答 —— 会话存在应用自己的 IndexedDB（LevelDB）里，没有对外接口",
          "不能：往已打开的对话里插话 —— 没有 queue 式 IPC",
          "不能：CDP 驱动 —— --remote-debugging-port 在应用的黑名单里（app.asar 里 LY 数组）",
        ],
      };
    },
  }));
}