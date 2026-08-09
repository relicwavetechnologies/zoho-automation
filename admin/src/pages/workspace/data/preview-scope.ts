/**
 * Turning a dry run's counts into a sentence that cannot be misread.
 *
 * `Read 11 · none matched` is a true statement that reads as a broken rule.
 * Eleven may be every message Divo has ever recorded for the mailbox — the
 * conditions could be perfect and there is simply nothing there to catch yet —
 * and it may equally be the replay's own ceiling, in which case "none matched"
 * is a claim about the recent past and not about the mailbox at all. The count
 * alone cannot tell those two apart, and they mean opposite things.
 *
 * Its own module because it is the one piece of this screen that is pure, and
 * the branch that is wrong is the one nobody looks at: an empty archive.
 */

export type PreviewScope = {
  consideredCount: number
  /** The oldest message the replay reached, ISO. Absent when it read nothing. */
  coversSince?: string
  /** True when the replay stopped at its ceiling rather than running out of mail. */
  truncated?: boolean
}

/** Short and unambiguous — "2 Aug", not a locale's numeric guess at 8/2. */
export function previewDay(iso: string, locale?: string): string {
  return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}

export function previewScopeSentence(result: PreviewScope, locale?: string): string {
  // Said first, because with nothing stored every other phrasing implies the
  // conditions were tested against something.
  if (result.consideredCount === 0) return 'Divo has recorded nothing for this inbox yet.'

  const since = result.coversSince ? `, back to ${previewDay(result.coversSince, locale)}` : ''

  return result.truncated
    // Never "all" here. At the ceiling there is older mail this did not see,
    // and a member who reads "all" stops looking for the message they expected.
    ? `Read the ${result.consideredCount} most recent${since}. There may be older mail this did not reach.`
    : `Read all ${result.consideredCount} Divo has stored${since}.`
}
