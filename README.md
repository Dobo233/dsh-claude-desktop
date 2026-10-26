# dsh-claude-desktop

让 **DSH** 把活交给 **Claude 桌面端**（claude:// 深链），并且把边界写清楚：哪些能，哪些不能，凭什么。

和 `dsh-claude-pilot` 的分工：pilot 是 **spawn `claude` CLI**（能拿回结果、能 resume）；这个是 **调桌面应用**（能带 prompt + 目录 + 文件开一个新会话，结果留在应用里，读不回来）。

---

## 能力边界（都有实测依据）

| 能力 | 结论 | 依据 |
|---|---|---|
| 投递任务到桌面端 | **能** | `claude://code/new?q=…&folder=…` 实测启动后 `main.log` 出现 `Saved workspace trust for <dir>`，进程数 9 → 12，`[CCD] … plugin(s) go to Claude Code over stdin` |
| 投递 Cowork 任务（带文件） | **能** | `claudeURLHandler` 的 `cowork` 分支：`q` / `folder` / `file` → 转发到 `/task/new` |
| 把 CLI 会话交回桌面端 | **能** | 菜单项 `claude://code/continue?session=last`；`Resume` 分支调用 `importCliSession(<uuid>)` |
| 读回桌面端的回答 | **不能** | 无监听端口（`Get-NetTCPConnection` 里没有 claude 进程）；会话在 `Claude-Data\<pkg>\IndexedDB\https_claude.ai_0.indexeddb.leveldb`；`claude-code-sessions\<account>` 是空的 |
| 往已打开的对话里插话 | **不能** | 没有 queue 式 IPC（Codex CLI 有 `codex queue`，Claude 两侧都没有） |
| CDP / 远程调试驱动 | **不能** | `--remote-debugging-port` 在应用的 Chromium 开关黑名单里（`app.asar` 中的 `LY` 数组） |

一句话：**这个桥是「投递 + 交接」，不是「遥控」。**

---

## 深链契约（从应用 `app.asar` 的 `claudeURLHandler` 里读出来的）

| 入口 | URL | 参数 |
|---|---|---|
| 新 Claude Code 会话 | `claude://code/new` | `q`（或 `prompt`）、`folder`（可重复）、`file`（可重复） |
| 继续会话 | `claude://code/continue` | `session=last` 或 UUID（UUID 才会 import CLI 会话） |
| 等你处理的会话 | `claude://code/needs-input` | `session` |
| Cowork 任务 | `claude://cowork/new` | `q`、`folder`、`file` |
| 新聊天 | `claude://claude.ai/new` | `surface=chat` |
| 其它面板 | `claude://code/{agents,memory,hub,preview,security,share,family,enroll,disabled,onboarding}` | — |

`claude://` 协议由应用启动时注册（`HKCU\Software\Classes\claude`），应用里有个开关 `disableDeepLinkRegistration` 可以关掉它。

---

## 工具

| 工具 | 作用 | 参数 |
|---|---|---|
| `desktop_send` | 投递任务，开新会话并带上 prompt | `prompt`(必填)、`folder`、`files[]`、`surface`=`code`\|`cowork`\|`claude.ai` |
| `desktop_continue` | 把 CLI 会话交回桌面端继续 | `session`=`last` 或 CLI 返回的 UUID |
| `desktop_open` | 打开面板 / 任意深链 | `entry`=`new-chat`\|`new-code`\|`cowork-new`\|`continue-last`\|`needs-input`\|`agents`\|`memory`\|`hub`\|`settings`，或完整 `claude://…` |
| `desktop_probe` | 体检：版本、进程、协议注册、配置文件位置、能力边界 | — |

示例：

```text
desktop_send(prompt="把 README 的第一段改短一点", folder="E:\\path\\to\\repo")
desktop_continue(session="6bede325-c04e-405a-8681-85a1e060931d")
desktop_open(entry="needs-input")
desktop_probe()
```

---

## 安装

```powershell
# 从 GitHub（不进 npm 也能装）
dsh plugin --profile web add github:OWNER/dsh-claude-desktop

# 或本地开发
dsh plugin --profile web add <repo-path>
```

配置文件（`~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `config` 段或插件项里）：

| 键 | 默认 | 说明 |
|---|---|---|
| `dryRun` | `false` | `true` 只返回拼好的 URL，不真的拉起应用 —— 调试和写文档时用 |
| `maxPromptChars` | `6000` | prompt 截断长度（应用对 `q` 也有自己的上限） |
| `protocol` | `"claude"` | 自定义协议名（一般不用改） |
| `appPackageId` | `"Claude_pzs8sxrjxfjjc"` | 用来定位 `Claude-Data\<pkg>` 数据目录 |

---

## 安全边界

- 只启动 `claude://` 前缀的 URL，别的协议一律拒绝（防止被 prompt 注入成任意协议拉起）。
- Windows 上走 `rundll32.exe url.dll,FileProtocolHandler <url>`（ShellExecute），**不经过 shell**，所以 URL 里的 `&`、`%`、空格不会被拆开或二次解释。
- prompt 里的控制字符（`\x00-\x1F`，换行/制表除外）会被清成空格，超长截断并在返回值里提示。
- 投递 = 在用户的桌面端开一个真实会话，会消耗用户的额度；`dryRun` 可以先看 URL 再决定。
- 首次往某个目录投递，应用会要求一次工作区信任（日志：`Saved workspace trust for <dir>`）。

---

## 排错

先跑 `desktop_probe`，按输出逐项对：

| 现象 | 原因 / 处理 |
|---|---|
| `claude:// 注册: 未注册` | 桌面端没启动过，或应用里开了 `disableDeepLinkRegistration`；手动启动一次应用 |
| `应用: 未找到` | `Get-AppxPackage -Name '*Claude*'` 查不到；确认装的是 Clash→Claude 桌面版（MSIX 包名 `Claude_pzs8sxrjxfjjc`） |
| 投递了但没反应 | 应用在后台未响应；先 `desktop_open(entry="new-chat")` 试最轻的入口 |
| 新会话没带上 prompt | prompt 太长被应用截断；或 `q` 里的特殊字符被 URL 编码问题吃掉（本插件用 `URLSearchParams` 编码） |
| 想拿结果回 DSH | 拿不到 —— 用 `dsh-claude-pilot` 的 `claude_run`（走 CLI，能返回文本和 session_id） |

---

## English

`dsh-claude-desktop` lets DSH hand work to the Claude desktop app over the app's own `claude://` deep links: start a new Claude Code session with a prompt and folders (`claude://code/new?q=…&folder=…`), start a Cowork task with files, or push a CLI session id back into the app (`claude://code/continue?session=<uuid>`). It is a hand-off bridge, not a remote control: the desktop app exposes no local port, blocks `--remote-debugging-port`, and keeps transcripts in its own IndexedDB — so results cannot be read back. Use `dsh-claude-pilot` when you need the answer inside DSH.

## License

MIT