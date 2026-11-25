/**
 * visibility.test.mjs — both plugins in one bare Cordis host.
 *
 * The real `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-system-prompt`,
 * `dsh-ui-automation` and `dsh-ui-nl` plugins are mounted; only the workspace
 * registry, the subagent provider, the attachment store and the LLM registry
 * are fakes. The test proves the takeover contract end to end:
 *
 * - an ordinary Session resolves `ui_operate` and none of the six raw tools;
 * - a child Session resolves the six and not `ui_operate`;
 * - unloading ui-nl restores the six for the ordinary Session;
 * - `hideUnderlyingTools: false` keeps both surfaces;
 * - ui-automation alone is untouched;
 * - an explicit child model route fails fast (`MODEL_ROUTE`) and an inherited
 *   one is only checked for image support.
 *
 * No model and no display are contacted.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { loadShipped } from '../lib/shipped.js'
import { deferred } from './harness.mjs'

const UI_NAMES = ['ui_screenshot', 'ui_click', 'ui_double_click', 'ui_scroll', 'ui_drag', 'ui_type']
const TOP = 'session-top'
const CHILD = 'session-child'

const flush = () => new Promise(resolve => setImmediate(resolve))

/**
 * Mount the real Host services and both plugins.
 *
 * @param {object} [options] host options
 * @param {object} [options.config] ui-nl config overrides
 * @param {object | undefined} [options.llm] fake LLM registry (omitted by default)
 * @param {boolean} [options.withUiNl] mount dsh-ui-nl (default true)
 * @param {boolean} [options.withUiAutomation] mount dsh-ui-automation (default true)
 * @returns {Promise<object>} host
 */
async function createHost(options = {}) {
  const { Context, Service } = await loadShipped('@deepseek-ai/cordis')
  const toolsModule = await loadShipped('@deepseek-ai/dsh-tools')
  const promptModule = await loadShipped('@deepseek-ai/dsh-system-prompt')
  const { createScope } = await loadShipped('@deepseek-ai/dsh-scope')

  // A real directory: both plugins canonicalize their allow-list.
  const workspacePath = mkdtempSync(path.join(tmpdir(), 'dsh-ui-nl-visibility-'))
  const workspaces = [{ path: workspacePath, sessionIds: [TOP] }]
  const activations = []
  const childAgents = []
  let pending = deferred()

  class WorkspaceRegistry extends Service {
    static inject = []
    constructor(ctx) { super(ctx, 'workspaceRegistry') }
    list() { return workspaces }
  }

  class Subagents extends Service {
    static inject = []
    constructor(ctx) { super(ctx, 'subagents') }
    async startActivation(spec) {
      activations.push(spec)
      const child = {
        id: spec.childId,
        session: {
          header: { id: spec.childId, cwd: spec.cwd, origin: 'subagent' },
          meta: { parentSession: spec.parent.id, origin: 'subagent' },
        },
      }
      const scope = createScope(this.ctx, child)
      child.ctx = scope.ctx
      childAgents.push({ agent: child, scope })
      this.ctx.emit('agent/created', { agent: child, source: 'subagent' })
      return {
        childId: spec.childId,
        name: 'agent-1',
        messageId: 'message-1',
        result: pending.promise,
        dispose: async () => {},
      }
    }
  }

  const root = new Context()
  await root.plugin(promptModule.default, {})
  await root.plugin(toolsModule.default, {})
  await root.plugin(WorkspaceRegistry)
  await root.plugin(Subagents)
  if (options.llm !== undefined) root.provide('llm', options.llm)

  if (options.withUiAutomation !== false) {
    await root.plugin(await import('../../dsh-ui-automation-plugin/index.js'), {
      allowedWorkspacePaths: workspacePath,
      allowAllSessions: false,
      ...options.uiAutomationConfig,
    })
  }

  const pluginConfig = {
    allowedWorkspacePaths: workspacePath,
    enabledSessionIds: '',
    allowAllSessions: false,
    timeoutMs: 5_000,
    maxSteps: 40,
    ...options.config,
  }
  const uiNl = options.withUiNl === false
    ? undefined
    : await root.plugin(await import('../index.js'), pluginConfig)
  // `ctx.inject` activates the suppression child asynchronously.
  await flush()

  const top = {
    id: TOP,
    options: { provider: 'test-provider', model: 'test-model' },
    session: { header: { id: TOP, cwd: workspacePath }, requestHeader: () => undefined, meta: {} },
    ctx: root,
  }

  return {
    root,
    top,
    workspacePath,
    activations,
    childAgents,
    uiNl,
    prepareChild() {
      pending = deferred()
      return pending
    },
    async names(agent) {
      const set = await root.tools.resolve({
        agent,
        modelSelection: { provider: 'test-provider', model: 'test-model' },
        signal: new AbortController().signal,
      })
      const names = [...set.view(agent).keys()].sort()
      set.dispose()
      return names
    },
    async invoke(instruction) {
      return await root.tools.get('ui_operate').execute(
        { instruction },
        { agent: top, signal: new AbortController().signal },
      )
    },
  }
}

describe('tool takeover', () => {
  test('顶层会话只看到 ui_operate，看不到 6 个原始工具', async () => {
    const host = await createHost()
    const names = await host.names(host.top)
    assert.deepEqual(names, ['ui_operate'])
  })

  test('子代理解析到 6 个工具、解析不到 ui_operate', async () => {
    const host = await createHost()
    const child = host.prepareChild()
    const promise = host.invoke('看看界面上有什么')
    child.resolve({ output: [{ type: 'text', text: '界面正常。' }], stopReason: 'completed' })
    const value = await promise
    assert.equal(value.ok, true)

    const { agent } = host.childAgents[0]
    const names = await host.names(agent)
    assert.deepEqual(names, [...UI_NAMES].sort())
  })

  test('卸载 ui-nl 后顶层重新看到 6 个工具', async () => {
    const host = await createHost()
    assert.deepEqual(await host.names(host.top), ['ui_operate'])
    await host.uiNl.dispose()
    await flush()
    const names = await host.names(host.top)
    assert.deepEqual(names, [...UI_NAMES].sort())
  })

  test('hideUnderlyingTools=false 时两套工具面都在', async () => {
    const host = await createHost({ config: { hideUnderlyingTools: false } })
    const names = await host.names(host.top)
    assert.deepEqual(names, [...UI_NAMES, 'ui_operate'].sort())
  })

  test('单独安装 ui-automation（没有 ui-nl）时 6 个工具照常可见', async () => {
    const host = await createHost({ withUiNl: false })
    const names = await host.names(host.top)
    assert.deepEqual(names, [...UI_NAMES].sort())
  })

  test('门禁之外的顶层会话保留 6 个工具（抑制按范围生效）', async () => {
    // ui-automation opens every session, ui-nl only this workspace: the
    // outsider keeps the raw tools instead of losing both surfaces.
    const host = await createHost({ uiAutomationConfig: { allowAllSessions: true } })
    const outsider = {
      id: 'session-outsider',
      session: { header: { id: 'session-outsider' }, meta: {} },
      ctx: host.root,
    }
    const names = await host.names(outsider)
    assert.deepEqual(names, [...UI_NAMES].sort())
    assert.equal(names.includes('ui_operate'), false)
  })
})

describe('child model setting', () => {
  /** Fake LLM registry. */
  function fakeLlm({ models = [{ id: 'image-model' }], resolve, providers } = {}) {
    return {
      listProviders() {
        return providers ?? [{ id: 'test-provider', name: 'Test Provider' }]
      },
      async listModels() {
        return models
      },
      resolveModelInfo: resolve ?? (async () => ({ inputModalities: ['text', 'image'] })),
    }
  }

  test('合法显式路由通过预检并启动子代理', async () => {
    const host = await createHost({ llm: fakeLlm(), config: { modelProvider: 'test-provider', model: 'image-model' } })
    const child = host.prepareChild()
    const promise = host.invoke('截图')
    child.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
    const value = await promise
    assert.equal(value.ok, true)
    assert.deepEqual(host.activations[0].agentOptions, { provider: 'test-provider', model: 'image-model' })
  })

  test('不存在的 provider/model 快速失败 MODEL_ROUTE，不启动子代理', async () => {
    const llm = fakeLlm({
      providers: [{ id: 'test-provider', name: 'Test Provider' }],
      models: [{ id: 'image-model' }],
      resolve: async () => { throw new Error('unknown model "nope"') },
    })
    const host = await createHost({ llm, config: { modelProvider: 'test-provider', model: 'nope' } })
    const value = await host.invoke('截图')
    assert.equal(value.ok, false)
    assert.equal(value.code, 'MODEL_ROUTE')
    assert.match(value.error, /不存在或不可用/)
    assert.match(value.error, /test-provider: image-model/)
    assert.equal(host.activations.length, 0)
  })

  test('模型不在 provider 列表里也快速失败', async () => {
    const host = await createHost({ llm: fakeLlm(), config: { modelProvider: 'test-provider', model: 'unlisted' } })
    const value = await host.invoke('截图')
    assert.equal(value.ok, false)
    assert.equal(value.code, 'MODEL_ROUTE')
    assert.match(value.error, /不在该 provider 的模型列表里/)
    assert.equal(host.activations.length, 0)
  })

  test('留空继承：路由解析失败只告警，不阻塞', async () => {
    const llm = fakeLlm({ resolve: async () => { throw new Error('not resolvable yet') } })
    const host = await createHost({ llm })
    const child = host.prepareChild()
    const promise = host.invoke('截图')
    child.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
    const value = await promise
    assert.equal(value.ok, true)
    assert.equal(host.activations.length, 1)
    // Inheritance passes no agentOptions at all.
    assert.equal(host.activations[0].agentOptions, undefined)
  })

  test('模型只接受文本输入时 MODEL_ROUTE', async () => {
    const host = await createHost({
      llm: fakeLlm({ resolve: async () => ({ inputModalities: ['text'] }) }),
      config: { modelProvider: 'test-provider', model: 'image-model' },
    })
    const value = await host.invoke('截图')
    assert.equal(value.ok, false)
    assert.equal(value.code, 'MODEL_ROUTE')
    assert.match(value.error, /不接受图片输入/)
    assert.equal(host.activations.length, 0)
  })

  test('显式路由但 llm 服务不可用：MODEL_ROUTE', async () => {
    const host = await createHost({ config: { modelProvider: 'test-provider', model: 'image-model' } })
    const value = await host.invoke('截图')
    assert.equal(value.ok, false)
    assert.equal(value.code, 'MODEL_ROUTE')
    assert.match(value.error, /llm 服务不可用/)
    assert.equal(host.activations.length, 0)
  })

  test('只设 model 不设 modelProvider 时加载失败', async () => {
    await assert.rejects(
      createHost({ config: { model: 'image-model', modelProvider: '' } }),
      /model 需要和 modelProvider 成对设置/,
    )
  })
})
