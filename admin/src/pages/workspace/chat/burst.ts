/**
 * A run of tool calls, described in one line.
 *
 * A burst that made six calls should not leave six rows behind. Once it has
 * landed, the individual calls are detail rather than narrative — so they fold
 * to a single line and stay one click away. This is only what that line says.
 *
 * Ported from the desktop's `lib/pi/tool-summary.ts`, with one substitution
 * that matters. The desktop reads a call's vendor and native action out of the
 * raw tool part, because on the desktop everything arrived as one `divo_gateway`
 * dispatch and counting those produced "Ran 1 command" for every run Divo has
 * ever done. Here both halves are already on the ledger row — the mark says who
 * was called and the outcome says what was asked of them — so the sentence is
 * assembled from those instead of parsed back out of a payload.
 */
import { tool, type ToolKey } from './tools'

/** One call in a burst, reduced to the two things a summary needs. */
export type BurstStep = {
  tool: ToolKey
  /** What the call was about — the ledger's outcome, in the wire's words. */
  action: string
}

/**
 * The verb for a vendor call, matched against its own action text.
 *
 * Order matters — first hit wins — but the patterns are written not to overlap.
 * Note that `create` contains "reat" and not "read", and `update` contains no
 * read verb at all, so the read row cannot swallow the write ones.
 */
const ACTION_VERBS: { test: RegExp; past: string; present: string }[] = [
  { test: /search|query|find|lookup|list/, past: 'Searched', present: 'Searching' },
  { test: /read|get|describe|fetch|download|preview|check/, past: 'Checked', present: 'Checking' },
  { test: /send|reply|share|invite|post/, past: 'Sent from', present: 'Sending from' },
  { test: /delete|remove|trash|archive/, past: 'Deleted in', present: 'Deleting in' },
  { test: /create|add|insert|upload|write|update|edit|move|copy|rename/, past: 'Updated', present: 'Updating' },
]

type Category = 'file' | 'search' | 'command' | 'plan'

/**
 * Which bucket a call falls into.
 *
 * Keyed off the mark rather than off keywords in English. The desktop had to
 * sniff substrings because all it held was a tool name; identity is already
 * resolved by the time a beat exists here, and a guess made from a label is the
 * exact mistake `tool-identity.ts` was written to end.
 */
const CATEGORY: Partial<Record<ToolKey, Category>> = {
  read: 'file', write: 'file', edit: 'file', files: 'file',
  artifact: 'file', data: 'file',
  search: 'search', knowledge: 'search', web: 'search',
  todo: 'plan',
}

function categoryOf(step: BurstStep): Category {
  return CATEGORY[step.tool] ?? 'command'
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * A one-vendor burst, described rather than counted.
 *
 * "Ran 4 commands" is true of four Zoho reads and says nothing; "Searched Zoho
 * Books" is the same four calls in the words somebody would use. Returns
 * undefined when the burst is not a single vendor — a mixed Gmail + Drive burst
 * has no one sentence, and the row of marks already says who was involved.
 *
 * Divo's own capabilities are excluded on purpose. "Checked Files" reads as a
 * product that does not exist; those fall through to the count, which is what
 * they are.
 */
function describeVendor(steps: readonly BurstStep[], running: boolean): string | undefined {
  const marks = new Set(steps.map(step => step.tool))
  if (marks.size !== 1) return undefined
  const only = [...marks][0]!
  const meta = tool(only)
  if (!meta || meta.own) return undefined

  const action = steps.find(step => step.action.trim())?.action ?? ''
  const verb = ACTION_VERBS.find(v => v.test.test(action.toLowerCase()))
  if (!verb) return `${running ? 'Using' : 'Used'} ${meta.app}`
  return `${running ? verb.present : verb.past} ${meta.app}`
}

/**
 * The folded line for a burst.
 *
 * A single-vendor burst describes itself; anything mixed falls back to counts,
 * with the plan called out by name because "ran 3 commands" is not what keeping
 * a checklist is.
 */
export function summarizeBurst(steps: readonly BurstStep[], running: boolean): string {
  const described = describeVendor(steps, running)
  if (described) return described

  let file = 0, search = 0, command = 0, plan = 0
  for (const step of steps) {
    const category = categoryOf(step)
    if (category === 'file') file += 1
    else if (category === 'search') search += 1
    else if (category === 'plan') plan += 1
    else command += 1
  }

  const pieces: string[] = []
  if (plan > 0) pieces.push(running ? 'Updating the plan' : 'Updated the plan')

  const explored: string[] = []
  if (file > 0) explored.push(plural(file, 'file'))
  if (search > 0) explored.push(plural(search, 'search', 'searches'))
  if (explored.length > 0) {
    pieces.push(`${running ? 'Exploring' : 'Explored'} ${explored.join(', ')}`)
  }

  /* The command tail stays lowercase "ran" even while the burst is live, so the
     line reads "Exploring 2 files, ran 1 command" rather than starting a second
     sentence in the middle of the first. */
  if (command > 0) pieces.push(`ran ${plural(command, 'command')}`)

  if (pieces.length === 0) {
    return `${running ? 'Running' : 'Ran'} ${plural(steps.length, 'step')}`
  }
  // A lone command piece leads the line, so it takes the capital back.
  if (pieces.length === 1 && command > 0 && plan === 0 && explored.length === 0) {
    return `${running ? 'Running' : 'Ran'} ${plural(command, 'command')}`
  }
  return pieces.join(', ')
}

/**
 * The distinct marks a folded burst touched.
 *
 * Presence, not volume: three Gmail calls are still one Gmail mark, because
 * what the folded row needs to say is "this touched Gmail", not how often. This
 * is also what anchors the burst's left edge in the same column a single row
 * gives its own mark — the log's left edge should be a column of marks, not a
 * column of arrows.
 */
export function burstMarks(steps: readonly BurstStep[], max = 4): {
  marks: ToolKey[]
  overflow: number
} {
  const seen: ToolKey[] = []
  for (const step of steps) if (!seen.includes(step.tool)) seen.push(step.tool)
  return { marks: seen.slice(0, max), overflow: Math.max(0, seen.length - max) }
}
