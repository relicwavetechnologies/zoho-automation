import type { NormalizedOutput } from '../output'
import type { SummarizeHints } from '../result'

/** The native input of a vendor call (e.g. Google's `args.input`). */
export type CardArgs = Record<string, unknown>

/** Present/past phrasing for a call's verb, e.g. "Searching" / "Searched". */
export type Verb = { present: string; past: string }

/**
 * Everything a card needs to say about ONE operation, beyond its verb.
 *
 * Pure and defensive: `subject`/`summary` receive possibly-empty input/output
 * and must return undefined rather than throw when a field is missing. The card
 * renders fine with neither — they sharpen a header that already stands alone.
 */
export type ToolDescriptor = {
  /** Overrides the verb inferred from the operation name (see `inferVerb`). */
  verb?: Verb
  /** The call's headline noun, from the request's native input. */
  subject?: (input: CardArgs) => string | undefined
  /** Noun for a result count, e.g. "message" → "5 messages". */
  countNoun?: string
  /** Action group, so writes headline their target rather than a count. */
  action?: SummarizeHints['action']
  /**
   * Overrides the generic result headline — used when the takeaway comes from
   * the REQUEST (e.g. "3 rows" from the rows being appended) rather than the
   * result body. Returns undefined to keep the generic summary.
   */
  summary?: (ctx: { input: CardArgs; output: NormalizedOutput }) => string | undefined
}

export type DescriptorTable = Record<string, ToolDescriptor>

/**
 * The verb for an operation whose descriptor sets none, inferred from its name.
 * Mirrors the action groups the backend assigns — search/read/list/send/create/
 * update/delete — so an unmapped operation still reads as a real action.
 */
export function inferVerb(op: string): Verb {
  const t = op.toLowerCase()
  if (/search|query|find/.test(t)) return { present: 'Searching', past: 'Searched' }
  if (/^list|list_/.test(t)) return { present: 'Listing', past: 'Listed' }
  if (/get|read|inspect|debug|check|export|describe|content|preview/.test(t)) {
    return { present: 'Reading', past: 'Read' }
  }
  if (/send|reply|post|message/.test(t)) return { present: 'Sending', past: 'Sent' }
  if (/draft/.test(t)) return { present: 'Drafting', past: 'Drafted' }
  if (/create|import|copy|add|insert|append|upload/.test(t)) {
    return { present: 'Creating', past: 'Created' }
  }
  if (/delete|remove|trash|archive/.test(t)) return { present: 'Deleting', past: 'Deleted' }
  if (/run|execute/.test(t)) return { present: 'Running', past: 'Ran' }
  if (/modify|update|move|resize|format|manage|replace|batch|set/.test(t)) {
    return { present: 'Updating', past: 'Updated' }
  }
  return { present: 'Using', past: 'Used' }
}

/** The action group for an operation name, for the summarizer's write/read split. */
export function inferAction(op: string): SummarizeHints['action'] {
  const t = op.toLowerCase()
  if (/search|query|find/.test(t)) return 'search'
  if (/send|reply|post/.test(t)) return 'send'
  if (/delete|remove|trash/.test(t)) return 'delete'
  if (/create|import|copy|add|insert|append|upload|draft/.test(t)) return 'create'
  if (/modify|update|move|resize|format|manage|replace|set|write/.test(t)) return 'update'
  if (/get|read|inspect|list|content|export|preview/.test(t)) return 'read'
  return 'other'
}
