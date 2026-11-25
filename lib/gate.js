/**
 * gate.js — who may call `ui_operate`.
 *
 * The wrapper is the authorization boundary for desktop control. Its policy
 * mirrors `dsh-ui-automation` (allow-listed sessions/workspaces, plugin
 * directory by default) because the child subagent receives the six
 * numbered-image tools directly and would otherwise bypass that plugin's own
 * gate. Subagent sessions are always refused: a child must never be able to
 * start a grandchild through this tool.
 *
 * @module dsh-ui-nl/gate
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { splitList } from './config.js'

/**
 * Canonicalize a path for comparison; fall back to `resolve` when it does not
 * exist (an unregistered workspace path is still a stable identity).
 *
 * @param {string} value path
 * @returns {string} canonical absolute path
 */
export function canonicalPath(value) {
  try {
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

/**
 * Build the session gate.
 *
 * @param {object} deps dependencies
 * @param {() => Record<string, unknown>} deps.getSettings live settings reader
 * @param {{ list: () => Array<{ path: string, sessionIds: readonly string[] }> }} deps.workspaceRegistry workspace registry service
 * @param {(level: string, message: string, error?: unknown) => void} deps.log logger
 * @returns {{ allowedWorkspacePaths: () => string[], allowed: (sessionId: string | undefined, agent?: object) => boolean }} the gate
 */
export function createGate({ getSettings, workspaceRegistry, log }) {
  const allowedWorkspacePaths = () => {
    const settings = getSettings()
    const entries = settings.allowedWorkspacePaths === ''
      ? [settings.pluginDir]
      : splitList(settings.allowedWorkspacePaths)
    return (entries.length > 0 ? entries : [settings.pluginDir]).map(canonicalPath)
  }

  const allowed = (sessionId, agent) => {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const settings = getSettings()
    if (settings.allowAllSessions === true) return true
    if (splitList(settings.enabledSessionIds).includes(sessionId)) return true
    // Recursion guard: a subagent (including our own UI child) never sees ui_operate.
    if (agent?.session?.header?.origin === 'subagent') return false
    let workspace
    try {
      workspace = workspaceRegistry.list().find(entry => entry.sessionIds.includes(sessionId))
    } catch (error) {
      log('warn', 'failed to inspect workspaces for tool gating', error)
      return false
    }
    if (workspace === undefined) return false
    return allowedWorkspacePaths().includes(canonicalPath(workspace.path))
  }

  return { allowedWorkspacePaths, allowed }
}
