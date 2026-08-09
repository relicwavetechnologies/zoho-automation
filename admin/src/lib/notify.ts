/**
 * One place that decides how Divo interrupts you.
 *
 * Every surface reached for `toast.error` with whatever string it had, so the
 * same three situations arrived in three voices: a refusal came through as
 * "Error 403", a missing connection as a raw provider sentence, and a genuine
 * fault as the same red as both. A status code is not a message — the person
 * reading it can act on exactly one of those three, and could not tell which.
 *
 * So the intent is named at the call site and the wording is decided here:
 *
 *   refused   you are not allowed to, and retrying will not help
 *   missing   Divo needs something connected or configured first
 *   failed    it went wrong and trying again is reasonable
 *   done      it worked, and the change is not visible on screen
 *
 * `done` is deliberately rare. A toast confirming something the screen already
 * shows is the same news twice, and a person who is shown everything twice
 * stops reading either.
 */
import { toast } from 'sonner'

/** Trimmed so a stack trace or an HTML error page cannot become the message. */
const detail = (text?: string | null): string | undefined => {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return undefined
  if (/<\/?[a-z][\s\S]*>/i.test(trimmed)) return undefined
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed
}

const DURATION = {
  /** Long enough to read a remedy, short enough not to sit over the page. */
  actionable: 6_000,
  brief: 4_000,
} as const

export const notify = {
  /**
   * Not allowed. Never phrased as a failure — nothing went wrong, and telling
   * somebody to try again when the answer will not change wastes their time.
   */
  refused(what: string, why?: string | null) {
    toast.error(what, { description: detail(why), duration: DURATION.actionable })
  },

  /**
   * Something has to be connected or set up first. A warning rather than an
   * error, because this is a step the person can take.
   */
  missing(what: string, how?: string | null) {
    toast.warning(what, { description: detail(how), duration: DURATION.actionable })
  },

  /** It broke. Retrying is reasonable, so the wording says so. */
  failed(what: string, why?: string | null) {
    toast.error(what, { description: detail(why), duration: DURATION.actionable })
  },

  /** It worked, and nothing on screen already says so. */
  done(what: string, detailText?: string | null) {
    toast.success(what, { description: detail(detailText), duration: DURATION.brief })
  },

  /**
   * Allowed, and worth knowing before you commit to it.
   *
   * Its own intent because the other four are all about something being wrong.
   * "This forward leaves your company, so your manager is asked first" is not a
   * refusal, not a missing step and not a fault — it is the shape of what you
   * are about to turn on. Given a red dot it would read as a blocker; given
   * none it would not be read at all.
   */
  heads(what: string, why?: string | null) {
    toast.info(what, { description: detail(why), duration: DURATION.actionable })
  },

  /** Session gone. Its own case because the remedy is always the same one. */
  signedOut() {
    toast.error('Your session has expired', {
      description: 'Sign in again to continue.',
      duration: DURATION.actionable,
    })
  },
}

/**
 * The right intent for an HTTP status, so a caller does not have to guess.
 *
 * 403 and 404 are not failures and must not be red-with-retry: one is a
 * boundary and the other is a thing that is not there. 5xx is the only family
 * where "try again" is honest advice.
 */
export function notifyForStatus(status: number, message?: string | null): void {
  if (status === 401) return notify.signedOut()
  if (status === 403) return notify.refused('You do not have access to that', message)
  if (status === 404) return notify.missing('Divo could not find that', message)
  if (status === 409) return notify.refused('That conflicts with something already there', message)
  if (status === 422 || status === 400) return notify.refused('Divo could not accept that', message)
  if (status === 429) return notify.failed('Too many requests just now', 'Wait a moment and try again.')
  return notify.failed('Something went wrong', message)
}
