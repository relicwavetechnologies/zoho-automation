import { z } from 'zod';
import { sha256 } from '../../shared/hash';

/**
 * A rule's optional AI step: one question, asked of every matched message.
 *
 * The shape lives here rather than beside the evaluator because three layers
 * need it and only one of them ever calls a model — the matcher parses it off
 * the stored row, the payload carries it to the worker, and the evaluator asks
 * it. Putting it next to `generateText` would have made the matcher import the
 * model client to read a column.
 *
 * `question` is bounded at 500 because this is a question, not an instruction
 * set: a paragraph here is somebody writing a second rule inside the first one.
 *
 * `onFailure` decides what happens when the model cannot answer, and it belongs
 * to the rule's author because the right answer differs per rule — a rule that
 * cuts noise should keep working when the model is unreachable, and a rule that
 * stops the wrong mail leaving the company must not. Default `closed`.
 */
export const mailRuleJudgeSchema = z.object({
  question: z.string().trim().min(8).max(500),
  /**
   * Optional rather than defaulted in the schema, deliberately. A zod
   * `.default()` makes the parser's input and output types differ, and the tool
   * declares its argument schema as one type in both directions — so defaulting
   * here would have made the whole `mailAutomations` schema unassignable. The
   * default lives in `judgeFailurePolicy` instead, which is the only thing that
   * reads it.
   */
  onFailure: z.enum(['open', 'closed']).optional(),
}).strict();

export type MailRuleJudge = z.infer<typeof mailRuleJudgeSchema>;

/**
 * What an unanswerable question means for this rule. Absent is `closed`.
 *
 * Closed is the default because the failure it produces is silence, and the
 * other one is mail. A rule nobody configured carefully should, when the model
 * cannot be reached, do nothing rather than forward everything it matched — the
 * member notices mail that did not arrive, and does not notice mail that
 * arrived somewhere it should not have.
 */
export const judgeFailurePolicy = (judge: MailRuleJudge): 'open' | 'closed' =>
  judge.onFailure ?? 'closed';

export interface MailJudgeVerdict {
  decision: 'passed' | 'rejected' | 'unavailable';
  /** Always present. A verdict without a reason is not reviewable. */
  reason: string;
  confidence?: number;
  /** Set only on `unavailable`, so a member can see which way the policy sent it. */
  appliedFailure?: 'open' | 'closed';
}

/**
 * Whether a verdict lets the rule act.
 *
 * Stated once, here, so the worker and every test agree without either of them
 * needing a model or a mailbox to find out.
 */
export const judgeAllowsDelivery = (verdict: MailJudgeVerdict): boolean =>
  verdict.decision === 'passed'
  || (verdict.decision === 'unavailable' && verdict.appliedFailure === 'open');

/**
 * Raised when the Google account behind a mailbox is no longer usable.
 *
 * A named type rather than a plain Error because the worker's failure
 * classifier has to recognise it, and its only other way of doing so is
 * matching words in the message. It used to reach that classifier as "Token has
 * been expired or revoked." and be filed as `connection_unavailable` purely
 * because the word "token" happened to be in it. Once a revoked grant is marked
 * on the connection, the account simply stops being listed and the message
 * becomes one with no such word — which would have been filed as a generic
 * provider fault, and the mailbox would have lost the one remedy that fixes it.
 */
export class MailOpsConnectionUnavailableError extends Error {
  constructor(message = 'Mail Ops Google connection is unavailable.') {
    super(message);
    this.name = 'MailOpsConnectionUnavailableError';
  }
}

export const MAILBOX_RECONCILIATION_INTERVAL_MS = 60 * 60_000;
export const MAILBOX_CLAIM_STALE_AFTER_MS = 10 * 60_000;

/**
 * How many times one delivery is attempted before it is given up on.
 *
 * Stated once because three places have to agree on it exactly: the claim
 * predicate that refuses to pick a delivery up again, the failure path that
 * decides whether this attempt was the last, and the stale-claim sweep. They
 * were three separate literal `5`s, and when they disagreed once before, rows
 * at the ladder's end became unclaimable *and* unabandonable — stranded for
 * the life of the table.
 */
export const MAIL_DELIVERY_MAX_ATTEMPTS = 5;

/**
 * The first retry gap; each further attempt doubles it.
 *
 * Five attempts from 5s therefore span about 75 seconds in total, which is the
 * number quoted wherever the ladder is described.
 */
export const MAIL_DELIVERY_RETRY_BASE_MS = 5_000;

/** How long a Gmail watch is left before renewal. Google expires them at 7 days. */
export const MAILBOX_WATCH_RENEWAL_INTERVAL_MS = 24 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/**
 * How long a copy of somebody's mail is kept, and in what form.
 *
 * Three separate ages, because they answer three different questions. The
 * message *body* is the sensitive part and the part nothing needs after the
 * fact — a rule decided on it once, at arrival, and no screen ever shows it
 * again — so it goes first and the event survives without it. The event itself
 * is what stops a message being delivered twice, so it has to outlive any
 * plausible replay: Gmail keeps about a week of history, and 90 days is far
 * past the point where a re-delivery is possible. A delivery's frozen payload
 * carries a second copy of the body and is needed only while the delivery can
 * still be retried, which is minutes.
 *
 * Nothing was ever deleted before this. A mailbox watched for a year held a
 * year of message bodies in Postgres, for no purpose after the first hour.
 */
export const MAIL_EVENT_BODY_RETENTION_MS = 30 * DAY_MS;
export const MAIL_EVENT_RETENTION_MS = 90 * DAY_MS;
export const MAIL_DELIVERY_PAYLOAD_RETENTION_MS = 30 * DAY_MS;

/** How often the retention sweep runs. It is not urgent work. */
export const MAIL_RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * How much one retention sweep may do, and in what size pieces.
 *
 * Bounded because the first sweep after this ships meets everything ever
 * recorded — a mailbox watched for a year, in one `DELETE`. The sweep is
 * awaited inside the worker's tick and the tick is re-entrancy-guarded, so an
 * unbounded statement would block every delivery for as long as it ran, which
 * is precisely the guarantee the sweep is documented to keep. Worse, a
 * statement large enough to hit a timeout would fail, be retried identically an
 * hour later, and never once make progress.
 *
 * A batch always completes, so a backlog drains a piece per hour instead of
 * never. 10,000 rows an hour clears a year of ordinary mailbox history in days,
 * and nothing waits on it.
 */
export const MAIL_RETENTION_BATCH_SIZE = 1_000;
export const MAIL_RETENTION_MAX_BATCHES = 10;

export type MailboxSubscriptionStatus = 'active' | 'paused' | 'disconnected';
export type MailAutomationRuleStatus = 'active' | 'paused' | 'archived';
/**
 * Every state a delivery row is actually written in, and no others.
 *
 * It used to declare `failed` and omit `blocked`, which was wrong in both
 * directions at once. `failed` was never written by anything —
 * `markDeliveryFailed` returns the row to `pending` with a backoff, or gives up
 * at `abandoned` — so it read as a handled case that could not occur. `blocked`
 * is written on every refusal and every rate-limit drop, and was missing, so
 * the one state a member is most likely to ask about was the one the type
 * denied existed.
 *
 * Nothing referenced this union, which is how it drifted. It is stated here to
 * be the truth about the column, so the next thing that reads it starts from a
 * true list.
 */
export type MailDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  /** Matched, then refused — no permission, or over the rule's hourly ceiling. */
  | 'blocked'
  /**
   * Matched, read by the rule's AI step, and deliberately not acted on.
   *
   * Kept apart from `blocked` because they are opposite answers to a member
   * asking why nothing arrived: `blocked` is Divo unable to act, `held` is Divo
   * deciding not to. Sharing one status would make a working rule's normal
   * behaviour indistinguishable from a permission fault.
   *
   * A held message consumes no rate-limit budget — see the reservation query in
   * `delivery.repository.ts`, which counts neither this nor `blocked`.
   */
  | 'held'
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

/**
 * A phrase to look for, or several any one of which counts.
 *
 * The list is what people were reaching for when they typed
 * `OTP|verification code` into a field that matched it literally and therefore
 * matched nothing at all. Stored sorted and de-duplicated, so the same set
 * written in two orders is one rule rather than two forwarding every message
 * twice.
 */
export type MailRulePhrase = string | readonly string[];

export interface MailRuleMatch {
  from?: string;
  to?: string;
  subjectContains?: MailRulePhrase;
  bodyContains?: MailRulePhrase;
  hasAttachment?: boolean;
  notFrom?: string;
  notSubjectContains?: MailRulePhrase;
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
  /**
   * The rule owner's own Lark DM, addressed by their open id.
   *
   * Kept apart from `lark_chat` rather than stored as one, because the two have
   * opposite trust properties. A chat id names a room that has to be grounded
   * against the rooms Divo has actually been in — it is caller-supplied, and a
   * wrong one sends somebody's mail into a room they never meant, possibly in
   * another company. An open id here is never supplied by a caller at all: it
   * is read from the signed-in session, so the destination has exactly one
   * recipient and that recipient is provably the person who owns the mailbox.
   *
   * Same addressing scheme scheduled work already delivers on — Lark's send API
   * takes an open id as a receive id, so a DM needs no chat to exist first.
   */
  | { type: 'lark_dm'; openId: string }
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
  /**
   * The rule's AI step, frozen with the rest of the rule at reserve time.
   *
   * Read from here rather than re-fetched at delivery, so a message is judged
   * against the question that was in force when it arrived. The alternative —
   * reading the live rule — means editing a rule's question retroactively
   * changes the verdict on mail already queued behind it, which is the one
   * thing a member editing a question does not expect.
   *
   * `isRuleSendable` is re-read live and deliberately so: pause promises to
   * stop mail *already* queued, which is the opposite requirement.
   */
  judge?: MailRuleJudge;
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
/**
 * A phrase field, folded for identity.
 *
 * Always a sorted array, even for one phrase, so `"invoice"` and `["invoice"]`
 * are the same rule — otherwise adding a second alternative and removing it
 * again would leave the member with a different rule than they started with.
 */
const phraseIdentity = (value: MailRulePhrase | undefined): string[] | null => {
  if (value === undefined) return null;
  const phrases = typeof value === 'string' ? [value] : value;
  return [...new Set(phrases.map(phrase => phrase.toLowerCase()))].sort();
};

export function mailRuleDedupeKey(input: MailRuleIdentity): string {
  return `mail-rule:${sha256(JSON.stringify([
    input.companyId,
    input.userId,
    input.connectionId,
    input.match.from?.toLowerCase() ?? null,
    input.match.to?.toLowerCase() ?? null,
    phraseIdentity(input.match.subjectContains),
    phraseIdentity(input.match.bodyContains),
    input.match.hasAttachment ?? null,
    input.match.notFrom?.toLowerCase() ?? null,
    phraseIdentity(input.match.notSubjectContains),
    activeWindowIdentity(input.match.activeWindow),
    input.action.type,
    input.action.type === 'organize' ? input.action.label?.toLowerCase() ?? null : null,
    input.action.type === 'organize' ? input.action.archive ?? null : null,
    input.action.type === 'organize' ? input.action.markRead ?? null : null,
    input.destination.type,
    input.destination.type === 'email'
      ? input.destination.email.toLowerCase()
      : input.destination.type === 'lark_dm'
        // Not lowercased. An open id is opaque and case-sensitive, exactly as a
        // chat id is; folding it would merge two different people's rules.
        ? input.destination.openId
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

/**
 * A stored event's metadata, read back as a message.
 *
 * Lives here rather than in the worker because three things now read it — the
 * matcher's caller, the delivery payload, and the brief — and a second copy of
 * the `bodyText` rule below is how one of them starts disagreeing with the
 * others about which stored events are readable at all.
 */
export function readMessageMetadata(
  value: Record<string, unknown>,
): MailMessageMetadata | null {
  if (
    typeof value['from'] !== 'string'
    || typeof value['to'] !== 'string'
    || typeof value['subject'] !== 'string'
    || typeof value['snippet'] !== 'string'
    || typeof value['hasAttachment'] !== 'boolean'
  ) return null;
  // `bodyText` is the one field that legitimately goes missing: retention
  // strips it at 30 days and leaves the event standing. Requiring it made a
  // stripped event unreadable, which quietly dropped it out of matching
  // altogether — so a rule tested against older mail matched nothing, and the
  // member was told the rule was wrong when the body was simply gone.
  return {
    ...value,
    bodyText: typeof value['bodyText'] === 'string' ? value['bodyText'] : '',
  } as MailMessageMetadata;
}
