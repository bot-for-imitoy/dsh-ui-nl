/**
 * ui-tools.js — the numbered-image tool surface this wrapper delegates to.
 *
 * The child subagent receives exactly these definitions, re-registered into its
 * own agent scope. Nothing else is exposed to it, which is what keeps
 * `ui_operate` out of a child's tool list (no recursive nesting) even before
 * the depth cap applies.
 *
 * @module dsh-ui-nl/ui-tools
 */

/** Tool names registered by `dsh-ui-automation`, in the order the child sees them. */
export const UI_TOOL_NAMES = Object.freeze([
  'ui_screenshot',
  'ui_click',
  'ui_double_click',
  'ui_scroll',
  'ui_drag',
  'ui_type',
])

/**
 * Resolve the six numbered-image definitions from the installed UI plugin.
 *
 * @param {object} ctx plugin context exposing `tools`
 * @returns {object[]} the definitions, in {@link UI_TOOL_NAMES} order
 * @throws {Error} when a definition is missing (the dependency is not installed or not enabled)
 */
export function resolveUiDefinitions(ctx) {
  const missing = []
  const definitions = []
  for (const name of UI_TOOL_NAMES) {
    const definition = ctx.tools.get(name)
    if (definition === undefined) missing.push(name)
    else definitions.push(definition)
  }
  if (missing.length > 0) {
    throw new Error(
      `缺少 UI 自动化工具 ${missing.join(', ')}：本插件依赖 dsh-ui-automation，请先安装并启用它（plugins 里应有 ui-automation 一行）。`,
    )
  }
  return definitions
}
