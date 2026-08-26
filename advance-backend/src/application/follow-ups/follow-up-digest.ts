import { ownerLabel, type FollowUpOwner } from '../../domain/follow-ups/follow-up';

/**
 * What the group is told, per number.
 *
 * The digest is several cards rather than one. The *data* is pooled — a follow-up
 * belongs to Urban Aura, not to a handset — but delivery is split so the group
 * can see which line is carrying what. One merged card would answer "what is
 * outstanding" and lose "who should pick this up", which in a team sharing ten
 * numbers is most of the useful information.
 *
 * No model runs here. Everything on a card is a row we already hold, rendered.
 * That is deliberate and it is why the digest can be sent twice a day for free:
 * the single model call in this feature happens at analysis time, once per chat,
 * behind a thirty-minute cooldown.
 */

export interface DigestItem {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly counterparty: string;
  readonly chatName: string | null;
  readonly dueDate: Date | null;
  readonly urgency: string;
}

export interface NumberDigest {
  readonly sessionId: string;
  readonly label: string;
  readonly items: readonly DigestItem[];
  /** Items beyond the card's cap. Named, never silently dropped. */
  readonly withheld: number;
}

export interface DarkNumber {
  readonly label: string;
  readonly darkSince: Date | null;
}

export interface DigestCard {
  readonly sessionId: string | null;
  readonly title: string;
  /**
   * The digest as markdown.
   *
   * Not what gets sent — see `card`. This is the same content in a form that
   * can be logged, tested, or carried to a surface that has no cards: the
   * card's own blocks with the colour stripped out, so the two cannot say
   * different things.
   */
  readonly markdown: string;
  /**
   * The digest as a Lark interactive card, ready for `sendToChatId`.
   *
   * A group message sent as `msg_type: 'text'` is not interpreted by Lark:
   * `**We owe**` arrives with the asterisks showing. Every other place Divo
   * speaks in Lark builds a card for exactly this reason, and a standing
   * twice-daily report that renders as punctuation is one people learn to
   * ignore.
   */
  readonly card: string;
  readonly itemCount: number;
}

/**
 * How many items one card carries.
 *
 * Past this a card stops being read. The remainder is counted on the card and
 * reachable through the button rather than dropped — AGENTS.md is explicit that
 * a truncated result must say so, and "3 more" is the difference between a
 * summary and a lie.
 */
export const DIGEST_ITEMS_PER_CARD = 8;

const URGENCY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Most urgent first, then soonest due, then oldest. */
export function sortForDigest(items: readonly DigestItem[]): DigestItem[] {
  return [...items].sort((a, b) => {
    const urgency = (URGENCY_RANK[a.urgency] ?? 1) - (URGENCY_RANK[b.urgency] ?? 1);
    if (urgency !== 0) return urgency;
    const aDue = a.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bDue = b.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return aDue - bDue;
  });
}

// ── Card shape — mirrors mail-brief ────────────────────────────────────────

const DIGEST_BADGE = 'Divo Follow-ups';

const GREY = (text: string): string => `<font color='grey'>${text}</font>`;

interface DigestNote {
  readonly flag: string;
  readonly who: string;
  readonly title: string;
  readonly where: string;
  readonly due: string;
}

interface NumberCardContent {
  readonly label: string;
  readonly time: string;
  readonly notes: readonly DigestNote[];
  readonly withheld: number;
  readonly openUrl: string | null;
}

interface HealthCardContent {
  readonly dark: readonly { label: string; since: string | null }[];
  readonly openUrl: string | null;
}

/**
 * Where "Open follow-ups" goes, deep-linked to this number when present.
 *
 * Passed in rather than read from config here so the composer stays pure and
 * the link is testable. Omitted when no base URL is configured — a card that
 * offers a link to nowhere is worse than one that does not offer a link.
 *
 * Validated via URL constructor so a misconfigured base yields no button
 * rather than a broken one. Only http(s) is accepted — a `javascript:` base
 * would put a scheme of somebody else's choosing behind a button inside
 * Divo's own card.
 */
const followUpsUrl = (
  appBaseUrl: string | undefined,
  sessionId: string | null | undefined,
): string | null => {
  if (!appBaseUrl?.trim()) return null;
  try {
    const path = sessionId
      ? `/me/follow-ups?number=${encodeURIComponent(sessionId)}`
      : '/me/follow-ups';
    const url = new URL(path, appBaseUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
};

const digestWrapper = (
  summary: string,
  badge: string,
  elements: Array<Record<string, unknown>>,
): string =>
  JSON.stringify({
    msg_type: 'interactive',
    card: JSON.stringify({
      schema: '2.0',
      config: {
        width_mode: 'fill',
        update_multi: false,
        enable_forward: true,
        summary: { content: summary },
      },
      header: {
        template: 'default',
        text_tag_list: [
          {
            tag: 'text_tag',
            text: { tag: 'plain_text', content: badge },
            color: 'blue',
          },
        ],
      },
      body: {
        vertical_spacing: '4px',
        padding: '12px 12px 10px 12px',
        elements,
      },
    }),
  });

/**
 * One brief, as values rather than as prose.
 *
 * The card and the plain-text rendering are both built from this, so a change
 * to what a brief says cannot reach one surface and miss the other. The earlier
 * version shared pre-rendered markdown strings between them, which held the two
 * together only for as long as both wanted the same layout — and the card wants
 * a header, a grey footnote and a footer, none of which are lines of prose.
 */

const numberBody = (content: NumberCardContent): Array<Record<string, unknown>> => {
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: `**${content.label}** · ${content.time}` },
  ];

  for (const note of content.notes) {
    elements.push({
      tag: 'markdown',
      content: `- ${note.flag}**${note.who}** — ${note.title}${note.where}${note.due}`,
      margin: '8px 0 0 0',
    });
  }

  if (content.withheld > 0) {
    elements.push({
      tag: 'markdown',
      content: GREY(`…and ${content.withheld} more`),
      text_size: 'notation',
      margin: '8px 0 0 0',
    });
  }

  if (content.openUrl) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: 'Open follow-ups' },
      type: 'default',
      size: 'small',
      width: 'default',
      margin: '10px 0 0 0',
      behaviors: [{ type: 'open_url', default_url: content.openUrl }],
    });
  }

  return elements;
};

const numberCard = (content: NumberCardContent): string => {
  const elements = numberBody(content);
  const total = content.notes.length + content.withheld;
  const summary = `${DIGEST_BADGE} — ${content.label} · ${total} open`;
  return digestWrapper(summary, DIGEST_BADGE, elements);
};

const numberText = (content: NumberCardContent): string =>
  numberBody(content)
    .flatMap(element => {
      if (element.tag === 'markdown') {
        return [String(element.content).replace(/<\/?font[^<>]*>/g, '')];
      }
      if (element.tag === 'button') {
        const label = (element['text'] as { content?: string } | undefined)?.content ?? '';
        const url = (element['behaviors'] as Array<{ default_url?: string }> | undefined)?.[0]
          ?.default_url;
        return url ? [`[${label}](${url})`] : [];
      }
      return [];
    })
    .join('\n\n');

const healthBody = (content: HealthCardContent): Array<Record<string, unknown>> => {
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: '⚠️ **Some numbers are not being read**' },
  ];

  for (const number of content.dark) {
    const since = number.since ? ` — no messages since ${number.since}` : ' — never connected';
    elements.push({
      tag: 'markdown',
      content: `- **${number.label}**${since}`,
      margin: '8px 0 0 0',
    });
  }

  elements.push({
    tag: 'markdown',
    content: GREY(
      'Messages sent to these numbers are not reaching Divo. Open follow-ups to reconnect, then re-read the missed history.',
    ),
    text_size: 'notation',
    margin: '8px 0 0 0',
  });

  if (content.openUrl) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: 'Open follow-ups' },
      type: 'default',
      size: 'small',
      width: 'default',
      margin: '10px 0 0 0',
      behaviors: [{ type: 'open_url', default_url: content.openUrl }],
    });
  }

  return elements;
};

const healthCard = (content: HealthCardContent): string => {
  const elements = healthBody(content);
  const title = `${content.dark.length} number${content.dark.length === 1 ? '' : 's'} not reporting`;
  const summary = `${DIGEST_BADGE} — ${title}`;
  return digestWrapper(summary, DIGEST_BADGE, elements);
};

const healthText = (content: HealthCardContent): string =>
  healthBody(content)
    .flatMap(element => {
      if (element.tag === 'markdown') {
        return [String(element.content).replace(/<\/?font[^<>]*>/g, '')];
      }
      if (element.tag === 'button') {
        const label = (element['text'] as { content?: string } | undefined)?.content ?? '';
        const url = (element['behaviors'] as Array<{ default_url?: string }> | undefined)?.[0]
          ?.default_url;
        return url ? [`[${label}](${url})`] : [];
      }
      return [];
    })
    .join('\n\n');

/**
 * One number's card.
 *
 * Returns `null` when the number has nothing outstanding. A card saying "nothing
 * to report" twice a day from ten handsets is twenty messages of noise, and the
 * group would stop reading all of them — including the ones that matter.
 */
export function composeNumberCard(
  digest: NumberDigest,
  timeZone: string,
  now: Date,
  /**
   * Where "see everything" goes, deep-linked to this number.
   *
   * Passed in rather than read from config here so the composer stays pure and
   * the link is testable. Omitted when no base URL is configured — a card that
   * offers a link to nowhere is worse than one that does not offer a link.
   */
  appBaseUrl?: string,
): DigestCard | null {
  if (digest.items.length === 0) return null;

  const ordered = sortForDigest(digest.items);
  const shown = ordered.slice(0, DIGEST_ITEMS_PER_CARD);
  const withheld = digest.withheld + Math.max(0, ordered.length - shown.length);

  const notes: DigestNote[] = shown.map(item => {
    const who = ownerLabel(item.owner as FollowUpOwner, item.counterparty);
    const where = item.chatName ? ` · ${item.chatName}` : '';
    const due = item.dueDate ? ` · due ${formatDate(item.dueDate, timeZone)}` : '';
    const flag = item.urgency === 'high' ? '🔴 ' : '';
    return { flag, who, title: item.title, where, due };
  });

  const content: NumberCardContent = {
    label: digest.label,
    time: formatTime(now, timeZone),
    notes,
    withheld,
    openUrl: followUpsUrl(appBaseUrl, digest.sessionId),
  };

  return {
    sessionId: digest.sessionId,
    title: `${digest.label} — ${digest.items.length} open`,
    markdown: numberText(content),
    card: numberCard(content),
    itemCount: digest.items.length,
  };
}

/**
 * The health card, sent only when a number is dark.
 *
 * Its own card rather than a line on somebody else's, because a quiet handset
 * sends nothing — that is what being dark means — so without this the number
 * would simply be absent from the digest, and absent reads exactly like "nothing
 * outstanding". The one state that most needs saying is the one that says
 * nothing on its own.
 */
export function composeHealthCard(
  dark: readonly DarkNumber[],
  timeZone: string,
  appBaseUrl?: string,
): DigestCard | null {
  if (dark.length === 0) return null;

  const content: HealthCardContent = {
    dark: dark.map(number => ({
      label: number.label,
      since: number.darkSince ? formatDateTime(number.darkSince, timeZone) : null,
    })),
    openUrl: followUpsUrl(appBaseUrl, null),
  };

  return {
    sessionId: null,
    title: `${dark.length} number${dark.length === 1 ? '' : 's'} not reporting`,
    markdown: healthText(content),
    card: healthCard(content),
    itemCount: 0,
  };
}

const formatDate = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(date);

const formatTime = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);

const formatDateTime = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
