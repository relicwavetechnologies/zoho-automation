/**
 * Who actually writes to a mailbox, and which of its owner's addresses mail
 * arrives at — summarised from events Divo has already stored.
 *
 * This exists so nobody has to write a mail rule from memory. Somebody types
 * the brand they know, `acme.com`, and the invoices arrive from
 * `billing@mail.acme-billing.com`: the rule is valid, the screen says
 * "Waiting", and nothing ever happens. No amount of validation catches that,
 * because nothing about the rule is wrong. Only showing them what really
 * arrives does.
 *
 * Pure, and separated from the query for that reason — the counting rules
 * below are where the judgement is, and they are worth testing without a
 * database.
 *
 * TWO SETS, ANSWERING DIFFERENT QUESTIONS:
 *
 *  - `from` — senders, and the domains above them. Domains matter more than
 *    addresses here because the matcher reads a leading `@` as covering
 *    subdomains, so `@acme.com` is usually the rule somebody wants and
 *    `billing@acme.com` the one they would have written unaided.
 *  - `to` — the owner's *own* addresses: their mailbox, plus the group aliases
 *    in their organisation that deliver to it. Not every recipient of every
 *    message; an external party who was cc'd is not an address this mailbox
 *    receives at, and offering it would produce a rule that matches nothing.
 */
import { addressesIn, senderAddress } from './mail-rule.matcher';

export interface CorrespondentEvent {
  metadata: Record<string, unknown>;
}

export interface MailSuggestion {
  /** Exactly what belongs in the rule field — `@acme.com` keeps the syntax. */
  value: string;
  kind: 'domain' | 'address';
  messageCount: number;
  /** Domains only: how many distinct senders sit under it. */
  senderCount?: number;
  /** `to` addresses only: reaches this mailbox but is not its own address. */
  alias?: boolean;
}

export interface CorrespondentSummary {
  from: MailSuggestion[];
  to: MailSuggestion[];
}

/**
 * A domain is only worth offering above its senders when it actually groups
 * them. One sender under a domain makes the two rows the same rule written
 * twice, and the wider one is the worse default.
 */
const MIN_SENDERS_FOR_DOMAIN = 2;

/** Below this a suggestion is noise — a one-off is not what anybody meant. */
const MIN_MESSAGES = 2;

const MAX_PER_SET = 40;

const domainOf = (address: string): string => address.split('@')[1] ?? '';

/**
 * A domain worth suggesting on its own.
 *
 * `gmail.com` and the other public mailbox providers group nothing: every
 * unrelated individual who has ever written shares one, so `@gmail.com` would
 * top the list while describing a rule that catches half the inbox.
 */
const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'yahoo.co.in', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
  'aol.com', 'rediffmail.com', 'zoho.com', 'qq.com', '163.com',
]);

const str = (source: Record<string, unknown>, key: string): string =>
  typeof source[key] === 'string' ? (source[key] as string) : '';

export function summariseCorrespondents(
  events: readonly CorrespondentEvent[],
  mailboxEmail: string,
): CorrespondentSummary {
  const own = mailboxEmail.toLowerCase();
  const ownDomain = domainOf(own);

  const senders = new Map<string, number>();
  const recipients = new Map<string, number>();

  for (const event of events) {
    const metadata = event.metadata;

    // Divo's own forwards. A rule delivering back into the mailbox it watches
    // would otherwise appear in this list as a frequent correspondent, and a
    // rule built on it forwards Divo's output to itself for ever.
    if (typeof metadata['forwardedByRuleId'] === 'string') continue;

    const from = senderAddress(str(metadata, 'from'));
    // Mail the owner sent themselves is not a sender they can usefully match.
    if (from && from !== own) senders.set(from, (senders.get(from) ?? 0) + 1);

    // The union of every header that says where a message was delivered.
    // Events recorded before recipient matching existed carry `to` alone and
    // degrade to it, which is what the matcher does too.
    const seen = new Set<string>();
    for (const key of ['to', 'cc', 'bcc', 'deliveredTo'] as const) {
      const header = str(metadata, key);
      if (header.length === 0) continue;
      for (const address of addressesIn(header)) seen.add(address);
    }
    for (const address of seen) {
      // Only addresses inside this mailbox's own organisation, because only
      // those can be addresses that reach it. An external party cc'd on a
      // thread is a recipient of the message and not of this inbox, and a rule
      // written on one would wait for ever.
      if (address !== own && domainOf(address) !== ownDomain) continue;
      recipients.set(address, (recipients.get(address) ?? 0) + 1);
    }
  }

  return {
    from: buildSenderSet(senders),
    to: buildRecipientSet(recipients, own),
  };
}

function buildSenderSet(senders: Map<string, number>): MailSuggestion[] {
  const domains = new Map<string, { messages: number; senders: number }>();
  for (const [address, count] of senders) {
    const domain = domainOf(address);
    if (domain.length === 0 || PUBLIC_DOMAINS.has(domain)) continue;
    const entry = domains.get(domain) ?? { messages: 0, senders: 0 };
    entry.messages += count;
    entry.senders += 1;
    domains.set(domain, entry);
  }

  const suggestions: MailSuggestion[] = [];

  for (const [domain, entry] of domains) {
    if (entry.senders < MIN_SENDERS_FOR_DOMAIN || entry.messages < MIN_MESSAGES) continue;
    suggestions.push({
      value: `@${domain}`,
      kind: 'domain',
      messageCount: entry.messages,
      senderCount: entry.senders,
    });
  }

  for (const [address, count] of senders) {
    if (count < MIN_MESSAGES) continue;
    suggestions.push({ value: address, kind: 'address', messageCount: count });
  }

  return rank(suggestions);
}

function buildRecipientSet(
  recipients: Map<string, number>,
  own: string,
): MailSuggestion[] {
  const suggestions: MailSuggestion[] = [];
  for (const [address, count] of recipients) {
    // The owner's own address is always offered, however little it is counted
    // — it is the answer to "addressed to me directly", and a mailbox whose
    // mail mostly arrives via aliases would otherwise not list it at all.
    if (address !== own && count < MIN_MESSAGES) continue;
    suggestions.push({
      value: address,
      kind: 'address',
      messageCount: count,
      ...(address === own ? {} : { alias: true }),
    });
  }
  return rank(suggestions);
}

/**
 * Volume first, and never alphabetical.
 *
 * The count is the evidence that a rule built on this will catch anything, so
 * the order has to carry it. Domains sit above addresses at equal volume
 * because the wider match is usually the intended one; the tie-break on the
 * value itself only exists so the list does not reshuffle between reads.
 */
function rank(suggestions: MailSuggestion[]): MailSuggestion[] {
  return suggestions
    .sort((a, b) => (
      b.messageCount - a.messageCount
      || Number(b.kind === 'domain') - Number(a.kind === 'domain')
      || a.value.localeCompare(b.value)
    ))
    .slice(0, MAX_PER_SET);
}
