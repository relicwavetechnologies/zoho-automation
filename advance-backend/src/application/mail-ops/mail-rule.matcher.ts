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
 * - `to` still accepts free text, matched as a substring against the `To`
 *   header alone (see `recipientMatches`).
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

/**
 * Case is folded with `toLowerCase`, never `toLocaleLowerCase`.
 *
 * A rule's identity folds case the same way and is stored, so a
 * locale-sensitive fold here would let the two disagree: under a Turkish
 * locale `INVOICE` and `invoice` would be one rule by identity and two rules
 * by what they match.
 */
export function mailRuleMatches(
  match: MailRuleMatch,
  message: MailMessageMetadata,
): boolean {
  const includes = (actual: string, expected: string): boolean =>
    actual.toLowerCase().includes(expected.toLowerCase());
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
const WHOLE_ADDRESS_PATTERN = new RegExp(`^${ADDRESS_PATTERN.source}$`, 'i');

/**
 * Whether the message came from the mailbox the rule names.
 *
 * Through the same blanking as recipients, because `From` carries the same
 * display position and the leftmost address in the raw header is not
 * necessarily the sender's: `From: (receipts@stripe.com) evil@attacker.tld` is
 * a legal header from `evil@attacker.tld`, and reading it any other way lets an
 * outsider put their own message wherever a rule on `@stripe.com` points.
 */
function senderMatches(fromHeader: string, criterion: string): boolean {
  const address = senderAddress(fromHeader);
  return address !== undefined && addressMatches(address, criterion);
}

function senderAddress(fromHeader: string): string | undefined {
  const entries = splitRecipients(fromHeader);
  const first = addressIn(entries[0] ?? '');
  if (first) return first;
  // `From: Doe, John <j@example.com>` — an unquoted comma in a display name.
  // Invalid, and still emitted by enough mailers to matter; splitting it
  // leaves a first entry holding a surname and nothing else, which would stop
  // a rule the member is actively watching with nothing to show why. Recovered
  // only when exactly one entry holds a bracketed mailbox, so the recovery
  // cannot pick between candidates or read anything out of display text.
  const bracketed = entries.flatMap(
    entry => [...entry.matchAll(/<\s*([^<>]+)\s*>/g)].map(match => match[1]!),
  );
  if (bracketed.length !== 1) return undefined;
  return bracketed[0]!.match(ADDRESS_PATTERN)?.[0]?.toLowerCase();
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
  // A rule stored before recipients were parsed holds free text, and keeps
  // exactly the behaviour it was created under: a substring test against `To`
  // alone. Widening the loosest rule shape in the system to three more headers
  // would be a change to a rule nobody asked to change. Nothing new can be
  // written in that shape — `mailRuleMatchSchema` requires a mailbox or an
  // @domain.
  if (!recipientCriterionSchema.safeParse(criterion).success) {
    return message.to.toLowerCase()
      .includes(criterion.toLowerCase());
  }
  return [message.to, message.cc, message.bcc, message.deliveredTo]
    .filter((header): header is string => Boolean(header?.trim()))
    .flatMap(header => addressesIn(header))
    .some(address => addressMatches(address, criterion));
}

function addressMatches(address: string, criterion: string): boolean {
  const expected = criterion.trim().toLowerCase();
  return expected.startsWith('@')
    ? address.endsWith(expected)
    : address === expected;
}

/** Every address in one recipient header, one entry at a time. */
function addressesIn(header: string): string[] {
  return splitRecipients(header)
    .map(entry => addressIn(entry))
    .filter((address): address is string => address !== undefined);
}

/**
 * One header split into its entries, with everything that is not an address
 * blanked out.
 *
 * Three constructs sit in the display position, all of them free text and all
 * of them able to hold a comma: a quoted name, a parenthesised comment, and an
 * encoded word. Split the raw header on commas and any of them hands
 * `addressIn` a fragment with no bracketed mailbox left in it — and the
 * fragment then reads as whatever address the free text contained, so a rule
 * fires on a message that was never sent to the mailbox it names.
 *
 * This buys correctness, not authority. Every recipient header is written by
 * the sender and passed through untouched, so anyone who can email a member can
 * put any address in `To` and fire that member's rule on their own message.
 * `to` narrows a member's own mail; it is not evidence of anything, and no
 * amount of parsing here would make it so.
 *
 * So each is consumed as a unit and replaced with blanks: none can ever be an
 * address, and blanks keep the entry's real mailbox where it was. Quotes and
 * comments both honour `\` escapes, since a scanner that ends a name at the
 * first delimiter it meets can be walked straight back out of it. Comments
 * nest, as RFC 5322 allows.
 *
 * Anything left unterminated swallows the rest of the header. That loses a
 * match rather than inventing one, which is the only direction this is allowed
 * to fail in.
 */
function splitRecipients(header: string): string[] {
  const entries: string[] = [];
  let entry = '';
  let quoted = false;
  let commentDepth = 0;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index]!;
    const hidden = quoted || commentDepth > 0;
    // A header appearing more than once arrives here as its instances joined
    // by newlines, and no parser state may cross that seam. One instance
    // leaving a quote open would otherwise swallow the next — and `Delivered-To`
    // is exactly the header that repeats, where the instance the receiving
    // server added is the one worth having. Damage stays inside the instance
    // that caused it.
    if (character === '\n') {
      entries.push(hidden ? '' : entry);
      entry = '';
      quoted = false;
      commentDepth = 0;
      continue;
    }
    if (hidden && character === '\\') {
      index += 1;
      entry += ' ';
      continue;
    }
    if (character === '"' && commentDepth === 0) {
      quoted = !quoted;
      entry += ' ';
      continue;
    }
    if (!quoted && character === '(') {
      commentDepth += 1;
      entry += ' ';
      continue;
    }
    if (!quoted && commentDepth > 0 && character === ')') {
      commentDepth -= 1;
      entry += ' ';
      continue;
    }
    // An encoded word is a single token: `=?charset?encoding?text?=`. Its text
    // may hold a comma and, because `?` and `=` are legal in an address, its
    // tail can read as one.
    //
    // The terminator is looked for only within the token, because RFC 2047
    // forbids whitespace inside an encoded word — and a search that ran to the
    // end of the header would let a bare `=?` blank its way across an opening
    // quote, which both drops whatever recipient that quote belonged to and
    // exposes the display text behind it as an address. A `=?` with no
    // terminator in its own token is not an encoded word and is read as the
    // ordinary text it is.
    if (!hidden && character === '=' && header[index + 1] === '?') {
      const whitespace = header.slice(index).search(/\s/);
      const limit = whitespace === -1 ? header.length : index + whitespace;
      const end = header.indexOf('?=', index + 2);
      if (end !== -1 && end + 2 <= limit) {
        entry += ' '.repeat(end + 2 - index);
        index = end + 1;
        continue;
      }
    }
    // `;` as well as `,`: it closes a group — `Team: ana@x.example,
    // bob@x.example;` — and some clients simply separate recipients with it.
    // Either way what follows is a different recipient, which is exactly what
    // an entry boundary means.
    if ((character === ',' || character === ';') && !hidden) {
      entries.push(entry);
      entry = '';
      continue;
    }
    entry += hidden ? ' ' : character;
  }
  // The header ran out mid-name. Escapes are honoured inside a quote, which is
  // exactly how one can be walked back out of: `"a\\"victim@bank.example"
  // <evil@attacker.tld>` closes its quote on the escaped backslash, leaves the
  // imitation standing and hides the real mailbox in the quote that never
  // ends. The entry that was still being read is not an entry, so it is
  // dropped whole. Earlier ones parsed cleanly and are kept.
  entries.push(quoted || commentDepth > 0 ? '' : entry);
  return entries;
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
  if (bracketedMailbox !== undefined) {
    return bracketedMailbox.match(ADDRESS_PATTERN)?.[0]?.toLowerCase();
  }
  // With no brackets the address has to *be* a token, not sit inside one.
  // Reading it out of the middle of one is how text that is not an address at
  // all comes to satisfy a rule: `=?utf-8?q?receipts@stripe.com?x` holds no
  // mailbox — `?` and `=` are simply legal in a local part — and two bare
  // addresses side by side name no single sender. Neither is an answer, and
  // saying so loses a match rather than inventing one.
  const addresses = entry
    .trim()
    .split(/\s+/)
    // A group label sits on the front of the first recipient when no space
    // follows the colon — `Team:ana@example.com` is one token holding one
    // address, and `:` is not legal in a local part, so the whole token would
    // otherwise be refused and that recipient lost. Only a label that could not
    // itself be an address is taken off: strip to the last colon instead and
    // the prefix becomes free space for the sender, who writes
    // `evil@attacker.tld:receipts@stripe.com` and has the rule read the brand.
    .map(token => token.replace(/^[^\s:<>@]*:/, ''))
    .map(token => token.replace(/^[<>]+/, '').replace(/[<>.]+$/, ''))
    .filter(token => WHOLE_ADDRESS_PATTERN.test(token));
  return addresses.length === 1 ? addresses[0]!.toLowerCase() : undefined;
}
