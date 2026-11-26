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

本 bundle **依赖 `dsh-ui-automation`**，自身不提供任何界面控制能力。请先安装并启用它：截图标号、AT-SPI 元素枚举和 XTEST 输入都由它完成。下面的"工具接管"需要 **2.2.0 或更新**；更老版本上 `ui_operate` 仍可用，但六个原始工具依旧可见（缺少抑制服务，因此不会隐藏）。

```bash
# 在已经内置该插件的 profile 里，或作为 bundle 安装
dsh plugin --profile <profile> add link:/path/to/dsh-ui-automation-plugin
```

然后安装本 bundle —— 可以从 GitHub 装，也可以从本地目录装：

```bash
dsh plugin --profile <profile> add github:bot-for-imitoy/dsh-ui-nl
# 或：dsh plugin --profile <profile> add link:/path/to/dsh-ui-nl
```

（Plugins → Add plugin → 本地目录、或用 `plugin_manager` 的 `install_bundle` 指向本目录绝对路径也可以。）依赖在调用时校验：六个 `ui_*` 工具缺任一，`ui_operate` 返回 `UI_TOOLS_UNAVAILABLE`，并且不会启动子代理。

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
    hideUnderlyingTools: true # 接管底层 6 个 ui_* 工具（见下）；false 保留两套工具面
    enabledSessionIds: ''     # 额外允许调用 ui_operate 的会话 ID
    allowedWorkspacePaths: '' # 允许调用 ui_operate 的工作区；留空 = 本插件目录
    allowAllSessions: false   # 对所有会话开放（它会驱动真实桌面）
```

`timeoutMs` 同时会在加载时写入工具定义的 pipeline 上限；修改后请重启 profile。

### 子代理模型设置

模型用**两个明确的字符串字段** `modelProvider` 与 `model` 配置（profile 的 `cordis.patch.yml`，或 **Plugins** 里本 bundle 的页面）：

```yaml
- id: ui-nl
  name: 'dsh-ui-nl'
  config:
    modelProvider: new-api          # LLM 注册表声明的 provider id
    model: deepseek-v4.1-flash-1017 # 支持图片输入的模型 id
```

- **留空即继承。** 两个都留空（默认）时子代理使用调用方当前路由，单模型部署无需配置。
- **成对设置。** 只设 `model` 不设 `modelProvider` 会在加载时失败；二者组成一条路由。
- **启动子代理前校验。** 显式配置的路由会先 `llm.resolveModelInfo(provider, model)`，再用 `llm.listModels(provider)` 检查是否在列；provider 不存在、模型未被该 provider 声明、或路由无法解析时立即返回 `MODEL_ROUTE`（错误里带当前可用路由），不会启动子代理。路由能解析但声明只接受文本时同样 `MODEL_ROUTE`，因为标号截图是以图片块送达子代理的。
- **继承路由只校验图片能力**；继承路由解析失败只记 warning 继续，因为调用方自己的路由在首次请求前可能还不可解析。

**为什么不是下拉？** DSH Web 客户端不会按插件 schema 生成表单：settings 服务只暴露 volatile 字段表单，而没有任何随包客户端按 schema 建页面；官方配置页是手写的浏览器 bundle，第三方插件不允许以模块方式引入。做模型下拉需要额外的 client 半 + 目录 Remote 方法；本 bundle 有意采用文档化的字段形态，并配合快速失败与错误里的可用路由。Host 侧 `Config` schema 仍声明这两个字段，将来有按 schema 渲染的客户端时它们就是普通文本字段。
## 子代理为什么能拿到工具（以及为什么不走工作区白名单）

`dsh-ui-automation` 用 `allowAllSessions` / `enabledSessionIds` / `allowedWorkspacePaths` 控制可见性。但"启动时把这个子代理加进白名单"并不可靠：agent loop 在 `system-prompt/assemble` 和 `agent/pre-step` **之前**就解析工具可见性（`ctx.tools.resolve`），而子代理在 prompt 被接受后立刻开始第一步——父 Agent 在工具调用里做的工作区 attach 可能输掉这场竞争，导致第一步看不到 `ui_*` 工具。

因此本插件在**串行的 `agent/created` 事件**里（子代理创建期间、prompt 被接受之前）把六个工具定义重新注册进**子代理自己的 agent scope**（`agent.ctx.tools.register(...)`）。工具可见性按 agent scope 解析，所以子代理恰好看到这六个、别的都看不到。这与 Host 给 preset 受限工具使用的 per-agent scoping 是同一机制；scope 随子代理销毁，且不触碰 UI 插件的全局白名单（没有打开 `allowAllSessions: true`）。

由于封装层成了授权边界，`ui_operate` 本身也用同样的三个开关做门禁，默认只允许本插件所在目录；子代理会话永远被拒绝。

### 防递归（四层）

1. `ui_operate` 的 `when` 对 `origin === 'subagent'` 的会话返回 `false`。
2. 即使定义被解析到，`execute()` 对子代理调用方也直接抛错。
3. 子代理 scope 被限制为六个 UI 工具，`ui_operate`（以及 `bash`、`write` 等）全部被遮掉。
4. 启动子代理时传 `maxDepth: 1`：运行时允许这个子代理（深度 1），但拒绝它再创建孙代理。

### 接管底层工具（`hideUnderlyingTools`）

安装本 bundle 后，操作桌面应该只有一条明显路径。`hideUnderlyingTools: true`（默认）时，`apply()` 通过 `dsh-ui-automation` 2.2.0 发布的 `uiAutomationVisibility` 服务抑制底层工具面：

```js
// dsh-ui-nl，注册在插件 fiber 拥有的 effect 里
const release = ctx.uiAutomationVisibility.suppress('ui-nl', (sessionId, agent) => gate.allowed(sessionId, agent))
```

- 抑制生效时，能调用 `ui_operate` 的会话不再解析到 `ui_screenshot`/`ui_click`/`ui_double_click`/`ui_scroll`/`ui_drag`/`ui_type`，也看不到标号图片提示段；它看到的唯一 UI 工具是 `ui_operate`。
- 子代理会话在 `dsh-ui-automation` 内部被豁免（本插件的门禁也拒绝子代理），所以子代理仍能解析到六个工具——它们是通过每个子代理自己的 scope 授权拿到的，不依赖白名单。
- 判定谓词就是本插件自己的门禁：`allowedWorkspacePaths` / `enabledSessionIds` 之外的会话保留原始工具，不会两套都没有。
- 抑制属于本插件 fiber：禁用或卸载 `dsh-ui-nl` 会释放，六个工具对所有允许的会话恢复可见。单独安装 `dsh-ui-automation` 行为不变。

**回滚方式：** 在 `ui-nl` 行设置 `hideUnderlyingTools: false`（两套工具面都可见，即 0.2.0 之前的行为），或移除 `dsh-ui-nl`。若 `dsh-ui-automation` 低于 2.2.0，抑制服务不存在，接管子 fiber 不会激活，两套工具面都保持可见。

### 数据安全

- 只接受形如 `shot-YYYYMMDD-HHMMSS-<pid>-<seq>.png` 的文件作为截图，糊涂或恶意的子代理无法借工具结果外泄任意图片。
- 同一 agent 的 `ui_operate` 串行执行（工具未声明并发安全），不会有两个子代理同时操作同一个桌面。
- 超时或调用方中断会取消激活、有界等待清理，并带原因返回 `TIMEOUT`/`ABORTED`。

## 开发

```bash
node --test test/*.test.mjs   # 49 个测试，不连模型
```

- `test/operate.test.mjs` —— 工具 schema、prompt 投递、文本透传、图片块、失败码、超时/取消、步数预算、工作区门禁、接管注册、配置与 prompt 辅助函数。
- `test/integration.test.mjs` —— 在裸 Cordis context 里挂真实的 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-system-prompt`：六个工具在子代理 scope 解析、`ui_operate`/`bash` 被遮、guard 生效。
- `test/visibility.test.mjs` —— **两个真插件**挂进同一个裸 Cordis 宿主：顶层只解析到 `ui_operate`，子代理只解析到六个工具，卸载 ui-nl 后六个工具恢复，`hideUnderlyingTools: false` 两套都在，门禁外的会话保留原始工具；并覆盖子代理模型的全部情形（合法路由、不存在的 provider/model、不在列表的模型、纯文本路由、llm 服务缺失、只设 `model`）。

### 真实模型端到端

下面是真正跑通的（非桩）端到端：临时 Xvfb + 私有 D-Bus + GTK3 fixture，临时 profile（`/tmp/dsh-ui-nl-e2e`）复用本机模型路由与凭据库，一句自然语言：

```
dsh --profile e2e headless "看看界面上有什么，并给我一张图"
```

结果（exit 0）：主 Agent 调用 `ui_operate`；子代理对 `:150` 截图（`shot-20261125-064507-202324-1.png`，582×466，6 个编号目标），描述 fixture，工具结果携带 `[{type:'image', attachment:{id:'sha256:accc…', mediaType:'image/png'}}, {type:'text', …}]`；主 Agent 随后汇报了编号控件与状态行。子代理会话（记录 `ui_screenshot` 的图片块）和主会话（记录 `ui_operate` 返回同一 attachment）都是证据；这次运行还抓出了 `lib/operate.js` 的 `maxDepth` 错误（传 `0` 会拒绝子代理本身，应为 `1`：允许子代理、拒绝孙代理），已修复。注意临时 profile 对两个插件开了 `allowAllSessions: true`，**因为它的 display 是一次性 Xvfb**；门禁本身由上面的测试覆盖。

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
- 模型选择是配置字段对而不是下拉，原因见[子代理模型设置](#子代理模型设置)。
- 子代理的系统提示仍是 Host 组合的提示（被遮掉的工具段不会被重写），`dsh-ui-automation` 自己的标号图片提示段**不会**挂给子代理；操作规则写在子代理任务 prompt 里。
- 图片依赖子代理模型路由；纯文本路由会以 `MODEL_ROUTE` 快速失败。
- 只封装标号截图契约：没有坐标寻址、没有窗口启动、没有可访问性名称寻址。
- 截图作为 attachment 保存，本插件不清理；`dsh-ui-automation` 的 `keepImages` 只清理它自己的目录。

## License

MIT © 2026 bot-for-imitoy
