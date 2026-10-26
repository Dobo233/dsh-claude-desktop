// 桌面端会话的读取层：把 Claude 桌面端（CCD）跑出来的会话捞回来。
//
// 两层数据：
//   1. 应用侧索引  %LOCALAPPDATA%\Claude-Data\claude*\claude-code-sessions\<account>\<org>\local_<uuid>.json
//      给的是 sessionId(local_x) ↔ cliSessionId(x)、cwd、completedTurns、title、postTurnSummary。
//   2. 真身 transcript  ~/.claude/projects/<slug(cwd)>/<cliSessionId>.jsonl
//      桌面端的 CCD 内部跑的就是真 Claude Code，所以它的对话原样落在 CLI 的 projects 目录里。
// 这两层都是明文的，所以「投递 → 等 → 读回回答」是可行的，不需要去碰 IndexedDB。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function appSessionRoots() {
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Claude-Data");
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  return names
    .filter((n) => n.toLowerCase().startsWith("claude"))
    .map((n) => path.join(base, n, "claude-code-sessions"));
}

function walkFiles(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out, depth + 1);
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

export function listAppSessions() {
  const rows = [];
  for (const root of appSessionRoots()) {
    for (const file of walkFiles(root)) {
      let j;
      try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
      if (!j || !j.sessionId) continue;
      rows.push({
        sessionId: j.sessionId,
        cliSessionId: j.cliSessionId || null,
        cwd: j.cwd || j.originCwd || null,
        title: j.title || null,
        completedTurns: j.completedTurns || 0,
        createdAt: j.createdAt || 0,
        lastActivityAt: j.lastActivityAt || 0,
        archived: !!j.isArchived,
        status: (j.postTurnSummary && j.postTurnSummary.status_category) || null,
        statusDetail: (j.postTurnSummary && j.postTurnSummary.status_detail) || null,
        file,
      });
    }
  }
  rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return rows;
}

export function projectsRoot() {
  return path.join(os.homedir(), ".claude", "projects");
}

export function slugFor(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9._-]/g, "-");
}

export function findTranscript(cliSessionId) {
  if (!cliSessionId) return null;
  const root = projectsRoot();
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(root, d, cliSessionId + ".jsonl");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function textOf(entry) {
  const c = entry && entry.message && entry.message.content;
  if (typeof c === "string") return c.trim();
  if (!Array.isArray(c)) return "";
  return c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
}

export function parseTranscript(file, turnLimit = 3) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const users = [], assistants = [];
  let sessionId = null, cwd = null, stopReason = null;
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!sessionId && o.sessionId) sessionId = o.sessionId;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (o.type === "user") {
      const t = textOf(o);
      if (t) users.push({ text: t, ts: o.timestamp || null });
    } else if (o.type === "assistant") {
      const t = textOf(o);
      if (o.message && o.message.stop_reason) stopReason = o.message.stop_reason;
      if (t) assistants.push({ text: t, ts: o.timestamp || null, uuid: o.uuid || null });
    }
  }
  const exchanges = [];
  const n = Math.max(users.length, assistants.length);
  for (let i = 0; i < n; i++) exchanges.push({ user: users[i] ? users[i].text : null, assistant: assistants[i] ? assistants[i].text : null });
  return {
    file,
    sessionId,
    cwd,
    lines: lines.length,
    userCount: users.length,
    assistantCount: assistants.length,
    stopReason,
    lastUser: users.length ? users[users.length - 1].text : null,
    lastAssistant: assistants.length ? assistants[assistants.length - 1].text : null,
    exchanges: exchanges.slice(-turnLimit),
  };
}

/** 找到 createdAt 之后新建、且至少跑完一轮的会话，等它出回答。 */
export function waitForNewSession(sinceMs, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 180000;
  const pollMs = opts.pollMs ?? 2000;
  const cwd = opts.cwd || null;
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const rows = listAppSessions().filter((r) => r.createdAt >= sinceMs - 3000 && (!cwd || slugFor(r.cwd) === slugFor(cwd)));
      const done = rows.find((r) => r.completedTurns > 0 && r.cliSessionId);
      if (done) {
        const parsed = parseTranscript(findTranscript(done.cliSessionId) || "", 1);
        if (parsed && parsed.lastAssistant) {
          return resolve({ ok: true, session: done, answer: parsed });
        }
      }
      if (Date.now() - started > timeoutMs) {
        return resolve({ ok: false, session: rows[0] || null, waitedMs: Date.now() - started, reason: rows.length ? "会话建了，但没等到回答" : "没等到新会话（可能没提交成功）" });
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

export function waitForNewSessionRow(sinceMs, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const pollMs = opts.pollMs ?? 600;
  const cwd = opts.cwd || null;
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const rows = listAppSessions().filter((r) => r.createdAt >= sinceMs - 3000 && (!cwd || slugFor(r.cwd) === slugFor(cwd)));
      if (rows.length) return resolve({ ok: true, row: rows[0], waitedMs: Date.now() - started });
      if (Date.now() - started > timeoutMs) return resolve({ ok: false, row: null, waitedMs: Date.now() - started });
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

export function resolveSession(ref) {
  const rows = listAppSessions();
  if (!ref || ref === "last") return { row: rows[0] || null, rows };
  const want = String(ref).trim();
  const row = rows.find((r) => r.sessionId === want || r.cliSessionId === want || (want.startsWith("local_") && r.sessionId === want));
  return { row: row || null, rows };
}
