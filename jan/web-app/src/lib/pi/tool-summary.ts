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

import { humanizeToolId, resolveToolIdentity } from './tool-label'

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
 * Verb for a vendor call, matched against its native action.
 *
 * Order matters — the first hit wins — but the patterns are written not to
 * overlap: note that `create` contains "reat" and not "read", and `update`
 * contains no read verb at all, so the read row can't swallow the write ones.
 */
const ACTION_VERBS: Array<{ test: RegExp; past: string; present: string }> = [
  { test: /search|query|find|lookup|list/, past: 'Searched', present: 'Searching' },
  { test: /read|get|describe|fetch|download|preview|check/, past: 'Checked', present: 'Checking' },
  { test: /send|reply|share|invite|post/, past: 'Sent from', present: 'Sending from' },
  { test: /delete|remove|trash|archive/, past: 'Deleted in', present: 'Deleting in' },
  { test: /create|add|insert|upload|write|update|edit|move|copy|rename/, past: 'Updated', present: 'Updating' },
]

/** `google drive` → `Google Drive`, so a sentence-leading phrase reads right. */
function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

/**
 * A one-vendor burst, described rather than counted.
 *
 * Every Divo tool call arrives as a `divo_gateway` dispatch, so counting them
 * produced "Ran 1 command" for everything — technically true and completely
 * uninformative. The payload already knows both halves of a real sentence:
 * `toolId` is who was called, `payload.args.nativeTool` is what was asked of
 * them. Together they give "Searching Google Drive".
 *
 * Returns undefined when the burst isn't one vendor, so the caller falls back
 * to counting — a mixed Gmail + Drive + Zoho burst has no single sentence, and
 * the icon stack on the folded row already shows who was involved.
 */
function describeVendorBurst(
  parts: ToolLikePart[],
  running: boolean
): string | undefined {
  const identities = parts.map(resolveToolIdentity)
  // EVERY call must be a vendor call, not merely the ones that have a toolId.
  // Dropping the undefined ones first would let a burst of "skills.search +
  // one Zoho call" describe itself as pure Zoho and hide the search.
  if (identities.some((i) => !i.toolId)) return undefined

  const vendors = new Set(identities.map((i) => i.toolId))
  if (vendors.size !== 1) return undefined

  const vendor = titleCase(humanizeToolId([...vendors][0]!))
  const action = identities.find((i) => i.action)?.action ?? ''
  const verb = ACTION_VERBS.find((v) => v.test.test(action.toLowerCase()))

  if (!verb) return `${running ? 'Using' : 'Used'} ${vendor}`
  return `${running ? verb.present : verb.past} ${vendor}`
}

/**
 * The collapsed line for a burst.
 *
 * A single-vendor burst describes itself ("Searching Google Drive"); anything
 * mixed falls back to counts ("Explored 8 files, 4 searches, ran 4 commands").
 * `running` switches to the present tense so the same line can head the burst
 * while it's still in flight.
 */
export function summarizeBurst(
  parts: ToolLikePart[],
  running: boolean
): string {
  const described = describeVendorBurst(parts, running)
  if (described) return described

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
