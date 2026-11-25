/**
 * dsh-ui-nl — natural-language UI operation for DSH.
 *
 * One model-facing tool, `ui_operate({ instruction })`, hands the instruction
 * to a child subagent. The child owns exactly the six numbered-image tools of
 * `dsh-ui-automation` (screenshot → act by index → re-screenshot), decides its
 * own steps, and reports back in text; when the instruction asks to see the
 * screen, its newest numbered screenshot is returned as an image block.
 *
 * The child receives those tools through a per-agent scoped registration
 * (`agent.ctx.tools.register`), not by widening the UI plugin's session
 * allow-list: tool visibility is resolved before any async hook runs, so a
 * workspace-based grant cannot be guaranteed in time for the child's first
 * step. Re-registering the definitions into the child's own scope is
 * deterministic, is removed with the child, and — together with the
 * `origin !== 'subagent'` gate and `maxDepth: 0` — makes recursion through
 * `ui_operate` impossible.
 *
 * @module dsh-ui-nl
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config, readConfig } from './lib/config.js'
import { createGate } from './lib/gate.js'
import { buildChildPrompt, OPERATE_GUIDANCE } from './lib/prompt.js'
import { createOperateTool } from './lib/tool.js'
import { resolveUiDefinitions, UI_TOOL_NAMES } from './lib/ui-tools.js'

/** Cordis diagnostic name. */
export const name = 'ui-nl'

/** Required services. */
export const inject = ['tools', 'subagents', 'systemPrompt', 'workspaceRegistry']

export { Config }

/**
 * Main plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {object} config live plugin configuration
 * @returns {void}
 */
export function apply(ctx, config) {
  const pluginDir = path.dirname(fileURLToPath(import.meta.url))
  const settings = () => readConfig(config, pluginDir)
  const log = (level, message, error) => {
    const sink = ctx.logger?.[level]
    if (typeof sink === 'function') sink.call(ctx.logger, `[ui-nl] ${message}`, error)
    else (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[ui-nl] ${message}`, error ?? '')
  }

  const initial = settings()
  if (initial.model !== '' && initial.modelProvider === '') {
    throw new Error('ui-nl: model 需要和 modelProvider 成对设置（子代理模型路由）；留空表示继承调用方模型。')
  }

  const gate = createGate({ getSettings: settings, workspaceRegistry: ctx.workspaceRegistry, log })

  // Take the underlying surface over: while ui-nl is enabled, a Session that
  // may call `ui_operate` no longer sees the six raw tools, so the only way to
  // drive the desktop is the natural-language entry point. The predicate keeps
  // the change scoped to this plugin's own allow-list — a Session that cannot
  // call `ui_operate` keeps the raw tools it had. Subagent Sessions are exempt
  // inside `dsh-ui-automation`, and this gate already refuses them.
  if (initial.hideUnderlyingTools) {
    ctx.inject(['uiAutomationVisibility'], visibilityCtx => {
      visibilityCtx.effect(() => {
        const release = visibilityCtx.uiAutomationVisibility.suppress(
          'ui-nl',
          (sessionId, agent) => gate.allowed(sessionId, agent),
        )
        log('info', 'ui_operate 接管底层 ui_* 工具：可调用 ui_operate 的会话不再看到它们')
        return () => {
          release()
          log('info', 'ui-nl 已卸载：底层 ui_* 工具恢复可见')
        }
      }, 'ui-nl.suppress-underlying-tools')
    })
  }

  /** Children started by this plugin: child session id → the scope they must receive. */
  const children = new Map()

  // Compose every child we start: exactly the six numbered-image tools, a
  // monotonic step budget, and no other capability.
  ctx.on('agent/created', async ({ agent }) => {
    const record = children.get(agent.id)
    if (record === undefined) return
    const disposers = []
    try {
      for (const definition of record.definitions) disposers.push(agent.ctx.tools.register(definition))
      disposers.push(agent.ctx.tools.restrict({ allow: [...UI_TOOL_NAMES] }))
      let steps = 0
      disposers.push(agent.ctx.tools.guard(call => {
        if (!UI_TOOL_NAMES.includes(call.name)) return undefined
        steps += 1
        if (steps <= record.maxSteps) return undefined
        return `UI 操作预算已用完（上限 ${record.maxSteps} 次）；停止操作，并汇报当前界面状态和未完成的部分。`
      }))
      log('info', `子代理 ${agent.id} 获得 ${record.definitions.length} 个 ui_* 工具，预算 ${record.maxSteps} 次`)
    } catch (error) {
      for (const dispose of disposers) {
        try { dispose() } catch {}
      }
      log('error', `无法为子代理 ${agent.id} 组合 UI 工具`, error)
      throw error
    }
  })

  /**
   * Render one thrown value as a message.
   *
   * @param {unknown} error thrown value
   * @returns {string} message
   */
  const messageOf = error => (error instanceof Error ? error.message : String(error ?? 'unknown error'))

  /**
   * List the model routes the LLM registry currently advertises, for a
   * failed-fast configuration error. Bounded: a bad route must not produce a
   * huge tool result.
   *
   * @param {object} llm LLM registry service
   * @returns {Promise<string>} `provider: model, model; …`
   */
  async function describeRoutes(llm) {
    if (typeof llm.listProviders !== 'function') return '(当前部署不提供路由列表)'
    const groups = []
    try {
      for (const provider of llm.listProviders()) {
        let models = []
        try {
          models = await llm.listModels(provider.id)
        } catch {
          models = []
        }
        groups.push(`${provider.id}: ${models.map(model => model.id).join(', ') || '(无模型)'}`)
      }
    } catch (error) {
      return `(无法列出路由：${messageOf(error)})`
    }
    const text = groups.join('; ')
    return text.length > 600 ? `${text.slice(0, 600)}…` : text
  }

  /**
   * Preflight the child's model route. An explicitly configured route must be
   * resolvable, advertised by its provider, and accept image input — the
   * numbered screenshot reaches the child as an image block. An inherited route
   * is only checked for image support, because the caller's own route may not
   * be resolvable before its first request.
   *
   * @param {object} parent calling agent
   * @returns {Promise<void>} resolves when the route is usable
   * @throws {Error} when an explicit route does not exist or a resolved route cannot see images
   */
  async function preflightModel(parent) {
    const current = settings()
    const explicit = current.model !== ''
    const requestConfig = parent.session?.requestHeader?.()?.config
    const route = explicit
      ? { provider: current.modelProvider, model: current.model }
      : { provider: requestConfig?.provider ?? parent.options?.provider, model: requestConfig?.model ?? parent.options?.model }
    if (route.provider === undefined || route.model === undefined) return

    const llm = ctx.get('llm')
    if (typeof llm?.resolveModelInfo !== 'function') {
      if (explicit) {
        throw new Error(
          `无法校验子代理模型 ${route.provider}/${route.model}：llm 服务不可用。`
          + '请去掉 modelProvider/model（留空继承调用方模型），或加载 LLM 适配器。',
        )
      }
      return
    }

    let info
    try {
      info = await llm.resolveModelInfo(route.provider, route.model)
    } catch (error) {
      if (!explicit) {
        log('warn', `无法预检继承的子代理模型 ${route.provider}/${route.model}，继续`, error)
        return
      }
      throw new Error(
        `子代理模型 ${route.provider}/${route.model} 不存在或不可用：${messageOf(error)}。`
        + `可用的路由：${await describeRoutes(llm)}`,
      )
    }

    if (explicit) {
      let models
      try {
        models = await llm.listModels(route.provider)
      } catch {
        models = undefined
      }
      if (Array.isArray(models) && models.length > 0 && !models.some(model => model.id === route.model)) {
        throw new Error(
          `子代理模型 ${route.provider}/${route.model} 不在该 provider 的模型列表里。`
          + `可用的路由：${await describeRoutes(llm)}`,
        )
      }
    }

    const modalities = info?.inputModalities
    if (Array.isArray(modalities) && !modalities.includes('image')) {
      throw new Error(
        `子代理模型 ${route.provider}/${route.model} 不接受图片输入，ui_screenshot 的标号图片无法送达；`
        + '请用 modelProvider/model 配置一个支持图片的模型（留空表示继承调用方模型）。',
      )
    }
  }

  const deps = {
    startActivation: spec => ctx.subagents.startActivation(spec),
    newChildId: () => `session-${randomUUID()}`,
    registerChild: (childId, record) => { children.set(childId, record) },
    releaseChild: childId => { children.delete(childId) },
    uiDefinitions: () => resolveUiDefinitions(ctx),
    buildPrompt: (instruction, maxSteps) => buildChildPrompt({ instruction, maxSteps }),
    preflightModel,
    /**
     * Store one numbered screenshot as an image attachment.
     *
     * @param {string} imagePath admitted screenshot path
     * @returns {Promise<object | undefined>} the durable attachment reference
     */
    async saveImage(imagePath) {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) return undefined
      return await attachments.saveImage({
        data: readFileSync(imagePath),
        mediaType: 'image/png',
        name: path.basename(imagePath),
      })
    },
    logger: { info: m => log('info', m), warn: (m, e) => log('warn', m, e), error: (m, e) => log('error', m, e) },
  }

  const tool = createOperateTool({
    deps,
    getConfig: settings,
    // The pipeline deadline sits above the live child deadline; the child
    // timeout is the one that reports a useful code.
    timeoutMs: initial.timeoutMs + 60_000,
  })
  ctx.tools.register(tool, { when: ({ agent }) => gate.allowed(agent?.id, agent) })

  ctx.systemPrompt.section({
    name: 'ui-nl:operate',
    order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
    text: context => gate.allowed(context?.agent?.id, context?.agent) ? OPERATE_GUIDANCE : '',
  })

  log('info', `ready; ui_operate 限于 ${gate.allowedWorkspacePaths().join(', ')}（子代理 provider=${initial.subagentProvider}，超时 ${initial.timeoutMs}ms，预算 ${initial.maxSteps}，接管底层工具=${initial.hideUnderlyingTools}）`)
}
