/**
 * operate.js — one `ui_operate` call as an awaitable subagent activation.
 *
 * The main agent's instruction becomes the child subagent's entire task. The
 * child owns the numbered-image UI tools (registered into its scope in
 * `index.js`), decides the screenshot → numbered action → re-screenshot steps
 * itself, and its final answer is returned verbatim. When it reports a
 * screenshot, the wrapper stores that PNG as an attachment so the tool result
 * carries an image block.
 *
 * Every failure mode returns a value: startup failure, a child that stops with
 * an error, a timeout, and caller cancellation never hang the tool or lose the
 * reason.
 *
 * @module dsh-ui-nl/operate
 */
import { admitScreenshot, parseChildOutput } from './markers.js'

/** Grace period for activation teardown after a timeout or abort. */
const DISPOSE_GRACE_MS = 10_000

/**
 * Render one thrown value as a message.
 *
 * @param {unknown} error thrown value
 * @returns {string} message
 */
function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/**
 * Race an activation result against the timeout and caller cancellation.
 *
 * @param {Promise<object>} result activation result
 * @param {number} timeoutMs deadline
 * @param {AbortSignal | undefined} signal caller cancellation
 * @returns {Promise<{ kind: 'result', result: object } | { kind: 'failed', error: unknown } | { kind: 'timeout' } | { kind: 'aborted', reason: unknown }>} outcome
 */
async function raceDeadline(result, timeoutMs, signal) {
  let resolveOutcome
  const outcome = new Promise(resolve => { resolveOutcome = resolve })
  const timer = setTimeout(() => { resolveOutcome({ kind: 'timeout' }) }, timeoutMs)
  const onAbort = () => { resolveOutcome({ kind: 'aborted', reason: signal?.reason }) }
  if (signal?.aborted === true) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  void result.then(
    value => { resolveOutcome({ kind: 'result', result: value }) },
    error => { resolveOutcome({ kind: 'failed', error }) },
  )
  try {
    return await outcome
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Release one activation without letting teardown hang the tool.
 *
 * @param {object} deps dependencies
 * @param {object} activation activation handle
 * @returns {Promise<void>} resolves after cleanup or the grace period
 */
async function disposeQuietly(deps, activation) {
  const disposal = Promise.resolve()
    .then(() => activation.dispose())
    .catch(error => { deps.logger.warn('ui_operate: activation teardown failed', error) })
  let timer
  try {
    await Promise.race([disposal, new Promise(resolve => { timer = setTimeout(resolve, DISPOSE_GRACE_MS) })])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Store one numbered screenshot as an attachment.
 *
 * @param {object} deps dependencies
 * @param {string} imagePath absolute screenshot path
 * @returns {Promise<{ attachment?: object, warning?: string }>} attachment or a warning
 */
async function storeScreenshot(deps, imagePath) {
  try {
    const attachment = await deps.saveImage(imagePath)
    if (attachment === undefined) {
      return { warning: `图片附件不可用（没有 attachments 服务），请用 read_image 读取 ${imagePath}` }
    }
    return { attachment }
  } catch (error) {
    return { warning: `图片附件保存失败，请用 read_image 读取 ${imagePath}：${messageOf(error)}` }
  }
}

/**
 * Shape a failed call.
 *
 * @param {object} fields failure fields
 * @returns {object} tool output value
 */
function failure({ code, error, text, childId, childName, stopReason, imagePath, attachment, warnings, elapsedMs }) {
  return {
    ok: false,
    code,
    error,
    ...text === undefined || text === '' ? {} : { text },
    ...childId === undefined ? {} : { childId },
    ...childName === undefined ? {} : { childName },
    ...stopReason === undefined ? {} : { stopReason },
    ...imagePath === undefined ? {} : { imagePath },
    ...attachment === undefined ? {} : { attachment },
    ...warnings === undefined || warnings.length === 0 ? {} : { warnings },
    elapsedMs,
  }
}

/**
 * Run one natural-language UI operation through a child subagent.
 *
 * @param {object} deps injected capabilities
 * @param {(spec: object) => Promise<object>} deps.startActivation `ctx.subagents.startActivation`
 * @param {() => string} deps.newChildId durable child session id
 * @param {(childId: string, record: object) => void} deps.registerChild claim the child before startup
 * @param {(childId: string) => void} deps.releaseChild release the claim
 * @param {() => object[]} deps.uiDefinitions the six numbered-image definitions
 * @param {(instruction: string, maxSteps: number) => string} deps.buildPrompt child task prompt
 * @param {(parent: object) => Promise<void>} deps.preflightModel child route check
 * @param {(imagePath: string) => Promise<object | undefined>} deps.saveImage attachment store
 * @param {{ info: Function, warn: Function, error: Function }} deps.logger plugin logger
 * @param {object} request the call
 * @param {string} request.instruction natural-language task
 * @param {object} request.parent calling agent
 * @param {AbortSignal | undefined} request.signal caller cancellation
 * @param {object} request.config normalized settings
 * @returns {Promise<object>} tool output value
 */
export async function operate(deps, request) {
  const { instruction, parent, signal, config } = request
  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt

  let definitions
  try {
    definitions = deps.uiDefinitions()
  } catch (error) {
    return failure({ code: 'UI_TOOLS_UNAVAILABLE', error: messageOf(error), elapsedMs: elapsed() })
  }

  try {
    await deps.preflightModel(parent)
  } catch (error) {
    return failure({ code: 'MODEL_ROUTE', error: messageOf(error), elapsedMs: elapsed() })
  }

  const childId = deps.newChildId()
  const record = { definitions, maxSteps: config.maxSteps, childId }
  deps.registerChild(childId, record)

  if (signal?.aborted === true) {
    deps.releaseChild(childId)
    return failure({
      code: 'ABORTED',
      error: '调用方在启动子代理前取消了 ui_operate',
      elapsedMs: elapsed(),
    })
  }

  let activation
  try {
    activation = await deps.startActivation({
      provider: config.subagentProvider,
      childId,
      label: `ui_operate: ${instruction.length > 60 ? `${instruction.slice(0, 57)}…` : instruction}`,
      prompt: [{ type: 'text', text: deps.buildPrompt(instruction, config.maxSteps) }],
      parent,
      signal,
      // Forbid the child from delegating further: depth 0 is a hard stop.
      maxDepth: 0,
      ...config.model === '' ? {} : { agentOptions: { provider: config.modelProvider, model: config.model } },
      delivery: 'caller',
    })
  } catch (error) {
    deps.releaseChild(childId)
    return failure({ code: 'START_FAILED', error: messageOf(error), elapsedMs: elapsed() })
  }

  try {
    const outcome = await raceDeadline(activation.result, config.timeoutMs, signal)
    if (outcome.kind === 'timeout') {
      await disposeQuietly(deps, activation)
      return failure({
        code: 'TIMEOUT',
        error: `子代理在 ${config.timeoutMs}ms 内没有完成，已取消；可以拆分指令或调大 timeoutMs。`,
        childId,
        childName: activation.name,
        elapsedMs: elapsed(),
      })
    }
    if (outcome.kind === 'aborted') {
      await disposeQuietly(deps, activation)
      return failure({
        code: 'ABORTED',
        error: '调用方取消了 ui_operate，子代理已停止。',
        childId,
        childName: activation.name,
        elapsedMs: elapsed(),
      })
    }
    if (outcome.kind === 'failed') {
      return failure({
        code: 'ACTIVATION_FAILED',
        error: `子代理激活失败：${messageOf(outcome.error)}`,
        childId,
        childName: activation.name,
        elapsedMs: elapsed(),
      })
    }

    const result = outcome.result
    const parsed = parseChildOutput(result.output)
    const { text } = parsed
    const warnings = []
    let imagePath
    let attachment
    const admitted = admitScreenshot(parsed.reported)
    if (admitted !== undefined) {
      if ('reason' in admitted) warnings.push(admitted.reason)
      else {
        imagePath = admitted.path
        if (config.attachImages) {
          const stored = await storeScreenshot(deps, imagePath)
          attachment = stored.attachment
          if (stored.warning !== undefined) warnings.push(stored.warning)
        }
      }
    }

    if (result.stopReason !== 'completed') {
      return failure({
        code: 'CHILD_STOPPED',
        error: result.diagnostic === undefined || result.diagnostic === ''
          ? `子代理以 ${result.stopReason} 结束，没有正常完成。`
          : result.diagnostic,
        text,
        childId,
        childName: activation.name,
        stopReason: result.stopReason,
        imagePath,
        attachment,
        warnings,
        elapsedMs: elapsed(),
      })
    }

    return {
      ok: true,
      text,
      childId,
      childName: activation.name,
      stopReason: result.stopReason,
      ...imagePath === undefined ? {} : { imagePath },
      ...attachment === undefined ? {} : { attachment },
      ...warnings.length === 0 ? {} : { warnings },
      elapsedMs: elapsed(),
    }
  } finally {
    deps.releaseChild(childId)
  }
}
