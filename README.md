# dsh-ui-nl

English | [中文](README.zh-CN.md)

Natural-language UI operation for [DeepSeek Harness](https://github.com/deepseek-ai/dsh). It exposes **one** tool, `ui_operate`, which hands a plain-language instruction to a **child subagent** that owns the numbered-image tools of [`dsh-ui-automation`](https://github.com/bot-for-imitoy/dsh-ui-automation). The child decides its own steps — screenshot → act by index → re-screenshot to verify — and reports back in text; when the instruction asks to see the screen, the newest numbered screenshot comes back as an image block.

```
main agent ──ui_operate({instruction})──▶ child subagent
                                           ├─ ui_screenshot
                                           ├─ ui_click / ui_double_click
                                           ├─ ui_scroll / ui_drag / ui_type
                                           └─ (verify with the next image)
main agent ◀── report text (+ IMAGE block when asked) ──┘
```

## Dependency (install this first)

This bundle **depends on `dsh-ui-automation`** and provides no UI control of its own. Install and enable it first: it is the plugin that takes the numbered screenshot, enumerates AT-SPI elements, and performs XTEST input. Version **2.2.0 or newer** is required for the tool takeover below; with an older version `ui_operate` still works, but the six raw tools stay visible too (the suppression service is absent, so nothing is hidden).

```bash
# from a profile that already ships the plugin, or install it as a bundle
dsh plugin --profile <profile> add link:/path/to/dsh-ui-automation-plugin
```

Then install this bundle — from GitHub, or from a local checkout:

```bash
dsh plugin --profile <profile> add github:bot-for-imitoy/dsh-ui-nl
# or: dsh plugin --profile <profile> add link:/path/to/dsh-ui-nl
```

(Plugins → Add plugin → local directory and `plugin_manager` `install_bundle` work too.) The dependency is checked at call time: if any of the six `ui_*` tools is missing, `ui_operate` returns `UI_TOOLS_UNAVAILABLE` and starts nothing.

Linux only (X11/XTEST). The child's model must accept image input, because a screenshot reaches it as an image block; `ui_operate` preflights the route and fails with `MODEL_ROUTE` when the resolved model declares text-only input.

## Tool

### `ui_operate`

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `instruction` | string | yes | The complete natural-language task for the UI subagent, in the user's language: what to look at, what to click or type (by visible text), and whether an image of the screen is wanted. |

Result value (JSON):

```jsonc
{
  "ok": true,
  "text": "点了 #7「立即领取」，界面弹出「领取成功」。",
  "childId": "session-…",
  "childName": "agent-1",
  "stopReason": "completed",
  "imagePath": "/…/screenshots/shot-20261125-120000-1234-1.png", // when the child reported one
  "attachment": { "id": "…", "mediaType": "image/png" },          // when attachImages is on
  "warnings": [],
  "elapsedMs": 61234
}
```

Failures use `ok: false` plus `code` and `error`:

| `code` | Meaning |
|---|---|
| `UI_TOOLS_UNAVAILABLE` | `dsh-ui-automation` is not installed/enabled (message names the missing tools) |
| `MODEL_ROUTE` | the child's model route rejects image input |
| `START_FAILED` | the subagent provider failed to start the child |
| `CHILD_STOPPED` | the child ended with `error`/`aborted`/`max-tokens`/`refusal`; `error` carries its diagnostic |
| `ACTIVATION_FAILED` | the activation result rejected (teardown failure) |
| `TIMEOUT` | the child did not finish within `timeoutMs`; it was cancelled |
| `ABORTED` | the caller cancelled the tool call |

Rendering puts the image block first and the report second; the report always contains `imagePath`, so a text-only surface still has the evidence.

## Usage

The main agent only needs to phrase the task:

- **Look and show me** — `ui_operate({ instruction: "看看界面上有什么，并给我一张图" })` → the child takes `ui_screenshot`, describes the numbered elements, and ends with `IMAGE: <path>`; the tool result carries that PNG as an image block and the description as text.
- **Click by visible name** — `ui_operate({ instruction: "在当前的浏览器窗口里点击「立即领取」" })` → the child screenshots, finds the element whose label is 「立即领取」, clicks its index, screenshots again to verify, and reports “点了 #7「立即领取」，界面变成…”. No image is attached because the instruction did not ask for one.
- **Type into a field** — `ui_operate({ instruction: "在搜索框里输入「Overwatch 2」并回车，然后告诉我结果列表的前三项" })` → `ui_type` with `text`/`keys`, then verification screenshots, then a text report.
- **Multi-step** — keep each call to one outcome and call again with what you learned; the child's report is the input for the next instruction.

The child never runs shell commands, never edits files, and never starts another agent: it sees exactly the six numbered-image tools (`tools.restrict({ allow: [...] })` on its agent scope), and its UI action budget is bounded by `maxSteps`.

## Configuration

```yaml
- id: ui-nl
  name: 'dsh-ui-nl'
  config:
    subagentProvider: spawn   # ctx.subagents provider used to start the child
    workspace: ''             # child cwd; '' inherits the caller's directory (does not affect visibility)
    modelProvider: ''         # child LLM provider; set with model, '' inherits the caller's
    model: ''                 # child LLM model (must accept image input)
    timeoutMs: 180000         # total budget per call, 5000–1800000; TIMEOUT cancels the child
    maxSteps: 40              # UI tool calls the child may make before the guard refuses, 1–500
    attachImages: true        # store the reported screenshot and return an image block
    hideUnderlyingTools: true # take the six ui_* tools over (see below); false keeps both surfaces
    enabledSessionIds: ''     # extra session ids allowed to call ui_operate
    allowedWorkspacePaths: '' # workspaces allowed to call ui_operate; '' = this plugin's directory
    allowAllSessions: false   # open ui_operate to every session (it drives the real desktop)
```

`timeoutMs` is also baked into the tool definition's pipeline deadline at load time; restart the profile after changing it.

### The child model setting

The model is chosen with **two explicit string fields**, `modelProvider` and `model`, in the
bundle's configuration (profile `cordis.patch.yml`, or the bundle's page in **Plugins**):

```yaml
- id: ui-nl
  name: 'dsh-ui-nl'
  config:
    modelProvider: new-api          # a provider id the LLM registry advertises
    model: deepseek-v4.1-flash-1017 # a model id that accepts image input
```

- **Empty means inherit.** Leaving both empty (the default) starts the child on the caller's
  current route, so a single-model deployment needs no configuration.
- **Both or neither.** Setting `model` without `modelProvider` fails at load; the pair is written
  as a route.
- **Validated before the child starts.** An explicitly configured route is resolved with
  `llm.resolveModelInfo(provider, model)` and checked against `llm.listModels(provider)`; a
  missing provider, a model the provider does not advertise, or an unresolvable route returns
  `MODEL_ROUTE` immediately — with the currently available routes in the message — and starts no
  child. A route that resolves but declares text-only input also fails with `MODEL_ROUTE`, because
  the numbered screenshot reaches the child as an image block.
- **An inherited route is only checked for image support**, and an unresolvable inherited route
  logs a warning and proceeds, because the caller's own route may not be resolvable before its
  first request.

**Why not a dropdown?** The DSH Web client renders no form from a plugin's schema: the settings
service exposes volatile-field forms, but no shipped client builds pages from the schema, and the
official configuration pages are hand-written browser bundles whose modules third-party plugins
must not import. A model picker therefore needs a custom client half plus a catalog Remote method;
this bundle deliberately ships the documented field form instead, with fail-fast validation and the
available routes in the error. The Host-side `Config` schema still declares both fields, so a
future client that renders schemas shows them as ordinary text fields.

## How the child gets the tools (and why not through the workspace allow-list)

`dsh-ui-automation` gates its tools with `allowAllSessions` / `enabledSessionIds` / `allowedWorkspacePaths`. Granting a freshly spawned child through that gate is not deterministic: the agent loop resolves tool visibility (`ctx.tools.resolve`) before `system-prompt/assemble` and before `agent/pre-step`, and the child's first step starts right after its prompt is accepted — a workspace attach made from the parent's tool call can lose that race and leave step 1 without `ui_*` tools.

This plugin therefore **re-registers the six definitions into the child's own agent scope** in the serial `agent/created` event (`agent.ctx.tools.register(...)`), which runs during child creation, before the prompt is accepted. Tool visibility is resolved by agent scope, so the child sees exactly those six and nothing else. This is the same per-agent scoping the Host uses for preset-restricted tools; the child's scope is disposed with the child, and the UI plugin's global allow-list is left untouched (no `allowAllSessions: true`).

Because the wrapper becomes the authorization boundary, `ui_operate` itself is gated by the same three knobs, defaulting to this plugin's own directory. Subagent sessions are always refused.

### Recursion prevention (four layers)

1. `ui_operate`'s `when` returns `false` for any session whose header `origin` is `subagent`.
2. `execute()` throws for a subagent caller even if the definition were somehow resolved.
3. The child's scope is restricted to the six UI tools, so `ui_operate` (and `bash`, `write`, …) are masked.
4. The activation is started with `maxDepth: 1`, so the subagent runtime admits this child (depth 1) and refuses any grandchild it might try to start.

### Taking the six tools over (`hideUnderlyingTools`)

Installing this bundle should leave one obvious way to drive the desktop. With
`hideUnderlyingTools: true` (the default), `apply()` suppresses the underlying surface through the
`uiAutomationVisibility` service that `dsh-ui-automation` 2.2.0 publishes:

```js
// dsh-ui-nl, inside an effect owned by the plugin fiber
const release = ctx.uiAutomationVisibility.suppress('ui-nl', (sessionId, agent) => gate.allowed(sessionId, agent))
```

- While the suppression is active, a Session that may call `ui_operate` no longer resolves
  `ui_screenshot`/`ui_click`/`ui_double_click`/`ui_scroll`/`ui_drag`/`ui_type`, nor the
  numbered-image prompt section. The only UI tool it sees is `ui_operate`.
- Subagent Sessions are exempt inside `dsh-ui-automation` (and this plugin's own gate refuses
  them), so the child still resolves the six tools — it receives them as an explicit per-agent
  scope grant, not through the allow-list.
- The predicate is this plugin's own gate, so a Session outside `allowedWorkspacePaths` /
  `enabledSessionIds` keeps the raw tools instead of losing both surfaces.
- The suppression belongs to this plugin's fiber: disabling or unloading `dsh-ui-nl` releases it,
  and the six tools come back for every allow-listed Session. `dsh-ui-automation` alone is
  unchanged.

**Rolling back:** set `hideUnderlyingTools: false` on the `ui-nl` row (both surfaces visible, the
pre-0.2.0 behavior), or remove `dsh-ui-nl`. With `dsh-ui-automation` older than 2.2.0 the
service is absent, the takeover child never activates, and both surfaces stay visible.

### Data safety

- Only files named `shot-YYYYMMDD-HHMMSS-<pid>-<seq>.png` are admitted as screenshots, so a confused child cannot exfiltrate an arbitrary image through the tool result.
- `ui_operate` calls are serialized per agent (the tool declares no concurrency safety), so two children never drive the same desktop at once.
- A timeout or caller interrupt cancels the activation, waits (bounded) for teardown, and returns `TIMEOUT`/`ABORTED` with the reason.

## Development

```bash
node --test test/*.test.mjs   # 49 tests, no model contacted
```

- `test/operate.test.mjs` — tool schema, prompt delivery, text passthrough, image blocks, failure codes, timeout/cancel, step budget, workspace gate, takeover registration, config/prompt helpers.
- `test/integration.test.mjs` — the real `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-system-prompt` services in a bare Cordis context: the six tools resolve in the child's scope, `ui_operate`/`bash` are masked, and the guard fires.
- `test/visibility.test.mjs` — **both real plugins** in one bare Cordis host: an ordinary Session resolves only `ui_operate`, a child resolves only the six, unloading ui-nl restores the six, `hideUnderlyingTools: false` keeps both surfaces, an out-of-gate Session keeps the raw tools, and every child-model case (valid route, unknown provider/model, unlisted model, text-only route, missing LLM service, `model` without `modelProvider`) is asserted.

### Real-model end-to-end

The run below is a real, non-stubbed end-to-end: throw-away Xvfb + private D-Bus + the GTK3
fixture, a temporary profile (`/tmp/dsh-ui-nl-e2e`) reusing the machine's model route and
credential store, and one natural-language instruction:

```
dsh --profile e2e headless "看看界面上有什么，并给我一张图"
```

Result (exit 0): the main agent called `ui_operate`; the child subagent screenshotted display
`:150` (`shot-20261125-064507-202324-1.png`, 582×466, six numbered targets), described the
fixture, and the tool result carried `[{type:'image', attachment:{id:'sha256:accc…', mediaType:'image/png'}}, {type:'text', …}]`;
the main agent then reported the numbered controls and the status line. Both the child session
(logged `ui_screenshot` with the image block) and the main session (logged `ui_operate` returning
that same attachment) are the evidence; the raw run failed before the `maxDepth` fix in
`lib/operate.js` (`0` refuses the child itself, `1` refuses grandchildren), which this test caught.
Note the temporary profile sets `allowAllSessions: true` on both plugins **because its display is
a throw-away Xvfb**; the gate itself is covered by the tests above.

Install smoke test in a throw-away profile (never the Web profile):

```bash
TMP=/tmp/dsh-ui-nl-smoke
mkdir -p "$TMP/profiles/smoke"
# package.json with link: deps for both bundles, then:
pnpm install --offline
DSH_HOME="$TMP" dsh --profile smoke --dump-config | sed -n '/dsh-ui-nl/,$p'
```

## Known limitations

- The child gets **only** the six UI tools; it cannot read files, run commands, or message you. That is deliberate, and it means the report must be self-contained.
- The model choice is a configuration field pair, not a dropdown, for the reason in [The child model setting](#the-child-model-setting).
- The child's system prompt is still the host composition's prompt (tool sections for masked tools are not rewritten), so `dsh-ui-automation`'s own numbered-image prompt section is *not* mounted for the child; the operating rules live in the child task prompt instead.
- Image support depends on the child's model route; a text-only route fails fast with `MODEL_ROUTE`.
- Only the numbered-screenshot contract is wrapped: no coordinate addressing, no window launching, no accessibility-name addressing.
- Screenshots are stored as attachments and never pruned by this plugin; `dsh-ui-automation`'s `keepImages` prunes its own directory.

## License

MIT © 2026 bot-for-imitoy
