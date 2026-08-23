/**
 * The apps named inside a draft, found in the text rather than tracked beside it.
 *
 * `@Gmail` is typed, pasted, edited and deleted like any other characters, so
 * there is nowhere else for the truth about it to live. A parallel list of
 * "mentions this message has" would go out of step the first time somebody
 * backspaced through one, and the draft would still say `@Gmai`.
 *
 * Two vocabularies write into the same box and both have to be understood here.
 * The composer's own `@` picker writes the full product name (`@Google
 * Sheets`), and the app tray under Home writes the short one (`@Sheets`),
 * because a row of four chips reading "Google …" four times is unreadable.
 * Neither is wrong and neither is going away, so this knows both.
 */
import type { ToolKey } from './tools'

/**
 * A name that can follow an `@`, and the mark it earns.
 *
 * `key` is null for an app Divo can reach that has no mark in `tools.tsx`. It
 * still highlights: the pebble says "this is an app", and the mark says which
 * one, and the first of those is true whether or not the second can be drawn.
 */
type Known = { readonly name: string; readonly key: ToolKey | null }

const KNOWN: readonly Known[] = [
  /* Full names, as the composer's picker writes them. */
  { name: 'Gmail', key: 'gmail' },
  { name: 'Google Sheets', key: 'sheets' },
  { name: 'Google Drive', key: 'drive' },
  { name: 'Google Calendar', key: 'calendar' },
  { name: 'Google Docs', key: 'docs' },
  { name: 'Zoho Books', key: 'zohoBooks' },
  { name: 'Zoho CRM', key: 'zohoCrm' },
  { name: 'Web search', key: 'web' },
  /* Short names, as the app tray and the signed-out rail write them. */
  { name: 'Sheets', key: 'sheets' },
  { name: 'Drive', key: 'drive' },
  { name: 'Calendar', key: 'calendar' },
  { name: 'Docs', key: 'docs' },
  { name: 'Books', key: 'zohoBooks' },
  { name: 'CRM', key: 'zohoCrm' },
  /* Named the same either way. */
  { name: 'Lark', key: 'lark' },
  { name: 'Airtable', key: 'airtable' },
  { name: 'Canva', key: 'canva' },
  { name: 'Semrush', key: 'semrush' },
  { name: 'Shopify', key: 'shopify' },
  { name: 'AITable', key: null },
]

/* Longest first, so `@Google Sheets` is one mention and not `@Google` followed
   by the word "Sheets". Sorted once at module load rather than per keystroke. */
const BY_LENGTH: readonly Known[] = [...KNOWN].sort((a, b) => b.name.length - a.name.length)

/*
 * The colour a mention wears now lives in `pebble.ts`, because a link in the
 * transcript and a step in the landing reel wear the same one. Re-exported here
 * so a caller that already has a mention in hand does not have to know that.
 */
export { tintFor } from './pebble'

export type Run =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; name: string; key: ToolKey | null }

/** A letter or digit. A mention cannot start or end in the middle of a word. */
function wordish(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char)
}

/**
 * The draft, split into what to draw plainly and what to draw as an app.
 *
 * Concatenating every run's `text` gives back the input exactly, which is not a
 * nicety: the caller draws these behind a real textarea holding the same
 * string, and a single character added or dropped here slides the caret out of
 * line with the letters under it for the rest of the message.
 */
export function splitMentions(draft: string): Run[] {
  const runs: Run[] = []
  let plain = ''
  let i = 0

  const flush = (): void => {
    if (!plain) return
    runs.push({ kind: 'text', text: plain })
    plain = ''
  }

  while (i < draft.length) {
    if (draft[i] !== '@' || wordish(draft[i - 1])) {
      plain += draft[i]
      i += 1
      continue
    }
    const found = matchAt(draft, i + 1)
    if (!found) {
      plain += draft[i]
      i += 1
      continue
    }
    flush()
    runs.push({
      kind: 'mention',
      text: `@${draft.slice(i + 1, i + 1 + found.name.length)}`,
      name: found.name,
      key: found.key,
    })
    i += 1 + found.name.length
  }

  flush()
  return runs
}

/**
 * Whether the tile at `index` has another one a single space away, either side.
 *
 * The tile pays for its padding out of the space beside it, and between two
 * tiles there is exactly one space to share — 3.8px at the field's size, against
 * 4.3px each tile would take. Anywhere else, before a word or at the end of a
 * line, the padding costs nothing.
 *
 * Both directions, and both tiles in a pair tighten. Marking only the first left
 * the second still pushing a full pad into the shared space from the other side,
 * and the two overlapped by 1.7px. A pair reads as a pair; they give way
 * together.
 *
 * A question about the draft, answered where the draft is understood, rather
 * than a DOM trick in the stylesheet. CSS can see that two spans are adjacent
 * siblings; it cannot see that the only thing between them is one space.
 */
export function crowded(runs: readonly Run[], index: number): boolean {
  if (runs[index]?.kind !== 'mention') return false
  return oneSpaceApart(runs, index, 1) || oneSpaceApart(runs, index, -1)
}

/** A mention exactly one space away in `direction`. */
function oneSpaceApart(runs: readonly Run[], index: number, direction: 1 | -1): boolean {
  const between = runs[index + direction]
  if (between?.kind !== 'text' || between.text !== ' ') return false
  return runs[index + direction * 2]?.kind === 'mention'
}

/** The longest known name sitting at `from`, if any. */
function matchAt(draft: string, from: number): Known | null {
  for (const candidate of BY_LENGTH) {
    const slice = draft.slice(from, from + candidate.name.length)
    if (slice.toLowerCase() !== candidate.name.toLowerCase()) continue
    /* `@Larkspur` is a word, not a mention of Lark. */
    if (wordish(draft[from + candidate.name.length])) continue
    return candidate
  }
  return null
}

/** Every app named in the draft, in the order they first appear. */
export function mentionedApps(draft: string): { name: string; key: ToolKey | null }[] {
  const seen = new Set<string>()
  const apps: { name: string; key: ToolKey | null }[] = []
  for (const run of splitMentions(draft)) {
    if (run.kind !== 'mention' || seen.has(run.name)) continue
    seen.add(run.name)
    apps.push({ name: run.name, key: run.key })
  }
  return apps
}
