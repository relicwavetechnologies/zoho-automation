/**
 * Hold one fixture decision open in the real chat, on purpose.
 *
 * The decision card is the hardest surface in the product to look at while
 * building it. It appears only when an agent run happens to need a person, on
 * whichever product that run happened to touch, and it goes away the moment it
 * is answered. Designing it by triggering real approvals is not a loop anybody
 * can iterate in.
 *
 * `/preview/decisions` shows every variant side by side, which is right for
 * comparing them. This is the other half: one variant pinned into the composer
 * slot of the actual chat, at the real width, above the real thread, so the
 * swap that replaces the composer can be judged where it happens.
 *
 * Development builds only. Guarded the same way as the preview routes, and for
 * the stronger reason: this one returns a decision that does not exist, and a
 * production reader offered a card they cannot answer would be a bug that looks
 * like data loss.
 */
import { DECISION_FIXTURES } from './preview'
import type { Decision } from './decision'

/** The query parameter that pins one. `?card=gmail-send`, or `?card=1`. */
export const PINNED_PARAM = 'card'

/**
 * The fixture named in the URL, addressed into this thread.
 *
 * `threadId` is rewritten to the open thread because that is the field the chat
 * filters on. A fixture carrying its own null would be dropped by exactly the
 * rule that stops a colleague's Lark approval from taking over the composer,
 * and the pin would silently do nothing.
 *
 * Accepts an id or a 1-based index, because typing `?card=3` while comparing
 * variants beats remembering which slug is which.
 */
export function pinnedDecision(search: string, threadId: string | null): Decision | null {
  if (!import.meta.env.DEV) return null
  const wanted = new URLSearchParams(search).get(PINNED_PARAM)
  if (!wanted) return null

  const index = Number.parseInt(wanted, 10)
  const fixture = Number.isFinite(index) && String(index) === wanted
    ? DECISION_FIXTURES[index - 1]
    : DECISION_FIXTURES.find((entry) => entry.id === wanted)
  if (!fixture) return null

  return { ...fixture, threadId }
}

/** Every id a reader can pin, for the hint shown when the name matches nothing. */
export function pinnableIds(): string[] {
  return DECISION_FIXTURES.map((fixture) => fixture.id)
}
