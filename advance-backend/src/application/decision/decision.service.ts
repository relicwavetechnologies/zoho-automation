import type { Logger } from '../../shared/logger';
import type { AuditService } from '../observability/audit.service';
import type {
  RuntimeApprovalRepository,
  RuntimeApprovalRow,
} from '../../infrastructure/persistence/runtime-approval.repository';
import type { ApprovalResumerService } from '../approval/approval-resumer.service';
import type { BusinessActionService } from '../approval/business-action.service';
import type { ApprovalCardInput } from '../approval/approval-card-builder';
import type { GatewayMemberContext } from '../gateway/gateway.types';
import { approvalResumesAutomatically, isGatewayApprovalMetadata } from '../approval/approval-origin';
import { sha256 } from '../../shared/hash';
import { surfaceCapabilities } from '../../domain/channel/surface-capabilities';
import type { ChannelKey } from '../../domain/channel/incoming-message';
import {
  checkAnswer,
  isOpen,
  nextQuestion,
  summarizeAnswer,
  verdictOf,
  type Decision,
  type DecisionAnswer,
  type DecisionContinuation,
  type DecisionQuestion,
  type DecisionVerdict,
} from '../../domain/decision/decision';
import {
  DECISION_ROW_KIND,
  DECISION_TOOL_ID,
  projectDecision,
  type ProjectedDecision,
} from './decision-projection';

/**
 * The one place Divo asks a person something and hears back.
 *
 * This replaces `ApprovalInboxService` and the dispatch that used to sit in the
 * route above it, where answering a decision meant trying the requester-owned
 * path first and falling through to the governance one — an ordering at the
 * door, standing in for a decision the module should have been making.
 *
 * Three things are true of every question that comes through here, and each one
 * used to be re-established per feature:
 *
 * **One authority check.** Who may answer is read off the row, once. Six call
 * sites had their own version, and the two newest — the knowledge review and
 * the workbook offer — had none, because their pending question lived in a
 * cache rather than on a row with an owner.
 *
 * **One expiry.** `isOpen` is asked here and nowhere else. Three separate
 * comparisons against `expiresAt` is three chances to accept an answer to a
 * question that had already closed.
 *
 * **One settlement.** `atomicResolve` is what stops a card and a browser both
 * resolving the same request; it only works if everything goes through it.
 *
 * What is deliberately *not* here: what any decision is about. This module has
 * no idea what a mail rule or a workbook is. It takes questions, gives back
 * answers, and hands the continuation to whoever declared it.
 */

export interface DecisionActor {
  readonly userId: string;
  readonly companyId: string;
  readonly displayName?: string;
  /**
   * The signed-in member, when the caller has one.
   *
   * Needed only to settle a requester confirmation, which executes its tool
   * call inline under the answerer's own identity. A Lark card press has no
   * member context and never needs one: those rows are never carded.
   */
  readonly member?: GatewayMemberContext;
}

export interface AskDecision {
  readonly companyId: string;
  /** Who has to answer. */
  readonly approver: { readonly userId: string; readonly displayName?: string; readonly larkOpenId?: string | null };
  /** Who is asking, as a person rather than a system. */
  readonly requestedBy: { readonly userId: string; readonly displayName?: string };
  readonly title: string;
  readonly detail?: string;
  /** Named on the card: a requester, a department, "Divo". */
  readonly source?: string;
  readonly questions: readonly DecisionQuestion[];
  readonly continuation: DecisionContinuation;
  /** Where the asking happened, so the answer can find its way back. */
  readonly channel: ChannelKey;
  readonly conversationKey: string;
  /**
   * What makes this the *same* question as one already open.
   *
   * Two identical asks a second apart must produce one card, not two. Callers
   * that can name the thing being decided should — a retry then reuses the
   * open request instead of stacking another beside it.
   */
  readonly idempotencyKey?: string;
  readonly expiresInMs?: number;
}

export type AskOutcome =
  | { readonly ok: true; readonly decision: Decision; readonly created: boolean; readonly deliveredVia: 'lark' | 'divo' }
  | { readonly ok: false; readonly message: string };

export type SettleOutcome =
  | {
      readonly ok: true;
      readonly verdict: DecisionVerdict;
      readonly decision: Decision;
      /** What was said, in the labels the person read. */
      readonly summary: string;
      /** Present when settling ran something: the requester-confirmation path. */
      readonly execution?: unknown;
    }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'forbidden' | 'already_resolved' | 'expired' | 'invalid_answer' | 'failed';
      readonly message: string;
    };

export interface DecisionInbox {
  readonly awaitingMe: readonly Decision[];
  readonly requestedByMe: readonly Decision[];
}

/**
 * Putting a card in front of somebody, on a surface that has cards.
 *
 * A port rather than a direct call because the web has no equivalent and needs
 * none: a browser reads its open decisions. Two implementations justify the
 * seam — Lark in production, nothing at all in a test.
 */
export interface DecisionCourier {
  deliver(input: {
    readonly decisionId: string;
    readonly decision: Decision;
    readonly questions: readonly DecisionQuestion[];
    readonly approverOpenId: string;
  }): Promise<{ readonly ok: boolean; readonly messageId?: string }>;
}

export interface DecisionServiceDeps {
  readonly approvals: RuntimeApprovalRepository;
  readonly resumer: ApprovalResumerService;
  readonly logger: Logger;
  readonly audit?: Pick<AuditService, 'record'>;
  /** Owns requester confirmations end to end, including their execution. */
  readonly businessActions?: Pick<BusinessActionService, 'decide'>;
  readonly courier?: DecisionCourier;
  /** Stops a delivered card offering buttons for a decision settled elsewhere. */
  readonly onResolvedCard?: (
    messageId: string,
    decision: DecisionVerdict,
    byName: string,
    request: Omit<ApprovalCardInput, 'approvalId' | 'approverName'>,
  ) => Promise<void>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

export class DecisionService {
  constructor(private readonly deps: DecisionServiceDeps) {}

  /**
   * Put a question to a person.
   *
   * The row is the request and delivery is a side effect of it — which is why
   * the card is sent after the write and a failure to send does not lose the
   * question. Somebody Divo cannot card still has it waiting in Divo.
   */
  async ask(input: AskDecision): Promise<AskOutcome> {
    const questions = input.questions;
    if (questions.length === 0) return { ok: false, message: 'A decision needs at least one question.' };

    /* The questions are part of what makes this the same question.
       `createOrReuseActive` reuses any live row with a matching key without
       comparing payloads, so a key built from the title alone let a second,
       different ask inside the TTL quietly return the first one's decision —
       answered, resumed, while its own caller was told it had been asked. */
    const idempotencyKey = input.idempotencyKey
      ?? sha256(`decision:${input.companyId}:${input.approver.userId}:${input.conversationKey}:${input.title}:${
        JSON.stringify({ questions, continuation: input.continuation })}`);

    const created = await this.deps.approvals.createOrReuseActive({
      chatId: input.conversationKey,
      companyId: input.companyId,
      toolId: DECISION_TOOL_ID,
      actionGroup: 'execute',
      kind: DECISION_ROW_KIND,
      summary: input.title,
      payloadJson: { questions, continuation: input.continuation },
      metadataJson: {
        title: input.title,
        detail: input.detail ?? null,
        source: input.source ?? input.requestedBy.displayName ?? 'Divo',
        // The field the inbox query reads. Named for the manager approval it
        // came from; it means "whose answer this is waiting on".
        resolvedManagerUserId: input.approver.userId,
        resolvedManagerName: input.approver.displayName ?? null,
        resolvedManagerOpenId: input.approver.larkOpenId ?? null,
        requesterId: input.requestedBy.userId,
        requesterName: input.requestedBy.displayName ?? null,
        sourceChannel: input.channel,
        approvalOrigin: input.channel === 'lark' ? 'lark' : 'gateway',
        /* Native decisions carry their own continuation, so the resumer's
           gateway rule must not also apply to them. */
        autoResume: input.continuation.kind === 'run',
        /* Named so the projection can tell a decision asked in a browser from
           one asked anywhere else, without inferring it from an id shape. */
        conversationKey: input.conversationKey,
      },
      channel: input.channel,
      requestedBy: input.requestedBy.userId,
      idempotencyKey,
      expiresAt: new Date(Date.now() + (input.expiresInMs ?? DEFAULT_TTL_MS)),
      // Nothing has to be delivered for a decision to be answerable: it is
      // already visible in Divo the moment it exists.
      initialStatus: 'pending',
    });

    if (!created.ok) {
      this.deps.logger.error('decision.ask_failed', { error: created.error.message, title: input.title });
      return { ok: false, message: 'Divo could not open that request. Please try again.' };
    }

    const projected = projectDecision(created.value.approval);
    const cardable = input.approver.larkOpenId
      && surfaceCapabilities(input.channel).decisions === 'buttons'
      && this.deps.courier;

    let deliveredVia: 'lark' | 'divo' = 'divo';
    if (cardable && created.value.created) {
      const sent = await this.deps.courier!.deliver({
        decisionId: created.value.approval.id,
        decision: projected.decision,
        questions,
        approverOpenId: input.approver.larkOpenId!,
      }).catch(error => {
        this.deps.logger.warn('decision.deliver_failed', { id: created.value.approval.id, error: String(error) });
        return { ok: false as const };
      });
      if (sent.ok) {
        deliveredVia = 'lark';
        if (sent.messageId) await this.deps.approvals.setDecisionMessageId(created.value.approval.id, sent.messageId);
      }
    }

    this.deps.logger.info('decision.asked', {
      id: created.value.approval.id,
      created: created.value.created,
      questions: questions.length,
      deliveredVia,
    });
    return { ok: true, decision: projected.decision, created: created.value.created, deliveredVia };
  }

  /**
   * Everything open for this person, as questions rather than as rows.
   *
   * Both halves are projected the same way, so a request somebody made shows
   * them exactly what the approver is looking at. Only one half can be settled,
   * and `settle` decides that rather than this.
   */
  async open(actor: DecisionActor): Promise<DecisionInbox> {
    const rows = await this.openRows(actor);
    return {
      awaitingMe: rows.awaitingMe.map(projected => projected.decision),
      requestedByMe: rows.requestedByMe.map(projected => projected.decision),
    };
  }

  /**
   * The same read, projected but not yet narrowed to a `Decision`.
   *
   * Exists for one caller: the compatibility route the installed Desktop
   * clients call, which has to answer in the shape it promised them — tool ids,
   * department names, a described tool action. `Decision` drops all of that on
   * purpose, and a route that went back to the rows to describe them a second
   * time would be a second projection to keep in agreement with this one.
   */
  async openRows(actor: DecisionActor): Promise<{
    readonly awaitingMe: readonly ProjectedDecision[];
    readonly requestedByMe: readonly ProjectedDecision[];
  }> {
    const listed = await this.deps.approvals.listInboxFor({
      companyId: actor.companyId,
      userId: actor.userId,
    });
    if (!listed.ok) {
      this.deps.logger.error('decision.open_failed', { error: listed.error.message });
      return { awaitingMe: [], requestedByMe: [] };
    }
    const now = new Date();
    const live = (row: RuntimeApprovalRow): ProjectedDecision | null => {
      const projected = projectDecision(row);
      return isOpen(projected.decision, now) ? projected : null;
    };
    return {
      awaitingMe: listed.value.awaitingMe.flatMap(row => live(row) ?? []),
      requestedByMe: listed.value.requestedByMe.flatMap(row => live(row) ?? []),
    };
  }

  /** One open decision this person may answer, or nothing. */
  async find(actor: DecisionActor, decisionId: string): Promise<Decision | null> {
    const loaded = await this.load(actor, decisionId);
    return loaded.ok ? loaded.projected.decision : null;
  }

  /**
   * Record an answer, and do what the asker said should happen next.
   *
   * The order is load, authorize, check the clock, check the answer, and only
   * then resolve. Resolving first and validating after is how a malformed
   * answer used to close a request nobody had actually answered.
   */
  async settle(actor: DecisionActor, decisionId: string, answer: DecisionAnswer): Promise<SettleOutcome> {
    const loaded = await this.load(actor, decisionId);
    if (!loaded.ok) return loaded.outcome;
    const { row, projected } = loaded;

    const invalid = checkAnswer(projected.questions, answer);
    if (invalid) {
      return {
        ok: false,
        reason: 'invalid_answer',
        message: answerProblem(invalid.reason),
      };
    }

    const verdict = verdictOf(projected.questions, answer);
    const summary = summarizeAnswer(projected.questions, answer);

    /* A requester confirmation owns its whole lifecycle — it resolves, claims
       and executes in one transaction-guarded sequence, and doing half of that
       here would let the same action run twice. So it is delegated whole rather
       than partly reimplemented. */
    if (projected.rowKind === 'business_action') {
      return this.settleBusinessAction(actor, projected, verdict, summary);
    }

    const resolved = await this.deps.approvals.atomicResolve(decisionId, verdict, actor.userId, summary || undefined);
    if (!resolved.ok || !resolved.value) {
      this.deps.logger.warn('decision.resolve_failed', { decisionId, verdict });
      return { ok: false, reason: 'failed', message: 'Could not record that. Please try again.' };
    }

    const stored = await this.deps.approvals.persistAnswer(decisionId, answer);
    if (!stored.ok) {
      // The verdict is already durable and the continuation is about to run on
      // it. Losing the transcript of a settled decision is worth a loud log and
      // nothing else — refusing here would strand a resolved request.
      this.deps.logger.error('decision.answer_not_stored', { decisionId, error: stored.error.message });
    }

    await this.updateDeliveredCard(row, verdict, actor);
    this.continue(row, projected.continuation, verdict);

    this.deps.audit?.record({
      actorId: actor.userId,
      companyId: row.companyId ?? actor.companyId,
      action: 'decision.settled',
      outcome: 'success',
      metadata: { decisionId, verdict, summary, toolId: row.toolId, kind: row.kind },
    });
    this.deps.logger.info('decision.settled', { decisionId, verdict, kind: row.kind });

    return { ok: true, verdict, decision: projected.decision, summary };
  }

  /**
   * One press of one button, from a surface that only has buttons.
   *
   * A card holds no state between presses, so the part-finished answer lives on
   * the row and each press adds to it. Which is also what makes the sequence
   * survivable: somebody who answers two of three questions and closes Lark
   * finds the third one waiting rather than starting again.
   *
   * Two presses racing can lose one another's partial answer. The cost is that
   * a question is asked a second time, which is why this is not worth a lock —
   * the settlement that matters is still `atomicResolve`, and that one is.
   */
  async answerOne(
    actor: DecisionActor,
    decisionId: string,
    questionId: string,
    value: string,
  ): Promise<
    | { readonly ok: true; readonly settled: false; readonly decision: Decision; readonly answer: DecisionAnswer }
    | ({ readonly settled: true } & SettleOutcome)
    | { readonly ok: false; readonly settled: false; readonly reason: string; readonly message: string }
  > {
    const loaded = await this.load(actor, decisionId);
    if (!loaded.ok) return { settled: true, ...loaded.outcome };
    const { row, projected } = loaded;

    const question = projected.questions.find(entry => entry.id === questionId);
    if (!question || 'text' in question) {
      return { ok: false, settled: false, reason: 'unknown_question', message: 'That question is no longer being asked.' };
    }
    if (!question.options.some(option => option.value === value)) {
      return { ok: false, settled: false, reason: 'unknown_option', message: 'That option is no longer on this request.' };
    }

    const answer = addChoice(storedAnswer(row), question, value);
    if (nextQuestion(projected.questions, answer)) {
      /* Guarded to a still-open row. Two surfaces can hold this decision at
         once, and a card press that loaded before a browser settled it would
         otherwise overwrite the transcript of a finished decision — leaving a
         stored answer that disagrees with the verdict beside it. */
      const stored = await this.deps.approvals.persistPartialAnswer(decisionId, answer);
      if (!stored.ok) {
        this.deps.logger.error('decision.partial_not_stored', { decisionId, error: stored.error.message });
        return { ok: false, settled: false, reason: 'failed', message: 'Could not record that. Please try again.' };
      }
      if (!stored.value) {
        return {
          ok: false,
          settled: false,
          reason: 'already_resolved',
          message: 'This request was answered somewhere else.',
        };
      }
      return { ok: true, settled: false, decision: projected.decision, answer };
    }
    return { settled: true, ...await this.settle(actor, decisionId, answer) };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async load(actor: DecisionActor, decisionId: string): Promise<
    | { readonly ok: true; readonly row: RuntimeApprovalRow; readonly projected: ProjectedDecision }
    | { readonly ok: false; readonly outcome: Extract<SettleOutcome, { ok: false }> }
  > {
    const found = await this.deps.approvals.findById(decisionId);
    if (!found.ok || !found.value) {
      return { ok: false, outcome: { ok: false, reason: 'not_found', message: 'That request no longer exists.' } };
    }
    const row = found.value;
    const projected = projectDecision(row);

    // `dispatching` is live for the same reason the card handler accepts it: a
    // request can be delivered before its message id is stored.
    if (!['dispatching', 'pending'].includes(row.status)) {
      return {
        ok: false,
        outcome: { ok: false, reason: 'already_resolved', message: `This request was already ${row.status}.` },
      };
    }
    if (!isOpen(projected.decision, new Date())) {
      return {
        ok: false,
        outcome: { ok: false, reason: 'expired', message: 'This request expired. Ask for it again.' },
      };
    }
    if (
      !projected.approverUserId
      || row.companyId !== actor.companyId
      || projected.approverUserId !== actor.userId
    ) {
      // Persisted rather than only logged: somebody answering a decision that
      // was not theirs to make is a security event an admin must be able to
      // query, and it is the same event whichever surface it arrives on.
      this.deps.audit?.record({
        actorId: actor.userId,
        companyId: row.companyId ?? actor.companyId,
        action: 'decision.unauthorized_actor',
        outcome: 'failure',
        metadata: { decisionId, expectedApproverUserId: projected.approverUserId, actorCompanyId: actor.companyId },
      });
      this.deps.logger.warn('decision.unauthorized_actor', { decisionId, actorUserId: actor.userId });
      return {
        ok: false,
        outcome: { ok: false, reason: 'forbidden', message: 'This request is waiting on someone else.' },
      };
    }
    return { ok: true, row, projected };
  }

  private async settleBusinessAction(
    actor: DecisionActor,
    projected: ProjectedDecision,
    verdict: DecisionVerdict,
    summary: string,
  ): Promise<SettleOutcome> {
    if (!this.deps.businessActions || !actor.member) {
      return {
        ok: false,
        reason: 'failed',
        message: 'This action can only be confirmed from a signed-in Divo session.',
      };
    }
    const outcome = await this.deps.businessActions.decide({
      member: actor.member,
      actionId: projected.decision.id,
      decision: verdict,
    });
    if (!outcome.handled) {
      return { ok: false, reason: 'not_found', message: 'That action no longer exists.' };
    }
    if (outcome.response.status === 'permission_denied') {
      return { ok: false, reason: 'forbidden', message: 'This action is waiting on the person who requested it.' };
    }
    this.deps.logger.info('decision.settled', {
      decisionId: projected.decision.id,
      verdict,
      kind: 'business_action',
      status: outcome.response.status,
    });
    return { ok: true, verdict, decision: projected.decision, summary, execution: outcome.response };
  }

  private async updateDeliveredCard(
    row: RuntimeApprovalRow,
    verdict: DecisionVerdict,
    actor: DecisionActor,
  ): Promise<void> {
    if (!row.decisionMessageId || !this.deps.onResolvedCard) return;
    const meta = asRecord(row.metadataJson);
    const payload = asRecord(row.payloadJson);
    const authority = meta['approvalAuthority'];
    await this.deps.onResolvedCard(
      row.decisionMessageId,
      verdict,
      actor.displayName ?? actor.userId,
      {
        toolId: row.toolId,
        action: row.actionGroup,
        args: payload['args'],
        summary: row.summary,
        requesterName: readString(meta['requesterName']) ?? readString(meta['requesterEmail']) ?? 'A team member',
        authority: authority === 'connection_owner' || authority === 'company_admin' || authority === 'department_manager'
          ? authority
          : 'department_manager',
        departmentName: readString(meta['departmentName']) ?? 'Company-wide',
      },
    ).catch(error => this.deps.logger.warn('decision.card_update_failed', { id: row.id, error: String(error) }));
  }

  /**
   * Hand the settled decision to whatever was waiting on it.
   *
   * Deliberately not awaited. The person who pressed the button is owed an
   * immediate answer — Lark gives a card callback three seconds — and the work
   * that follows can take minutes.
   */
  private continue(row: RuntimeApprovalRow, continuation: DecisionContinuation, verdict: DecisionVerdict): void {
    if (continuation.kind !== 'run') return;
    const meta = asRecord(row.metadataJson);
    /* A gateway request is normally retried by the requester rather than
       resumed for them; resuming it would execute an action nobody re-issued.
       Unless the asker said otherwise — a request made from a form has no
       requester left to re-issue it, and a yes that did nothing is worse. */
    if (isGatewayApprovalMetadata(meta) && !approvalResumesAutomatically(meta)) return;
    void this.deps.resumer.resume(row.id, verdict)
      .catch(error => this.deps.logger.error('decision.resume_failed', { id: row.id, error: String(error) }));
  }
}

/** What to tell somebody whose answer will not do. */
function answerProblem(reason: NonNullable<ReturnType<typeof checkAnswer>>['reason']): string {
  switch (reason) {
    case 'needs_one': return 'Answer every question before sending.';
    case 'needs_exactly_one': return 'Pick one option.';
    case 'needs_words': return 'Write an answer before sending.';
    case 'no_text_allowed': return 'That question only takes one of the listed options.';
    default: return 'That answer no longer matches the question. Reload and try again.';
  }
}

/**
 * The part-finished answer already on the row.
 *
 * Anything unreadable is treated as nothing rather than repaired: an answer
 * that will not parse is one nobody can prove a person gave, and starting the
 * questions again is the honest outcome.
 */
function storedAnswer(row: RuntimeApprovalRow): DecisionAnswer {
  const stored = asRecord(row.responseJson)['responses'];
  if (!Array.isArray(stored)) return { responses: [] };
  return {
    responses: stored.flatMap(entry => {
      const record = asRecord(entry);
      const questionId = readString(record['questionId']);
      if (!questionId) return [];
      const chose = Array.isArray(record['chose'])
        ? record['chose'].filter((value): value is string => typeof value === 'string')
        : [];
      const said = readString(record['said']);
      return [{ questionId, chose, ...(said ? { said } : {}) }];
    }),
  };
}

/** One more choice on one question, replacing it where the question takes one. */
function addChoice(
  answer: DecisionAnswer,
  question: Extract<DecisionQuestion, { pick: 'one' | 'many' }>,
  value: string,
): DecisionAnswer {
  const existing = answer.responses.find(entry => entry.questionId === question.id);
  const chose = question.pick === 'one'
    ? [value]
    : [...new Set([...(existing?.chose ?? []), value])];
  const updated = { questionId: question.id, chose };
  return {
    responses: existing
      ? answer.responses.map(entry => (entry.questionId === question.id ? updated : entry))
      : [...answer.responses, updated],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
