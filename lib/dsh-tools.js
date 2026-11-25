/**
 * dsh-tools.js — the `defineTool` helper, resolved from the DSH installation.
 *
 * @module dsh-ui-nl/dsh-tools
 */
import { loadShipped } from './shipped.js'

const toolsModule = await loadShipped('@deepseek-ai/dsh-tools')

export const defineTool = toolsModule.defineTool
export default toolsModule
