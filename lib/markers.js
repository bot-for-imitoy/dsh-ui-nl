/**
 * markers.js — parsing the child's answer and admitting its screenshot.
 *
 * The child reports the newest numbered screenshot as an `IMAGE: <path>` line.
 * Only files named like `shot-YYYYMMDD-HHMMSS-<pid>-<seq>.png` are admitted,
 * so a confused or hostile child cannot turn the wrapper into an arbitrary
 * file-exfiltration channel; anything else is reported back as a warning.
 *
 * @module dsh-ui-nl/markers
 */
import { statSync } from 'node:fs'
import path from 'node:path'
import { IMAGE_MARKER } from './prompt.js'

/** Numbered-screenshot file name produced by `dsh-ui-automation`. */
export const SCREENSHOT_NAME = /^shot-\d{8}-\d{6}-\d+-\d+\.png$/

const MARKER_LINE = new RegExp(`^\\s*${IMAGE_MARKER}\\s*(.+?)\\s*$`, 'gim')

/**
 * Join the text blocks of a subagent output.
 *
 * @param {readonly object[] | undefined} output content blocks
 * @returns {string} concatenated text
 */
export function outputText(output) {
  if (!Array.isArray(output)) return ''
  return output
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Split the child's answer into its prose and the reported screenshot path.
 *
 * The last marker wins and every marker line is removed from the prose.
 *
 * @param {readonly object[] | undefined} output content blocks
 * @returns {{ text: string, reported: string | undefined }} prose and the raw marker value
 */
export function parseChildOutput(output) {
  const joined = outputText(output)
  let reported
  for (const match of joined.matchAll(MARKER_LINE)) reported = match[1].trim()
  const text = joined.replace(MARKER_LINE, '').replace(/\n{3,}/g, '\n\n').trim()
  return { text, reported }
}

/**
 * Validate a reported screenshot path.
 *
 * @param {string | undefined} reported raw marker value
 * @returns {{ path: string } | { reason: string } | undefined} the admitted path,
 *   a rejection reason, or `undefined` when the child did not report an image
 */
export function admitScreenshot(reported) {
  if (reported === undefined) return undefined
  if (reported === '' || reported.toLowerCase() === 'none') return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(reported)) return { reason: `不是本地路径：${reported}` }
  const resolved = path.resolve(reported)
  if (!SCREENSHOT_NAME.test(path.basename(resolved))) {
    return { reason: `只接受标号截图（shot-*.png），收到：${reported}` }
  }
  try {
    if (!statSync(resolved).isFile()) return { reason: `不是文件：${resolved}` }
  } catch {
    return { reason: `截图不存在：${resolved}` }
  }
  return { path: resolved }
}
