/**
 * Answering "would this rule have caught anything?" without sending a thing.
 *
 * Every other way of finding out costs somebody real mail. A rule that is too
 * narrow says nothing at all and looks identical to a rule whose mailbox has
 * stopped being watched; a rule that is too broad is discovered by the person
 * on the receiving end. This replays the rule over mail Divo has already
 * recorded and reports what it would have done — the one question the whole
 * subsystem could not previously answer.
 *
 * It replays against `MailEvent` rows, which means it can only see mail that
 * arrived while the mailbox was being watched, and it says so rather than
 * letting an empty result be read as "this rule matches nothing".
 */
import type { MailMessageMetadata, MailRuleMatch } from './mail-ops.types';
import { mailRuleMatches, parseMailRule } from './mail-rule.matcher';

export interface MailRuleDryRunEvent {
  eventId: string;
  occurredAt: Date;
  metadata: Record<string, unknown>;
}

export interface MailRuleDryRunHit {
  eventId: string;
  occurredAt: Date;
  from: string;
  subject: string;
  /**
   * Whether this message arrived before the rule started watching.
   *
   * A hit that predates `activatedAt` is a true statement about the match and a
   * false one about the rule: the runtime skips anything older, so reporting it
   * as something the rule "would have caught" would promise a backfill that
   * will never happen.
   */
  predatesRule: boolean;
}

export type MailRuleDryRun =
  | {
      status: 'ran';
      /** How many recorded messages were replayed. */
      consideredCount: number;
      matched: MailRuleDryRunHit[];
      /**
       * Matches that are only matches in hindsight, counted separately so a
       * caller never presents them as future behaviour.
       */
      predatingCount: number;
      /**
       * Replayed messages whose body Divo no longer holds, where this rule
       * needs the body to decide.
       *
       * Retention strips `bodyText` at 30 days. For a rule matching on the
       * body, those messages cannot be judged either way — and counting them
       * as non-matches would answer "your rule caught nothing" when the truth
       * is "we cannot tell any more". A caller that ignores this reports the
       * first sentence; the dry run exists so nobody has to guess which one
       * they are being told.
       */
      bodyUnavailableCount: number;
    }
  | { status: 'rule_invalid'; reason: string };

export function dryRunMailRule(input: {
  rule: {
    match: Record<string, unknown>;
    action: Record<string, unknown>;
    destination: Record<string, unknown>;
    activatedAt: Date;
  };
  events: readonly MailRuleDryRunEvent[];
}): MailRuleDryRun {
  let match: MailRuleMatch;
  try {
    // Through the same parser the worker uses, so a rule that the runtime
    // refuses to run cannot report a clean dry run. This is the honest place to
    // learn a rule is broken.
    match = parseMailRule(input.rule).match;
  } catch (error) {
    return {
      status: 'rule_invalid',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const matched: MailRuleDryRunHit[] = [];
  let considered = 0;
  let bodyUnavailable = 0;
  const needsBody = match.bodyContains !== undefined;
  for (const event of input.events) {
    const message = readMessage(event.metadata);
    // Metadata Divo cannot read is not evidence either way, and inventing a
    // verdict for it would make the dry run less trustworthy than the silence
    // it exists to replace. It is not counted as considered either: saying
    // "we looked at 200 messages" about messages nothing could read is the
    // same lie in a different place.
    if (!message) continue;
    considered += 1;
    if (message.forwardedByRuleId) continue;
    // A body-matching rule against a message whose body retention has taken is
    // unanswerable. Reported, not guessed.
    if (needsBody && typeof event.metadata['bodyText'] !== 'string') {
      bodyUnavailable += 1;
      continue;
    }
    if (!mailRuleMatches(match, message, event.occurredAt)) continue;
    matched.push({
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      from: message.from,
      subject: message.subject,
      predatesRule: event.occurredAt < input.rule.activatedAt,
    });
  }

  return {
    status: 'ran',
    consideredCount: considered,
    matched,
    predatingCount: matched.filter(hit => hit.predatesRule).length,
    bodyUnavailableCount: bodyUnavailable,
  };
}

function readMessage(
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
