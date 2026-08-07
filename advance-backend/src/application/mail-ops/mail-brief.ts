/**
 * Twice a day, what happened in your mail — in your Lark DM.
 *
 * Two sections, and they answer two different questions:
 *
 *   **What wants you.** Mail that arrived and is waiting on a decision or a
 *   reply from you. This is the part a person actually opens the message for.
 *
 *   **What Divo handled.** What each rule forwarded, filed, or held back. This
 *   is the part that makes the rules trustworthy — a rule you never see working
 *   is a rule you eventually turn off.
 *
 * A third section, *what you are waiting on* — mail you sent that nobody
 * answered — is deliberately absent. It needs Divo to watch the SENT label and
 * correlate replies, and every part of Mail Ops today is built around mail
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
 * The second section touches no model at all. It is arithmetic over delivery
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

export interface MailBriefDeps {
  readonly model: LanguageModel;
}

export interface MailBrief {
  /** Lark markdown, ready to send. */
  readonly text: string;
  /** How many messages were named. Zero is a valid, deliverable brief. */
  readonly wantCount: number;
  /** True when the model could not be reached, so the first section is absent. */
  readonly degraded: boolean;
}

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
    const lines: string[] = [];

    lines.push(
      `**Your mail** · ${timeIn(window.from, window.timeZone)}–`
      + `${timeIn(window.to, window.timeZone)} · ${window.mailboxEmail}`,
    );
    lines.push('');

    if (wants === null) {
      // Said out loud rather than rendered as "nothing needs you". An empty
      // section and an unread mailbox look identical, and only one of them is
      // safe to act on.
      lines.push(
        `Divo could not read your mail this time, so this brief covers only what `
        + `your rules did. ${plural(recent.length, 'message', 'messages')} arrived.`,
      );
    } else if (wants.length === 0) {
      lines.push(
        recent.length === 0
          ? 'No mail arrived in this window.'
          : `Nothing is waiting on you. `
            + `${plural(recent.length, 'message', 'messages')} arrived.`,
      );
    } else {
      lines.push(`**${plural(wants.length, 'message needs', 'messages need')} you**`);
      for (const { message, want } of wants) {
        lines.push(
          `· **${senderName(message.from)}** — ${message.subject}`,
          `  ${want} _(${timeIn(message.occurredAt, window.timeZone)})_`,
        );
      }
      const rest = recent.length - wants.length;
      if (rest > 0) {
        lines.push('', `${plural(rest, 'other message', 'other messages')} arrived and none of them needs a reply.`);
      }
    }

    /*
     * Arithmetic, never a model. This section is a report on the member's own
     * automation, and a summary of what your rules did that can be wrong is
     * worse than no summary at all.
     */
    const acted = window.handled.filter(
      r => r.delivered + r.held + r.blocked + r.failed > 0,
    );
    if (acted.length > 0) {
      lines.push('', '**What Divo handled**');
      for (const rule of acted) {
        const parts: string[] = [];
        if (rule.delivered > 0) parts.push(`${rule.delivered} passed on`);
        if (rule.held > 0) parts.push(`${rule.held} held back`);
        if (rule.blocked > 0) parts.push(`${rule.blocked} over the limit`);
        if (rule.failed > 0) parts.push(`${rule.failed} failed`);
        lines.push(`· **${rule.ruleName}** — ${parts.join(', ')}`);
      }
    }

    return {
      text: lines.join('\n'),
      wantCount: wants?.length ?? 0,
      degraded: wants === null,
    };
  };
}
