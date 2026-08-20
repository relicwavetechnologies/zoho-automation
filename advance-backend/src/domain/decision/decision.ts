/**
 * A question Divo puts to a person, and the answer that comes back.
 *
 * This is the vocabulary the whole human-in-the-loop spine is built on. Before
 * it there were seven of them: the manager gate spoke `'approved' | 'rejected'`,
 * the knowledge review spoke `knowledge_review_publish` with a target key, the
 * workbook offer spoke `workbook_conversion_confirm`, and each of the four
 * carried its own card, its own callback shape and its own store. Two of them
 * had given up on the approvals table entirely and kept their pending question
 * in a cache, because the table can only hold a verdict.
 *
 * So the verdict stops being the vocabulary and becomes a case of it. A confirm
 * is one question with two options. A choice of department is one question with
 * N. The three-step form is three questions. Nothing here knows what is being
 * asked about — no tool ids, no approvals, no mail rules — which is what lets
 * one renderer draw all of them and one settlement close all of them.
 *
 * Pure on purpose. Everything with a rule in it lives here (what counts as a
 * complete answer, what a chosen option settles the decision as, what a card
 * can carry), and everything with I/O in it lives in the module above. The rules
 * are the part that can be wrong quietly.
 */
import type { DecisionSubject } from './decision-subject';

export type { DecisionSubject, DecisionPreview, DecisionBrand } from './decision-subject';

/**
 * One thing a person can pick.
 *
 * `settles` is what makes approve/reject expressible without a second concept:
 * an option carrying it ends the whole decision that way the moment it is
 * chosen. Ordinary options — a department, a flavour — carry nothing, and the
 * decision settles by being completed.
 */
export interface DecisionOption {
  readonly value: string;
  readonly label: string;
  /** How it should look. `danger` is for the option that stops the work. */
  readonly tone?: 'default' | 'primary' | 'danger';
  /** Choosing this ends the decision here, with this verdict. */
  readonly settles?: DecisionVerdict;
  /** An option carrying this opens a URL and settles nothing. */
  readonly href?: string;
}

/**
 * A question, in one of the two shapes a person can answer.
 *
 * Deliberately only two. A date picker, a slider and a file field were all
 * plausible and none of them has a caller, and a shape nobody fills reads to
 * the next author as a fact the system knows.
 */
export type DecisionQuestion =
  | {
      readonly id: string;
      readonly ask: string;
      readonly pick: 'one' | 'many';
      readonly options: readonly DecisionOption[];
      /** May the person write something instead of picking? */
      readonly allowText?: boolean;
      readonly optional?: boolean;
    }
  | {
      readonly id: string;
      readonly ask: string;
      readonly text: { readonly placeholder?: string };
      readonly optional?: boolean;
    };

export type DecisionVerdict = 'approved' | 'rejected';

/** What one person said to one question. */
export interface DecisionResponse {
  readonly questionId: string;
  /** Option values, in the order the questions list them. */
  readonly chose: readonly string[];
  /** What they typed, when the question allowed it. */
  readonly said?: string;
}

export interface DecisionAnswer {
  readonly responses: readonly DecisionResponse[];
}

/**
 * What happens once the answer is in.
 *
 * Declared by whoever asks, rather than reconstructed afterwards. The gate used
 * to work this out from four separate metadata reads — an id prefix, an
 * `autoResume` flag, an origin string and a row-kind test — and the prefix
 * carried two meanings at once, which is how a mail rule created in a browser
 * got its approval inbox entry and never got its resume.
 *
 * `run` is the existing behaviour and the strict one: approval is a decision
 * over one validated set of arguments, never a licence to re-plan. The hash is
 * carried so the thing that executes can prove the arguments did not move while
 * a person was reading them.
 */
export type DecisionContinuation =
  | { readonly kind: 'run'; readonly toolId: string; readonly action: string; readonly argsHash: string }
  /** Nobody is waiting on the answer. The record of it is the whole point. */
  | { readonly kind: 'none' };

/*
  There was a third arm here — `tell`, "hand the answer back to the run that
  asked, as another turn" — and it is gone rather than kept for later. Nothing
  consumed it: the settlement path ran the `run` case and returned, so a caller
  declaring `tell` got a settled row, a resolved card, an audit line and a run
  that was never told anything. Three test fixtures used it and none asserted an
  effect, which made it read as covered.

  It is the right idea and it needs the runtime threaded through to this module
  to work. Until that exists, an arm the code does not honour is worse than an
  absent one: the next author reads it as a fact about the system and builds on
  it. Add it back the day something can carry out the promise.
*/

/**
 * One open question, as every surface receives it.
 *
 * A Lark card, the web thread and the approvals inbox are all built from this
 * one value, which is the only reason they cannot disagree about what is being
 * asked.
 */
export interface Decision {
  readonly id: string;
  /** The ask itself, in one line. "Send a reply to 4 customers". */
  readonly title: string;
  /** The detail under it, when there is any worth reading. */
  readonly detail?: string;
  /** Who or what is asking. A requester's name, a department, "Divo". */
  readonly source: string;
  /**
   * What the decision acts on, when it acts on a third-party product.
   *
   * Optional because plenty of asks have no product behind them — a choice of
   * department, a name for a thread. Those draw as the plain card, which is the
   * correct look for them rather than a gap where a logo should be.
   */
  readonly subject?: DecisionSubject;
  readonly questions: readonly DecisionQuestion[];
  readonly requestedAt: string;
  readonly expiresAt: string | null;
  /**
   * The web thread this was asked in, when it was asked in one.
   *
   * Carried so a surface can tell "the run in front of you is waiting on this"
   * from "somebody, somewhere, is waiting on you". Without it the chat had only
   * the second and treated it as the first: every open request replaced the
   * composer of every thread, including approvals raised by other people's Lark
   * runs. Null for anything not asked in a browser, which belongs on the
   * Approvals page and nowhere else.
   */
  readonly threadId: string | null;
}

// ── Answering ───────────────────────────────────────────────────────────────

export type DecisionAnswerError =
  | { readonly reason: 'unknown_question'; readonly questionId: string }
  | { readonly reason: 'unknown_option'; readonly questionId: string; readonly value: string }
  | { readonly reason: 'needs_one'; readonly questionId: string }
  | { readonly reason: 'needs_exactly_one'; readonly questionId: string }
  | { readonly reason: 'needs_words'; readonly questionId: string }
  | { readonly reason: 'no_text_allowed'; readonly questionId: string };

/**
 * Is this a complete, well-formed answer to exactly these questions?
 *
 * Checked here rather than at the edge that received it because both edges
 * receive it: a Lark button press and a browser POST are the same answer
 * arriving twice as differently-shaped bytes, and validating in two places is
 * how the two surfaces end up disagreeing about whether a blank line counts.
 *
 * A response to a question that was not asked is an error rather than an
 * ignored extra. The only ways to produce one are a stale card and a forged
 * request, and neither should be quietly accepted as an answer.
 */
export function checkAnswer(
  questions: readonly DecisionQuestion[],
  answer: DecisionAnswer,
): DecisionAnswerError | null {
  const byId = new Map(questions.map(question => [question.id, question]));

  for (const response of answer.responses) {
    const question = byId.get(response.questionId);
    if (!question) return { reason: 'unknown_question', questionId: response.questionId };

    const said = response.said?.trim() ?? '';

    if ('text' in question) {
      if (response.chose.length > 0) {
        return { reason: 'unknown_option', questionId: question.id, value: response.chose[0]! };
      }
      if (!said && !question.optional) return { reason: 'needs_words', questionId: question.id };
      continue;
    }

    if (said && !question.allowText) {
      return { reason: 'no_text_allowed', questionId: question.id };
    }
    const known = new Set(question.options.map(option => option.value));
    for (const value of response.chose) {
      if (!known.has(value)) return { reason: 'unknown_option', questionId: question.id, value };
    }
    /* Typed words stand in for a choice rather than joining it: somebody who
       writes their own answer has said the listed ones did not fit. */
    if (said) continue;
    if (response.chose.length === 0 && !question.optional) {
      return { reason: 'needs_one', questionId: question.id };
    }
    if (question.pick === 'one' && response.chose.length > 1) {
      return { reason: 'needs_exactly_one', questionId: question.id };
    }
  }

  /* An option that ends the decision has ended it, so the questions after it
     are not unanswered — they are not being asked. Without this, a form whose
     second page says "stop" could never be sent: the answer would be judged
     incomplete against pages the stop had just made irrelevant. */
  if (settlesEarly(questions, answer)) return null;

  const answered = new Set(answer.responses.map(response => response.questionId));
  for (const question of questions) {
    if (question.optional) continue;
    if (!answered.has(question.id)) return { reason: 'needs_one', questionId: question.id };
  }
  return null;
}

/** Has one of the choices already closed the whole decision? */
export function settlesEarly(
  questions: readonly DecisionQuestion[],
  answer: DecisionAnswer,
): boolean {
  return answer.responses.some(response => {
    const question = questions.find(entry => entry.id === response.questionId);
    if (!question || 'text' in question) return false;
    return response.chose.some(value =>
      question.options.find(option => option.value === value)?.settles !== undefined);
  });
}

/**
 * Which question still needs answering, if any.
 *
 * Used by both pagers: the browser's, and Lark's — where a card cannot hold a
 * form, so a three-question decision is three cards, each replacing the last.
 * One function so the two surfaces walk the questions in the same order.
 */
export function nextQuestion(
  questions: readonly DecisionQuestion[],
  answer: DecisionAnswer,
): DecisionQuestion | null {
  /* Nothing follows a choice that ended the decision. A pager that kept walking
     would card somebody a second question after they pressed Reject. */
  if (settlesEarly(questions, answer)) return null;
  const answered = new Set(
    answer.responses
      .filter(response => response.chose.length > 0 || (response.said?.trim() ?? '') !== '')
      .map(response => response.questionId),
  );
  return questions.find(question => !answered.has(question.id)) ?? null;
}

/**
 * How a completed answer settles the decision.
 *
 * One rule, stated once: an option that says it ends things ends them, and
 * otherwise finishing the questions is itself the approval. That is what makes
 * "approve or reject" the one-question case of a form rather than a mode beside
 * it — the manager's Reject button is an option carrying `settles: 'rejected'`,
 * and nothing downstream needs to know it was special.
 */
export function verdictOf(
  questions: readonly DecisionQuestion[],
  answer: DecisionAnswer,
): DecisionVerdict {
  for (const question of questions) {
    if ('text' in question) continue;
    const response = answer.responses.find(entry => entry.questionId === question.id);
    if (!response) continue;
    for (const value of response.chose) {
      const settles = question.options.find(option => option.value === value)?.settles;
      if (settles === 'rejected') return 'rejected';
    }
  }
  return 'approved';
}

/**
 * The answer as one line, for a resolved card and the audit trail.
 *
 * Labels rather than values: `value` is a key the code matches on and `label`
 * is the sentence the person read, and a resolution reason written in keys is
 * unreadable exactly when somebody is trying to work out what was agreed.
 */
export function summarizeAnswer(
  questions: readonly DecisionQuestion[],
  answer: DecisionAnswer,
): string {
  const parts: string[] = [];
  for (const question of questions) {
    const response = answer.responses.find(entry => entry.questionId === question.id);
    if (!response) continue;
    const said = response.said?.trim() ?? '';
    if ('text' in question) {
      if (said) parts.push(said);
      continue;
    }
    const labels = response.chose.map(value =>
      question.options.find(option => option.value === value)?.label ?? value);
    if (said) labels.push(said);
    if (labels.length > 0) parts.push(labels.join(', '));
  }
  return parts.join(' · ');
}

// ── Time ────────────────────────────────────────────────────────────────────

/**
 * Is this still answerable?
 *
 * Expiry is a property of the decision rather than of each surface, which is
 * the bug this replaces: the Lark handler compared `expiresAt` to now, the
 * business action compared it again with its own reading, and the inbox query
 * had a third. Three readings of one deadline is three chances to accept an
 * answer to a question that had already closed.
 */
export function isOpen(decision: Pick<Decision, 'expiresAt'>, now: Date): boolean {
  if (!decision.expiresAt) return true;
  const at = Date.parse(decision.expiresAt);
  return Number.isNaN(at) ? true : at > now.getTime();
}

// ── The confirm case ────────────────────────────────────────────────────────

export const CONFIRM_QUESTION_ID = 'confirm';
export const CONFIRM_YES = 'yes';
export const CONFIRM_NO = 'no';

/**
 * The oldest question there is, in the new vocabulary.
 *
 * Written once here so that every yes/no in the product is the *same* yes/no.
 * Six card builders each had their own pair of buttons, and their labels had
 * drifted to "Approve"/"Reject", "Confirm"/"Cancel" and "Publish"/"Discard" for
 * decisions that were mechanically identical.
 */
export function confirmQuestion(input: {
  readonly ask: string;
  readonly yes?: string;
  readonly no?: string;
}): DecisionQuestion {
  return {
    id: CONFIRM_QUESTION_ID,
    ask: input.ask,
    pick: 'one',
    options: [
      { value: CONFIRM_YES, label: input.yes ?? 'Approve', tone: 'primary', settles: 'approved' },
      { value: CONFIRM_NO, label: input.no ?? 'Reject', tone: 'danger', settles: 'rejected' },
    ],
  };
}

/** The answer a yes/no card produces. */
export function confirmAnswer(verdict: DecisionVerdict): DecisionAnswer {
  return {
    responses: [{
      questionId: CONFIRM_QUESTION_ID,
      chose: [verdict === 'approved' ? CONFIRM_YES : CONFIRM_NO],
    }],
  };
}

/**
 * Is this decision answerable with buttons alone?
 *
 * A Lark card can carry a row of buttons and nothing else — no text field, no
 * multi-select that survives a redraw. Rather than let the card builder discover
 * that per feature, the question is asked here and answered for every surface
 * that only has buttons.
 *
 * A decision that fails this is still delivered to Lark; it just arrives as a
 * card that says what is being asked and sends the reader to the web thread,
 * the same way an artifact that Lark cannot hold arrives as an absence rather
 * than as a broken attachment.
 */
export function answerableWithButtons(questions: readonly DecisionQuestion[]): boolean {
  return questions.every(question =>
    !('text' in question) && question.pick === 'one' && !question.allowText);
}
