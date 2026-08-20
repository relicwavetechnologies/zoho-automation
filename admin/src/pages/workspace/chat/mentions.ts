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

/**
 * The colour a mention wears, per app.
 *
 * Taken from the real marks in `components/brand-icons.tsx` rather than
 * invented, so a Lark pebble is Lark's blue and a Zoho Books pebble is Zoho's.
 * Where a logo is genuinely several colours, this picks the one that
 * identifies it fastest *and* keeps it apart from its neighbours: Drive gets
 * its yellow rather than its green, because Sheets already owns green and two
 * green pebbles side by side say less than one green and one yellow.
 *
 * Null for an app with no vendor colour. Those fall back to plain ink, which is
 * the same rule `tools.tsx` uses for Divo's own capabilities.
 */
const TINT: Partial<Record<NonNullable<ToolKey>, string>> = {
  gmail: '#EA4335',       // the red in the Gmail M
  sheets: '#0F9D58',      // Sheets green
  drive: '#FFBA00',       // Drive's yellow arm
  calendar: '#4285F4',    // Calendar blue
  docs: '#2684FC',        // Docs blue
  zohoBooks: '#226DB4',   // Zoho blue
  zohoCrm: '#E42527',     // Zoho red
  lark: '#4C6FFB',        // Lark blue
  airtable: '#18BFFF',    // Airtable cyan, not its red — Gmail has the red
  canva: '#7D2AE8',       // Canva purple
  semrush: '#FF642D',     // Semrush orange
  shopify: '#95BF47',     // Shopify green
}

/** The app's own colour, or null for one that has none. */
export function tintFor(key: ToolKey | null): string | null {
  if (!key) return null
  return TINT[key] ?? null
}

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
    /*
     * The space after the app comes with it.
     *
     * Not a trick — it is the only real horizontal room this design has. The
     * pebble must span exactly the advance width of what it covers, because the
     * mirror it is drawn on has to keep pace with the textarea underneath,
     * character for character. So padding cannot be added on that side; it can
     * only be found in characters that are already there and have no ink in
     * them.
     *
     * The space is one of those. Painting the pebble over it moves nothing and
     * costs nothing, and it is worth three and a half pixels — more than twice
     * what the shadow can spare.
     */
    const after = i + 1 + found.name.length
    const trailing = draft[after] === ' ' ? ' ' : ''
    runs.push({
      kind: 'mention',
      text: `@${draft.slice(i + 1, after)}${trailing}`,
      name: found.name,
      key: found.key,
    })
    i = after + trailing.length
  }

  flush()
  return runs
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
