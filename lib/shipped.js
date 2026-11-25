/**
 * shipped.js — resolve a package that ships with the DSH installation.
 *
 * A bundle must not declare dependencies on packages dsh already ships, and a
 * locally linked bundle resolves bare imports from its own directory (not from
 * the profile). This helper first tries the normal resolver (profile hoisting /
 * bundled host) and then resolves from the DSH installation directory, so the
 * plugin works both as a linked workspace package and inside a profile.
 *
 * @module dsh-ui-nl/shipped
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const cache = new Map()

/**
 * Serialize resolutions: a CJS package that requires an ES module (for example
 * `@deepseek-ai/schemastery` → `@deepseek-ai/cosmokit`) fails with
 * `ERR_REQUIRE_ESM_RACE_CONDITION` when two dynamic imports load it
 * concurrently. One queue keeps every shim resolution sequential.
 */
let queue = Promise.resolve()

/** Candidate DSH installation directories. */
function installDirs() {
  const dirs = []
  if (typeof process.env.DSH_INSTALL_DIR === 'string' && process.env.DSH_INSTALL_DIR !== '') {
    dirs.push(process.env.DSH_INSTALL_DIR)
  }
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry !== '') {
    let dir = path.dirname(path.resolve(entry))
    for (let depth = 0; depth < 10; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
        if (manifest?.name === '@deepseek-ai/dsh') {
          dirs.push(dir)
          break
        }
      } catch {}
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const common = '/usr/lib/node_modules/@deepseek-ai/dsh'
  if (existsSync(common)) dirs.push(common)
  return [...new Set(dirs)]
}

/**
 * Import one package from the DSH installation.
 *
 * @param {string} name bare package specifier
 * @returns {Promise<any>} module namespace
 */
export function loadShipped(name) {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const pending = queue.then(async () => {
    try {
      return await import(name)
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') throw error
    }
    for (const dir of installDirs()) {
      try {
        const require = createRequire(path.join(dir, 'package.json'))
        const resolved = require.resolve(name)
        return await import(pathToFileURL(resolved).href)
      } catch {}
    }
    throw new Error(
      `无法解析 dsh 内置包 ${name}：既不在当前 profile，也不在 DSH 安装目录（${installDirs().join(', ') || '未找到'}）。`,
    )
  })
  queue = pending.then(() => {}, () => {})
  cache.set(name, pending)
  return pending
}
