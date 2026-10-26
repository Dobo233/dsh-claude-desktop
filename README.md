# dsh-claude-desktop

让 **DSH** 把活交给 **Claude 桌面端**（claude:// 深链），并且把边界写清楚：哪些能，哪些不能，凭什么。

和 `dsh-claude-pilot` 的分工：pilot 是 **spawn `claude` CLI**（拿 JSON 结果、能 resume）；这个是 **调桌面应用**：带 prompt + 目录 + 文件开新会话、代按发送键，**再从桌面端把回答读回来**（桌面端内部跑的就是真 Claude Code，正文是明文 jsonl）。

---

## 能力边界（都有实测依据）

| 能力 | 结论 | 依据 |
|---|---|---|
| 投递任务到桌面端 | **能** | `claude://code/new?q=…&folder=…` 实测启动后 `main.log` 出现 `Saved workspace trust for <dir>`，进程数 9 → 12，`[CCD] … plugin(s) go to Claude Code over stdin` |
| 投递 Cowork 任务（带文件） | **能** | `claudeURLHandler` 的 `cowork` 分支：`q` / `folder` / `file` → 转发到 `/task/new` |
| 把 CLI 会话交回桌面端 | **能** | 菜单项 `claude://code/continue?session=last`；`Resume` 分支调用 `importCliSession(<uuid>)` |
| 读回桌面端的回答 | **能** | 桌面端 CCD 内部就是 CLI：正文落在 `~\.claude\projects\<cwd-slug>\<cliSessionId>.jsonl`（明文）；应用侧索引 `Claude-Data\claude_<pkg>\claude-code-sessions\<account>\<org>\local_<uuid>.json` 里有 `sessionId ↔ cliSessionId` 对照 |
| 往已打开的对话里插话 | **不能** | 没有 queue 式 IPC（Codex CLI 有 `codex queue`，Claude 两侧都没有） |
| CDP / 远程调试驱动 | **不能** | `--remote-debugging-port` 在应用的 Chromium 开关黑名单里（`app.asar` 中的 `LY` 数组） |

一句话：**这个桥是「投递 + 交接 + 读回」，不是「遥控」** —— 不能往已开的对话里插话，也不能用 CDP 驱动。

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

### 投递 ≠ 发送（实测结论）

`q` 参数只会把文本**预填进输入框**，不会替你按发送键。实测证据：

- 投递后应用写下 `Local Storage\leveldb` 里 `composer-draft` 记录：`{"text":"<你的 prompt>","readyImageCount":0,"textChangedAt":…}` —— 这是草稿，不是已发出的消息。
- 只按 `Enter`：草稿原封不动留在那里（Claude 的输入框里回车是**换行**）。
- 按 `Ctrl+Enter`：应用日志出现 `[CCD] session spawn`、`LocalSessions.updateSession: sessionId=local_<uuid>`、`[CCD CycleHealth] healthy cycle … hadFirstResponse=true` —— 这才会真正开跑一轮并拿到回答。

所以 `desktop_send(..., submit=true)` 做的事是：拉起深链 → 把窗口抢到前台 → `SendKeys('^{ENTER}')`。它是**尽力而为**：找不到有主窗口的进程、或 `AppActivate` 抢不到前台时会返回 `ok:false` 并说明原因，不会假装成功。

---

## 工具

| 工具 | 作用 | 参数 |
|---|---|---|
| `desktop_send` | 投递任务，开新会话并把 prompt 预填进输入框 | `prompt`(必填)、`folder`、`files[]`、`surface`=`code`\|`cowork`\|`claude.ai`、`submit`（尽力代按 Ctrl+Enter） |
| `desktop_continue` | 把 CLI 会话交回桌面端继续 | `session`=`last` 或 CLI 返回的 UUID |
| `desktop_open` | 打开面板 / 任意深链 | `entry`=`new-chat`\|`new-code`\|`cowork-new`\|`continue-last`\|`needs-input`\|`agents`\|`memory`\|`hub`\|`settings`，或完整 `claude://…` |
| `desktop_sessions` | 列出桌面端最近会话（`local_<uuid>`、`cliSessionId`、cwd、轮次、状态） | `limit`、`includeArchived` |
| `desktop_read` | 读回某个会话的对话正文（最后 N 轮） | `session`=`local_<uuid>`/cli UUID/`last`、`turns` |
| `desktop_wait` | 等某个会话跑完一轮并把回答读回 | `session`（不传=最新）、`timeoutMs` |
| `desktop_probe` | 体检：版本、进程、协议注册、配置文件位置、能力边界 | — |

示例：

```text
desktop_send(prompt="把 README 的第一段改短一点", folder="E:\\path\\to\\repo")
desktop_send(prompt="只回复一行 OK", submit=true)   # 连发送键一起替你按
desktop_send(prompt="跑一下 unit test", folder="E:\\repo", submit=true, wait=true)  # 投递 + 代按 + 读回
desktop_read(session="last", turns=2)              # 读最近会话的最后两轮
desktop_sessions(limit=5)                          # 看有哪些会话
desktop_continue(session="6bede325-c04e-405a-8681-85a1e060931d")
desktop_open(entry="needs-input")
desktop_probe()
```

---

## 读回：会话正文在哪

桌面端的 Claude Code 面板**内部跑的就是真 Claude Code**，所以正文不是锁在 IndexedDB 里，而是原样写在 CLI 的 projects 目录：

```text
~/.claude/projects/<cwd-slug>/<cliSessionId>.jsonl        # 正文（每个会话一个 jsonl）
%LOCALAPPDATA%/Claude-Data/claude_<pkg>/claude-code-sessions/<account>/<org>/local_<uuid>.json   # 应用侧索引
```

- `cwd-slug` 规则：路径里非 `[A-Za-z0-9._-]` 的字符逐个换成 `-`，例如 `D:\work\my-repo` → `D--work-my-repo`。
- 索引 json 里有 `sessionId`（`local_<uuid>`，应用自己的 id）、**`cliSessionId`**（真 Claude Code 的 session id，对应 jsonl 文件名）、`cwd`、`title`、`completedTurns`、`lastActivityAt`、`model`、`permissionMode` 等。
- jsonl 每行一类事件（`user` / `assistant` / `system` / `custom-title` / `file-history-snapshot` …），正文在 `message.content[]` 里 `type === "text"` 的块，`message.stop_reason` 表这一轮结束。

因此：

- `desktop_read(session="last")` 直接读 jsonl，**不需要应用配合**，应用关了也能读（文件已经在盘上）。
- `desktop_send(..., submit=true, wait=true)` = 投递 → 代按 Ctrl+Enter → 轮询新会话 → 等 `completedTurns>0` 且 `stop_reason` 出现 → 把【提问】/【回答】直接返回给你。
- 读的是**本地文件**，不联网；额度只有那一轮真跑掉了才会花。

---

## 安装

```powershell
# 从 GitHub（不进 npm 也能装）
dsh plugin --profile web add github:Dobo233/dsh-claude-desktop

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
| `submit` | `false` | 默认不代按发送键；`true` 时投递后自动按一次 Ctrl+Enter |
| `submitKeys` | `"^{ENTER}"` | 代按时用的 SendKeys 组合（`{ENTER}` 只换行，别改错） |
| `focusDelayMs` | `1200` | 投递后等多久再抢前台按发送键 |
| `waitTimeoutMs` | `180000` | `wait` 时最多等多久（含自动重按发送键的时间） |
| `pollMs` | `2000` | 轮询会话索引的间隔 |

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
| 输入框里有字，但消息没发出去 | 预期行为：深链只预填。按 Ctrl+Enter，或传 `submit=true` 让插件代按 |
| `submit=true` 但返回「没按成」 | 应用没有带主窗口的进程（在托盘/最小化），或 `AppActivate` 抢不到前台；先手动点开窗口再试 |
| 按键发了但没开新会话 | `SendKeys` 抢前台不稳（`AppActivate` 返回 True 不代表键落进输入框），应用正忙时更明显。带 `wait=true` 时插件会**自动重按**（最多 4 轮、每轮观察 8 s），次数写进结果；仍失败就手动按一次 |
| 回车按了只换行 | 桌面端 Claude Code 输入框里 `Enter` = 换行、`Ctrl+Enter` = 发送（实测：按 Enter 后 `composer-draft` 不变；按 Ctrl+Enter 后日志出现 `[CCD] session spawn`） |
| 新会话没带上 prompt | prompt 太长被应用截断；或 `q` 里的特殊字符被 URL 编码问题吃掉（本插件用 `URLSearchParams` 编码） |
| 想拿结果回 DSH | `desktop_read` / `desktop_wait`（读本地 jsonl，见「读回」章节）；要干净 JSON（cost / turns / session_id）就用 `dsh-claude-pilot` 的 `claude_run` |

---

## English

`dsh-claude-desktop` lets DSH hand work to the Claude desktop app over the app's own `claude://` deep links: start a new Claude Code session with a prompt and folders (`claude://code/new?q=…&folder=…`), start a Cowork task with files, or push a CLI session id back into the app (`claude://code/continue?session=<uuid>`). It is a hand-off bridge, not a remote control: the desktop app exposes no local port, blocks `--remote-debugging-port`, and keeps transcripts in its own IndexedDB — so results cannot be read back. Use `dsh-claude-pilot` when you need the answer inside DSH.

## License

MIT