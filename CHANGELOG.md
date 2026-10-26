# Changelog

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
