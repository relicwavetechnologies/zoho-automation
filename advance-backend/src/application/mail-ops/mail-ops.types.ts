import { sha256 } from '../../shared/hash';

export const MAILBOX_RECONCILIATION_INTERVAL_MS = 60 * 60_000;
export const MAILBOX_CLAIM_STALE_AFTER_MS = 10 * 60_000;

export type MailboxSubscriptionStatus = 'active' | 'paused' | 'disconnected';
export type MailAutomationRuleStatus = 'active' | 'paused' | 'archived';
export type MailDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'abandoned';

export interface NewMailEvent {
  providerMessageId: string;
  providerThreadId?: string;
  historyId: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

export interface MailMessageMetadata extends Record<string, unknown> {
  from: string;
  to: string;
  /**
   * The other headers that say where a message was sent.
   *
   * Optional because events recorded before recipient matching existed carry
   * `to` alone; a rule reading one of those falls back to `to`, which is what
   * it used to match against anyway.
   */
  cc?: string;
  bcc?: string;
  deliveredTo?: string;
  subject: string;
  date?: string;
  snippet: string;
  bodyText: string;
  hasAttachment: boolean;
  /**
   * Set when Divo forwarded this message itself, to the rule that did it.
   *
   * A destination aliasing back into the same mailbox, plus a rule matching on
   * subject alone, re-matches its own `Fwd:` output forever. Nothing else in a
   * message distinguishes Divo's forward from ordinary mail.
   */
  forwardedByRuleId?: string;
}

export const MAIL_RULE_WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;

export type MailRuleWeekday = (typeof MAIL_RULE_WEEKDAYS)[number];

/**
 * The stretch of the week a rule is awake for, in somebody's actual timezone.
 *
 * `start` and `end` are `HH:MM` local wall-clock times and the window is
 * half-open — `09:00`–`18:00` includes mail arriving at 09:00 and excludes mail
 * arriving at 18:00. An `end` at or before `start` wraps past midnight, which is
 * the only way to express an overnight window and the shape people reach for
 * first ("only outside office hours").
 *
 * `timeZone` is required and is an IANA name. There is no server-local default
 * on purpose: a window is a claim about the member's day, and resolving it
 * against whatever timezone a container happens to boot in would be wrong for
 * everyone except by accident.
 */
export interface MailRuleActiveWindow {
  /** Omitted means every day. */
  days?: readonly MailRuleWeekday[];
  start: string;
  end: string;
  timeZone: string;
}

export interface MailRuleMatch {
  from?: string;
  to?: string;
  subjectContains?: string;
  bodyContains?: string;
  hasAttachment?: boolean;
  notFrom?: string;
  notSubjectContains?: string;
  activeWindow?: MailRuleActiveWindow;
}

/**
 * `rateLimitPerHour` is a ceiling on how many messages one rule may send in a
 * rolling hour, counted per rule and not per connection — the connection budget
 * already exists and protects Google, while this protects whoever is on the
 * other end of the destination.
 *
 * `organize` carries no ceiling because it sends nothing: labelling and
 * archiving act on the member's own mailbox, where a burst is the correct
 * response to a burst.
 */
export type MailRuleAction =
  | { type: 'forward'; rateLimitPerHour?: number }
  | { type: 'deliver'; rateLimitPerHour?: number }
  | {
      type: 'organize';
      label?: string;
      archive?: boolean;
      markRead?: boolean;
    };

export type MailRuleDestination =
  | { type: 'email'; email: string }
  | { type: 'lark_chat'; chatId: string }
  /** An `organize` rule acts on the message where it already is. */
  | { type: 'none' };

export interface PendingMailDeliveryPayload {
  companyId: string;
  userId: string;
  departmentId?: string;
  subscriptionId: string;
  connectionId: string;
  mailboxEmail: string;
  ruleId: string;
  eventId: string;
  sourceMessageId: string;
  idempotencyKey: string;
  action: MailRuleAction;
  destination: MailRuleDestination;
  message: MailMessageMetadata;
}

export function mailDeliveryIdempotencyKey(ruleId: string, eventId: string): string {
  return `mail:${sha256(`${ruleId}:${eventId}`)}`;
}

export interface MailRuleIdentity {
  companyId: string;
  userId: string;
  connectionId: string;
  match: MailRuleMatch;
  action: MailRuleAction;
  destination: MailRuleDestination;
}

/**
 * The identity of a rule, so that asking for one twice does not create two.
 *
 * Derived from a fixed sequence rather than from `JSON.stringify` of the
 * request, which made the identity turn on things the rule does not: the order
 * the keys happened to be written in, and the case of every value. Matching is
 * case-insensitive, so a rule asked for as `otp` and a rule asked for as `OTP`
 * watch exactly the same mail — and both being active meant every matching
 * message was forwarded twice, with nothing in either rule to suggest the
 * other existed.
 *
 * Case is folded only where the runtime already ignores it: the match clause,
 * and a destination email address. A Lark `chatId` is an opaque identifier and
 * is left alone — two chats whose IDs differ only in case are two chats.
 *
 * `toLowerCase`, not `toLocaleLowerCase`, because this value is stored: a
 * locale-sensitive fold would make a rule's identity depend on the environment
 * of whichever process last wrote it. Turkish alone would map `I` to `ı`.
 *
 * `rateLimitPerHour` is deliberately **not** part of the identity. Two rules
 * alike but for their ceiling are one rule with two opinions about how fast it
 * may go, and treating them as two would leave both running and forwarding
 * everything twice. The consequence is that re-creating a rule with a different
 * ceiling has to *apply* it, which is why `createRuleForMailbox` writes
 * `actionJson` on the update branch — the action can differ from the stored one
 * in that field alone, so writing it means exactly "adopt the new ceiling".
 */
export function mailRuleDedupeKey(input: MailRuleIdentity): string {
  return `mail-rule:${sha256(JSON.stringify([
    input.companyId,
    input.userId,
    input.connectionId,
    input.match.from?.toLowerCase() ?? null,
    input.match.to?.toLowerCase() ?? null,
    input.match.subjectContains?.toLowerCase() ?? null,
    input.match.bodyContains?.toLowerCase() ?? null,
    input.match.hasAttachment ?? null,
    input.match.notFrom?.toLowerCase() ?? null,
    input.match.notSubjectContains?.toLowerCase() ?? null,
    activeWindowIdentity(input.match.activeWindow),
    input.action.type,
    input.action.type === 'organize' ? input.action.label?.toLowerCase() ?? null : null,
    input.action.type === 'organize' ? input.action.archive ?? null : null,
    input.action.type === 'organize' ? input.action.markRead ?? null : null,
    input.destination.type,
    input.destination.type === 'email'
      ? input.destination.email.toLowerCase()
      : input.destination.type === 'lark_chat'
        ? input.destination.chatId
        : null,
  ]))}`;
}

/**
 * A window reduced to a fixed sequence, so that the same window written two
 * ways is one rule.
 *
 * Days are sorted into week order rather than the order they were typed, and an
 * absent `days` is spelled as the full week — "every day" and "mon…sun" are the
 * same window, and a member who lists all seven should not get a second rule.
 * The timezone is a case-sensitive IANA name (`Europe/Paris`, not
 * `europe/paris`) and is left exactly as given.
 */
function activeWindowIdentity(
  window: MailRuleActiveWindow | undefined,
): unknown {
  if (!window) return null;
  const days = window.days?.length ? window.days : MAIL_RULE_WEEKDAYS;
  return [
    MAIL_RULE_WEEKDAYS.filter(day => days.includes(day)),
    window.start,
    window.end,
    window.timeZone,
  ];
}
