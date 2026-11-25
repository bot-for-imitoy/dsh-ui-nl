/**
 * harness.mjs — a fake Cordis context for `apply()` and a controllable
 * subagent activation.
 *
 * It models only the surface this plugin touches: the tools registry (with a
 * distinct child scope per agent), the system-prompt section registry, the
 * `agent/created` serial event, the workspace registry, optional
 * attachments/LLM services, and `ctx.subagents.startActivation`. No model is
 * contacted; the child's result is a promise the test settles.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Deferred promise with exposed resolvers. */
export function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Recording child scope: the six tool registrations, restrictions, and guards. */
export function createScopedTools() {
  return {
    registrations: [],
    restrictions: [],
    guards: [],
    register(definition) {
      this.registrations.push(definition)
      return () => {
        const at = this.registrations.indexOf(definition)
        if (at >= 0) this.registrations.splice(at, 1)
      }
    },
    restrict(filter) {
      this.restrictions.push(filter)
      return () => {}
    },
    guard(guard) {
      this.guards.push(guard)
      return () => {}
    },
  }
}

/** A fake UI-automation tool definition (only `name` is ever read). */
function uiDefinition(name) {
  return { name, description: `${name} (fake)`, parameters: {}, output: { schema: { type: 'json' }, render: () => [] } }
}

/**
 * Build the fake context, apply the plugin, and expose helpers.
 *
 * @param {object} [options] harness options
 * @param {object} [options.config] plugin config overrides
 * @param {string[]} [options.uiToolNames] globally registered numbered-image tools
 * @param {Array<{path: string, sessionIds: string[]}>} [options.workspaces] workspace registry rows
 * @param {object} [options.attachments] fake attachment store (`saveImage`)
 * @param {object} [options.llm] fake LLM registry (`resolveModelInfo`)
 * @param {object} [options.uiAutomationVisibility] fake suppression service
 * @param {string} [options.workspacePath] allowed workspace path (defaults to the repo)
 * @param {string} [options.parentId] calling session id
 * @returns {Promise<object>} harness
 */
export async function createPluginHarness(options = {}) {
  const { apply } = await import(path.join(repoDir, 'index.js'))
  const workspacePath = options.workspacePath ?? repoDir
  const parentId = options.parentId ?? 'session-parent'
  const workspaces = options.workspaces ?? [{ path: workspacePath, sessionIds: [parentId] }]

  const definitions = new Map()
  for (const name of options.uiToolNames ?? ['ui_screenshot', 'ui_click', 'ui_double_click', 'ui_scroll', 'ui_drag', 'ui_type']) {
    definitions.set(name, uiDefinition(name))
  }

  const registrations = []
  const hostTools = {
    register(definition, registrationOptions = {}) {
      registrations.push({ definition, options: registrationOptions })
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    },
    get(name) { return definitions.get(name) },
  }

  const sections = []
  const listeners = new Map()
  const logs = []
  const activations = []
  const childAgents = []
  const effectDisposers = []
  const suppressionCalls = []
  const releases = []
  let pending
  let disposeCount = 0

  const visibility = options.uiAutomationVisibility === undefined
    ? undefined
    : {
        suppress(key, applies) {
          suppressionCalls.push({ key, applies })
          return () => { releases.push(key) }
        },
      }

  const log = level => (message, error) => { logs.push({ level, message, error }) }

  const ctx = {
    ...visibility === undefined ? {} : { uiAutomationVisibility: visibility },
    logger: { info: log('info'), warn: log('warn'), error: log('error') },
    tools: hostTools,
    systemPrompt: {
      section(section) { sections.push(section); return () => {} },
      getSectionOrder(name) { return name === 'TOOL_COMPUTER_USE' ? 3000 : 0 },
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return () => {}
    },
    workspaceRegistry: { list: () => workspaces },
    get(name) {
      if (name === 'attachments') return options.attachments
      if (name === 'llm') return options.llm
      if (name === 'uiAutomationVisibility') return visibility
      return undefined
    },
    inject(deps, callback) {
      const ready = deps.every(name => ctx.get(name) !== undefined)
      if (ready) callback(ctx)
      return { dispose: async () => {} }
    },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => {}
    },
    subagents: {
      async startActivation(spec) {
        activations.push(spec)
        pending ??= deferred()
        const tools = createScopedTools()
        const agent = {
          id: spec.childId,
          session: {
            header: { id: spec.childId, cwd: workspacePath, origin: 'subagent' },
            meta: { parentSession: spec.parent.id, origin: 'subagent' },
          },
          ctx: { tools },
        }
        childAgents.push({ agent, tools })
        // `agent/created` is serial: creation awaits listeners before the prompt.
        for (const listener of listeners.get('agent/created') ?? []) {
          await listener({ agent, source: 'subagent' })
        }
        return {
          childId: spec.childId,
          name: 'agent-1',
          messageId: 'message-1',
          result: pending.promise,
          dispose: async () => { disposeCount += 1 },
        }
      },
    },
  }

  const config = { ...options.config }
  apply(ctx, config)

  const parentAgent = {
    id: parentId,
    options: { provider: 'test-provider', model: 'test-model' },
    session: { header: { id: parentId, cwd: workspacePath }, requestHeader: () => undefined, meta: {} },
    ctx,
  }

  const operateRegistration = () => {
    const found = registrations.find(entry => entry.definition.name === 'ui_operate')
    if (found === undefined) throw new Error('ui_operate was not registered')
    return found
  }

  return {
    ctx,
    config,
    parentAgent,
    workspaces,
    registrations,
    sections,
    childAgents,
    activations,
    logs,
    operateRegistration,
    tool: () => operateRegistration().definition,
    when: (agent = parentAgent) => operateRegistration().options.when({ agent, modelSelection: {}, signal: new AbortController().signal }),
    /** Create the activation result the next `startActivation` returns. */
    prepareChild() {
      pending = deferred()
      return pending
    },
    /** Invoke the tool as the parent agent would. */
    async invoke(instruction, exec = {}) {
      return await operateRegistration().definition.execute({ instruction }, { agent: parentAgent, signal: exec.signal, arguments: { instruction } })
    },
    suppressionCalls,
    releases,
    disposeEffects() {
      for (const dispose of effectDisposers.splice(0)) dispose()
    },
    get disposeCount() { return disposeCount },
    resetDisposeCount() { disposeCount = 0 },
    readScreenshot(file) { return readFileSync(file) },
  }
}
