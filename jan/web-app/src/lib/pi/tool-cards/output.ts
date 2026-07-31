/**
 * Normalising a tool call's *result* into something a card can read.
 *
 * Unlike the request (which Divo shapes and always controls — see
 * `invoke-args.ts`), the result is whatever the external MCP server chose to
 * return. Across the Google Workspace tools that is usually the MCP standard
 * shape `{ content: [{ type: 'text', text }] }`, but it can also be a bare
 * string, a plain object, or an array. This flattens all of them to:
 *
 *   - `text`  — the human-readable body, if there is one (for a count/preview)
 *   - `raw`   — a pretty-printed form for the "view raw" footer
 *
 * Everything here is best-effort and non-throwing: a card's header is built
 * from the request and stands on its own, so a result we can't read just means
 * no bonus summary line, never a broken card.
 */

export type NormalizedOutput = {
  /** The result's text body, when one could be found. */
  text: string | null
  /**
   * The structured form of the result (parsed object/array), when it is one.
   * Lets the summarizer walk a result that carried no MCP text envelope.
   */
  value: unknown
  /** A pretty-printed form of the whole result, for the raw disclosure. */
  raw: string
  /** True when there is genuinely no output yet (call still running). */
  empty: boolean
}

function stringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Concatenate the `text` items of an MCP content array, if that's what this is.
 * Returns null for any other shape so the caller can keep looking.
 */
function textFromContentArray(value: unknown): string | null {
  const content =
    value && typeof value === 'object' && 'content' in value
      ? (value as { content?: unknown }).content
      : null
  if (!Array.isArray(content)) return null

  const parts = content
    .filter(
      (item): item is { type?: string; text?: string } =>
        !!item && typeof item === 'object'
    )
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)

  return parts.length ? parts.join('\n').trim() : null
}

export function normalizeToolOutput(output: unknown): NormalizedOutput {
  if (output === null || output === undefined || output === '') {
    return { text: null, value: null, raw: '', empty: true }
  }

  if (typeof output === 'string') {
    const trimmed = output.trim()
    // A JSON string is common; unwrap it so the raw view is pretty and the
    // text extraction can see an MCP content array inside.
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return {
        text: textFromContentArray(parsed) ?? (typeof parsed === 'string' ? parsed : null),
        value: parsed && typeof parsed === 'object' ? parsed : null,
        raw: stringifySafe(parsed),
        empty: false,
      }
    } catch {
      return { text: trimmed, value: null, raw: trimmed, empty: trimmed.length === 0 }
    }
  }

  return {
    text: textFromContentArray(output),
    value: output && typeof output === 'object' ? output : null,
    raw: stringifySafe(output),
    empty: false,
  }
}

/** Countable result nouns an MCP might trail a number with. */
const COUNT_NOUNS =
  'messages?|results?|files?|folders?|rows?|events?|items?|matches?|threads?|' +
  'documents?|docs?|contacts?|tasks?|comments?|labels?|records?|entries|calendars?'

/**
 * A result count in a text body, e.g. Gmail's "Found 5 messages" or
 * "3 results". Returns the number so a card can say "5 messages" without
 * hard-coding each MCP's exact wording.
 *
 * Deliberately conservative — a bare number is ignored (it is as likely a year
 * inside a date as a count). A match needs either an explicit lead verb
 * ("Found N", "Returned N") or a countable noun right after the number, so a
 * timestamp in the body can't be mistaken for a tally.
 */
export function detectCount(text: string | null): number | undefined {
  if (!text) return undefined
  const lead = text.match(/\b(?:found|returned|showing|listing|got|total(?:ing|ed)?)\s+(\d{1,6})\b/i)
  const trailing = text.match(new RegExp(`\\b(\\d{1,6})\\s+(?:${COUNT_NOUNS})\\b`, 'i'))
  const raw = lead?.[1] ?? trailing?.[1]
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : undefined
}
