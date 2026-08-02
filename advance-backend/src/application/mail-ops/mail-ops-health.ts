/**
 * Turns raw Mail Ops columns into a state a person can act on.
 *
 * The columns already record every failure this system has; nothing has ever
 * read them. The judgement of what they mean belongs here rather than in the
 * UI, so Lark notifications, the web screen, and any future operator view all
 * agree on when a mailbox is "dead" — and so the rules are unit-testable
 * without a database.
 *
 * Deliberately pure: no clock of its own, no I/O.
 */
import { parseMailRule } from './mail-rule.matcher';
import {
  WATCH_FAILURES_BEFORE_DEGRADED,
  type MailRuleActivity,
  type MailboxHealthRecord,
} from '../../infrastructure/persistence/mail-ops-read.repository';

/**
 * Ordered worst-first. A mailbox reports exactly one state, and the first
 * matching rule wins, because a user asking "why did my rules stop" wants the
 * root cause and not a list of symptoms.
 */
export type MailboxState =
  /** Nothing has ever worked here: no watch, and no successful sync either. */
  | 'never_started'
  /** Sync itself is failing — usually the Google connection. Rules cannot fire. */
  | 'sync_failing'
  /** The watch has failed enough times to stop calling it transient. */
  | 'watch_degraded'
  /**
   * The watch is not working but reconciliation is. Rules still fire, up to
   * the reconciliation interval late. Not worth waking anyone for.
   */
  | 'watch_delayed'
  /** No active rules, so the subscription was parked. */
  | 'paused'
  /** Registered, syncing, and has at least one active rule. */
  | 'healthy';

export interface MailboxHealth {
  subscriptionId: string;
  mailboxEmail: string;
  state: MailboxState;
  /** True when rules on this mailbox cannot fire at all right now. */
  rulesCanFire: boolean;
  /** One sentence, addressed to the mailbox owner. */
  summary: string;
  /** What the owner can actually do about it, when there is something. */
  remedy: string | null;
  activeRuleCount: number;
  lastSucceededAt: Date | null;
  lastSignalAt: Date | null;
  watchExpirationAt: Date | null;
  /** Machine-readable provider code, for support rather than display. */
  failureCode: string | null;
}

export function assessMailbox(record: MailboxHealthRecord): MailboxHealth {
  const base = {
    subscriptionId: record.subscriptionId,
    mailboxEmail: record.mailboxEmail,
    activeRuleCount: record.activeRuleCount,
    lastSucceededAt: record.lastSucceededAt,
    lastSignalAt: record.lastSignalAt,
    watchExpirationAt: record.watchExpirationAt,
    failureCode: record.watchFailureCode ?? record.failureCode,
  };

  // Checked before `paused`: a mailbox that has never worked at all is broken
  // whether or not anyone has since paused its rules, and saying "paused"
  // would hide it.
  //
  // The test is both signals, not just the watch. Reconciliation no longer
  // depends on a registered watch, so a mailbox with no watch but a successful
  // sync behind it is late, not dead — and calling that "never started" would
  // send someone chasing an outage that is not happening.
  if (!record.watchRegisteredAt && !record.lastSucceededAt) {
    return {
      ...base,
      state: 'never_started',
      rulesCanFire: false,
      summary:
        `Divo has never been able to start watching ${record.mailboxEmail}, `
        + 'so none of its rules have ever run.',
      remedy: remedyForFailure(record.watchFailureCode)
        ?? 'This needs a Divo operator — the mail service has not accepted the connection.',
    };
  }

  // Sync failure outranks any watch problem: this is the one that actually
  // stops mail, where a broken watch only slows it down.
  if (record.failureCode) {
    return {
      ...base,
      state: 'sync_failing',
      rulesCanFire: false,
      summary: `Divo cannot read new mail in ${record.mailboxEmail} right now.`,
      remedy: remedyForFailure(record.failureCode),
    };
  }

  // Ahead of the watch states, and deliberately after `never_started`. A
  // parked mailbox has no active rules, so the state of its notifications is
  // not something to report — saying "rules still run on the hourly check"
  // about a mailbox running no rules is simply untrue.
  if (record.status !== 'active' || record.activeRuleCount === 0) {
    return {
      ...base,
      state: 'paused',
      rulesCanFire: false,
      summary: `No rules are running on ${record.mailboxEmail}.`,
      remedy: record.totalRuleCount > 0
        ? 'Resume a rule to start watching this mailbox again.'
        : null,
    };
  }

  if (record.watchFailureCode || !record.watchRegisteredAt) {
    const degraded = record.watchFailureCount >= WATCH_FAILURES_BEFORE_DEGRADED;
    return {
      ...base,
      state: degraded ? 'watch_degraded' : 'watch_delayed',
      // True in both cases. Reconciliation is running, so the rules work —
      // this is a latency fault, and reporting it as an outage would be the
      // same class of lie the rest of this wave is removing.
      rulesCanFire: true,
      summary: degraded
        ? `Divo has stopped receiving instant mail notifications for ${record.mailboxEmail}. `
          + 'Rules still run, but up to an hour after the mail arrives.'
        : `Instant mail notifications for ${record.mailboxEmail} are not working. `
          + 'Rules still run on the hourly check while Divo retries.',
      remedy: degraded
        ? remedyForFailure(record.watchFailureCode)
          ?? 'This needs a Divo operator — the mail service is refusing the notification setup.'
        : null,
    };
  }

  return {
    ...base,
    state: 'healthy',
    rulesCanFire: true,
    summary:
      `Watching ${record.mailboxEmail} for `
      + `${record.activeRuleCount} rule${record.activeRuleCount === 1 ? '' : 's'}.`,
    remedy: null,
  };
}

/**
 * Failure codes are assigned by the worker from provider errors. Only codes we
 * can give honest advice for get a remedy; the rest return null rather than a
 * guess, because a wrong instruction is worse than none.
 */
function remedyForFailure(code: string | null): string | null {
  switch (code) {
    case 'scope_missing':
      return 'Reconnect Google and allow Divo to read and send mail.';
    case 'connection_unavailable':
      return 'Your Google connection is no longer valid. Reconnect it to resume.';
    case 'provider_rate_limited':
      return 'Google is rate-limiting this mailbox. Divo keeps retrying — no action needed yet.';
    case 'authorization_unavailable':
      // Nothing on the member's side is wrong, and telling them to reconnect
      // Google would send them to fix an account that is working.
      return 'This is a problem inside Divo, not with your account. It retries automatically.';
    default:
      return null;
  }
}

export type MailRuleState =
  /** Stored in a shape the current matcher rejects, so it matches nothing. */
  | 'broken'
  /** Active, but its mailbox cannot deliver right now. */
  | 'blocked'
  | 'paused'
  | 'archived'
  /** Active and has delivered at least once. */
  | 'working'
  /** Active and healthy, but nothing has matched yet. */
  | 'waiting';

export interface MailRuleHealth {
  state: MailRuleState;
  summary: string;
  /** Present when the stored rule no longer parses. */
  invalidReason: string | null;
}

export function assessRule(
  rule: Pick<
    MailRuleActivity,
    'status' | 'match' | 'action' | 'destination' | 'lastDeliveredAt'
    | 'abandonedCount' | 'blockedCount' | 'lastBlockedAt' | 'blockedReason'
    | 'lastError'
  >,
  mailbox: Pick<MailboxHealth, 'rulesCanFire' | 'state'> | undefined,
): MailRuleHealth {
  if (rule.status === 'archived') {
    return {
      state: 'archived',
      summary: 'Archived. It cannot be resumed — create a new rule instead.',
      invalidReason: null,
    };
  }

  // Validity is checked before status so a paused rule still reports that it
  // would not work if resumed.
  const invalidReason = validationFailure(rule);
  if (invalidReason) {
    return {
      state: 'broken',
      summary:
        'This rule is stored in a form Divo can no longer match, so it is not '
        + 'firing. Update it to fix.',
      invalidReason,
    };
  }

  if (rule.status === 'paused') {
    return { state: 'paused', summary: 'Paused.', invalidReason: null };
  }

  // Ahead of the mailbox check: this rule is refused on its own terms, and
  // fixing the mailbox would not change it. Reported before "waiting", which
  // is what a refused rule looked like for as long as refusals went unrecorded.
  //
  // Gated on the refusal being the *latest* evidence, not merely present in
  // the 30-day window. Access can be taken away and given back; a rule that
  // has delivered since is working, and calling it blocked contradicts the
  // delivery count sitting next to it.
  if (rule.blockedCount > 0 && isCurrentlyRefused(rule)) {
    return {
      state: 'blocked',
      summary:
        `${rule.blockedCount} matching message`
        + `${rule.blockedCount === 1 ? ' was' : 's were'} not sent because `
        + 'Divo is no longer allowed to act on this rule. '
        + (rule.blockedReason ?? ''),
      invalidReason: null,
    };
  }

  if (mailbox && !mailbox.rulesCanFire) {
    return {
      state: 'blocked',
      summary: 'Active, but its mailbox is not being watched right now.',
      invalidReason: null,
    };
  }

  if (rule.lastDeliveredAt) {
    return {
      state: 'working',
      summary: rule.abandonedCount > 0
        ? `Working, but ${rule.abandonedCount} message`
          + `${rule.abandonedCount === 1 ? '' : 's'} could not be delivered.`
        : 'Working.',
      invalidReason: null,
    };
  }

  return {
    state: 'waiting',
    summary: rule.abandonedCount > 0
      ? 'No mail has been delivered yet, and delivery has failed. '
        + (rule.lastError ?? '')
      : 'Active. No matching mail has arrived yet.',
    invalidReason: null,
  };
}

/**
 * Whether the refusal is still the last thing that happened to this rule.
 *
 * A rule with no successful delivery at all stays blocked; one that delivered
 * after the refusal has plainly recovered.
 */
function isCurrentlyRefused(rule: {
  lastDeliveredAt: Date | null;
  lastBlockedAt: Date | null;
}): boolean {
  if (!rule.lastBlockedAt) return false;
  if (!rule.lastDeliveredAt) return true;
  return rule.lastBlockedAt > rule.lastDeliveredAt;
}

/** Mirrors what the worker does at match time, so the two cannot disagree. */
function validationFailure(rule: {
  match: Record<string, unknown>;
  action: Record<string, unknown>;
  destination: Record<string, unknown>;
}): string | null {
  try {
    parseMailRule(rule);
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return reason.slice(0, 500);
  }
}

/**
 * States that are worth interrupting someone over.
 *
 * `watch_delayed` is deliberately absent. Rules still fire in that state, just
 * late, and Divo is already retrying — telling someone about a fault that is
 * probably gone in fifteen minutes is how an alert channel gets muted.
 */
const NOTIFIABLE: ReadonlySet<MailboxState> = new Set<MailboxState>([
  'never_started',
  'sync_failing',
  'watch_degraded',
]);

/**
 * Whether a mailbox transition is worth interrupting someone over.
 *
 * Only the transition into a notifiable state notifies. Staying broken does
 * not re-notify, because an alert that repeats every ten seconds is the same
 * as no alert.
 */
export function shouldNotifyMailbox(
  previous: MailboxState | null,
  current: MailboxState,
): boolean {
  if (!NOTIFIABLE.has(current)) return false;
  return previous !== current;
}
