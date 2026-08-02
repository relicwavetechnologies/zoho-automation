import { z } from 'zod';
import type {
  MailMessageMetadata,
  MailRuleAction,
  MailRuleDestination,
  MailRuleMatch,
} from './mail-ops.types';

const mailboxCriterionSchema = (subject: 'Sender' | 'Recipient') =>
  z.string().trim().min(1).refine(
    value =>
      z.string().email().safeParse(value).success
      || (
        value.startsWith('@')
        && z.string().email().safeParse(`mailbox${value}`).success
      ),
    `${subject} must be one exact email address or an @domain.`,
  );

const senderCriterionSchema = mailboxCriterionSchema('Sender');
const recipientCriterionSchema = mailboxCriterionSchema('Recipient');

/** Fields that narrow a rule to a recognisable slice of someone's mail. */
const NARROWING_FIELDS = ['from', 'to', 'subjectContains', 'bodyContains'] as const;

/**
 * What a newly submitted match may say.
 *
 * `.strict()` because the alternative is worse than a rejection: Zod strips
 * keys it does not recognise, so a rule asked for as
 * `{"from":"@x.com","cc":"finance@y.com"}` used to be created matching `from`
 * alone and reported as a success. The narrowing the user asked for was gone
 * and nothing said so.
 */
export const mailRuleMatchSchema = z.object({
  from: senderCriterionSchema.optional(),
  to: recipientCriterionSchema.optional(),
  subjectContains: z.string().trim().min(1).optional(),
  bodyContains: z.string().trim().min(1).optional(),
  hasAttachment: z.boolean().optional(),
}).strict().refine(
  value => NARROWING_FIELDS.some(field => value[field] !== undefined),
  {
    message: 'A rule needs at least one of from, to, subjectContains or '
      + 'bodyContains. hasAttachment on its own forwards every message that '
      + 'carries a file.',
  },
);

/**
 * What a match already in the database may say.
 *
 * Deliberately looser than the creation schema in two places, because a stored
 * rule that stops parsing stops firing, and a rule that has been quietly doing
 * its job for months should not break because the rules for writing a *new*
 * one got stricter:
 *
 * - `to` still accepts free text, matched as a substring (see `toMatches`).
 * - `hasAttachment` alone still counts as a match clause.
 */
const storedMailRuleMatchSchema = z.object({
  from: senderCriterionSchema.optional(),
  to: z.string().trim().min(1).optional(),
  subjectContains: z.string().trim().min(1).optional(),
  bodyContains: z.string().trim().min(1).optional(),
  hasAttachment: z.boolean().optional(),
}).refine(value => Object.keys(value).length > 0, {
  message: 'At least one deterministic mail match is required.',
});

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('forward') }),
  z.object({ type: z.literal('deliver') }),
]);

const DestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email'), email: z.string().email() }),
  z.object({ type: z.literal('lark_chat'), chatId: z.string().trim().min(1) }),
]);

export function parseMailRule(input: {
  match: Record<string, unknown>;
  action: Record<string, unknown>;
  destination: Record<string, unknown>;
}): {
  match: MailRuleMatch;
  action: MailRuleAction;
  destination: MailRuleDestination;
} {
  const parsedMatch = storedMailRuleMatchSchema.parse(input.match);
  const match: MailRuleMatch = {
    ...(parsedMatch.from ? { from: parsedMatch.from } : {}),
    ...(parsedMatch.to ? { to: parsedMatch.to } : {}),
    ...(parsedMatch.subjectContains
      ? { subjectContains: parsedMatch.subjectContains }
      : {}),
    ...(parsedMatch.bodyContains
      ? { bodyContains: parsedMatch.bodyContains }
      : {}),
    ...(parsedMatch.hasAttachment !== undefined
      ? { hasAttachment: parsedMatch.hasAttachment }
      : {}),
  };
  return { match, ...parseMailRuleDelivery(input) };
}

export function parseMailRuleDelivery(input: {
  action: Record<string, unknown>;
  destination: Record<string, unknown>;
}): {
  action: MailRuleAction;
  destination: MailRuleDestination;
} {
  const action = ActionSchema.parse(input.action);
  const destination = DestinationSchema.parse(input.destination);
  if (action.type === 'forward' && destination.type !== 'email') {
    throw new Error('Forward rules require an email destination.');
  }
  if (action.type === 'deliver' && destination.type !== 'lark_chat') {
    throw new Error('Delivery rules require a Lark chat destination.');
  }
  return { action, destination };
}

export function mailRuleMatches(
  match: MailRuleMatch,
  message: MailMessageMetadata,
): boolean {
  const includes = (actual: string, expected: string): boolean =>
    actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
  return (
    (!match.from || senderMatches(message.from, match.from))
    && (!match.to || recipientMatches(message, match.to))
    && (!match.subjectContains || includes(message.subject, match.subjectContains))
    && (!match.bodyContains || includes(message.bodyText, match.bodyContains))
    && (
      match.hasAttachment === undefined
      || message.hasAttachment === match.hasAttachment
    )
  );
}

const ADDRESS_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

function senderMatches(fromHeader: string, criterion: string): boolean {
  const address = addressIn(fromHeader);
  return address !== undefined && addressMatches(address, criterion);
}

/**
 * Whether the message reached the mailbox the rule names.
 *
 * The union of every header that says where a message was sent, not `To`
 * alone. Someone asking Divo to watch mail addressed to an alias means the
 * mail they receive at that alias — being Cc'd is not a different event to
 * them, and a rule that ignored Cc simply never fired for half the mail it
 * described.
 *
 * `Delivered-To` is the header that survives an alias or a group expansion,
 * where the address the user typed appears nowhere else in the message.
 */
function recipientMatches(message: MailMessageMetadata, criterion: string): boolean {
  const headers = [message.to, message.cc, message.bcc, message.deliveredTo]
    .filter((header): header is string => Boolean(header?.trim()));
  // A rule stored before recipients were parsed holds free text, so it keeps
  // the substring behaviour it was created under. Nothing new can be written
  // in that shape — `mailRuleMatchSchema` requires a mailbox or an @domain.
  if (!recipientCriterionSchema.safeParse(criterion).success) {
    const expected = criterion.toLocaleLowerCase();
    return headers.some(
      header => header.toLocaleLowerCase().includes(expected),
    );
  }
  return headers
    .flatMap(header => addressesIn(header))
    .some(address => addressMatches(address, criterion));
}

function addressMatches(address: string, criterion: string): boolean {
  const expected = criterion.trim().toLocaleLowerCase();
  return expected.startsWith('@')
    ? address.endsWith(expected)
    : address === expected;
}

/** Every address in one recipient header, one entry at a time. */
function addressesIn(header: string): string[] {
  return header
    .split(',')
    .map(entry => addressIn(entry))
    .filter((address): address is string => address !== undefined);
}

/**
 * The address of one header entry.
 *
 * The bracketed mailbox wins, because a display name is attacker-controlled
 * text that can hold an address of its own: `"billing@stripe.com" <x@evil.tld>`
 * must read as `x@evil.tld`.
 */
function addressIn(entry: string): string | undefined {
  const bracketedMailbox = entry.match(/<\s*([^<>]+)\s*>/)?.[1];
  return (bracketedMailbox ?? entry)
    .match(ADDRESS_PATTERN)?.[0]
    ?.toLocaleLowerCase();
}
