/**
 * Summarises a settled burst of tool calls into one line.
 *
 * A burst that ran six calls should not leave six rows behind — once it's done
 * the individual calls are detail, not narrative. This collapses them the way
 * Cursor does: "Explored 8 files, 4 searches, ran 4 commands". The rows are
 * still there, one click away; this is only what the collapsed line says.
 *
 * Phrasing follows the counts, not a fixed template. Reads and searches are
 * things you *explore*; everything else is something you *ran*. A burst with no
 * reads or searches therefore says "Ran 2 commands" rather than the empty
 * "Explored , ran 2 commands".
 */

import { resolveToolIdentity } from './tool-label'

export type ToolCategory = 'file' | 'search' | 'command'

type ToolLikePart = {
  type?: string
  toolName?: string
  input?: unknown
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Substrings that mark a call as touching a file rather than doing something.
 * Includes the write verbs: `write` and `edit` are file work, and bucketing
 * them as commands made "Explored 2 files, ran 3 commands" undercount the reads
 * and overcount the shell.
 */
const FILE_HINTS = [
  'read',
  'write',
  'edit',
  'patch',
  'file',
  'document',
  'ocr',
  'fetch',
  'get',
]
const SEARCH_HINTS = ['search', 'grep', 'find', 'lookup', 'query', 'resolve', 'list', 'rag']

/**
 * Which bucket a call falls into.
 *
 * Search is checked before file on purpose: `skills.get` is a read, but
 * `tools.list` and `skills.search` are lookups, and "list"/"search" are the
 * stronger signal when both appear (e.g. `documents.search`).
 */
export function toolCategory(part: ToolLikePart): ToolCategory {
  const { op, toolId, name, label } = resolveToolIdentity(part)
  const key = normalize(toolId || op || name || label || '')

  if (SEARCH_HINTS.some((h) => key.includes(h))) return 'search'
  if (FILE_HINTS.some((h) => key.includes(h))) return 'file'
  return 'command'
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export type BurstCounts = Record<ToolCategory, number>

export function countByCategory(parts: ToolLikePart[]): BurstCounts {
  const counts: BurstCounts = { file: 0, search: 0, command: 0 }
  for (const part of parts) counts[toolCategory(part)]++
  return counts
}

/**
 * The collapsed line for a burst, e.g. `Explored 8 files, 4 searches, ran 4
 * commands`. `running` switches to the present tense so the same line can head
 * the burst while it's still in flight.
 */
export function summarizeBurst(
  parts: ToolLikePart[],
  running: boolean
): string {
  const { file, search, command } = countByCategory(parts)
  const explored: string[] = []
  if (file) explored.push(plural(file, 'file'))
  if (search) explored.push(plural(search, 'search', 'searches'))

  if (explored.length) {
    const verb = running ? 'Exploring' : 'Explored'
    const tail = command ? `, ran ${plural(command, 'command')}` : ''
    return `${verb} ${explored.join(', ')}${tail}`
  }

  if (command) {
    return `${running ? 'Running' : 'Ran'} ${plural(command, 'command')}`
  }

  const total = parts.length
  return `${running ? 'Running' : 'Ran'} ${plural(total, 'step')}`
}
