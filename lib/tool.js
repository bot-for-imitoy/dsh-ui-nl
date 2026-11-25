/**
 * tool.js — the single model-facing tool: `ui_operate`.
 *
 * The tool takes one natural-language instruction, runs it through a child
 * subagent, and renders the child's report. A reported numbered screenshot
 * becomes an `ImageBlock` (image first, so image-capable UIs show the frame
 * before the report), while the textual output always carries `imagePath` so a
 * text-only surface still has the evidence.
 *
 * @module dsh-ui-nl/tool
 */
import { defineTool } from './dsh-tools.js'
import { operate } from './operate.js'

/** Model-facing tool description. */
const DESCRIPTION = `Operate a Linux graphical interface from one natural-language instruction.

The instruction is handed to a child subagent that owns the numbered-image UI tools (ui_screenshot, ui_click, ui_double_click, ui_scroll, ui_drag, ui_type). It screenshots, acts only by the index printed on the newest image, re-screenshots after every action to verify, and returns a short report of what it did and what the screen shows now.

Say explicitly when you want to see the screen (for example "看看界面上有什么，并给我一张图"); the result then carries the final numbered screenshot as an image. Do not ask for an image when only the text outcome matters.

Use it for GUI work a shell cannot do. Keep the instruction self-contained: name the window, the visible text to click or type, and any safety limits (do not pay, do not delete). The subagent never runs shell commands or spawns further agents, and it stops and reports when an action needs confirmation.`

/**
 * Build the rendered tool result.
 *
 * @param {object} value tool output value
 * @returns {object[]} content blocks
 */
export function renderOperate(value) {
  const blocks = []
  const ok = value?.ok === true
  const lines = ok
    ? [value.text === undefined || value.text === '' ? '(子代理没有给出文字结论)' : value.text]
    : [
        `✗ ui_operate failed${typeof value?.code === 'string' ? ` [${value.code}]` : ''}`,
        `  ${value?.error ?? 'unknown error'}`,
      ]

  if (ok) {
    const meta = []
    if (value.childName !== undefined) meta.push(`subagent: ${value.childName}`)
    if (value.stopReason !== undefined && value.stopReason !== 'completed') meta.push(`stop: ${value.stopReason}`)
    if (typeof value.elapsedMs === 'number') meta.push(`${value.elapsedMs}ms`)
    if (meta.length > 0) lines.push('', `— ${meta.join(' · ')}`)
  } else if (value?.text !== undefined && value.text !== '') {
    lines.push('', value.text)
  }

  if (value?.imagePath !== undefined) {
    lines.push(value?.attachment === undefined
      ? 'image: 未附图片，用 read_image 读取上面的 imagePath'
      : 'image: 已作为图片块附上（同时保留 imagePath）')
  }
  if (Array.isArray(value?.warnings)) {
    for (const warning of value.warnings) lines.push(`warning: ${warning}`)
  }

  blocks.push({ type: 'text', text: lines.join('\n') })
  if (value?.attachment !== undefined) blocks.unshift({ type: 'image', attachment: value.attachment })
  return blocks
}

/**
 * Create the `ui_operate` definition.
 *
 * @param {object} options definition options
 * @param {object} options.deps operate dependencies (`startActivation`, attachment store, …)
 * @param {() => object} options.getConfig live normalized settings
 * @param {number} options.timeoutMs pipeline-level timeout, above the child deadline
 * @returns {object} tool definition
 */
export function createOperateTool({ deps, getConfig, timeoutMs }) {
  return defineTool({
    name: 'ui_operate',
    description: DESCRIPTION,
    parameters: {
      instruction: {
        type: 'string',
        required: true,
        description: 'The complete natural-language task for the UI subagent, in the user\'s language: what to look at, what to click or type (by visible text), and whether an image of the screen is wanted.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderOperate(value),
    },
    timeoutMs,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('ui_operate requires a calling agent (exec.agent was undefined)')
      }
      // Recursion guard, second layer: even if a child somehow resolved this
      // definition, it must not be able to start a grandchild through it.
      if (parent.session?.header?.origin === 'subagent') {
        throw new Error('ui_operate is not available to subagent sessions (recursion guard)')
      }
      const instruction = typeof args?.instruction === 'string' ? args.instruction.trim() : ''
      if (instruction === '') throw new Error('ui_operate requires a non-empty natural-language instruction')
      return await operate(deps, { instruction, parent, signal: exec.signal, config: getConfig() })
    },
  })
}
