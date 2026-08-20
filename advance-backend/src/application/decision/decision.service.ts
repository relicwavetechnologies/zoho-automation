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
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import { approvalResumesAutomatically, isGatewayApprovalMetadata } from '../approval/approval-origin';
import {
  approvalDeliveryFailedCheckpoint,
  approvalDeliveryUnknownCheckpoint,
} from '../approval/approval-delivery';
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
  type DecisionSubject,
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
 * It replaces `ApprovalInboxService` and the dispatch that used to sit in the
 * route above it, where answering a decision meant trying the requester-owned
 * path first and falling through to the governance one — an ordering at the
 * door, standing in for a decision the module should have been making.
 *
 * WHAT IS AND IS NOT MIGRATED. Every existing approval is *read* and *settled*
 * through here: the projection turns any stored row into questions, so the web
 * card, the Approvals page, the Desktop route, and the compatibility handler for
 * old Lark approval cards all come through this module. Manager approval opening
 * now comes through `ask` too. The other older producers still write their own
 * rows and draw their own cards until their phases migrate them. Said plainly
 * here because a module that reads as finished is one the next author will not
 * finish.
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
   * The authenticated Lark card identity, when settlement came from Lark.
   *
   * This stays optional so web and Desktop callers keep their existing member
   * identity contract. When present, the row's manager open id and tenant key
   * are checked here, at the same seam that checks the user and company.
   */
  readonly lark?: { readonly openId: string; readonly tenantKey: string };
  /**
   * The signed-in member, when the caller has one.
   *
   * Needed only to settle a requester confirmation, which executes its tool
   * call inline under the answerer's own identity. A Lark card press has no
   * member context and never needs one: those rows are never carded.
   */
  readonly member?: GatewayMemberContext;
}

export interface NativeDecisionAsk {
  readonly kind?: 'decision';
  readonly companyId: string;
  /** Who has to answer. */
  readonly approver: { readonly userId: string; readonly displayName?: string; readonly larkOpenId?: string | null };
  /** Who is asking, as a person rather than a system. */
  readonly requestedBy: { readonly userId: string; readonly displayName?: string };
  readonly title: string;
  readonly detail?: string;
  /** Named on the card: a requester, a department, "Divo". */
  readonly source?: string;
  /**
   * The product being acted on, when there is one.
   *
   * Declared by the asker rather than worked out here: this module knows
   * nothing about tool ids on purpose, and a native ask is the one case where
   * there is no stored tool call to read a subject back out of.
   */
  readonly subject?: DecisionSubject;
  readonly questions: readonly DecisionQuestion[];
  /**
   * Deliberately narrower than `DecisionContinuation`.
   *
   * A projected legacy row can say `run`, and that works: the resumer knows how
   * to re-execute a `tool_action` payload because the gate wrote one. A row
   * opened here has no such payload — it holds questions — and no metadata the
   * resumer reads, so a `run` declared at this door would resolve the row,
   * patch the card to "Approved", say "Divo is carrying on", and run nothing.
   *
   * That is the same defect the `tell` arm was deleted for. Rather than delete
   * `run` too — legitimate for the rows that already carry it — it is refused
   * at the one place that could introduce a new one. Widen this on the day a
   * continuation executor exists for native decisions.
   */
  readonly continuation: Extract<DecisionContinuation, { kind: 'none' }>;
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

export interface ToolActionDecisionAsk {
  readonly kind: 'tool_action';
  readonly companyId: string;
  /** Who has to answer. */
  readonly approver: { readonly userId: string; readonly displayName?: string; readonly larkOpenId?: string | null };
  /** Who is asking, as a person rather than a system. */
  readonly requestedBy: { readonly userId: string; readonly displayName?: string };
  /** The exact requester-facing summary already prepared by the producer. */
  readonly summary: string;
  readonly toolId: string;
  readonly action: ToolActionGroup;
  /** Stored row kind, kept explicit for requester-owned execution routing. */
  readonly rowKind?: 'tool_action' | 'business_action' | 'automation_script_plan';
  readonly args: unknown;
  readonly argsHash: string;
  /** Optional immutable payload for a domain-specific row such as an automation plan. */
  readonly payloadJson?: unknown;
  /** Producer-owned metadata that must survive row opening unchanged. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Validation/binding that must finish before a new card is sent. */
  readonly beforeDelivery?: (row: RuntimeApprovalRow) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string; readonly message: string }
  >;
  readonly channel: ChannelKey;
  readonly conversationKey: string;
  readonly idempotencyKey: string;
  readonly compatibleIdempotencyKeys?: readonly string[];
  /** Exact legacy-row predicate owned by the approval gate. */
  readonly isCompatibleApproval?: (row: RuntimeApprovalRow) => boolean;
  /** Producer-owned copy for delivery failures that include domain context. */
  readonly deliveryMessages?: {
    readonly unknown: (rowId: string) => string;
    readonly failed: (rowId: string) => string;
  };
  readonly initialStatus: 'dispatching' | 'pending';
  readonly expiresInMs?: number;
}

export type AskDecision = NativeDecisionAsk | ToolActionDecisionAsk;

export type AskOutcome =
  | {
      readonly ok: true;
      readonly decision: Decision;
      readonly row: RuntimeApprovalRow;
      readonly created: boolean;
      readonly replacedExpired: boolean;
      readonly deliveredVia: 'lark' | 'desktop' | 'web' | 'divo';
      readonly requestState: 'created' | 'reused' | 'dispatching' | 'replaced_expired';
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'store_failed' | 'delivery_failed' | 'delivery_unknown';
      readonly message: string;
      readonly rowId?: string;
    };

export type SettleOutcome =
  | {
      readonly ok: true;
      readonly verdict: DecisionVerdict;
      readonly decision: Decision;
      /** What was said, in the labels the person read. */
      readonly summary: string;
      /**
       * What the settled row expects next. The old Lark adapter uses this to
       * keep its existing toast without deciding whether a gateway request
       * resumes or waits for the requester to retry.
       */
      readonly followUp: 'resumed' | 'retry' | 'none';
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
  }): Promise<
    | { readonly ok: true; readonly messageId?: string }
    | {
        readonly ok: false;
        readonly failure?: {
          readonly certainty: 'definite' | 'unknown';
          readonly message: string;
        };
      }
  >;
}

export interface DecisionServiceDeps {
  readonly approvals: RuntimeApprovalRepository;
  readonly resumer: ApprovalResumerService;
  readonly logger: Logger;
  readonly audit?: Pick<AuditService, 'record'>;
  /** Owns requester confirmations end to end, including their execution. */
  readonly businessActions?: Pick<BusinessActionService, 'decide'>;
  readonly courier?: DecisionCourier;
  /**
   * Stops a delivered card offering buttons for a decision settled elsewhere.
   *
   * `native` says which card to draw over it. A manager approval gets the
   * resolution card the gate's own flow has always drawn; a decision opened
   * here gets one carrying what was actually answered, which the approval card
   * has no field for. Chosen by the caller rather than here because building a
   * Lark card is not this module's job.
   */
  readonly onResolvedCard?: (input: {
    readonly messageId: string;
    readonly verdict: DecisionVerdict;
    readonly byName: string;
    readonly title: string;
    /** What was said, in the labels the person read. */
    readonly summary: string;
    readonly native: boolean;
    readonly request: Omit<ApprovalCardInput, 'approvalId' | 'approverName'>;
  }) => Promise<void>;
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
    const isToolAction = input.kind === 'tool_action';
    const questions = isToolAction ? null : input.questions;
    if (questions && questions.length === 0) {
      return { ok: false, reason: 'invalid', message: 'A decision needs at least one question.' };
    }

    /* The questions are part of what makes this the same question.
       `createOrReuseActive` reuses any live row with a matching key without
       comparing payloads, so a key built from the title alone let a second,
       different ask inside the TTL quietly return the first one's decision —
       answered, resumed, while its own caller was told it had been asked. */
    const idempotencyKey = isToolAction
      ? input.idempotencyKey
      : input.idempotencyKey
        ?? sha256(`decision:${input.companyId}:${input.approver.userId}:${input.conversationKey}:${input.title}:${
          JSON.stringify({ questions, continuation: input.continuation })}`);

    const createInput = isToolAction
      ? {
          chatId: input.conversationKey,
          companyId: input.companyId,
          toolId: input.toolId,
          actionGroup: input.action,
          kind: input.rowKind ?? 'tool_action',
          summary: input.summary,
          payloadJson: input.payloadJson ?? {
            toolId: input.toolId,
            action: input.action,
            args: input.args,
            argsHash: input.argsHash,
          },
          metadataJson: {
            ...input.metadata,
            resolvedManagerUserId: input.approver.userId,
            resolvedManagerName: input.approver.displayName ?? null,
            resolvedManagerOpenId: input.approver.larkOpenId ?? null,
            requesterId: input.requestedBy.userId,
            requesterName: input.requestedBy.displayName ?? null,
          },
          channel: input.channel,
          requestedBy: input.requestedBy.userId,
          idempotencyKey,
          expiresAt: new Date(Date.now() + (input.expiresInMs ?? DEFAULT_TTL_MS)),
          initialStatus: input.initialStatus,
        }
      : {
          chatId: input.conversationKey,
          companyId: input.companyId,
          toolId: DECISION_TOOL_ID,
          actionGroup: 'execute' as const,
          kind: DECISION_ROW_KIND,
          summary: input.title,
          payloadJson: { questions, continuation: input.continuation },
          metadataJson: {
            title: input.title,
            detail: input.detail ?? null,
            source: input.source ?? input.requestedBy.displayName ?? 'Divo',
            /* Stored rather than derived, because a native ask is the one case with
               no tool call to read it back out of. A tool approval gets its subject
               from the call it already holds; this is the other half. */
            subject: input.subject ?? null,
            // The field the inbox query reads. Named for the manager approval it
            // came from; it means "whose answer this is waiting on".
            resolvedManagerUserId: input.approver.userId,
            resolvedManagerName: input.approver.displayName ?? null,
            resolvedManagerOpenId: input.approver.larkOpenId ?? null,
            requesterId: input.requestedBy.userId,
            requesterName: input.requestedBy.displayName ?? null,
            sourceChannel: input.channel,
            approvalOrigin: input.channel === 'lark' ? 'lark' : 'gateway',
            /* A native decision never resumes a stored tool call — see the note on
               `continuation` above — so it must not inherit the gateway rule that
               would ask the resumer to find one. */
            autoResume: false,
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
          initialStatus: 'pending' as const,
        };
    const createOptions = isToolAction
      ? {
          ...(input.compatibleIdempotencyKeys
            ? { compatibleIdempotencyKeys: input.compatibleIdempotencyKeys }
            : {}),
          ...(input.isCompatibleApproval
            ? { isCompatibleApproval: input.isCompatibleApproval }
            : {}),
        }
      : undefined;
    const created = await this.deps.approvals.createOrReuseActive(createInput, createOptions);

    if (!created.ok) {
      this.deps.logger.error('decision.ask_failed', {
        error: created.error.message,
        title: isToolAction ? input.summary : input.title,
      });
      return {
        ok: false,
        reason: 'store_failed',
        message: 'Divo could not open that request. Please try again.',
      };
    }

    const { approval, created: wasCreated, replacedExpired } = created.value;
    if (isToolAction && input.beforeDelivery) {
      const validation = await input.beforeDelivery(approval);
      if (!validation.ok) {
        const marked = await this.deps.approvals.markFailed(approval.id, validation.reason);
        if (!marked.ok) {
          this.deps.logger.error('decision.before_delivery_failed', {
            id: approval.id,
            error: marked.error.message,
          });
        }
        return {
          ok: false,
          reason: 'invalid',
          message: validation.message,
          rowId: approval.id,
        };
      }
    }

    const projected = projectDecision(approval);
    const cardable = input.approver.larkOpenId
      && input.channel === 'lark'
      && surfaceCapabilities(input.channel).decisions === 'buttons'
      && this.deps.courier;

    let deliveredVia: 'lark' | 'desktop' | 'web' | 'divo' = isToolAction
      ? input.channel === 'airnote' ? 'divo' : input.channel
      : 'divo';
    let requestState: 'created' | 'reused' | 'dispatching' | 'replaced_expired' = wasCreated
      ? (replacedExpired ? 'replaced_expired' : 'created')
      : 'reused';
    if (cardable && wasCreated) {
      const sent = await this.deps.courier!.deliver({
        decisionId: approval.id,
        decision: projected.decision,
        questions: projected.questions,
        approverOpenId: input.approver.larkOpenId!,
      }).catch(error => {
        this.deps.logger.warn('decision.deliver_failed', { id: approval.id, error: String(error) });
        return {
          ok: false as const,
          failure: { certainty: 'unknown' as const, message: String(error) },
        };
      });
      if (!sent.ok) {
        if (isToolAction) return this.handleToolDeliveryFailure(input, approval, sent.failure);
        this.deps.logger.warn('decision.native_delivery_unavailable', { id: approval.id });
      } else {
        deliveredVia = 'lark';
        if (sent.messageId) {
          const persisted = await this.deps.approvals.setDecisionMessageId(approval.id, sent.messageId);
          if (isToolAction && !persisted.ok) {
            this.deps.logger.error('decision.delivery_persist_failed', {
              id: approval.id,
              error: persisted.error.message,
            });
            requestState = 'dispatching';
          }
        }
      }
    }

    this.deps.logger.info('decision.asked', {
      id: approval.id,
      created: wasCreated,
      questions: projected.questions.length,
      deliveredVia,
    });
    return {
      ok: true,
      decision: projected.decision,
      row: approval,
      created: wasCreated,
      replacedExpired,
      deliveredVia,
      requestState,
    };
  }

  private async handleToolDeliveryFailure(
    input: ToolActionDecisionAsk,
    approval: RuntimeApprovalRow,
    failure?: { readonly certainty: 'definite' | 'unknown'; readonly message: string },
  ): Promise<AskOutcome> {
    const detail = failure ?? {
      certainty: 'unknown' as const,
      message: 'The delivery adapter did not report whether Lark accepted the card.',
    };
    if (detail.certainty === 'unknown') {
      const checkpoint = await this.deps.approvals.persistResult(
        approval.id,
        approvalDeliveryUnknownCheckpoint(detail.message),
      );
      if (!checkpoint.ok) {
        this.deps.logger.error('decision.delivery_unknown_checkpoint_failed', {
          id: approval.id,
          error: checkpoint.error.message,
        });
      }
      return {
        ok: false,
        reason: 'delivery_unknown',
        message: input.deliveryMessages?.unknown(approval.id)
          ?? `Divo lost confirmation while delivering the approval card to ${input.approver.displayName ?? 'the approver'}. The card may still be actionable, so the exact request is blocked from automatic retry (id: ${approval.id}). Please contact your administrator.`,
        rowId: approval.id,
      };
    }

    const markedFailed = await this.deps.approvals.markFailed(
      approval.id,
      `card_send_failed:${detail.message}`,
    );
    if (!markedFailed.ok) {
      this.deps.logger.error('decision.delivery_failure_mark_failed_failed', {
        id: approval.id,
        error: markedFailed.error.message,
      });
      const checkpoint = await this.deps.approvals.persistResult(
        approval.id,
        approvalDeliveryFailedCheckpoint(detail.message),
      );
      if (!checkpoint.ok) {
        this.deps.logger.error('decision.delivery_failure_checkpoint_failed', {
          id: approval.id,
          error: checkpoint.error.message,
        });
      }
    }
    return {
      ok: false,
      reason: 'delivery_failed',
      message: input.deliveryMessages?.failed(approval.id)
        ?? 'This action requires manager approval, but the approval card could not be delivered. Please try again or contact your administrator.',
      rowId: approval.id,
    };
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

    this.updateDeliveredCard(row, projected, verdict, summary, actor);
    const followUp = this.continue(row, projected.continuation, verdict);

    this.deps.audit?.record({
      actorId: actor.userId,
      companyId: row.companyId ?? actor.companyId,
      action: 'decision.settled',
      outcome: 'success',
      metadata: { decisionId, verdict, summary, toolId: row.toolId, kind: row.kind },
    });
    this.deps.logger.info('decision.settled', { decisionId, verdict, kind: row.kind });

    return { ok: true, verdict, decision: projected.decision, summary, followUp };
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
    const metadata = asRecord(row.metadataJson);

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
    const larkIdentity = actor.lark;
    const resolvedManagerOpenId = readString(metadata['resolvedManagerOpenId']);
    const larkMetadataMissing = Boolean(larkIdentity)
      && (
        !resolvedManagerOpenId
        || !projected.approverUserId
        || !row.companyId
      );
    const larkIdentityMismatch = Boolean(larkIdentity)
      && !larkMetadataMissing
      && (
        resolvedManagerOpenId !== larkIdentity!.openId
        || (
          readString(metadata['tenantKey'])
          && readString(metadata['tenantKey']) !== larkIdentity!.tenantKey
        )
      );

    if (
      larkMetadataMissing
      || larkIdentityMismatch
      || !projected.approverUserId
      || row.companyId !== actor.companyId
      || projected.approverUserId !== actor.userId
    ) {
      const missingLarkMetadata = larkMetadataMissing;
      // Persisted rather than only logged: somebody answering a decision that
      // was not theirs to make is a security event an admin must be able to
      // query, and it is the same event whichever surface it arrives on.
      this.deps.audit?.record({
        actorId: actor.userId,
        companyId: row.companyId ?? actor.companyId,
        action: 'decision.unauthorized_actor',
        outcome: 'failure',
        metadata: {
          decisionId,
          expectedApproverUserId: projected.approverUserId,
          expectedApproverOpenId: resolvedManagerOpenId,
          actorCompanyId: actor.companyId,
          ...(larkIdentity ? {
            actorOpenId: larkIdentity.openId,
            actorTenantKey: larkIdentity.tenantKey,
          } : {}),
        },
      });
      this.deps.logger.warn('decision.unauthorized_actor', { decisionId, actorUserId: actor.userId });
      return {
        ok: false,
        outcome: {
          ok: false,
          reason: 'forbidden',
          message: missingLarkMetadata
            ? 'Approval metadata is missing. Please ask the requester to try again.'
            : larkIdentity
              ? 'You are not authorized to approve this request.'
              : 'This request is waiting on someone else.',
        },
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
    return {
      ok: true,
      verdict,
      decision: projected.decision,
      summary,
      followUp: 'none',
      execution: outcome.response,
    };
  }

  private updateDeliveredCard(
    row: RuntimeApprovalRow,
    projected: ProjectedDecision,
    verdict: DecisionVerdict,
    summary: string,
    actor: DecisionActor,
  ): void {
    if (!row.decisionMessageId || !this.deps.onResolvedCard) return;
    const meta = asRecord(row.metadataJson);
    const payload = asRecord(row.payloadJson);
    const authority = meta['approvalAuthority'];
    void this.deps.onResolvedCard({
      messageId: row.decisionMessageId,
      verdict,
      byName: actor.displayName ?? actor.userId,
      title: projected.decision.title,
      summary,
      native: projected.rowKind === DECISION_ROW_KIND,
      request: {
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
    }).catch(error => this.deps.logger.warn('decision.card_update_failed', { id: row.id, error: String(error) }));
  }

  /**
   * Hand the settled decision to whatever was waiting on it.
   *
   * Deliberately not awaited. The person who pressed the button is owed an
   * immediate answer — Lark gives a card callback three seconds — and the work
   * that follows can take minutes.
   */
  private continue(
    row: RuntimeApprovalRow,
    continuation: DecisionContinuation,
    verdict: DecisionVerdict,
  ): 'resumed' | 'retry' | 'none' {
    if (continuation.kind !== 'run') return 'none';
    const meta = asRecord(row.metadataJson);
    /* A gateway request is normally retried by the requester rather than
       resumed for them; resuming it would execute an action nobody re-issued.
       Unless the asker said otherwise — a request made from a form has no
       requester left to re-issue it, and a yes that did nothing is worse. */
    if (isGatewayApprovalMetadata(meta) && !approvalResumesAutomatically(meta)) return 'retry';
    void this.deps.resumer.resume(row.id, verdict)
      .catch(error => this.deps.logger.error('decision.resume_failed', { id: row.id, error: String(error) }));
    return 'resumed';
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
