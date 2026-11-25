/**
 * operate.test.mjs — unit tests for the natural-language UI wrapper.
 *
 * No model is contacted: a fake subagent activation, a fake attachment store,
 * and a fake LLM registry stand in for the real services. The fake context in
 * `harness.mjs` models the tools registry, the serial `agent/created` event,
 * and the workspace gate.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { buildChildPrompt, IMAGE_MARKER, OPERATE_GUIDANCE } from '../lib/prompt.js'
import { admitScreenshot, parseChildOutput } from '../lib/markers.js'
import { operate } from '../lib/operate.js'
import { readConfig } from '../lib/config.js'
import { createOperateTool } from '../lib/tool.js'
import { createPluginHarness, deferred } from './harness.mjs'

const UI_NAMES = ['ui_screenshot', 'ui_click', 'ui_double_click', 'ui_scroll', 'ui_drag', 'ui_type']

/** Minimal valid 1×1 PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** Create a numbered screenshot file on disk. */
function screenshotFile(name = 'shot-20261125-120000-1234-1.png') {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-ui-nl-test-'))
  const file = path.join(dir, name)
  writeFileSync(file, PNG_1X1)
  return file
}

/** Fake attachment store recording saved screenshots. */
function fakeAttachments() {
  const calls = []
  return {
    calls,
    async saveImage(input) {
      calls.push(input)
      return { id: `att-${calls.length}`, mediaType: input.mediaType, byteLength: input.data.byteLength }
    },
  }
}

/** Fake LLM registry. */
function fakeLlm(modalities) {
  const calls = []
  return {
    calls,
    async resolveModelInfo(provider, model) {
      calls.push({ provider, model })
      return { inputModalities: modalities }
    },
  }
}

/** Tools registered by the fake UI plugin. */
const fakeUiDefinitions = UI_NAMES.map(name => ({ name }))

/** Build `operate()` deps with a controllable activation. */
function operateDeps(overrides = {}) {
  const state = { disposed: 0, started: [], child: undefined }
  const deps = {
    state,
    async startActivation(spec) {
      state.started.push(spec)
      return {
        childId: spec.childId,
        name: 'agent-1',
        messageId: 'message-1',
        result: state.child.promise,
        dispose: async () => { state.disposed += 1 },
      }
    },
    newChildId: () => 'session-child-1',
    registerChild() {},
    releaseChild() {},
    uiDefinitions: () => fakeUiDefinitions,
    buildPrompt: (instruction, maxSteps) => buildChildPrompt({ instruction, maxSteps }),
    preflightModel: async () => {},
    saveImage: async () => undefined,
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  }
  return deps
}

/** Base operate config. */
function operateConfig(overrides = {}) {
  return {
    subagentProvider: 'spawn',
    workspace: '',
    modelProvider: '',
    model: '',
    timeoutMs: 5_000,
    maxSteps: 7,
    attachImages: true,
    enabledSessionIds: '',
    allowedWorkspacePaths: '',
    allowAllSessions: false,
    ...overrides,
  }
}

afterEach(() => {
  // Nothing global to reset: every harness owns its state.
})

describe('tool signature', () => {
  test('只暴露一个工具 ui_operate，参数只有必填的 instruction', async () => {
    const h = await createPluginHarness()
    const tool = h.tool()
    assert.equal(tool.name, 'ui_operate')
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(Object.keys(tool.parameters.properties), ['instruction'])
    assert.equal(tool.parameters.properties.instruction.type, 'string')
    assert.deepEqual(tool.parameters.required, ['instruction'])
    assert.match(tool.description, /natural-language instruction/)
    assert.match(tool.parameters.properties.instruction.description, /natural-language task/)
    // Exactly one registered tool: the six ui_* definitions come from the
    // underlying plugin, not from this wrapper.
    assert.deepEqual(h.registrations.map(entry => entry.definition.name), ['ui_operate'])
  })

  test('空指令被拒绝', async () => {
    const h = await createPluginHarness()
    await assert.rejects(h.invoke('   '), /non-empty natural-language instruction/)
  })
})

describe('subagent delegation', () => {
  test('指令进入子代理 prompt，且以 caller 交付、深度上限 0', async () => {
    const h = await createPluginHarness()
    const child = h.prepareChild()
    const promise = h.invoke('点击「立即领取」')
    child.resolve({ output: [{ type: 'text', text: '点了 #7「立即领取」。' }], stopReason: 'completed' })
    const value = await promise

    assert.equal(value.ok, true)
    const spec = h.activations[0]
    assert.equal(spec.provider, 'spawn')
    assert.equal(spec.delivery, 'caller')
    // Depth 1 admits this child and refuses any grandchild.
    assert.equal(spec.maxDepth, 1)
    assert.match(spec.childId, /^session-/)
    assert.deepEqual(spec.prompt, [{ type: 'text', text: spec.prompt[0].text }])
    assert.ok(spec.prompt[0].text.includes('点击「立即领取」'), '子代理 prompt 必须包含原始指令')
    assert.equal(spec.prompt[0].text.split('User instruction:')[1].includes('点击「立即领取」'), true)
    // The instruction is the last thing the child reads, so it cannot be
    // reinterpreted as operating rules.
    assert.match(spec.prompt[0].text, new RegExp(`---\\n点击「立即领取」\\n---$`))
  })

  test('子代理最终文本原样透传，渲染为单个 text block', async () => {
    const h = await createPluginHarness()
    const child = h.prepareChild()
    const promise = h.invoke('看看界面上有什么')
    child.resolve({ output: [{ type: 'text', text: '界面上有 #1 标题栏、#2 账号输入框、#3「登录」按钮。' }], stopReason: 'completed' })
    const value = await promise

    assert.equal(value.ok, true)
    assert.equal(value.text, '界面上有 #1 标题栏、#2 账号输入框、#3「登录」按钮。')
    assert.equal(value.stopReason, 'completed')
    assert.equal(value.childName, 'agent-1')
    assert.equal(typeof value.elapsedMs, 'number')
    const blocks = h.tool().output.render({ instruction: '看看界面上有什么' }, value)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /界面上有 #1 标题栏/)
  })

  test('子代理看不到 ui_operate：六个 ui_* 工具被加进子代理 scope，且限制白名单不含 ui_operate', async () => {
    const h = await createPluginHarness()
    const child = h.prepareChild()
    const promise = h.invoke('截图')
    child.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
    await promise

    assert.equal(h.childAgents.length, 1)
    const { tools } = h.childAgents[0]
    assert.deepEqual(tools.registrations.map(definition => definition.name), UI_NAMES)
    assert.equal(tools.restrictions.length, 1)
    assert.deepEqual(tools.restrictions[0].allow, UI_NAMES)
    assert.equal(tools.restrictions[0].allow.includes('ui_operate'), false)
  })

  test('子代理会话被 when 拒绝，直接调用 execute 也抛递归错误', async () => {
    const h = await createPluginHarness()
    const childScope = {
      id: 'session-child',
      session: { header: { id: 'session-child', origin: 'subagent' }, meta: {} },
      ctx: {},
    }
    assert.equal(h.when(childScope), false)
    assert.equal(h.when(h.parentAgent), true)
    await assert.rejects(
      h.tool().execute({ instruction: '截图' }, { agent: childScope, signal: new AbortController().signal }),
      /recursion guard/,
    )
  })

  test('子代理完成 notice 不产生额外工具调用：只在 caller 交付时等待结果', async () => {
    const h = await createPluginHarness()
    const child = h.prepareChild()
    const promise = h.invoke('点击 #2')
    child.resolve({ output: [{ type: 'text', text: '完成' }], stopReason: 'completed' })
    await promise
    // One activation per call, and the child's name is reported back.
    assert.equal(h.activations.length, 1)
  })
})

describe('image return', () => {
  test('要求看图时把标号截图保存为 attachment 并生成 image block', async () => {
    const file = screenshotFile()
    const attachments = fakeAttachments()
    const h = await createPluginHarness({ attachments })
    const child = h.prepareChild()
    const promise = h.invoke('看看界面上有什么，并给我一张图')
    child.resolve({
      output: [{ type: 'text', text: `界面里有登录框和「立即领取」按钮。\n${IMAGE_MARKER} ${file}` }],
      stopReason: 'completed',
    })
    const value = await promise

    assert.equal(value.ok, true)
    assert.equal(value.imagePath, file)
    assert.equal(attachments.calls.length, 1)
    assert.equal(attachments.calls[0].mediaType, 'image/png')
    assert.equal(attachments.calls[0].name, path.basename(file))
    assert.ok(Buffer.isBuffer(attachments.calls[0].data))
    assert.equal(value.attachment.id, 'att-1')
    // The marker line never reaches the model as prose.
    assert.equal(value.text.includes(IMAGE_MARKER), false)

    const blocks = h.tool().output.render({ instruction: '看看界面上有什么，并给我一张图' }, value)
    assert.equal(blocks[0].type, 'image')
    assert.equal(blocks[0].attachment.id, 'att-1')
    assert.equal(blocks[1].type, 'text')
    assert.match(blocks[1].text, /image: 已作为图片块附上/)
  })

  test('没有要求图片时不附大图（IMAGE: none）', async () => {
    const attachments = fakeAttachments()
    const h = await createPluginHarness({ attachments })
    const child = h.prepareChild()
    const promise = h.invoke('点击「立即领取」')
    child.resolve({ output: [{ type: 'text', text: `点了 #7「立即领取」。\n${IMAGE_MARKER} none` }], stopReason: 'completed' })
    const value = await promise

    assert.equal(value.ok, true)
    assert.equal(value.attachment, undefined)
    assert.equal(value.imagePath, undefined)
    assert.equal(attachments.calls.length, 0)
    const blocks = h.tool().output.render({ instruction: '点击「立即领取」' }, value)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
  })

  test('attachImages=false 时只返回 imagePath', async () => {
    const file = screenshotFile()
    const attachments = fakeAttachments()
    const h = await createPluginHarness({ attachments, config: { attachImages: false } })
    const child = h.prepareChild()
    const promise = h.invoke('给我图')
    child.resolve({ output: [{ type: 'text', text: `${IMAGE_MARKER} ${file}` }], stopReason: 'completed' })
    const value = await promise
    assert.equal(value.imagePath, file)
    assert.equal(value.attachment, undefined)
    assert.equal(attachments.calls.length, 0)
    const blocks = h.tool().output.render({}, value)
    assert.equal(blocks.length, 1)
    assert.match(blocks[0].text, /read_image/)
  })

  test('只接受标号截图：任意文件路径被拒绝并给出 warning', async () => {
    const h = await createPluginHarness({ attachments: fakeAttachments() })
    const child = h.prepareChild()
    const promise = h.invoke('给我图')
    child.resolve({ output: [{ type: 'text', text: `${IMAGE_MARKER} /etc/passwd` }], stopReason: 'completed' })
    const value = await promise
    assert.equal(value.ok, true)
    assert.equal(value.attachment, undefined)
    assert.equal(value.imagePath, undefined)
    assert.equal(value.warnings.length, 1)
    assert.match(value.warnings[0], /只接受标号截图/)
  })

  test('截图保存失败时退回 imagePath 并告警，不丢结论', async () => {
    const file = screenshotFile()
    const h = await createPluginHarness({
      attachments: { async saveImage() { throw new Error('disk full') } },
    })
    const child = h.prepareChild()
    const promise = h.invoke('给我图')
    child.resolve({ output: [{ type: 'text', text: `结论\n${IMAGE_MARKER} ${file}` }], stopReason: 'completed' })
    const value = await promise
    assert.equal(value.ok, true)
    assert.equal(value.text, '结论')
    assert.equal(value.imagePath, file)
    assert.match(value.warnings[0], /disk full/)
  })
})

describe('failure propagation', () => {
  test('子代理以 error 结束：错误与部分文本一起返回', async () => {
    const h = await createPluginHarness()
    const child = h.prepareChild()
    const promise = h.invoke('点击「立即领取」')
    child.resolve({
      output: [{ type: 'text', text: '已经截图，但模型请求失败。' }],
      stopReason: 'error',
      diagnostic: 'provider returned 500',
    })
    const value = await promise
    assert.equal(value.ok, false)
    assert.equal(value.code, 'CHILD_STOPPED')
    assert.equal(value.error, 'provider returned 500')
    assert.equal(value.text, '已经截图，但模型请求失败。')
    assert.equal(value.stopReason, 'error')
    const blocks = h.tool().output.render({}, value)
    assert.match(blocks[0].text, /✗ ui_operate failed \[CHILD_STOPPED\]/)
    assert.match(blocks[0].text, /provider returned 500/)
    assert.match(blocks[0].text, /已经截图/)
  })

  test('启动失败（provider 不可用）透传原因', async () => {
    const h = await createPluginHarness()
    h.ctx.subagents.startActivation = async () => { throw new Error('subagent provider "spawn" is not registered') }
    // Re-apply so the tool closes over the replaced service.
    const { apply } = await import('../index.js')
    apply(h.ctx, {})
    const registration = h.registrations.find(entry => entry.definition.name === 'ui_operate')
    const value = await registration.definition.execute({ instruction: '截图' }, { agent: h.parentAgent, signal: new AbortController().signal })
    assert.equal(value.ok, false)
    assert.equal(value.code, 'START_FAILED')
    assert.match(value.error, /not registered/)
  })

  test('缺少 dsh-ui-automation 时给出可操作的错误', async () => {
    const h = await createPluginHarness({ uiToolNames: ['ui_screenshot', 'ui_click'] })
    const child = h.prepareChild()
    const value = await h.invoke('截图')
    assert.equal(value.ok, false)
    assert.equal(value.code, 'UI_TOOLS_UNAVAILABLE')
    assert.match(value.error, /dsh-ui-automation/)
    assert.match(value.error, /ui_double_click/)
    // No child was started.
    assert.equal(h.activations.length, 0)
  })

  test('模型不支持图片输入时在启动前失败', async () => {
    const llm = fakeLlm(['text'])
    const h = await createPluginHarness({ llm })
    const value = await h.invoke('截图')
    assert.equal(value.ok, false)
    assert.equal(value.code, 'MODEL_ROUTE')
    assert.match(value.error, /不接受图片输入/)
    assert.equal(h.activations.length, 0)
  })

  test('模型支持图片输入时正常启动', async () => {
    const llm = fakeLlm(['text', 'image'])
    const h = await createPluginHarness({ llm })
    const child = h.prepareChild()
    const promise = h.invoke('截图')
    child.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
    const value = await promise
    assert.equal(value.ok, true)
    assert.deepEqual(llm.calls[0], { provider: 'test-provider', model: 'test-model' })
  })
})

describe('timeout and cancellation', () => {
  test('超时返回 TIMEOUT 并取消激活', async () => {
    const deps = operateDeps()
    deps.state.child = deferred()
    const value = await operate(deps, {
      instruction: '卡住的界面',
      parent: {},
      signal: undefined,
      config: operateConfig({ timeoutMs: 20 }),
    })
    assert.equal(value.ok, false)
    assert.equal(value.code, 'TIMEOUT')
    assert.match(value.error, /20ms/)
    assert.equal(deps.state.disposed, 1)
  })

  test('调用方取消返回 ABORTED 并取消激活', async () => {
    const deps = operateDeps()
    deps.state.child = deferred()
    const controller = new AbortController()
    const promise = operate(deps, {
      instruction: '很慢的界面',
      parent: {},
      signal: controller.signal,
      config: operateConfig({ timeoutMs: 5_000 }),
    })
    setTimeout(() => controller.abort(new Error('user interrupt')), 5)
    const value = await promise
    assert.equal(value.ok, false)
    assert.equal(value.code, 'ABORTED')
    assert.equal(deps.state.disposed, 1)
  })

  test('激活结果 reject 时返回 ACTIVATION_FAILED', async () => {
    const deps = operateDeps()
    deps.state.child = deferred()
    const promise = operate(deps, {
      instruction: '截图',
      parent: {},
      signal: undefined,
      config: operateConfig(),
    })
    deps.state.child.reject(new Error('teardown failed'))
    const value = await promise
    assert.equal(value.ok, false)
    assert.equal(value.code, 'ACTIVATION_FAILED')
    assert.match(value.error, /teardown failed/)
  })
})

describe('step budget', () => {
  test('guard 在预算内放行、超预算拒绝', async () => {
    const h = await createPluginHarness({ config: { maxSteps: 2 } })
    const child = h.prepareChild()
    const promise = h.invoke('多点几下')
    child.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
    await promise
    const { guards } = h.childAgents[0].tools
    assert.equal(guards.length, 1)
    const guard = guards[0]
    assert.equal(guard({ name: 'ui_screenshot' }), undefined)
    assert.equal(guard({ name: 'ui_click' }), undefined)
    const denial = guard({ name: 'ui_click' })
    assert.equal(typeof denial, 'string')
    assert.match(denial, /预算已用完（上限 2 次）/)
    // Non-UI tools are not counted.
    assert.equal(guard({ name: 'bash' }), undefined)
  })
})

describe('tool takeover registration', () => {
  test('默认接管：向 uiAutomationVisibility 注册抑制，卸载时释放', async () => {
    const h = await createPluginHarness({ uiAutomationVisibility: {} })
    assert.equal(h.suppressionCalls.length, 1)
    assert.equal(h.suppressionCalls[0].key, 'ui-nl')
    const applies = h.suppressionCalls[0].applies
    // The predicate is this plugin's own gate.
    assert.equal(applies('session-parent', h.parentAgent), true)
    assert.equal(applies('session-outsider', { id: 'session-outsider', session: { header: { id: 'session-outsider' }, meta: {} } }), false)
    // A subagent never matches the gate, so the six tools stay for the child.
    assert.equal(applies('session-child', { id: 'session-child', session: { header: { origin: 'subagent' }, meta: {} } }), false)
    h.disposeEffects()
    assert.deepEqual(h.releases, ['ui-nl'])
  })

  test('hideUnderlyingTools=false 时不注册抑制', async () => {
    const h = await createPluginHarness({ uiAutomationVisibility: {}, config: { hideUnderlyingTools: false } })
    assert.equal(h.suppressionCalls.length, 0)
  })

  test('没有 uiAutomationVisibility 服务时（旧版 ui-automation）插件照常加载', async () => {
    const h = await createPluginHarness()
    assert.deepEqual(h.registrations.map(entry => entry.definition.name), ['ui_operate'])
    assert.equal(h.suppressionCalls.length, 0)
  })
})

describe('workspace gate', () => {
  test('允许工作区内的会话可见，工作区外不可见', async () => {
    const h = await createPluginHarness({
      workspaces: [{ path: '/tmp/allowed', sessionIds: ['session-ok'] }],
      config: { allowedWorkspacePaths: '/tmp/allowed' },
    })
    const allowed = { id: 'session-ok', session: { header: { id: 'session-ok' }, meta: {} } }
    const denied = { id: 'session-nope', session: { header: { id: 'session-nope' }, meta: {} } }
    assert.equal(h.when(allowed), true)
    assert.equal(h.when(denied), false)
  })

  test('enabledSessionIds 可额外放行', async () => {
    const h = await createPluginHarness({
      workspaces: [],
      config: { enabledSessionIds: 'session-extra, session-other' },
    })
    const extra = { id: 'session-extra', session: { header: { id: 'session-extra' }, meta: {} } }
    assert.equal(h.when(extra), true)
  })

  test('allowAllSessions 全开', async () => {
    const h = await createPluginHarness({ workspaces: [], config: { allowAllSessions: true } })
    const any = { id: 'session-any', session: { header: { id: 'session-any' }, meta: {} } }
    assert.equal(h.when(any), true)
  })

  test('prompt 段只对允许的会话出现', async () => {
    const h = await createPluginHarness({ workspaces: [{ path: '/tmp/allowed', sessionIds: ['session-ok'] }], config: { allowedWorkspacePaths: '/tmp/allowed' } })
    const section = h.sections.find(entry => entry.name === 'ui-nl:operate')
    assert.ok(section !== undefined)
    assert.equal(section.text({ agent: { id: 'session-ok', session: { header: { id: 'session-ok' }, meta: {} } } }), OPERATE_GUIDANCE)
    assert.equal(section.text({ agent: { id: 'session-nope', session: { header: { id: 'session-nope' }, meta: {} } } }), '')
  })
})

describe('config and prompt helpers', () => {
  test('readConfig 归一化并夹紧数值', () => {
    const config = readConfig({ timeoutMs: 1, maxSteps: 9_999, allowAllSessions: 'yes' })
    assert.equal(config.timeoutMs, 5_000)
    assert.equal(config.maxSteps, 500)
    assert.equal(config.allowAllSessions, false)
    assert.equal(config.subagentProvider, 'spawn')
    assert.equal(config.attachImages, true)
    assert.equal(config.hideUnderlyingTools, true)
    assert.equal(readConfig({ attachImages: false }).attachImages, false)
    assert.equal(readConfig({ hideUnderlyingTools: false }).hideUnderlyingTools, false)
    assert.equal(readConfig({ model: 'm', modelProvider: 'p' }).model, 'm')
  })

  test('buildChildPrompt 写清了编号规则、安全边界和图片标记', () => {
    const prompt = buildChildPrompt({ instruction: '点击「立即领取」', maxSteps: 12 })
    assert.match(prompt, /only ones you have/)
    assert.match(prompt, /never invent an element, a coordinate, or a number/)
    assert.match(prompt, /Previous indices expire immediately/)
    assert.match(prompt, /never confirm payments/)
    assert.match(prompt, /at most 12 UI actions/)
    assert.match(prompt, new RegExp(`${IMAGE_MARKER} none`))
    assert.match(prompt, /User instruction:\n---\n点击「立即领取」\n---$/)
  })

  test('parseChildOutput 去掉标记行并取最后一个标记', () => {
    const { text, reported } = parseChildOutput([
      { type: 'text', text: '第一段' },
      { type: 'text', text: `IMAGE: /a/shot-20260101-000000-1-1.png\nIMAGE: /b/shot-20260101-000000-1-2.png` },
    ])
    assert.equal(reported, '/b/shot-20260101-000000-1-2.png')
    assert.equal(text, '第一段')
    assert.equal(parseChildOutput([{ type: 'text', text: 'IMAGE: none' }]).reported, 'none')
    assert.equal(parseChildOutput(undefined).text, '')
  })

  test('admitScreenshot 只接受 shot-*.png 的本地文件', () => {
    const file = screenshotFile()
    assert.deepEqual(admitScreenshot(file), { path: file })
    assert.equal(admitScreenshot('none'), undefined)
    assert.equal(admitScreenshot(undefined), undefined)
    assert.match(admitScreenshot('https://example.com/a.png').reason, /不是本地路径/)
    assert.match(admitScreenshot('/tmp/not-a-shot.png').reason, /只接受标号截图/)
    assert.match(admitScreenshot('/tmp/shot-20260101-000000-1-1.png').reason, /截图不存在/)
  })

  test('renderOperate 错误块包含 code 与 error', () => {
    const tool = createOperateTool({ deps: {}, getConfig: () => ({}), timeoutMs: 1_000 })
    const blocks = tool.output.render({}, { ok: false, code: 'TIMEOUT', error: '超时了' })
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /\[TIMEOUT\]/)
    assert.match(blocks[0].text, /超时了/)
  })
})
