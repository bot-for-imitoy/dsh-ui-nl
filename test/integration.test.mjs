/**
 * integration.test.mjs — the scoping story against the real services.
 *
 * A bare Cordis context with the real `@deepseek-ai/dsh-tools` and
 * `@deepseek-ai/dsh-system-prompt` services stands in for the Host. The six
 * numbered-image tools are registered globally behind a workspace gate (as
 * `dsh-ui-automation` does), and this plugin composes each child into its own
 * agent scope. The test proves the two claims the design rests on:
 *
 * - a child that the global gate refuses still sees the six tools, because they
 *   are registered into the child's own scope;
 * - a child never sees `ui_operate` (restricted away) and the step guard
 *   enforces the budget.
 *
 * No model is contacted: the fake provider emits `agent/created` and settles a
 * ready-made result.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deferred } from './harness.mjs'
import { loadShipped } from '../lib/shipped.js'

const UI_NAMES = ['ui_screenshot', 'ui_click', 'ui_double_click', 'ui_scroll', 'ui_drag', 'ui_type']

/**
 * Mount a minimal Host and return its services plus helpers.
 *
 * @param {object} [options] host options
 * @param {string} [options.allowedSession] session id the fake UI plugin admits
 * @param {number} [options.maxSteps] step budget
 * @returns {Promise<object>} host
 */
async function createHost(options = {}) {
  const { Context, Service } = await loadShipped('@deepseek-ai/cordis')
  const toolsModule = await loadShipped('@deepseek-ai/dsh-tools')
  const promptModule = await loadShipped('@deepseek-ai/dsh-system-prompt')
  const { createScope } = await loadShipped('@deepseek-ai/dsh-scope')

  const allowedSession = options.allowedSession ?? 'session-parent'
  const workspaces = [{ path: process.cwd(), sessionIds: [allowedSession] }]
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
      // The Agent object is the scope key, exactly as the agent registry does
      // it: tool visibility is resolved by the agent identity.
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

  // The fake UI plugin: six global tools behind the workspace gate.
  for (const name of UI_NAMES) {
    root.tools.register({
      name,
      description: `${name} (fake ui-automation)`,
      parameters: {},
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: name }] },
    }, { when: ({ agent }) => agent?.id === allowedSession })
  }
  // Another global tool that must be masked for the child.
  root.tools.register({
    name: 'bash',
    description: 'fake bash',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
  })

  const plugin = await import('../index.js')
  assert.equal(typeof root.plugin, 'function')
  await root.plugin(plugin, {
    allowedWorkspacePaths: '',
    enabledSessionIds: '',
    allowAllSessions: false,
    maxSteps: options.maxSteps ?? 40,
    timeoutMs: 5_000,
  })

  const parent = {
    id: allowedSession,
    options: { provider: 'test-provider', model: 'test-model' },
    session: { header: { id: allowedSession, cwd: process.cwd() }, requestHeader: () => undefined, meta: {} },
    ctx: root,
  }

  return {
    root,
    parent,
    activations,
    childAgents,
    prepareChild() {
      pending = deferred()
      return pending
    },
    async invoke(instruction) {
      return await root.tools.get('ui_operate').execute({ instruction }, { agent: parent, signal: new AbortController().signal })
    },
    admitted(agent) {
      return root.tools.resolve({ agent, modelSelection: { provider: 'test-provider', model: 'test-model' }, signal: new AbortController().signal })
    },
  }
}

describe('real tools service scoping', () => {
  test('子代理通过自己的 scope 拿到 6 个 ui_*，父代理看不到这条路径', async () => {
    const host = await createHost()
    // The parent passes the gate but the underlying UI plugin's global gate is
    // also open for it, so both the global and the scoped registrations show.
    const parentSet = await host.admitted(host.parent)
    assert.equal(parentSet.view(host.parent).has('ui_operate'), true)
    assert.equal(parentSet.view(host.parent).has('ui_screenshot'), true)
    parentSet.dispose()

    const child = host.prepareChild()
    const promise = host.invoke('看看界面上有什么')
    child.resolve({ output: [{ type: 'text', text: '界面正常。' }], stopReason: 'completed' })
    const value = await promise
    assert.equal(value.ok, true)
    assert.equal(value.text, '界面正常。')

    const { agent: childAgent, scope } = host.childAgents[0]
    const childSet = await host.admitted(childAgent)
    const names = [...childSet.view(childAgent).keys()].sort()
    assert.deepEqual(names, [...UI_NAMES].sort(), '子代理只看见 6 个 ui_* 工具')
    assert.equal(childSet.view(childAgent).has('ui_operate'), false)
    assert.equal(childSet.view(childAgent).has('bash'), false)
    childSet.dispose()

    // The child scope really owns the six registrations (not the global layer,
    // whose `when` refuses the child). Scopes are keyed by the Agent object.
    assert.equal(host.root.tools.get('ui_screenshot', childAgent) !== undefined, true)
    assert.equal(host.root.tools.get('ui_operate', childAgent), undefined)
    assert.equal(host.root.tools.get('ui_operate', host.parent) !== undefined, true)
    assert.equal(scope.ctx, childAgent.ctx)
  })

  test('子代理的 step guard 在真实 tools 服务上生效', async () => {
    const host = await createHost({ maxSteps: 1 })
    const child = host.prepareChild()
    const promise = host.invoke('连点')
    child.resolve({ output: [{ type: 'text', text: 'ok' }] , stopReason: 'completed' })
    await promise
    const { agent: childAgent } = host.childAgents[0]
    const call = name => ({ name, arguments: {}, agent: childAgent, callId: 'call-1' })
    assert.equal(host.root.tools.checkGuards(call('ui_screenshot')), undefined)
    const denial = host.root.tools.checkGuards(call('ui_click'))
    assert.notEqual(denial, undefined)
    assert.match(denial.reason, /预算已用完/)
  })

  test('父代理由 workspace 门禁控制（不在允许工作区时不可见）', async () => {
    const host = await createHost({ allowedSession: 'session-somebody-else' })
    const outsider = {
      id: 'session-outsider',
      session: { header: { id: 'session-outsider' }, meta: {} },
      ctx: host.root,
    }
    // `get` shows registrations; the `when` gate decides step admission.
    const set = await host.admitted(outsider)
    assert.equal(set.view(outsider).has('ui_operate'), false)
    set.dispose()
    const allowed = await host.admitted(host.parent)
    assert.equal(allowed.view(host.parent).has('ui_operate'), true)
    allowed.dispose()
  })
})
