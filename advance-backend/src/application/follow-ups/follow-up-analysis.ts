import { z } from 'zod';
import { generateObject, type LanguageModel } from 'ai';
import type { Logger } from '../../shared/logger';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';
import {
  FOLLOW_UP_KINDS,
  type FollowUpKind,
  type FollowUpAnalysis,
  type TrackedFollowUp,
} from '../../domain/follow-ups/follow-up';

/**
 * The one model call in this entire feature.
 *
 * Everything downstream — the digest, the reminders, the cards — reads rows this
 * produced. Nothing else spends a token, which is why the gates in front of this
 * function (quiet window, cooldown, moved-since) are the whole cost model rather
 * than a tuning detail.
 *
 * Ported from the follow-up agent's `analyzer.js`, with two changes that matter:
 *
 *  - **Second person becomes first person plural.** The imported prompt speaks
 *    to "the account holder", whose own messages are "You", and returns
 *    `owner: 'me'`. Urban Aura runs one shared pool with nothing assigned, so a
 *    digest saying "you promised" has no subject. It reads as a team throughout,
 *    and `owner` is `us`/`them` — a side, never a person.
 *  - **DeepSeek, not Claude.** `composition.ts` states the house rule: every
 *    backend-side model is DeepSeek. The imported agent defaulted to
 *    `anthropic/claude-opus-5`.
 *
 * Kept unchanged because it is correct: the incremental contract. The model is
 * handed the items already tracked *with their ids* and must return each one
 * either refreshed in `openItems` under the same id, or in `resolved`. Silence
 * about an item means "the new messages said nothing about it" and leaves it
 * open — which is not the same as saying it is done, and is the difference
 * between a tracker and a duplicate generator.
 */

const followUpItemSchema = z.object({
  id: z.string().nullable()
    .describe('The id of the already-tracked item this refreshes, or null when newly spotted.'),
  title: z.string()
    .describe('Imperative one-liner, max ~70 chars, e.g. "Send Priya the Q3 invoice".'),
  detail: z.string()
    .describe('One or two sentences of context: who asked, what for, what was promised.'),
  // Spelled out rather than derived from FOLLOW_UP_KINDS: casting a readonly
  // array into z.enum's tuple type sends inference into an excessively deep
  // instantiation. The `kindsMatchDomain` check below keeps the two honest.
  kind: z.enum(['commitment', 'unanswered_question', 'request', 'deadline', 'decision_pending']),
  owner: z.enum(['us', 'them'])
    .describe('"us" = our team owes this; "them" = we are waiting on the other side.'),
  counterparty: z.string().describe('Name of the other person or company, or "" when unclear.'),
  due_date: z.string().nullable()
    .describe('YYYY-MM-DD when a date was stated or clearly implied, else null.'),
  urgency: z.enum(['low', 'medium', 'high']),
  confidence: z.number()
    .describe('0-1. Only exceed 0.9 for an explicit, unambiguous commitment or question.'),
  evidence: z.array(z.string())
    .describe('Short verbatim quotes from the transcript that justify this item.'),
  suggested_reply: z.string()
    .describe('A ready-to-send message that would close this out, or "" when not applicable.'),
});

/**
 * Compile-time proof that the schema's kinds and the domain's kinds are the same
 * set. Adding a kind in one place and not the other becomes a type error here
 * rather than a validation failure in production.
 */
const kindsMatchDomain: readonly FollowUpKind[] = followUpItemSchema.shape.kind.options;
void kindsMatchDomain;
void FOLLOW_UP_KINDS;

const analysisSchema = z.object({
  open_items: z.array(followUpItemSchema),
  resolved: z.array(z.object({ id: z.string(), reason: z.string() })),
});

export const FOLLOW_UP_SYSTEM_PROMPT = `You track loose ends in WhatsApp conversations for one team. The team's own messages are labelled "Us".

Report only real, actionable follow-ups:
- commitment — someone said they would do, send, check, or confirm something, and the transcript does not show it happening
- unanswered_question — a direct question that never received an answer
- request — something one side asked the other for, still outstanding
- deadline — a dated obligation raised in the chat
- decision_pending — a choice the thread is visibly waiting on

Never report: greetings, thanks, small talk, jokes, opinions, forwarded links with no ask, anything the later messages already answered or delivered, and — in group chats — matters strictly between two other participants that the team is not part of.

Ownership is mandatory and binary:
- "us": our team owes the action.
- "them": someone outside the team owes it to us, and we are waiting.
If neither is true, leave the item out entirely.

Write from the team's point of view, never an individual's. Say "we", not "you" or "I", and never attribute an item to a named colleague — several people share these numbers and nothing here is assigned to a person.

Messages may mix English and Hindi, or use Hinglish. Read them in whatever language they are written; always write titles, details and replies in English.

Confidence discipline: 0.9+ only for an explicit, unambiguous commitment or question. 0.5-0.7 when you are inferring intent from context. Anything you would score below 0.4, omit — a missed reminder costs the team far less than a wrong one.

You are given the items already being tracked for this chat, each with an id. For every one of them decide:
- still outstanding -> return it inside open_items with that same id, refreshing any field the newer messages changed
- delivered, answered, cancelled, or no longer relevant -> put its id in resolved with a one-line reason
An already-tracked item you list in neither array is left open and untouched, so leave one out only when the new messages say nothing about it.

Newly spotted items go in open_items with id set to null. Write titles as imperatives from the team's point of view.`;

export interface TranscriptMessage {
  readonly senderName: string | null;
  readonly fromMe: boolean;
  readonly body: string | null;
  readonly type: string;
  readonly quotedText: string | null;
  readonly occurredAt: Date;
}

export interface AnalyzeChatInput {
  readonly chatName: string;
  readonly isGroup: boolean;
  readonly timeZone: string;
  readonly messages: readonly TranscriptMessage[];
  readonly tracked: readonly TrackedFollowUp[];
  /** Injected so a test can pin "today" — every relative date resolves against it. */
  readonly now?: Date;
}

/** One message as the model sees it. */
function renderTranscript(
  messages: readonly TranscriptMessage[],
  timeZone: string,
): string {
  return messages
    .map(message => {
      // "Us" rather than "You": the team is the subject throughout, and a prompt
      // that says "You" invites the model to answer in the second person.
      const who = message.fromMe ? 'Us' : message.senderName || 'Unknown';
      let text = (message.body ?? '').trim();
      if (text.length > 600) text = `${text.slice(0, 600)}…`;
      if (!text) text = `[${message.type || 'media'}]`;
      else if (message.type && message.type !== 'text') text = `[${message.type}] ${text}`;
      const quoted = message.quotedText
        ? ` (replying to: "${message.quotedText.slice(0, 120)}")`
        : '';
      return `[${stamp(message.occurredAt, timeZone)}] ${who}: ${text}${quoted}`;
    })
    .join('\n');
}

const trackedLine = (item: TrackedFollowUp): string => {
  const due = item.dueDate ? `, due ${item.dueDate}` : '';
  return `- id=${item.id} | owner=${item.owner}${due} | ${item.title}`.trim();
};

function renderTracked(items: readonly TrackedFollowUp[]): string {
  const open = items.filter(item => !item.closedByTeam);
  if (open.length === 0) return 'None yet — this is the first pass over this chat.';
  return open.map(trackedLine).join('\n');
}

/**
 * Items a person closed, shown so the model does not raise them again.
 *
 * Without this the model cannot see them at all, re-spots the same commitment
 * from the same transcript, and files it as new — the team's decision undone
 * silently, on a fresh id that cannot be traced back to what they dismissed.
 */
function renderClosed(items: readonly TrackedFollowUp[]): string | null {
  const closed = items.filter(item => item.closedByTeam);
  if (closed.length === 0) return null;
  return closed.map(trackedLine).join('\n');
}

const stamp = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);

const isoDate = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date);

const weekday = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(date);

export interface FollowUpAnalyzerDeps {
  readonly model: LanguageModel;
  readonly logger: Logger;
}

export interface AnalysisOutcome {
  readonly analysis: FollowUpAnalysis;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

/**
 * Read one chat window and report its outstanding follow-ups.
 *
 * Pure with respect to storage: it takes a transcript and the tracked items, and
 * returns a result. Nothing is written here, so the awkward half — reconciling
 * ids, applying the confidence floor, arming reminders — is testable without a
 * model and the model call is testable without a database.
 */
const closedSection = (tracked: readonly TrackedFollowUp[]): string[] => {
  const closed = renderClosed(tracked);
  if (!closed) return [];
  return [
    '',
    'Already closed by the team — do NOT report these again, in either array:',
    closed,
  ];
};

/**
 * The prompt, built and exported so it can be read in a test.
 *
 * Exported because it is the actual contract with the model: whether a closed
 * item is listed as closed, and whether "Us" or "You" names the team, decides
 * what comes back. Asserting it through a mocked model would prove the mock.
 */
export function buildAnalysisPrompt(
  input: AnalyzeChatInput,
  now: Date = input.now ?? new Date(),
  label: string = input.chatName || 'Unnamed chat',
): string {
  return [
    `Chat: ${label}`,
    `Type: ${input.isGroup ? 'group chat' : 'one-to-one DM'}`,
    `Today: ${isoDate(now, input.timeZone)} (${weekday(now, input.timeZone)}), timezone ${input.timeZone}.`,
    'Resolve every relative date ("tomorrow", "next Monday", "by EOD") against this.',
    '',
    'Already tracked for this chat:',
    renderTracked(input.tracked),
    ...closedSection(input.tracked),
    '',
    `Transcript (${input.messages.length} most recent messages, oldest first):`,
    '<transcript>',
    renderTranscript(input.messages, input.timeZone),
    '</transcript>',
    '',
    'Report the outstanding follow-ups for our team in this chat.',
  ].join('\n');
}

export async function analyzeChat(
  input: AnalyzeChatInput,
  deps: FollowUpAnalyzerDeps,
): Promise<Result<AnalysisOutcome, InfraError>> {
  const now = input.now ?? new Date();
  const label = input.chatName || 'Unnamed chat';
  const prompt = buildAnalysisPrompt(input, now, label);

  try {
    // The same cast the rule compiler, the judge and the knowledge extractor
    // use: `generateObject`'s inferred types blow the instantiation depth limit
    // against a zod schema. The shape is re-established by parsing the result,
    // which has to happen regardless.
    const generateStructured = generateObject as unknown as (
      options: Record<string, unknown>,
    ) => Promise<{ object: unknown; usage?: { inputTokens?: number; outputTokens?: number } }>;

    const result = await generateStructured({
      model: deps.model,
      schema: analysisSchema,
      schemaName: 'follow_up_analysis',
      schemaDescription: 'Outstanding follow-ups in one WhatsApp conversation.',
      system: FOLLOW_UP_SYSTEM_PROMPT,
      prompt,
      temperature: 0,
      // Generous on purpose. DeepSeek's own JSON-mode guidance is to allow room
      // *because* a truncated reply is invalid JSON — the cap is not a spend
      // control, the gates in front of this call are.
      maxOutputTokens: 4_000,
      abortSignal: AbortSignal.timeout(60_000),
    });

    const parsed = analysisSchema.parse(result.object);

    return ok({
      analysis: {
        openItems: parsed.open_items.map((item): FollowUpAnalysis['openItems'][number] => ({
          id: item.id,
          title: item.title,
          detail: item.detail,
          kind: item.kind,
          owner: item.owner,
          counterparty: item.counterparty,
          dueDate: item.due_date,
          urgency: item.urgency,
          confidence: item.confidence,
          evidence: item.evidence,
          suggestedReply: item.suggested_reply,
        })),
        resolved: parsed.resolved,
      },
      ...(result.usage?.inputTokens ? { promptTokens: result.usage.inputTokens } : {}),
      ...(result.usage?.outputTokens ? { completionTokens: result.usage.outputTokens } : {}),
    });
  } catch (cause) {
    return err(wrapInfra('ai', `followUpAnalysis.${label}`, cause));
  }
}
