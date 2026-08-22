/**
 * A decision, as a Lark card.
 *
 * One builder and one callback kind, `decision_answer`, for every question
 * asked through the decision module. It is meant to replace the old pattern of
 * one callback family per workflow — manager approvals, knowledge review,
 * workbook conversion, and group mode — all arriving at one webhook, dispatched
 * by an if-chain that every new feature extended.
 *
 * Manager tool approvals and automation plans now call `DecisionService.ask`
 * through this builder. The remaining older feature branches are still in
 * `lark.webhook.routes.ts` below this one and will migrate separately.
 *
 * The interesting part is the degradation. A card is a row of buttons: it can
 * carry a single choice and cannot carry a text field or a multi-select that
 * survives a redraw. So a decision with three questions becomes three cards,
 * each replacing the last, and a decision needing words says so and sends the
 * reader to the web rather than rendering something that cannot be answered.
 * That rule is `answerableWithButtons` in the domain, asked once, so the card
 * builder and the web renderer cannot disagree about what Lark can hold.
 */
import {
  answerableWithButtons,
  nextQuestion,
  type Decision,
  type DecisionAnswer,
  type DecisionQuestion,
} from '../../../domain/decision/decision';
import { buildCallbackCardData } from './lark-card.builder';
import { focusedSkillReviewBlocks } from '../../../application/knowledge/knowledge-review-presentation';

/** The one callback kind a decision card sends back. */
export const DECISION_CARD_KIND = 'decision_answer';

/**
 * What comes back when a button is pressed.
 *
 * One option of one question, never the whole answer: a card holds no state
 * between presses, so the accumulated answer lives on the row and each press
 * adds to it. That is also what makes the sequence resumable — somebody who
 * answers two of three questions and closes Lark finds the third waiting.
 */
export interface DecisionCardAction {
  readonly kind: typeof DECISION_CARD_KIND;
  readonly decisionId: string;
  readonly questionId: string;
  readonly value: string;
}

export function isDecisionCardAction(value: unknown): value is DecisionCardAction {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return record['kind'] === DECISION_CARD_KIND
    && typeof record['decisionId'] === 'string'
    && typeof record['questionId'] === 'string'
    && typeof record['value'] === 'string';
}

export interface DecisionCardInput {
  readonly decision: Decision;
  readonly questions: readonly DecisionQuestion[];
  /** What has been answered so far, so the card can show the next question. */
  readonly answer?: DecisionAnswer;
  /** Where to send somebody whose question a card cannot hold. */
  readonly webUrl?: string;
}

/**
 * The card for wherever this decision has got to, as a message payload.
 *
 * Returns null when there is nothing left to ask — the caller draws the
 * resolution card instead, so that "we are done" is one shape rather than a
 * question card with no buttons on it.
 */
export function buildDecisionCard(input: DecisionCardInput): string | null {
  const card = buildDecisionCardData(input);
  return card ? JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) }) : null;
}

/**
 * The same card as a value, for a callback response.
 *
 * Lark wants the card object inline when it is answering a button press, and a
 * doubly-stringified message envelope when it is being sent. One builder, two
 * wrappers — the alternative was parsing our own JSON back out of the payload
 * at the call site, which is how a card ends up escaped twice.
 */
export function buildDecisionCardData(input: DecisionCardInput): Record<string, unknown> | null {
  const answer = input.answer ?? { responses: [] };
  const question = nextQuestion(input.questions, answer);
  if (!question) return null;

  const blocks: string[] = [];
  if (input.decision.evidence?.kind === 'skill') {
    blocks.push(...focusedSkillReviewBlocks(input.decision.evidence));
  } else if (input.decision.detail) {
    blocks.push(input.decision.detail);
  }
  blocks.push(`**${question.ask}**`);

  /* More than one question means the reader is part-way through something, and
     a card that does not say so reads as the whole request. */
  const position = input.questions.length > 1
    ? `Question ${input.questions.indexOf(question) + 1} of ${input.questions.length}`
    : undefined;

  if ('text' in question || !answerableWithButtons([question])) {
    return buildCallbackCardData({
      title: input.decision.title,
      template: 'blue',
      markdownBlocks: input.webUrl
        ? [...blocks, `[Answer this in Divo](${input.webUrl})`]
        : blocks,
      note: 'This one needs more than a tap, so it is waiting in Divo.',
    });
  }

  return buildCallbackCardData({
    title: input.decision.title,
    template: 'blue',
    markdownBlocks: blocks,
    ...(position ? { note: position } : {}),
    actions: question.options.map(option => ({
      label: option.label,
      style: option.tone === 'primary' ? 'primary' as const
        : option.tone === 'danger' ? 'danger' as const
        : 'default' as const,
      value: {
        kind: DECISION_CARD_KIND,
        decisionId: input.decision.id,
        questionId: question.id,
        value: option.value,
      } satisfies DecisionCardAction,
    })),
  });
}

/**
 * The card that replaces the question once it has been answered.
 *
 * It carries the answer in the words the person read rather than the values the
 * code matched on, and it carries no buttons — a settled decision that still
 * offers them invites a second press that can only ever fail.
 */
export interface DecisionResolvedCardInput {
  readonly title: string;
  readonly verdict: 'approved' | 'rejected';
  readonly summary: string;
  readonly byName: string;
  readonly at: Date;
}

export function buildDecisionResolvedCard(input: DecisionResolvedCardInput): string {
  return JSON.stringify({
    msg_type: 'interactive',
    card: JSON.stringify(buildDecisionResolvedCardData(input)),
  });
}

export function buildDecisionResolvedCardData(
  input: DecisionResolvedCardInput,
): Record<string, unknown> {
  const when = input.at.toISOString().replace('T', ' ').slice(0, 16);
  return buildCallbackCardData({
    title: input.title,
    template: input.verdict === 'approved' ? 'green' : 'grey',
    markdownBlocks: [
      input.summary
        ? `**${input.verdict === 'approved' ? 'Answered' : 'Declined'}**\n${input.summary}`
        : `**${input.verdict === 'approved' ? 'Approved' : 'Rejected'}**`,
    ],
    note: `${input.byName} · ${when} UTC`,
  });
}
