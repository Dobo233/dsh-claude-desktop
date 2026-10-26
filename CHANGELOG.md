# Changelog

## 0.1.2

- **能读回回答了**：桌面端的 Claude Code 面板内部跑的就是真 Claude Code，正文是明文，落在 `~/.claude/projects/<cwd-slug>/<cliSessionId>.jsonl`；应用侧索引 `%LOCALAPPDATA%/Claude-Data/claude_<pkg>/claude-code-sessions/<account>/<org>/local_<uuid>.json` 里 `sessionId ↔ cliSessionId` 可对。新增 `lib/transcripts.js`（无依赖）负责解析。
- 新工具 `desktop_sessions`（列会话）、`desktop_read`（读最后 N 轮正文）、`desktop_wait`（等一轮跑完并读回）。
- `desktop_send` 新增 `wait`：投递 + 代按发送后轮询新会话，等 `completedTurns>0` 且 `stop_reason` 出现，直接把【提问】/【回答】返回。
- **发送键改成自动重按**：`SendKeys` 抢前台不稳（`AppActivate` 返回 True 不代表键落进输入框），`wait=true` 时最多重按 4 轮、每轮观察 8 s，次数写进结果；`submit` 失败不再静默。
- 新增配置 `waitTimeoutMs`（默认 `180000`）、`pollMs`（默认 `2000`）。
- 文档：README 增「读回：会话正文在哪」，能力边界表里「读回」从「不能」改为「能」并写明依据。

## 0.1.1

- `desktop_send` 新增 `submit`（默认 `false`）：深链只会把文本预填进输入框，回车在输入框里是换行，只有 `Ctrl+Enter` 才真正发送 —— 打开后投递完会把窗口抢到前台代按一次。
- 新增配置 `submitKeys`（默认 `"^{ENTER}"`）、`focusDelayMs`（默认 `1200`）。
- 渲染结果区分「已投递」和「发送键按没按成」，不再让人误以为消息已经发出去了。

## 0.1.0

- `desktop_send`：用 `claude://code/new?q=…&folder=…&file=…` 把任务投递到 Claude 桌面端（code / cowork / claude.ai 三个面）。
- `desktop_continue`：`claude://code/continue?session=<uuid|last>`，把 CLI 会话交回桌面端继续。
- `desktop_open`：打开 `needs-input` / `agents` / `memory` / `hub` 等面板，或直接投递自定义 `claude://` 链接。
- `desktop_probe`：版本、进程数、协议注册、`claude_desktop_config.json` 位置、能力边界体检。
- 跨平台启动：Windows 走 `rundll32 url.dll,FileProtocolHandler`（不经 shell），macOS `open`，Linux `xdg-open`。
- 只允许 `claude://` 协议；prompt 控制字符清理 + 长度截断；`dryRun` 只返回 URL。
