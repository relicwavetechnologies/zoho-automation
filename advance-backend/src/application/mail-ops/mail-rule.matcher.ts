import { z } from 'zod';
import {
  MAIL_RULE_WEEKDAYS,
  type MailMessageMetadata,
  type MailRuleAction,
  type MailRuleActiveWindow,
  type MailRuleDestination,
  type MailRuleMatch,
  type MailRuleWeekday,
} from './mail-ops.types';

/**
 * Domains too broad to be anybody's intent.
 *
 * A criterion of `@com` or `@co.uk` used to be harmless because it matched
 * nothing — no mailbox lives directly at a public suffix. Now that `@domain`
 * covers subdomains it would match half the internet instead, so the shapes
 * that were previously inert have to be refused outright.
 *
 * Deliberately not a public-suffix list. A real one is thousands of entries
 * that drift, and carrying a stale copy would refuse legitimate domains as
 * confidently as it refuses these. This covers what someone can actually type
 * by mistake: a bare TLD, and the handful of two-label registries where a
 * company's own domain has three labels and the two-label form is not
 * registrable by anyone.
 */
const PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp',
  'co.nz', 'com.br', 'com.cn', 'com.mx', 'com.sg', 'co.za', 'com.tr',
]);

const isTooBroadADomain = (domain: string): boolean =>
  !domain.includes('.') || PUBLIC_SUFFIXES.has(domain);

/**
 * The shapes people actually type, turned into the one shape a rule stores.
 *
 * Nobody writing a rule knows this tool's grammar, and refusing `stripe.com`
 * because it is missing an `@` teaches them nothing — they wrote a domain, they
 * meant a domain, and the difference is punctuation. Every conversion here is
 * mechanical: an address inside angle brackets, a `mailto:`, a pasted URL, a
 * trailing dot, a capital letter. None of them is a guess about intent.
 *
 * What is deliberately *not* normalised is a brand word. `Stripe` does not
 * become `@stripe.com`, because that is a guess, and the rule it would build is
 * both wrong and confidently reported as right — which is the failure this
 * whole subsystem exists to stop. A bare word is still refused, and the
 * refusal says what to write instead.
 */
export function normalizeMailboxCriterion(raw: string): string {
  let value = raw.trim();
  // `Alerts <alerts@example.com>` — the display-name form of every mail client
  // in existence, and what somebody pastes when they copy a sender.
  const bracketed = value.match(/<\s*([^<>]+)\s*>/)?.[1];
  if (bracketed !== undefined) value = bracketed.trim();
  value = value.replace(/^mailto:/i, '').trim();
  // A trailing dot is a fully-qualified name written out; it is never part of
  // an address and would fail validation on its own.
  value = value.replace(/\.+$/, '');
  if (!value.includes('@')) {
    // Only with no `@` can `/` or `?` be a URL rather than a legal — if odd —
    // local part, so the URL cleanup is confined to this branch.
    value = value
      .replace(/^https?:\/\//i, '')
      .replace(/[/?#].*$/, '')
      .replace(/\.+$/, '');
    // A domain written without its `@`. Requiring a dot is what keeps a bare
    // brand word out: `stripe.com` is a domain, `Stripe` is a wish.
    if (value.includes('.')) value = `@${value}`;
  }
  return value.toLowerCase();
}

// `transform().pipe()` rather than `preprocess`, which widens the schema's
// input to `unknown` and takes the tool's argument type with it.
const mailboxCriterionSchema = (subject: 'Sender' | 'Recipient') =>
  z.string().transform(normalizeMailboxCriterion).pipe(
    z.string().min(1).refine(
      value =>
        z.string().email().safeParse(value).success
        || (
          value.startsWith('@')
          && z.string().email().safeParse(`mailbox${value}`).success
        ),
      `${subject} must be one mailbox address such as alerts@acme.com, or a `
        + 'domain such as acme.com. A company or brand name on its own cannot '
        + 'be matched — find the real sending address first.',
    ).refine(
    value => !value.startsWith('@')
      || !isTooBroadADomain(value.slice(1).toLowerCase()),
      `${subject} names a whole registry rather than an organisation, and `
        + 'because a domain now covers its subdomains that would match almost '
        + 'any sender. Name the organisation, such as acme.co.uk.',
    ),
  );

const senderCriterionSchema = mailboxCriterionSchema('Sender');
const recipientCriterionSchema = mailboxCriterionSchema('Recipient');

/** One phrase or many, always read as many. */
const asPhrases = (value: string | readonly string[]): readonly string[] =>
  typeof value === 'string' ? [value] : value;

/** Fields that narrow a rule to a recognisable slice of someone's mail. */
const NARROWING_FIELDS = ['from', 'to', 'subjectContains', 'bodyContains'] as const;

const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const clockTimeSchema = z.string().trim().regex(
  CLOCK_TIME,
  'Times are 24-hour HH:MM, for example 09:00 or 18:30.',
);

/**
 * A timezone is checked by trying to use it, because that is the only thing
 * that answers the question this rule actually depends on: whether *this*
 * runtime can resolve the name. A hardcoded list would drift from the ICU data
 * underneath it and start accepting names the matcher then cannot evaluate.
 */
const timeZoneSchema = z.string().trim().min(1).refine(value => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'timeZone must be an IANA timezone name such as Asia/Kolkata.');

const activeWindowSchema = z.object({
  days: z.array(z.enum(MAIL_RULE_WEEKDAYS)).min(1).optional(),
  start: clockTimeSchema,
  end: clockTimeSchema,
  timeZone: timeZoneSchema,
}).strict().refine(value => value.start !== value.end, {
  message: 'A window that starts and ends at the same time says nothing. Use '
    + 'different times, or leave activeWindow out to watch around the clock.',
});

/**
 * A phrase somebody typed, reduced to the text they meant to match.
 *
 * People reach for the syntax of whatever search box they last used, and every
 * one of those spellings matched *nothing* — a rule reported `valid: true` and
 * sat silent for weeks, which is the failure this whole subsystem exists to
 * stop. The decorations below are unambiguous: nobody writing `*invoice*` wants
 * a subject with asterisks in it, and no real subject is wrapped in the quotes
 * somebody typed around their search term.
 *
 * Only decoration is removed. Anything that changes *which* messages match is
 * refused instead, by `phraseSchema` — a guessed widening is the same defect as
 * today's silent narrowing, pointed the other way.
 */
export function normalizePhrase(raw: string): string {
  return raw
    .trim()
    // Quotes somebody wrapped their search term in, straight or curly.
    .replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '')
    // Glob and SQL wildcards at the ends. Interior ones stay: `a*b` is a
    // pattern, not decoration, and is refused below rather than mangled.
    .replace(/^[*%]+|[*%]+$/g, '')
    // A subject wraps and gets re-flowed; nobody means to match a run of
    // spaces or the newline they pasted in.
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The spellings that mean something we cannot honestly act on.
 *
 * `|` is the one worth naming: it usually means "either of these", but
 * `Acme | Invoice 42` is also an ordinary subject line, so splitting on it
 * would silently *widen* somebody's rule. Refusing and pointing at the list
 * form is the only answer that is never wrong.
 */
const PATTERN_HINTS: ReadonlyArray<{ test: RegExp; hint: string }> = [
  {
    test: /\|/,
    hint: 'Write the alternatives as a list instead — ["OTP", "verification '
      + 'code"] — because a subject can legitimately contain a "|".',
  },
  {
    test: /[*%]/,
    hint: 'Matching is "contains", so a wildcard in the middle has nothing to '
      + 'do. Write the part that is always there.',
  },
  {
    test: /^\^|\$$|\[.*\]|\{\d+,?\d*\}|\.\*/,
    hint: 'Matching is plain text, not a regular expression. Write the words '
      + 'as they appear in the message.',
  },
];

/**
 * One phrase, or a list of phrases any of which matches.
 *
 * The list is what `|` was reaching for. It is sorted and de-duplicated on the
 * way in so that the same set written in two orders is the same rule — the
 * identity key is derived from this value, and `["a","b"]` and `["b","a"]`
 * would otherwise be two rules forwarding every message twice.
 */
const phraseSchema = z
  .union([z.string(), z.array(z.string()).min(1).max(20)])
  .transform(value => (Array.isArray(value) ? value : [value])
    .map(normalizePhrase)
    .filter(phrase => phrase.length > 0))
  .pipe(z.array(z.string().min(1)).min(1))
  .transform(phrases => [...new Set(phrases.map(p => p))].sort())
  .superRefine((phrases, ctx) => {
    for (const phrase of phrases) {
      const hint = PATTERN_HINTS.find(({ test }) => test.test(phrase));
      if (hint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${phrase}" looks like a search pattern. ${hint.hint}`,
        });
        return;
      }
    }
  })
  .transform(phrases => (phrases.length === 1 ? phrases[0]! : phrases));

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
  subjectContains: phraseSchema.optional(),
  bodyContains: phraseSchema.optional(),
  hasAttachment: z.boolean().optional(),
  notFrom: senderCriterionSchema.optional(),
  notSubjectContains: phraseSchema.optional(),
  activeWindow: activeWindowSchema.optional(),
}).strict().refine(
  // Exclusions are not narrowing. `notFrom` alone describes every message
  // except one sender's, which is the broadest rule the system can express and
  // the opposite of what someone writing an exclusion means by it.
  value => NARROWING_FIELDS.some(field => value[field] !== undefined),
  {
    message: 'A rule needs at least one of from, to, subjectContains or '
      + 'bodyContains. hasAttachment, notFrom, notSubjectContains and '
      + 'activeWindow only narrow a rule that already has one of those.',
  },
).refine(
  // A rule that can never match is worth refusing at the point somebody writes
  // it, not leaving to be discovered by its silence weeks later.
  value => !(value.from && value.notFrom && excludes(value.notFrom, value.from)),
  {
    message: 'notFrom cancels out from, so this rule could never match. Drop '
      + 'one of them.',
  },
).refine(
  // With lists, the rule is dead only when *every* phrase it looks for
  // contains one of the phrases it excludes — if one alternative survives, the
  // rule still matches something.
  value => {
    if (!value.subjectContains || !value.notSubjectContains) return true;
    const wanted = asPhrases(value.subjectContains);
    const unwanted = asPhrases(value.notSubjectContains);
    return !wanted.every(want =>
      unwanted.some(avoid => want.toLowerCase().includes(avoid.toLowerCase())));
  },
  {
    message: 'Every subject this rule looks for also contains something it '
      + 'excludes, so it could never match.',
  },
);

/**
 * Whether a `notFrom` criterion covers everything a `from` criterion admits.
 *
 * Both shapes are exact — an address or an `@domain` — so this is decidable
 * rather than a guess. It has to read `@domain` the same way the matcher does,
 * or the two disagree in the worst direction: `from: @mail.acme.com` with
 * `notFrom: @acme.com` now cancels out completely, and a check still using the
 * old exact reading would accept that rule and let it match nothing forever,
 * which is the failure the check exists to prevent.
 */
function excludes(exclusion: string, inclusion: string): boolean {
  const wide = exclusion.trim().toLowerCase();
  const narrow = inclusion.trim().toLowerCase();
  if (wide === narrow) return true;
  if (!wide.startsWith('@')) return false;
  const excluded = wide.slice(1);
  const admitted = narrow.startsWith('@')
    ? narrow.slice(1)
    : narrow.slice(narrow.lastIndexOf('@') + 1);
  return domainCovers(excluded, admitted);
}

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
/**
 * The same field, read back off a rule that already exists.
 *
 * Looser than `phraseSchema` on purpose, and for the reason the rest of the
 * stored schema is: a rule written under an older grammar has to keep running.
 * It normalises but never refuses, because refusing here does not stop a bad
 * rule being created — that already happened — it stops a working rule from
 * firing.
 */
const storedPhraseSchema = z
  .union([z.string(), z.array(z.string())])
  .transform(value => (Array.isArray(value) ? value : [value])
    .map(normalizePhrase)
    .filter(phrase => phrase.length > 0))
  .pipe(z.array(z.string().min(1)).min(1))
  .transform(phrases => (phrases.length === 1 ? phrases[0]! : phrases));

const storedMailRuleMatchSchema = z.object({
  from: senderCriterionSchema.optional(),
  to: z.string().trim().min(1).optional(),
  subjectContains: storedPhraseSchema.optional(),
  bodyContains: storedPhraseSchema.optional(),
  hasAttachment: z.boolean().optional(),
  notFrom: senderCriterionSchema.optional(),
  notSubjectContains: storedPhraseSchema.optional(),
  // Not loosened for stored rules, unlike `to`. A window whose timezone this
  // runtime cannot resolve has no answer to "is it inside the window right
  // now", and the two ways of inventing one are both wrong: matching always
  // sends mail the member excluded, and matching never stops the rule with
  // nothing said. Failing to parse routes it to the mechanism that exists for
  // exactly this — the rule reports itself broken, with the reason.
  activeWindow: activeWindowSchema.optional(),
}).refine(value => Object.keys(value).length > 0, {
  message: 'At least one deterministic mail match is required.',
});

const rateLimitSchema = z.number().int().min(1).max(1000).optional();

const organizeActionSchema = z.object({
  type: z.literal('organize'),
  label: z.string().trim().min(1).max(225).optional(),
  archive: z.boolean().optional(),
  markRead: z.boolean().optional(),
}).refine(
  value => value.label !== undefined || value.archive === true || value.markRead === true,
  {
    message: 'An organize rule must label, archive, or mark read. Setting them '
      + 'all to false describes a rule that does nothing.',
  },
);

const ActionSchema = z.union([
  z.object({ type: z.literal('forward'), rateLimitPerHour: rateLimitSchema }),
  z.object({ type: z.literal('deliver'), rateLimitPerHour: rateLimitSchema }),
  organizeActionSchema,
]);

const DestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email'), email: z.string().email() }),
  z.object({ type: z.literal('lark_chat'), chatId: z.string().trim().min(1) }),
  z.object({ type: z.literal('none') }),
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
    ...(parsedMatch.notFrom ? { notFrom: parsedMatch.notFrom } : {}),
    ...(parsedMatch.notSubjectContains
      ? { notSubjectContains: parsedMatch.notSubjectContains }
      : {}),
    ...(parsedMatch.activeWindow
      ? {
          activeWindow: {
            ...(parsedMatch.activeWindow.days
              ? { days: parsedMatch.activeWindow.days }
              : {}),
            start: parsedMatch.activeWindow.start,
            end: parsedMatch.activeWindow.end,
            timeZone: parsedMatch.activeWindow.timeZone,
          },
        }
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
  const parsedAction = ActionSchema.parse(input.action);
  // Rebuilt field by field rather than passed through, because an optional key
  // present and holding `undefined` is not the same thing as absent — it would
  // reach `JSON.stringify` in the dedupe key as a key that is there.
  const action: MailRuleAction = parsedAction.type === 'organize'
    ? {
        type: 'organize',
        ...(parsedAction.label !== undefined ? { label: parsedAction.label } : {}),
        ...(parsedAction.archive !== undefined
          ? { archive: parsedAction.archive }
          : {}),
        ...(parsedAction.markRead !== undefined
          ? { markRead: parsedAction.markRead }
          : {}),
      }
    : {
        type: parsedAction.type,
        ...(parsedAction.rateLimitPerHour !== undefined
          ? { rateLimitPerHour: parsedAction.rateLimitPerHour }
          : {}),
      };
  const destination = DestinationSchema.parse(input.destination);
  if (action.type === 'forward' && destination.type !== 'email') {
    throw new Error('Forward rules require an email destination.');
  }
  if (action.type === 'deliver' && destination.type !== 'lark_chat') {
    throw new Error('Delivery rules require a Lark chat destination.');
  }
  // An `organize` rule never leaves the mailbox, so a destination on one is not
  // a harmless extra field — it is a rule whose author believed mail was being
  // sent somewhere. Refusing it is the only way that belief gets corrected.
  if (action.type === 'organize' && destination.type !== 'none') {
    throw new Error(
      'Organize rules act on the message in place and take no destination.',
    );
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
  /**
   * When the message arrived, for `activeWindow`.
   *
   * The arrival time, not the time the rule is evaluated. A backlog drained an
   * hour late must decide the same way it would have decided live, or a rule
   * saying "only during office hours" quietly becomes "only when Divo happened
   * to catch up during office hours".
   */
  occurredAt: Date,
): boolean {
  // Any one of the phrases counts. A single phrase is the same question asked
  // of a one-item list, so there is one code path and not two.
  const includes = (actual: string, expected: string | readonly string[]): boolean => {
    const haystack = actual.toLowerCase();
    return (typeof expected === 'string' ? [expected] : expected)
      .some(phrase => haystack.includes(phrase.toLowerCase()));
  };
  return (
    (!match.from || senderMatches(message.from, match.from))
    && (!match.to || recipientMatches(message, match.to))
    && (!match.subjectContains || includes(message.subject, match.subjectContains))
    && (!match.bodyContains || includes(message.bodyText, match.bodyContains))
    && (
      match.hasAttachment === undefined
      || message.hasAttachment === match.hasAttachment
    )
    && (!match.notFrom || senderIsNot(message.from, match.notFrom))
    && (
      !match.notSubjectContains
      || !includes(message.subject, match.notSubjectContains)
    )
    && (!match.activeWindow || withinActiveWindow(match.activeWindow, occurredAt))
  );
}

/**
 * Whether the message provably did *not* come from the excluded mailbox.
 *
 * A `From` header nothing can be read out of is not evidence that the sender is
 * someone else, so it fails the exclusion and the rule does not fire. That is
 * the same direction every other decision in this file leans: an unreadable
 * header loses a match rather than inventing one. The cost is a rule with an
 * exclusion skipping mail from a malformed sender it would otherwise have
 * forwarded; the alternative is forwarding mail the member explicitly asked to
 * keep out, because its `From` was malformed enough to hide behind.
 */
function senderIsNot(fromHeader: string, criterion: string): boolean {
  const address = senderAddress(fromHeader);
  return address !== undefined && !addressMatches(address, criterion);
}

/**
 * Whether a message arriving at this instant falls inside the rule's window.
 *
 * Wall-clock in the rule's own timezone, resolved through `Intl` rather than by
 * arithmetic on a UTC offset — an offset is not a timezone, and a rule written
 * in March against a fixed offset would be an hour wrong from the last Sunday
 * of the month onward, every year, for half the world.
 */
function withinActiveWindow(window: MailRuleActiveWindow, at: Date): boolean {
  const local = localWallClock(window.timeZone, at);
  const start = clockMinutes(window.start);
  const end = clockMinutes(window.end);
  // `end` before `start` is an overnight window: 22:00–02:00 is four hours
  // spanning midnight, not a twenty-hour window with a hole in it.
  const wraps = end < start;
  const inside = wraps
    ? local.minutes >= start || local.minutes < end
    : local.minutes >= start && local.minutes < end;
  if (!inside) return false;
  if (!window.days?.length) return true;
  // A wrapped window belongs to the day it opened on, so mail arriving at 01:00
  // on Saturday is inside a Friday 22:00–02:00 window. Reading the calendar day
  // instead would make every overnight window ask for the wrong day at exactly
  // the hours it exists for.
  const index = MAIL_RULE_WEEKDAYS.indexOf(local.weekday);
  const openedOn = wraps && local.minutes < end
    ? MAIL_RULE_WEEKDAYS[(index + 6) % 7]!
    : local.weekday;
  return window.days.includes(openedOn);
}

const WEEKDAY_BY_LABEL = new Map<string, MailRuleWeekday>([
  ['mon', 'mon'], ['tue', 'tue'], ['wed', 'wed'], ['thu', 'thu'],
  ['fri', 'fri'], ['sat', 'sat'], ['sun', 'sun'],
]);

function localWallClock(
  timeZone: string,
  at: Date,
): { weekday: MailRuleWeekday; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const value = (type: string): string =>
    parts.find(part => part.type === type)?.value ?? '';
  const weekday = WEEKDAY_BY_LABEL.get(value('weekday').slice(0, 3).toLowerCase());
  if (!weekday) {
    // `en-US` short weekdays are the three-letter forms this map is built from,
    // and the timezone was proved resolvable when the rule was parsed. Reaching
    // here means the runtime disagrees with both, and guessing a day would put
    // mail somewhere on the strength of a guess.
    throw new Error(`Could not resolve the local weekday in ${timeZone}.`);
  }
  return {
    weekday,
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
  };
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
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

/**
 * Exported for the correspondent summary, which needs the same answer this
 * gives the matcher. Re-implementing it there would mean a second, softer
 * parser deciding who a message is from — and the two disagreeing is exactly
 * how a suggestion offers a sender that no rule can then match.
 */
export function senderAddress(fromHeader: string): string | undefined {
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
  // A rule stored before recipients were parsed holds free text, and which of
  // the two readings it gets depends on whether that text is an address at all.
  //
  // Text that normalises to one — a bare `acme.com` becoming `@acme.com` — is
  // matched as the address it is, across all four recipient headers and
  // covering subdomains. That *is* wider than the `To`-substring test such a
  // rule was created under, and deliberately: the member wrote a domain and
  // meant mail addressed to that domain, which is the same event to them
  // whether their address landed in `To` or in `Cc`. The narrow reading was
  // never a promise anybody made them; it was an artefact of nothing parsing
  // the header.
  //
  // Text that is not an address keeps the old substring test against `To`
  // alone, because there is no address to widen it to. Nothing new can be
  // written in either shape — `mailRuleMatchSchema` requires a mailbox or an
  // @domain.
  // Parsed once, and the *parsed* value is what gets matched. Reading the
  // schema for the branch and then matching the raw string was a way to lose
  // every legacy rule at once: the schema normalises, so a stored `acme.com`
  // now passes validation — it did not before — and then `addressMatches` was
  // handed `acme.com`, which has no `@`, so it compared it to a whole mailbox
  // and matched nothing. The rule kept reporting `valid: true` and quietly
  // stopped firing, which is precisely the failure this wave exists to remove.
  const parsed = recipientCriterionSchema.safeParse(criterion);
  if (!parsed.success) {
    return message.to.toLowerCase()
      .includes(criterion.toLowerCase());
  }
  return [message.to, message.cc, message.bcc, message.deliveredTo]
    .filter((header): header is string => Boolean(header?.trim()))
    .flatMap(header => addressesIn(header))
    .some(address => addressMatches(address, parsed.data));
}

/**
 * Whether one address satisfies one criterion. **`@domain` covers subdomains.**
 *
 * It used to mean that domain and nothing else, which is the more precise
 * reading and was the wrong one. Nearly every service that sends transactional
 * mail sends it from a subdomain — a bounce or delivery domain the recipient
 * has no reason to know about — so a member asking for mail from a company, and
 * a model writing the obvious `@company.com`, produced a rule that was created,
 * reported as active, and never fired once. A rule that silently matches
 * nothing is the exact failure this whole subsystem is being cleaned of, and it
 * cost far more than the precision was worth.
 *
 * What is given up is the ability to say "this domain and not its subdomains".
 * There is no syntax for it, because nobody has asked for one and the silent
 * dead rule is the failure that was actually happening. Adding `@*.domain`
 * later would not disturb this reading.
 *
 * Matching is on label boundaries, never on string suffix. `endsWith` would
 * make `@example.com` match `billing@notexample.com`, handing anyone who can
 * register a lookalike domain a rule that was never meant for them.
 */
function addressMatches(address: string, criterion: string): boolean {
  const expected = criterion.trim().toLowerCase();
  if (!expected.startsWith('@')) return address === expected;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return domainCovers(expected.slice(1), domain);
}

/** Whether `criterion` is `domain` itself or one of its parents. */
function domainCovers(criterion: string, domain: string): boolean {
  return domain === criterion || domain.endsWith(`.${criterion}`);
}

/** Every address in one recipient header, one entry at a time. */
export function addressesIn(header: string): string[] {
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
    // Not the separator itself, or an instance ending in a backslash would
    // swallow it and carry its open quote into the next instance — the one
    // thing the separator exists to stop.
    if (hidden && character === '\\' && header[index + 1] !== '\n') {
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
