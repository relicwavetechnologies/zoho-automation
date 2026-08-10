/**
 * Twice a day, what happened in your mail — in your Lark DM.
 *
 * It answers two questions, and the card gives them very different weight:
 *
 *   **What wants you.** Mail that arrived and is waiting on a decision or a
 *   reply from you. This is the part a person actually opens the message for,
 *   so it is the header line and the body — one block per message.
 *
 *   **What Divo handled.** What each rule forwarded, filed, or held back. This
 *   is the part that makes the rules trustworthy — a rule you never see working
 *   is a rule you eventually turn off — but it is a report on machinery that
 *   behaved, so it is a grey footnote rather than a section.
 *
 * A third question, *what you are waiting on* — mail you sent that nobody
 * answered — is deliberately unanswered. It needs Divo to watch the SENT label
 * and correlate replies, and every part of Mail Ops today is built around mail
 * arriving. It is a wave of its own, not a paragraph of this one.
 *
 * ── Where the content comes from ─────────────────────────────────────────────
 *
 * Entirely from rows Divo already has. Every INBOX arrival is recorded as a
 * `MailEvent` before any rule is matched against it, and every action a rule
 * took is a `MailDelivery`. So a brief costs **no Gmail API calls at all** — it
 * is a database read and one summarising call, which is the whole reason it can
 * run for every member twice a day without a quota conversation.
 *
 * ── What the model is and is not allowed to do ───────────────────────────────
 *
 * It picks messages out of a list by index and writes one sentence about each.
 * It never supplies a sender, a subject, an address or a time — those are
 * rendered from the stored row, so a model that hallucinates cannot put words
 * in a colleague's mouth or invent an email that never arrived. An index that
 * is out of range is dropped rather than repaired.
 *
 * What the rules did touches no model at all. It is arithmetic over delivery
 * rows, and a summary of a member's own automation should not be able to be
 * wrong.
 */
import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { extractJson } from './mail-rule-compiler';

export interface MailBriefMessage {
  from: string;
  subject: string;
  snippet: string;
  occurredAt: Date;
}

export interface MailBriefRuleActivity {
  ruleName: string;
  delivered: number;
  held: number;
  /** Refused: over the rule's ceiling, or by permission. */
  blocked: number;
  failed: number;
}

export interface MailBriefWindow {
  mailboxEmail: string;
  from: Date;
  to: Date;
  timeZone: string;
  messages: MailBriefMessage[];
  handled: MailBriefRuleActivity[];
}

/**
 * How many messages the model is shown.
 *
 * A quiet mailbox is under this and a busy one is not; a mailbox with four
 * hundred arrivals in twelve hours is a mailing-list problem that a longer
 * prompt does not fix. Newest first, so the cut falls on the oldest.
 */
const MAX_MESSAGES_READ = 60;

const SYSTEM_PROMPT = `You read a list of emails and pick out the ones that need something from the reader.

Return ONLY JSON. No prose, no code fence.

{"wants":[{"index":0,"want":"..."}]}

RULES
- "index" is the number shown beside the email in the list. Never invent one.
- "want" is one short sentence saying what that sender needs from the reader, in plain words. Start with a verb where it reads naturally: "Needs your sign-off on August payroll today."
- Include an email ONLY if a person is waiting on the reader to reply, decide, approve, send something, or turn up. When in doubt, leave it out.
- Exclude newsletters, marketing, receipts, notifications, delivery updates, calendar spam, automated alerts, and anything from a no-reply address.
- Never quote or copy codes, passwords, amounts, account numbers, or links. Describe, do not transcribe.
- Never mention being an AI, and never address the reader by name.
- If nothing needs the reader, return {"wants":[]}. That is a good answer, not a failure.`;

const responseSchema = z.object({
  wants: z.array(z.object({
    index: z.number().int().min(0),
    want: z.string().trim().min(1).max(300),
  })).max(40),
});

/** `Alerts <a@b.com>` → `Alerts`; a bare address keeps its local part. */
export function senderName(from: string): string {
  const named = from.match(/^\s*"?([^"<]+?)"?\s*</);
  if (named?.[1]) return named[1].trim();
  const bare = from.replace(/[<>]/g, '').trim();
  return bare.split('@')[0] ?? bare;
}

const timeIn = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at);

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Text from a mailbox, made safe to sit inside the card's own markup.
 *
 * The card wraps a subject in a `<font color='grey'>` of its own, so a subject
 * reading `Re: </font>` would close that tag early and take the rest of the
 * card's structure with it. An asterisk does the same to the bold the sender's
 * name is wrapped in. Underscores are deliberately left alone, on the same
 * reasoning the run log uses: stripping them would rewrite `invoice_2026_08`,
 * and the worst an unbalanced one does is italicise the rest of a line.
 *
 * Links are taken down to their anchor text and bare URLs are dropped outright,
 * on the same reasoning the mail preview uses: this card is unambiguously from
 * Divo, and a subject reading `[Verify your mailbox](https://…)` would put a
 * clickable target of a stranger's choosing, under wording of their choosing,
 * inside Divo's own message. Anyone who can email a member can write that
 * subject, so it is the one piece of mailbox text that must not survive.
 *
 * Length is capped here rather than by the model, because the sender, subject
 * and rule name never pass through it — they are read straight off stored rows,
 * and a 300-character subject wraps to five lines on a phone.
 */
const flatten = (value: string, maxLength: number): string => {
  /*
   * Tag-shaped runs only — `<` followed by a letter or a closing slash.
   * Matching every `<…>` deleted the middle of `Renewal: <500 USD, sign-off >
   * today`, which is a subject silently rewritten to say something the sender
   * did not, in the one card that promises the sender's own words.
   */
  let flat = value
    .replace(/<\/?[a-zA-Z][^<>]*>/g, ' ')
    /*
     * The stray characters go **before** the link passes, not after.
     *
     * Deleting them last meant a sender could hide a link from every pass and
     * have this very line reassemble it: `[Verify]<(ht<tps://evil.example)`
     * matches no link and no URL while the brackets are there, and comes out
     * of the last replace as a working `[Verify](https://evil.example)`. The
     * sanitiser was building the thing it exists to destroy.
     */
    .replace(/[<>`*]/g, '');

  /*
   * Links, to a fixed point.
   *
   * One pass is not enough either: unwrapping the inner link of
   * `[[Click here](/a)](//evil.example)` re-forms the outer one behind the
   * regex, which never looks back — so a nested link survived a stripper whose
   * whole purpose was that it could not.
   */
  for (let previous = ''; previous !== flat; ) {
    previous = flat;
    flat = flat.replace(/\[([^[\]]*)\]\([^()]*\)/g, '$1');
  }

  flat = flat
    /*
     * Bounded to characters a URL can hold, not to "everything up to a space".
     *
     * `\S+` ran to the next whitespace, and a Chinese or Japanese subject has
     * none — `请批准www.example.com/invoice上的发票，金额为12万元` came out as
     * `请批准`, deleting the amount and the deadline. On a Feishu install that
     * is the ordinary case, and it is the same silent rewriting of a sender's
     * words that the tag rule above was narrowed to avoid.
     */
    .replace(/(?:https?:\/\/|www\.)[\w\-.~:/?#@!$&'+=%()[\]*]+/gi, ' ')
    // Whatever bracket pairing the loop could not resolve is broken apart
    // rather than left whole. An unbalanced `](` is not a link Lark renders,
    // and separating it means no later edit can accidentally close it.
    .replace(/\]\s*\(/g, '] (')
    .replace(/\s+/g, ' ')
    .trim();

  // Cut on code points, not code units. Slicing UTF-16 through an emoji leaves
  // a lone surrogate in the card, which Lark may render as a replacement glyph
  // or reject outright — and a rejected card costs the member the whole brief.
  if (flat.length <= maxLength) return flat;
  return `${[...flat].slice(0, maxLength - 1).join('')}…`;
};

/**
 * How many messages the card names before it starts counting instead.
 *
 * The model may return up to forty, and forty two-line entries is not a brief —
 * it is an inbox, rendered worse. Lark also caps a card's elements and its total
 * size, and a card that exceeds either is rejected outright, which would cost
 * the member the brief rather than its tail. What is cut is said out loud.
 */
const MAX_SHOWN_WANTS = 12;

/** Rules named before the footnote starts counting instead. */
const MAX_SHOWN_RULES = 8;

const SENDER_MAX  = 40;
const SUBJECT_MAX = 70;
const WANT_MAX    = 180;
const RULE_MAX    = 60;

export interface MailBriefDeps {
  readonly model: LanguageModel;
}

export interface MailBrief {
  /**
   * The brief as markdown.
   *
   * Not what gets sent — see `card`. This is the same content in a form that
   * can be logged, tested, or carried to a surface that has no cards: the
   * card's own blocks with the colour stripped out, so the two cannot say
   * different things.
   */
  readonly text: string;
  /**
   * The brief as a Lark interactive card, ready for `deliverLarkDm`.
   *
   * A DM sent as `msg_type: 'text'` is not interpreted by Lark: `**Your mail**`
   * arrives with the asterisks showing. Every other place Divo speaks in Lark
   * builds a card for exactly this reason, and a standing twice-daily report
   * that renders as punctuation is one people learn to ignore.
   */
  readonly card: string;
  /** How many messages were named. Zero is a valid, deliverable brief. */
  readonly wantCount: number;
  /** True when the model could not be reached, so no mail is named. */
  readonly degraded: boolean;
}

/**
 * One brief, as values rather than as prose.
 *
 * The card and the plain-text rendering are both built from this, so a change
 * to what a brief says cannot reach one surface and miss the other. The earlier
 * version shared pre-rendered markdown strings between them, which held the two
 * together only for as long as both wanted the same layout — and the card wants
 * a header, a grey footnote and a footer, none of which are lines of prose.
 */
interface BriefNote {
  readonly sender: string;
  readonly subject: string;
  readonly want: string;
  readonly time: string;
}

interface BriefContent {
  /** `01:41–13:41 · you@company.com`. Provenance, not news — it sits in the footer. */
  readonly window: string;
  /** The one line that answers "do I need to open this?" */
  readonly verdict: string;
  readonly notes: readonly BriefNote[];
  /** What the verdict and the notes leave unsaid — counts, and what was cut. */
  readonly aside: string | null;
  /** `**Rule name** — 3 passed on, 2 held back`, already composed. */
  readonly handled: readonly string[];
}

const GREY = (text: string): string => `<font color='grey'>${text}</font>`;

/**
 * The brief, as Lark renders it.
 *
 * The design rule is the one every other Divo card follows: each fact appears
 * exactly once, and colour is spent only where it carries meaning.
 *
 *   which report this is → header title
 *   whether it needs you → header subtitle
 *   what needs you       → one block per message
 *   what it leaves out   → the grey aside
 *   what the rules did   → the grey footnote
 *   which window, whose mailbox → the footer
 *
 * The header was `template: 'blue'` and spent the widest, loudest band of the
 * card on the word "Your mail" and a timestamp, while the one sentence a reader
 * actually wanted sat below it in body grey. Blue said nothing — it was the
 * same blue on the morning a contract was waiting and on the morning nothing
 * was — so the template is now `default` like every other card Divo sends, and
 * the subtitle carries the verdict instead of the timestamp.
 *
 * `config.summary` is what Lark puts in the push notification and the chat
 * list. Without it a twice-daily brief arrives on a phone as the client's
 * generic card placeholder, which is the one moment the verdict is worth most.
 */
const briefBody = (content: BriefContent): Array<Record<string, unknown>> => {
  const elements: Array<Record<string, unknown>> = [];

  for (const note of content.notes) {
    elements.push({
      tag: 'markdown',
      // A subject that flattened to nothing leaves the metadata opening on a
      // stray separator, so it is dropped rather than rendered as ` · 07:30`.
      content: `**${note.sender}**  `
        + `${GREY([note.subject, note.time].filter(Boolean).join(' · '))}\n${note.want}`,
    });
  }

  if (content.aside) {
    elements.push({
      tag: 'markdown',
      content: GREY(content.aside),
      text_size: 'notation',
      ...(elements.length > 0 ? { margin: '4px 0 0 0' } : {}),
    });
  }

  /*
   * A footnote rather than a section.
   *
   * A rule you never see working is a rule you eventually turn off, so what the
   * rules did stays on every card — but it is a report on machinery that
   * behaved, and it competes with mail from a person for the same eye. Small
   * and grey is the honest weight for it.
   */
  if (content.handled.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr', margin: '8px 0 0 0' });
    elements.push({
      tag: 'markdown',
      content: [GREY('What Divo handled'), ...content.handled].join('\n'),
      text_size: 'notation',
    });
  }

  // A rule only where it separates two things. On the quietest brief there is
  // no aside and no rule activity, and a card that opens on a horizontal line
  // reads as one whose top half failed to render.
  if (elements.length > 0) elements.push({ tag: 'hr', margin: '8px 0 0 0' });
  elements.push({
    tag: 'markdown',
    content: GREY(content.window),
    text_size: 'notation',
    margin: '2px 0 0 0',
  });

  return elements;
};

const briefCard = (content: BriefContent): string =>
  JSON.stringify({
    msg_type: 'interactive',
    card: JSON.stringify({
      schema: '2.0',
      config: {
        width_mode: 'fill',
        update_multi: false,
        enable_forward: true,
        summary: { content: `Your mail — ${content.verdict}` },
      },
      header: {
        template: 'default',
        title: { tag: 'plain_text', content: 'Your mail' },
        subtitle: { tag: 'plain_text', content: content.verdict },
      },
      body: {
        vertical_spacing: '8px',
        padding: '12px 12px 10px 12px',
        elements: briefBody(content),
      },
    }),
  });

/**
 * The same brief without the card, for logs and for any surface that has none.
 *
 * Below the opening line this is deliberately the card's own blocks with the
 * colour taken out, so the two renderings can be asserted equal rather than
 * spot-checked. A card that grows a block the text never learned about is the
 * failure this shape exists to make impossible, and a hand-written list of
 * things to compare is a guard that only covers what someone remembered.
 *
 * The opening line is the one deliberate difference: the card says it in a
 * header, which the text has no equivalent of.
 */
const briefText = (content: BriefContent): string => [
  `**Your mail** · ${content.verdict}`,
  ...briefBody(content)
    .filter(element => element.tag === 'markdown')
    .map(element => String(element.content).replace(/<\/?font[^<>]*>/g, '')),
].join('\n\n');

export function createMailBriefComposer(deps: MailBriefDeps) {
  /**
   * Which of these want something. Returns `null` when the model could not say,
   * which is different from "none of them" and is rendered differently.
   */
  const readWants = async (
    messages: MailBriefMessage[],
    timeZone: string,
  ): Promise<Array<{ message: MailBriefMessage; want: string }> | null> => {
    if (messages.length === 0) return [];

    const listed = messages
      .map((m, i) => [
        `[${i}] from: ${m.from}`,
        `    subject: ${m.subject}`,
        `    preview: ${m.snippet.slice(0, 300)}`,
      ].join('\n'))
      .join('\n\n');

    let text: string;
    try {
      const result = await generateText({
        model: deps.model,
        system: SYSTEM_PROMPT,
        prompt: `Emails received between ${timeIn(messages[0]!.occurredAt, timeZone)} `
          + `and now:\n\n${listed}`,
        temperature: 0,
        maxOutputTokens: 1_200,
        abortSignal: AbortSignal.timeout(30_000),
      });
      text = result.text;
    } catch {
      return null;
    }

    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(extractJson(text));
    } catch {
      return null;
    }

    /*
     * Resolved against the list rather than trusted.
     *
     * The model returns an index and a sentence, and only the sentence is its
     * own — the sender, subject and time are read back out of the stored row.
     * An index nobody has is dropped, not repaired: a brief that names a
     * colleague who did not write to you is worse than a brief that is short.
     */
    const seen = new Set<number>();
    return parsed.wants.flatMap(({ index, want }) => {
      const message = messages[index];
      if (!message || seen.has(index)) return [];
      seen.add(index);
      return [{ message, want }];
    });
  };

  return async function composeMailBrief(
    window: MailBriefWindow,
  ): Promise<MailBrief> {
    // Newest first, so a busy mailbox loses its oldest mail to the cap rather
    // than its most recent.
    const recent = [...window.messages]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, MAX_MESSAGES_READ);

    const wants = await readWants(recent, window.timeZone);

    /*
     * Newest first, so the cut falls on the oldest and the card reads in the
     * order the mail arrived.
     *
     * The model returns its picks in whatever order it wrote them, and nothing
     * in the prompt or the schema makes that order recency. Slicing it directly
     * hid whichever twelve it happened to name last — on a busy morning, the
     * mail most likely to be urgent is exactly what would go unnamed.
     */
    const shown = [...wants ?? []]
      .sort((a, b) => b.message.occurredAt.getTime() - a.message.occurredAt.getTime())
      .slice(0, MAX_SHOWN_WANTS);
    const notes: BriefNote[] = shown.map(({ message, want }) => ({
      // A `from` that is nothing but markup flattens to nothing, and the note
      // would render as an empty pair of asterisks where a name belongs.
      sender:  flatten(senderName(message.from), SENDER_MAX) || 'Unknown sender',
      subject: flatten(message.subject, SUBJECT_MAX),
      want:    flatten(want, WANT_MAX),
      time:    timeIn(message.occurredAt, window.timeZone),
    }));

    /*
     * The verdict: whether this brief needs opening at all.
     *
     * It is the header subtitle and the push-notification preview, so it has to
     * survive being read on its own with nothing under it. "Divo could not read
     * your mail" is deliberately not "nothing needs you" — an unread mailbox
     * and an empty one look identical, and only one of them is safe to act on.
     */
    /*
     * How much arrived, against how much was read.
     *
     * These are not the same number on a busy morning, and the difference is
     * the one the verdict must not paper over: "nothing is waiting on you" is
     * read off a phone notification without the body, and saying it about
     * sixty messages when a hundred and fifty arrived is a false all-clear
     * about mail nobody looked at.
     */
    const arrived = window.messages.length;
    const unread = arrived - recent.length;

    const verdict = wants === null
      ? 'Divo could not read your mail this time'
      : wants.length > 0
        ? `${plural(wants.length, 'message needs', 'messages need')} you`
        : arrived === 0
          ? 'No mail arrived in this window'
          : unread > 0
            ? `Nothing waiting in your newest ${recent.length}`
            : 'Nothing is waiting on you';

    /*
     * What the verdict leaves out: how much else arrived, how much of it Divo
     * read, and — when the model named more than a card can hold — how many
     * were cut. A brief that silently drops the tail of what needs you is
     * worse than one that admits it is showing twelve.
     */
    const asides: string[] = [];
    const hidden = (wants?.length ?? 0) - notes.length;
    if (hidden > 0) {
      asides.push(`${hidden} more ${hidden === 1 ? 'is' : 'are'} waiting in your mail.`);
    }
    if (wants === null) {
      // No "Divo read the N newest" below: this run read none of them, and a
      // failed brief claiming to have read sixty messages is the confusion the
      // degraded verdict exists to prevent.
      asides.push(
        `This brief covers only what your rules did. `
        + `${plural(arrived, 'message', 'messages')} arrived.`,
      );
    } else {
      if (wants.length === 0) {
        // Left to the unread sentence when there is one, which states the same
        // count and what was done with it.
        if (arrived > 0 && unread === 0) {
          asides.push(`${plural(arrived, 'message', 'messages')} arrived.`);
        }
      } else {
        // Against what was read, not what arrived: "needed nothing from you"
        // is a claim about mail Divo actually looked at.
        const rest = recent.length - wants.length;
        if (rest > 0) {
          asides.push(`${plural(rest, 'other message', 'other messages')} arrived and needed nothing from you.`);
        }
      }
      if (unread > 0) {
        asides.push(
          `${plural(arrived, 'message', 'messages')} arrived in all; `
          + `Divo read the ${recent.length} newest.`,
        );
      }
    }

    /*
     * Arithmetic, never a model. This is a report on the member's own
     * automation, and a summary of what your rules did that can be wrong is
     * worse than no summary at all.
     */
    const acted = window.handled.flatMap(rule => {
      const parts: string[] = [];
      if (rule.delivered > 0) parts.push(`${rule.delivered} passed on`);
      if (rule.held > 0) parts.push(`${rule.held} held back`);
      if (rule.blocked > 0) parts.push(`${rule.blocked} over the limit`);
      if (rule.failed > 0) parts.push(`${rule.failed} failed`);
      if (parts.length === 0) return [];
      // Named, always: a footnote row that says `**** — 3 passed on` tells the
      // member nothing about which rule to trust, which is its entire purpose.
      const name = flatten(rule.ruleName, RULE_MAX) || 'Unnamed rule';
      return [`**${name}** — ${parts.join(', ')}`];
    });
    /*
     * Bounded for the same reason the message list is.
     *
     * Nothing limits how many rules a member may write, and these all render
     * into a single card element — the one contributor to card size that had
     * no ceiling, on a card whose rejection costs the member the whole brief.
     */
    const handled = acted.length > MAX_SHOWN_RULES
      ? [
          ...acted.slice(0, MAX_SHOWN_RULES),
          `+${plural(acted.length - MAX_SHOWN_RULES, 'other rule', 'other rules')} also ran.`,
        ]
      : acted;

    const content: BriefContent = {
      window: `${timeIn(window.from, window.timeZone)}–`
        + `${timeIn(window.to, window.timeZone)} · ${window.mailboxEmail}`,
      verdict,
      notes,
      aside: asides.length > 0 ? asides.join(' ') : null,
      handled,
    };

    return {
      text: briefText(content),
      card: briefCard(content),
      wantCount: wants?.length ?? 0,
      degraded: wants === null,
    };
  };
}
