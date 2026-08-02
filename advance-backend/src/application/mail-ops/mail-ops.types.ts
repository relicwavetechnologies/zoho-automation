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

export interface MailRuleMatch {
  from?: string;
  to?: string;
  subjectContains?: string;
  bodyContains?: string;
  hasAttachment?: boolean;
}

export type MailRuleAction =
  | { type: 'forward' }
  | { type: 'deliver' };

export type MailRuleDestination =
  | { type: 'email'; email: string }
  | { type: 'lark_chat'; chatId: string };

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
 */
export function mailRuleDedupeKey(input: MailRuleIdentity): string {
  return `mail-rule:${sha256(JSON.stringify([
    input.companyId,
    input.userId,
    input.connectionId,
    input.match.from?.toLocaleLowerCase() ?? null,
    input.match.to?.toLocaleLowerCase() ?? null,
    input.match.subjectContains?.toLocaleLowerCase() ?? null,
    input.match.bodyContains?.toLocaleLowerCase() ?? null,
    input.match.hasAttachment ?? null,
    input.action.type,
    input.destination.type,
    input.destination.type === 'email'
      ? input.destination.email.toLocaleLowerCase()
      : input.destination.chatId,
  ]))}`;
}

/**
 * A rule created before that fix carries whatever key the old serialisation
 * produced, and there is no way to recompute it from a fresh request — the
 * fork being repaired was a difference of case, so the request that exposes it
 * hashes to a third value under the old rule too. `createRuleForMailbox`
 * therefore recognises those rules by recomputing this key from what each one
 * stores, and moves the match onto its canonical key before creating anything.
 */
