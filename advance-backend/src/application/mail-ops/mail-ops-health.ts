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
import type {
  MailRuleActivity,
  MailboxHealthRecord,
} from '../../infrastructure/persistence/mail-ops-read.repository';

/**
 * Ordered worst-first. A mailbox reports exactly one state, and the first
 * matching rule wins, because a user asking "why did my rules stop" wants the
 * root cause and not a list of symptoms.
 */
export type MailboxState =
  /** Watch never registered, so the mailbox is excluded from sync entirely. */
  | 'never_started'
  /** Watch registered once but is now failing to renew. */
  | 'watch_failing'
  /** Sync itself is failing — usually the Google connection. */
  | 'sync_failing'
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

  // Checked before `paused`: a mailbox that never started is broken whether or
  // not anyone has since paused its rules, and saying "paused" would hide it.
  if (!record.watchRegisteredAt) {
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

  if (record.watchFailureCode) {
    return {
      ...base,
      state: 'watch_failing',
      rulesCanFire: false,
      summary:
        `Divo has stopped receiving new mail notifications for ${record.mailboxEmail}.`,
      remedy: remedyForFailure(record.watchFailureCode),
    };
  }

  if (record.failureCode) {
    return {
      ...base,
      state: 'sync_failing',
      rulesCanFire: false,
      summary: `Divo cannot read new mail in ${record.mailboxEmail} right now.`,
      remedy: remedyForFailure(record.failureCode),
    };
  }

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
    | 'abandonedCount' | 'lastError'
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
 * Whether a mailbox transition is worth interrupting someone over.
 *
 * Only the transition into an unable-to-fire state notifies. Staying broken
 * does not re-notify, because an alert that repeats every ten seconds is the
 * same as no alert.
 */
export function shouldNotifyMailbox(
  previous: MailboxState | null,
  current: MailboxState,
): boolean {
  if (current === 'healthy' || current === 'paused') return false;
  return previous !== current;
}
