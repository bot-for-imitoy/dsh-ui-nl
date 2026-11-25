# dsh-ui-nl

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的自然语言 UI 操作封装。它只暴露**一个**工具 `ui_operate`：把一句自然语言指令交给一个**子代理**，子代理拥有 [`dsh-ui-automation`](https://github.com/bot-for-imitoy/dsh-ui-automation) 的标号图片工具，自己决定"先截图 → 按编号操作 → 再截图验证"的步骤，最后用文字汇报；当指令要求看界面时，最新的标号截图会作为图片块返回。

```
主 Agent ──ui_operate({instruction})──▶ 子代理
                                       ├─ ui_screenshot
                                       ├─ ui_click / ui_double_click
                                       ├─ ui_scroll / ui_drag / ui_type
                                       └─（用下一张图验证）
主 Agent ◀── 汇报文字（被要求时 + 图片块）──┘
```

## 依赖（必须先装）

本 bundle **依赖 `dsh-ui-automation`**，自身不提供任何界面控制能力。请先安装并启用它：截图标号、AT-SPI 元素枚举和 XTEST 输入都由它完成。

```bash
# 在已经内置该插件的 profile 里，或作为 bundle 安装
dsh plugin --profile <profile> add link:/path/to/dsh-ui-automation-plugin
```

然后安装本 bundle（Plugins → Add plugin → 本地目录，或用 `plugin_manager` 的 `install_bundle` 指向本目录绝对路径）。依赖在调用时校验：六个 `ui_*` 工具缺任一，`ui_operate` 返回 `UI_TOOLS_UNAVAILABLE`，并且不会启动子代理。

仅支持 Linux（X11/XTEST）。子代理的模型必须支持图片输入（截图以图片块送达子代理）；`ui_operate` 会预检路由，模型声明为纯文本时以 `MODEL_ROUTE` 失败。

## 工具

### `ui_operate`

| 参数 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `instruction` | string | 是 | 给 UI 子代理的完整自然语言任务，用用户的语言：看哪里、点什么/输入什么（用界面上可见的文字）、是否需要一张界面图片。 |

结果值（JSON）：

```jsonc
{
  "ok": true,
  "text": "点了 #7「立即领取」，界面弹出「领取成功」。",
  "childId": "session-…",
  "childName": "agent-1",
  "stopReason": "completed",
  "imagePath": "/…/screenshots/shot-20261125-120000-1234-1.png", // 子代理报告了截图时
  "attachment": { "id": "…", "mediaType": "image/png" },          // attachImages 打开时
  "warnings": [],
  "elapsedMs": 61234
}
```

失败时 `ok: false`，并带 `code` 与 `error`：

| `code` | 含义 |
|---|---|
| `UI_TOOLS_UNAVAILABLE` | `dsh-ui-automation` 未安装/未启用（错误信息会点名缺少的工具） |
| `MODEL_ROUTE` | 子代理模型路由不接受图片输入 |
| `START_FAILED` | 子代理 provider 启动失败 |
| `CHILD_STOPPED` | 子代理以 `error`/`aborted`/`max-tokens`/`refusal` 结束；`error` 是它的诊断信息 |
| `ACTIVATION_FAILED` | 激活结果 reject（清理失败） |
| `TIMEOUT` | 超过 `timeoutMs` 未完成，子代理已被取消 |
| `ABORTED` | 调用方取消了这次工具调用 |

渲染时图片块在前、汇报在后；文字里始终带 `imagePath`，纯文字界面也拿得到证据。

## 用法

主 Agent 只需要把任务说清楚：

- **看图** —— `ui_operate({ instruction: "看看界面上有什么，并给我一张图" })` → 子代理 `ui_screenshot` 后描述编号元素，并以 `IMAGE: <path>` 结尾；工具结果把这张 PNG 作为图片块返回，同时给出文字描述。
- **按可见文字点击** —— `ui_operate({ instruction: "在当前的浏览器窗口里点击「立即领取」" })` → 子代理截图、找到标签为「立即领取」的编号、点击该编号、再截图验证，最后汇报"点了 #7「立即领取」，界面变成…"。指令没要图，所以不附图片。
- **输入** —— `ui_operate({ instruction: "在搜索框里输入「Overwatch 2」并回车，然后告诉我结果列表的前三项" })` → `ui_type` 输入文本/按键，再截图验证并文字汇报。
- **多步** —— 一次调用只做一个结果；用上一次的汇报决定下一次指令。

子代理不能执行 shell、不能读写文件、不能启动其他 agent：它的 scope 里只有六个标号图片工具（`tools.restrict({ allow: [...] })`），UI 操作次数受 `maxSteps` 限制。

## 配置

```yaml
- id: ui-nl
  name: 'dsh-ui-nl'
  config:
    subagentProvider: spawn   # 启动子代理使用的 ctx.subagents provider
    workspace: ''             # 子代理工作目录；留空继承调用方目录（不影响工具可见性）
    modelProvider: ''         # 子代理 LLM provider；与 model 成对，留空继承调用方
    model: ''                 # 子代理 LLM 模型（必须支持图片输入）
    timeoutMs: 180000         # 单次总超时，5000–1800000；超时会取消子代理并返回 TIMEOUT
    maxSteps: 40              # 子代理 UI 工具调用预算，1–500；超出后 guard 拒绝
    attachImages: true        # 把报告的截图存成 attachment 并作为图片块返回
    enabledSessionIds: ''     # 额外允许调用 ui_operate 的会话 ID
    allowedWorkspacePaths: '' # 允许调用 ui_operate 的工作区；留空 = 本插件目录
    allowAllSessions: false   # 对所有会话开放（它会驱动真实桌面）
```

`timeoutMs` 同时会在加载时写入工具定义的 pipeline 上限；修改后请重启 profile。

## 子代理为什么能拿到工具（以及为什么不走工作区白名单）

`dsh-ui-automation` 用 `allowAllSessions` / `enabledSessionIds` / `allowedWorkspacePaths` 控制可见性。但"启动时把这个子代理加进白名单"并不可靠：agent loop 在 `system-prompt/assemble` 和 `agent/pre-step` **之前**就解析工具可见性（`ctx.tools.resolve`），而子代理在 prompt 被接受后立刻开始第一步——父 Agent 在工具调用里做的工作区 attach 可能输掉这场竞争，导致第一步看不到 `ui_*` 工具。

因此本插件在**串行的 `agent/created` 事件**里（子代理创建期间、prompt 被接受之前）把六个工具定义重新注册进**子代理自己的 agent scope**（`agent.ctx.tools.register(...)`）。工具可见性按 agent scope 解析，所以子代理恰好看到这六个、别的都看不到。这与 Host 给 preset 受限工具使用的 per-agent scoping 是同一机制；scope 随子代理销毁，且不触碰 UI 插件的全局白名单（没有打开 `allowAllSessions: true`）。

由于封装层成了授权边界，`ui_operate` 本身也用同样的三个开关做门禁，默认只允许本插件所在目录；子代理会话永远被拒绝。

### 防递归（四层）

1. `ui_operate` 的 `when` 对 `origin === 'subagent'` 的会话返回 `false`。
2. 即使定义被解析到，`execute()` 对子代理调用方也直接抛错。
3. 子代理 scope 被限制为六个 UI 工具，`ui_operate`（以及 `bash`、`write` 等）全部被遮掉。
4. 启动子代理时传 `maxDepth: 0`，子代理运行时拒绝它再委派。

### 数据安全

- 只接受形如 `shot-YYYYMMDD-HHMMSS-<pid>-<seq>.png` 的文件作为截图，糊涂或恶意的子代理无法借工具结果外泄任意图片。
- 同一 agent 的 `ui_operate` 串行执行（工具未声明并发安全），不会有两个子代理同时操作同一个桌面。
- 超时或调用方中断会取消激活、有界等待清理，并带原因返回 `TIMEOUT`/`ABORTED`。

## 开发

```bash
node --test test/*.test.mjs   # 33 个测试，不连模型
```

- `test/operate.test.mjs` —— 工具 schema、prompt 投递、文本透传、图片块、失败码、超时/取消、步数预算、工作区门禁、配置与 prompt 辅助函数。
- `test/integration.test.mjs` —— 在裸 Cordis context 里挂真实的 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-system-prompt`：六个工具在子代理 scope 解析、`ui_operate`/`bash` 被遮、guard 生效。

临时 profile 安装冒烟（不要动 Web profile）：

```bash
TMP=/tmp/dsh-ui-nl-smoke
mkdir -p "$TMP/profiles/smoke"
# package.json 用 link: 声明两个 bundle，然后：
pnpm install --offline
DSH_HOME="$TMP" dsh --profile smoke --dump-config | sed -n '/dsh-ui-nl/,$p'
```

## 已知限制

- 子代理**只有**六个 UI 工具：不能读文件、不能跑命令、不能给主 Agent 发消息。这是有意为之，所以它的汇报必须自包含。
- 子代理的系统提示仍是 Host 组合的提示（被遮掉的工具段不会被重写），`dsh-ui-automation` 自己的标号图片提示段**不会**挂给子代理；操作规则写在子代理任务 prompt 里。
- 图片依赖子代理模型路由；纯文本路由会以 `MODEL_ROUTE` 快速失败。
- 只封装标号截图契约：没有坐标寻址、没有窗口启动、没有可访问性名称寻址。
- 截图作为 attachment 保存，本插件不清理；`dsh-ui-automation` 的 `keepImages` 只清理它自己的目录。

## License

MIT © 2026 bot-for-imitoy
