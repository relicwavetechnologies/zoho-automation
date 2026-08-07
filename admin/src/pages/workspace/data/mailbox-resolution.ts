/**
 * Which Google account a mail rule can be built on, and what to say when none
 * can.
 *
 * Kept apart from `use-mail-automations` for the same reason `connection-policy`
 * is kept apart from `use-connections`: none of it needs React or a token, so it
 * can be tested directly. That matters more than usual here. Four of the five
 * answers are refusals, each sending somebody to a different remedy, and a
 * wrong one is invisible — the page renders an equally confident sentence
 * either way and the member goes off to fix the wrong thing.
 */
import type { LiveConnection } from './use-connections'
import type { MailboxHealth } from './use-mail-automations'

/**
 * Usable right now. The only account any action may be run against.
 *
 * `reconnectRequired` is absent for every provider that cannot report it, which
 * is why this is `!== true` rather than a truthiness test — an unknown has to
 * read as working, or every non-Google account would be refused.
 */
export const isLive = (connection: LiveConnection): boolean =>
  connection.reconnectRequired !== true

export type MailboxOption = {
  connectionId: string
  /** The address, or the connection's label when Google gave us no email. */
  accountEmail: string
  accountName: string | null
  access: string
  /** A subscription already exists, i.e. Divo is watching this inbox today. */
  watched: boolean
  activeRuleCount: number
}

export type MailboxResolution =
  | { status: 'loading' }
  /** No Google account you own. `none_accessible`. */
  | { status: 'none' }
  /** Owned, but shared read-only or missing Gmail scopes. `insufficient_access`. */
  | { status: 'insufficient'; options: MailboxOption[] }
  /**
   * Owned and permitted, but Google ended the authorisation. Its own state
   * because the remedy is neither "connect Google" nor "ask for more access" —
   * it is signing in again to an account already sitting in the list.
   */
  | { status: 'reconnect'; options: MailboxOption[] }
  | { status: 'one'; option: MailboxOption }
  /** `google_workspace_connection_selection_required`. */
  | { status: 'choose'; options: MailboxOption[] }

/**
 * Read, watch and send. A connection shared with this person read-only can be
 * used to look at mail and not to forward any, which is a different problem
 * from having no account and has a different remedy — so it is not filtered
 * away silently, it is reported as its own state.
 */
const canRunMail = (connection: LiveConnection): boolean =>
  connection.ownerType === 'user' && connection.access !== 'read_only'

function toOption(connection: LiveConnection, mailboxes: readonly MailboxHealth[]): MailboxOption {
  const email = connection.accountEmail ?? connection.label
  const health = mailboxes.find(
    (m) => m.mailboxEmail.toLowerCase() === email.toLowerCase(),
  )
  return {
    connectionId: connection.connectionId,
    accountEmail: email,
    accountName: connection.accountName,
    access: connection.access,
    watched: health !== undefined,
    activeRuleCount: health?.activeRuleCount ?? 0,
  }
}

/** Which of five answers this person's Google accounts add up to. */
export function resolveMailboxes(
  connections: readonly LiveConnection[],
  mailboxes: readonly MailboxHealth[],
): Exclude<MailboxResolution, { status: 'loading' }> {
  const owned = connections.filter((c) => c.ownerType === 'user')
  /*
   * A revoked account is removed before anything else is decided.
   *
   * It reads as fully eligible — owned, read_write, Gmail scopes and all —
   * because every one of those was true when it was connected and none of
   * them is what broke. Left in, it becomes the single `one` option and the
   * wizard walks somebody through building a rule on a mailbox that cannot be
   * watched, ending in a rule that never fires.
   */
  const live = owned.filter(isLive)
  const usable = live.filter(canRunMail)

  if (usable.length === 0) {
    // Ordered so the fixable-by-signing-in case wins: somebody whose only
    // account was revoked is told to reconnect that account, not to grant it
    // access it already has or to connect a second one.
    if (live.length === 0 && owned.length > 0) {
      return { status: 'reconnect', options: owned.map((c) => toOption(c, mailboxes)) }
    }
    return live.length > 0
      ? { status: 'insufficient', options: live.map((c) => toOption(c, mailboxes)) }
      : { status: 'none' }
  }

  const options = usable.map((c) => toOption(c, mailboxes))
  // Watched inboxes first: somebody with two accounts almost always means the
  // one Divo is already working on, and it is the only ordering here that
  // carries information rather than reproducing whatever Google returned.
  options.sort((a, b) => Number(b.watched) - Number(a.watched))

  return options.length === 1 ? { status: 'one', option: options[0]! } : { status: 'choose', options }
}
