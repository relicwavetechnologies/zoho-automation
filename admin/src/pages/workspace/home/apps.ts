/**
 * The apps under the composer, and what pressing one types.
 *
 * The tray used to hold four verbs — Export, Compare, Draft, Investigate — the
 * same four the placeholder already names, so it said the thing directly above
 * it twice. What it never said is the part a person cannot guess: *what Divo
 * can reach on their behalf*. That is what a row of app marks says at a glance
 * and a sentence cannot.
 *
 * One connection is not one chip. A Google Workspace connection is Gmail and
 * Drive and Calendar and Sheets — four different jobs behind one consent
 * screen — and a single Google mark would leave somebody wondering which of
 * them Divo has. Zoho splits the same way, into Books and CRM.
 *
 * These are derived from the connections this person actually has. That is the
 * whole of what makes it honest: the row is empty for a workspace with nothing
 * connected rather than advertising six apps it cannot open, and it grows on
 * its own as somebody finishes onboarding. Note what a chip does *not* do — it
 * types a word into a box the person can still edit. It is not a button that
 * runs anything, so it promises nothing about scopes; if the grant is narrower
 * than the mark suggests, Divo says so in the reply, which is where a refusal
 * belongs.
 */
import type { BrandKey } from '@/components/admin/brand-catalog'
import type { Provider } from '../fixtures'

export type AppChip = {
  readonly key: BrandKey
  /**
   * Short, because it sits beside its own logo.
   *
   * "Drive" under the Drive mark is unambiguous; "Google Drive" is the mark
   * spelled out, and four of those do not fit a row anybody would read.
   */
  readonly label: string
}

/**
 * What each connection puts in the tray, in the order Divo is most often asked
 * for it. Mail first because that is what people bring Divo to.
 */
const PER_PROVIDER: Readonly<Record<Provider, readonly AppChip[]>> = {
  google_workspace: [
    { key: 'gmail', label: 'Gmail' },
    { key: 'googleDrive', label: 'Drive' },
    { key: 'googleSheets', label: 'Sheets' },
    { key: 'googleCalendar', label: 'Calendar' },
  ],
  lark: [{ key: 'lark', label: 'Lark' }],
  zoho: [
    { key: 'zohoBooks', label: 'Books' },
    { key: 'zohoCrm', label: 'CRM' },
  ],
  canva: [{ key: 'canva', label: 'Canva' }],
  airtable: [{ key: 'airtable', label: 'Airtable' }],
  aitable: [{ key: 'aitable', label: 'AITable' }],
}

/**
 * The tray, for a person with these connections.
 *
 * The provider order is the caller's, so the row follows whatever order the
 * page already lists connections in rather than inventing a second one.
 */
export function appChips(connected: readonly Provider[]): AppChip[] {
  return connected.flatMap((provider) => PER_PROVIDER[provider] ?? [])
}

/** How an app is named in the box. */
export function referenceFor(chip: AppChip): string {
  return `@${chip.label}`
}

/**
 * The draft with an app named in it.
 *
 * Appended rather than replacing, so pressing one halfway through a sentence
 * does not throw the sentence away — and never twice, because a box reading
 * "@Gmail @Gmail" is a person pressing a chip that appeared to do nothing the
 * first time. A draft that already names the app is left exactly as it is.
 */
export function withReference(draft: string, chip: AppChip): string {
  const reference = referenceFor(chip)
  if (draft.includes(reference)) return draft
  const before = draft.trimEnd()
  return before ? `${before} ${reference} ` : `${reference} `
}
