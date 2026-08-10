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
  /**
   * Whether Divo is still watching this mailbox.
   *
   * False means paused or disconnected: nothing is being synced, so the window
   * is empty for a reason that has nothing to do with a quiet inbox. It changes
   * the verdict rather than suppressing the brief — see `composeMailBrief`.
   */
  mailboxActive: boolean;
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
  /**
   * Where the member manages their mail rules, e.g. `https://divo.example.com`.
   *
   * Passed in rather than read from the environment here, on the same reasoning
   * every other link in this codebase follows: a composer that reaches for
   * `process.env` cannot be rendered in a test or a preview without one.
   *
   * Omitted, the card simply carries no button. A brief with a dead link is
   * worse than a brief with none — this is a standing report a member reads
   * twice a day, and a button that goes nowhere teaches them to stop pressing.
   */
  readonly appBaseUrl?: string;
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
  /** Where "Manage mail" goes, or `null` when the card carries no button. */
  readonly manageUrl: string | null;
}

/**
 * The rules page a member manages their mail from.
 *
 * Built here rather than at the call site so the path lives next to the card
 * that links to it — if the route moves, one string moves with it.
 *
 * A base URL that does not parse yields no button rather than a broken one.
 * This is deployment configuration, and a misconfigured environment should cost
 * a button, not the whole brief.
 */
const manageMailUrl = (appBaseUrl: string | undefined): string | null => {
  if (!appBaseUrl?.trim()) return null;
  try {
    const url = new URL('/me/mail', appBaseUrl.trim());
    // Only over HTTP(S). A `javascript:` or `data:` base would put a scheme of
    // somebody else's choosing behind a button inside Divo's own card.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
};

const GREY = (text: string): string => `<font color='grey'>${text}</font>`;

/**
 * What this report is called, wherever it names itself.
 *
 * One constant rather than three literals, because it appears in the card
 * badge, in the push-notification summary, and in the plain-text rendering —
 * and a brief that is called one thing on a phone and another in the chat list
 * is one nobody learns to recognise at a glance.
 */
const BRIEF_BADGE = 'Divo Mailer';

/**
 * The brief, as Lark renders it.
 *
 * The design rule is the one every other Divo card follows: each fact appears
 * exactly once, and colour is spent only where it carries meaning.
 *
 *   which report this is → the header badge
 *   whether it needs you → the first line of the body
 *   what needs you       → one block per message
 *   what it leaves out   → the grey aside
 *   what the rules did   → the grey footnote
 *   which window, whose mailbox → the footer
 *
 * The header was `template: 'blue'` with a title and a timestamp, and spent the
 * widest, loudest band of the card on the words "Your mail" while the one
 * sentence a reader actually wanted sat below it in body grey. Blue said
 * nothing — it was the same blue on the morning a contract was waiting and on
 * the morning nothing was.
 *
 * There is now no title and no subtitle, only a badge. Lark already prints the
 * sender's name and its Agent tag directly above every card, so a title band is
 * the third place in a row that says who is talking; the badge names the report
 * in a chip and gives the rest of the width back. It is the shape
 * `buildHeader` in the card builder already uses for department chips, not a
 * new one. The verdict moves down to be the first line of the body, which is
 * where the eye lands anyway and where it can be bold rather than grey.
 *
 * `config.summary` is what Lark puts in the push notification and the chat
 * list. Without it a twice-daily brief arrives on a phone as the client's
 * generic card placeholder, which is the one moment the verdict is worth most.
 */
const briefBody = (content: BriefContent): Array<Record<string, unknown>> => {
  // Always first, and always present. It is the one line that answers "do I
  // need to open this?", and it is the only element every brief has — which is
  // what lets the separators below assume something precedes them.
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: `**${content.verdict}**` },
  ];

  for (const note of content.notes) {
    elements.push({
      tag: 'markdown',
      // A subject that flattened to nothing leaves the metadata opening on a
      // stray separator, so it is dropped rather than rendered as ` · 07:30`.
      content: `**${note.sender}**  `
        + `${GREY([note.subject, note.time].filter(Boolean).join(' · '))}\n${note.want}`,
      margin: '8px 0 0 0',
    });
  }

  if (content.aside) {
    elements.push({
      tag: 'markdown',
      content: GREY(content.aside),
      text_size: 'notation',
      margin: '8px 0 0 0',
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
    elements.push({ tag: 'hr', margin: '8px 0 0 0' });
    elements.push({
      tag: 'markdown',
      content: [GREY('What Divo handled'), ...content.handled].join('\n'),
      text_size: 'notation',
    });
  }

  elements.push({ tag: 'hr', margin: '8px 0 0 0' });
  elements.push({
    tag: 'markdown',
    content: GREY(content.window),
    text_size: 'notation',
    margin: '2px 0 0 0',
  });

  /*
   * The one thing a member ever wants to do from this card.
   *
   * Every question the brief raises — why did that rule hold it, why is this
   * mailbox paused, can I stop being told about newsletters — is answered on
   * the rules page and nowhere else, and until now the card named the problem
   * and left them to find it. `default` rather than `primary`: the brief is a
   * report, not a request, and a filled button would read as one.
   *
   * Below the footer on purpose. It is a door out of the card, not part of what
   * the card says, and above the provenance line it would compete with the mail
   * for the same first glance.
   */
  if (content.manageUrl) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: 'Manage mail' },
      type: 'default',
      size: 'small',
      width: 'default',
      margin: '10px 0 0 0',
      behaviors: [{ type: 'open_url', default_url: content.manageUrl }],
    });
  }

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
        summary: { content: `${BRIEF_BADGE} — ${content.verdict}` },
      },
      header: {
        template: 'default',
        text_tag_list: [{
          tag: 'text_tag',
          text: { tag: 'plain_text', content: BRIEF_BADGE },
          color: 'blue',
        }],
      },
      body: {
        // Tighter than the 8px this card used, because every element that needs
        // separating now carries its own top margin. Left at 8px the two would
        // compound and the card would read as a list of loose cards.
        vertical_spacing: '4px',
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
 * The opening line is the one deliberate difference: the card wears the name as
 * a badge, which the text has no equivalent of. The verdict is no longer part
 * of that line — it is a body block now, so repeating it here would state it
 * twice in a rendering whose whole purpose is that it cannot drift from the
 * card.
 *
 * The button becomes a markdown link rather than being filtered out. Dropping
 * it would be exactly the drift this shape exists to prevent: a reader on a
 * surface without cards would be told what their rules did and never told where
 * to change them.
 */
const briefText = (content: BriefContent): string => [
  `**${BRIEF_BADGE}**`,
  ...briefBody(content).flatMap(element => {
    if (element.tag === 'markdown') {
      return [String(element.content).replace(/<\/?font[^<>]*>/g, '')];
    }
    if (element.tag === 'button') {
      const label = (element['text'] as { content?: string } | undefined)?.content ?? '';
      const url = (element['behaviors'] as Array<{ default_url?: string }> | undefined)
        ?.[0]?.default_url;
      return url ? [`[${label}](${url})`] : [];
    }
    // `hr` and anything added later. A separator is card structure, not
    // something the brief says, and inventing a text form for it would put
    // punctuation into a log line.
    return [];
  }),
].join('\n\n');

export function createMailBriefComposer(deps: MailBriefDeps) {
  // Resolved once, at construction. The link is the same on every brief this
  // process sends, and validating a fixed string twice a day per member is work
  // that buys nothing.
  const manageUrl = manageMailUrl(deps.appBaseUrl);

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

    /*
     * A paused mailbox is checked before everything else, because every verdict
     * below it would be a lie about it.
     *
     * Nothing is synced while a mailbox is paused, so its window is empty — and
     * the old wording, "No mail arrived in this window", is indistinguishable
     * from a quiet Tuesday. A member read that twice a day and concluded their
     * inbox was calm, when in fact Divo had stopped looking at it. That is the
     * same false all-clear the degraded verdict exists to prevent, arriving
     * through a different door.
     *
     * It still sends. A standing report whose absence means either "quiet" or
     * "broken" is one nobody can rely on, and this is precisely the state
     * somebody most needs told.
     */
    const verdict = !window.mailboxActive
      ? 'Divo is not watching this mailbox'
      : wants === null
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
    if (!window.mailboxActive) {
      // What to do about it, not just what happened. A verdict that reports a
      // stopped mailbox and leaves the member to work out how to restart it is
      // half a message, and this one is not self-healing.
      asides.push(
        'No new mail is being read while it is paused. '
        + 'Resume it to start getting briefs again.',
      );
    } else if (wants === null) {
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
      manageUrl,
    };

    return {
      text: briefText(content),
      card: briefCard(content),
      wantCount: wants?.length ?? 0,
      degraded: wants === null,
    };
  };
}
