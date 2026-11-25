/**
 * config.js — live plugin settings and their normalization.
 *
 * The plugin is the authorization boundary for desktop control: `ui_operate`
 * is only visible to allow-listed sessions/workspaces, exactly like the
 * underlying `dsh-ui-automation` tools. The child subagent never needs the
 * workspace gate because the six numbered-image tools are registered into its
 * own agent scope (see `index.js`), so `workspace` only selects the child's
 * working directory.
 *
 * @module dsh-ui-nl/config
 */
import path from 'node:path'
import { loadShipped } from './shipped.js'

const schemastery = await loadShipped('@deepseek-ai/schemastery')
const z = schemastery.default ?? schemastery

/** Timeout bounds in milliseconds. */
export const TIMEOUT_MIN_MS = 5_000
/** Upper timeout bound; a GUI task that takes longer should be split. */
export const TIMEOUT_MAX_MS = 1_800_000

/** Step-budget bounds (UI tool calls the child may make). */
export const STEPS_MIN = 1
/** Upper step-budget bound; the child prompt states the budget it got. */
export const STEPS_MAX = 500

/** Live plugin settings. */
export const Config = z.object({
  subagentProvider: z.string().default('spawn').volatile()
    .description('启动子代理使用的 ctx.subagents provider 名称（默认 spawn）。'),
  workspace: z.string().default('').volatile()
    .description('子代理的初始工作目录；留空表示继承调用方当前目录。它不影响 ui_* 工具可见性（那由每个子代理的 scoped 注册决定）。'),
  modelProvider: z.string().default('').volatile()
    .description('子代理使用的 LLM provider id；与 model 成对设置，留空继承调用方模型。'),
  model: z.string().default('').volatile()
    .description('子代理使用的模型 id；必须支持图片输入（ui_screenshot 返回图片块）。留空继承调用方模型。'),
  timeoutMs: z.number().default(180_000).volatile()
    .description(`一次 ui_operate 的总超时（毫秒，${TIMEOUT_MIN_MS}–${TIMEOUT_MAX_MS}），超时会取消子代理并返回 TIMEOUT。`),
  maxSteps: z.number().default(40).volatile()
    .description(`子代理最多可以执行多少次 UI 工具调用（${STEPS_MIN}–${STEPS_MAX}）；超过后 guard 拒绝并让子代理汇报。`),
  attachImages: z.boolean().default(true).volatile()
    .description('是否把子代理报告的标号截图保存为 attachment 并作为图片块放进工具结果；关闭时只返回 imagePath。'),
  hideUnderlyingTools: z.boolean().default(true).volatile()
    .description('启用后，能调用 ui_operate 的会话不再看到底层 6 个 ui_* 工具（子代理仍然可见）；设为 false 恢复两边都能看到的旧行为。'),
  enabledSessionIds: z.string().default('').volatile()
    .description('额外允许使用 ui_operate 的会话 ID，逗号分隔。'),
  allowedWorkspacePaths: z.string().default('').volatile()
    .description('允许使用 ui_operate 的工作区目录，逗号分隔；留空表示仅本插件所在目录。'),
  allowAllSessions: z.boolean().default(false).volatile()
    .description('对所有会话开放 ui_operate。默认关闭：它会驱动真实桌面。'),
})

/**
 * Clamp one numeric setting.
 *
 * @param {unknown} value raw setting
 * @param {number} fallback default when not finite
 * @param {number} low lower bound
 * @param {number} high upper bound
 * @returns {number} integral, clamped value
 */
function clampInteger(value, fallback, low, high) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(high, Math.max(low, Math.round(number)))
}

/**
 * Read one config value, unwrapping reactive `.get()` wrappers.
 *
 * @param {unknown} value raw setting
 * @returns {unknown} the plain value
 */
function setting(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/**
 * Normalize live configuration into plain values.
 *
 * @param {Record<string, unknown>} config plugin configuration
 * @param {string} pluginDir absolute plugin directory (gate default)
 * @returns {{
 *   subagentProvider: string, workspace: string, modelProvider: string, model: string,
 *   timeoutMs: number, maxSteps: number, attachImages: boolean, hideUnderlyingTools: boolean,
 *   enabledSessionIds: string,
 *   allowedWorkspacePaths: string, allowAllSessions: boolean,
 * }} normalized settings
 */
export function readConfig(config = {}, pluginDir = process.cwd()) {
  return {
    subagentProvider: String(setting(config.subagentProvider) ?? '').trim() || 'spawn',
    workspace: String(setting(config.workspace) ?? '').trim(),
    modelProvider: String(setting(config.modelProvider) ?? '').trim(),
    model: String(setting(config.model) ?? '').trim(),
    timeoutMs: clampInteger(setting(config.timeoutMs), 180_000, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS),
    maxSteps: clampInteger(setting(config.maxSteps), 40, STEPS_MIN, STEPS_MAX),
    attachImages: setting(config.attachImages) !== false,
    hideUnderlyingTools: setting(config.hideUnderlyingTools) !== false,
    enabledSessionIds: String(setting(config.enabledSessionIds) ?? '').trim(),
    allowedWorkspacePaths: String(setting(config.allowedWorkspacePaths) ?? '').trim(),
    allowAllSessions: setting(config.allowAllSessions) === true,
    pluginDir: path.resolve(pluginDir),
  }
}

/**
 * Split a comma/space separated list setting.
 *
 * @param {unknown} value raw setting
 * @returns {string[]} non-empty entries
 */
export function splitList(value) {
  return String(value ?? '').split(/[\s,;]+/).map(part => part.trim()).filter(Boolean)
}
