import { randomUUID } from 'node:crypto';
import type { Logger } from '../../shared/logger';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { IncomingMessage } from '../../domain/channel/incoming-message';
import type { ChannelLedgerRow, ChannelTimeline, InteractiveAction } from '../../domain/channel/outbound';
import { WEB_RUN_CONTENT_KIND, webThreadTitle, type WebThreadRunRecord } from '../../domain/channel/web-thread';
import { asChatId, asCorrelationId, asDepartmentId, asMessageId } from '../../shared/ids';
import { createRunTimelineReducer } from '../channels/run-timeline.reducer';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { DepartmentRepoPort } from '../../infrastructure/persistence/department.repository';
import type {
  ApprovalInboxItem,
  ApprovalInboxService,
} from '../approval/approval-inbox.service';
import type {
  LarkPiRuntimeAttachment,
  LarkPiRuntimeService,
} from './lark-pi-runtime.service';
import { LarkPiRuntimeError } from './lark-pi-runtime.service';
import { createLiveAnswerPublisher } from './live-answer-publisher';

/**
 * A Divo run driven from the browser.
 *
 * There is deliberately no second runtime here. This calls the same service a
 * Lark message calls, with the same lease, the same container, the same prompt
 * composition and the same permission checks — the only thing it does
 * differently is that nobody is patching a card at the other end, so the
 * timeline is streamed instead.
 *
 * If this file ever grows a decision about what Divo should *do*, that decision
 * is in the wrong place. See `plans/divo-one-soul-two-surfaces.md`.
 */

export type WebRunEvent =
  /** The run's neutral timeline, as it stands. Sent whenever it changes. */
  | { readonly type: 'timeline'; readonly timeline: ChannelTimeline }
  /** A reconnect snapshot of the assistant answer accumulated so far. */
  | { readonly type: 'answer'; readonly text: string }
  /** One exact fragment received from the model. */
  | { readonly type: 'answer_delta'; readonly delta: string }
  /** The preceding prose became pre-tool narration, not the final answer. */
  | { readonly type: 'answer_reset' }
  /** The answer. Terminal. */
  | {
      readonly type: 'final';
      readonly text: string;
      readonly actions?: readonly InteractiveAction[];
      readonly timeline: ChannelTimeline;
      /**
       * Approvals this run raised that are still waiting on the reader.
       *
       * Carried on the answer rather than left in a separate inbox, because on
       * Lark the buttons arrive in the same conversation — a reader who has to
       * know to go and look somewhere else has not been asked, they have been
       * filed. Decided through the existing member-authed approval routes; the
       * authority check is the approval row's, not this stream's.
       */
      readonly awaitingApproval?: readonly ApprovalInboxItem[];
    }
  /** The run did not produce an answer. Terminal. */
  | { readonly type: 'error'; readonly message: string; readonly code: string };

export interface WebRunInput {
  readonly runContext: RunContext;
  readonly threadId: string;
  readonly text: string;
  /** The member's own external identity, for conversation provenance. */
  readonly userExternalId: string;
  /**
   * The session the caller is signed in with.
   *
   * Named explicitly rather than left to be rediscovered: the only other way
   * back to a session row is the Lark identity pair, which a web caller does not
   * have. Handing over the exact session also means the run acts under the same
   * sign-in the person is holding — not whichever row happens to be newest.
   */
  readonly sessionId: string;
  /** Files handed over with this ask. Staged exactly as a Lark DM's are. */
  readonly attachments?: readonly LarkPiRuntimeAttachment[];
  readonly abortSignal?: AbortSignal;
}

export interface WebRunServiceDeps {
  readonly piRuntime: Pick<LarkPiRuntimeService, 'run'>;
  readonly logger: Logger;
  /** Resolves the same backend-owned active department used by Lark turns. */
  readonly identity?: Pick<ChannelIdentityRepoPort, 'resolveByUserId'>;
  /** Rejects a stale preference before it can be minted into a runtime lease. */
  readonly departments?: Pick<DepartmentRepoPort, 'getMembership'>;
  /** Optional: without it the run still answers, it just cannot show buttons. */
  readonly approvals?: Pick<ApprovalInboxService, 'list'>;
  /**
   * Where a run that produced no answer is written down.
   *
   * The runtime persists the exchange when a run succeeds; when it throws there
   * is no exchange to persist, and the question is left sitting alone in the
   * thread with nothing to say what became of it. On Lark that gap does not
   * exist, because the failure was posted into the chat as a message. This is
   * the web's equivalent of that message.
   */
  readonly transcript?: {
    appendTurn(
      chatId: string,
      turn: { role: 'user' | 'assistant'; content: string; timestamp: string },
      scope: { companyId: string; channel: string },
      metadata?: {
        dedupeKey?: string;
        sourceRunId?: string;
        contentJson?: unknown;
        conversationDefaults?: {
          createdByUserId?: string;
          createdByEmail?: string;
          title?: string;
        };
      },
    ): Promise<unknown>;
  };
}

/**
 * How often the timeline is pushed while the run works.
 *
 * Matched to Lark's card-edit throttle on purpose. A browser could take every
 * frame, and taking every frame is exactly the sort of small, reasonable
 * divergence that ends with two surfaces behaving differently — level 2 is
 * where the web is allowed to be better, and this is level 1.
 */
const TIMELINE_PUBLISH_MS = 1_000;

export class WebRunService {
  constructor(private readonly deps: WebRunServiceDeps) {}

  /**
   * Run one turn, yielding events as they happen.
   *
   * An async generator rather than a callback so the HTTP layer owns the
   * transport: the same stream can become SSE today and something else later
   * without this service knowing which.
   */
  async *run(input: WebRunInput): AsyncGenerator<WebRunEvent> {
    const log = this.deps.logger.child({ service: 'web-run' });
    const runId = randomUUID();
    const startedAtMs = Date.now();
    const timeline = createRunTimelineReducer({ startedAtMs });

    // Frames arrive faster than they are consumed, so they queue here and the
    // generator drains them. Without this the runtime would be blocked on the
    // browser's read speed, which would make a slow client a slow agent.
    const pending: WebRunEvent[] = [];
    let wake: (() => void) | undefined;
    const push = (event: WebRunEvent): void => {
      const last = pending.at(-1);
      if (event.type === 'answer_delta' && last?.type === 'answer_delta') {
        pending[pending.length - 1] = {
          type: 'answer_delta',
          delta: `${last.delta}${event.delta}`,
        };
        return;
      }
      pending.push(event);
      wake?.();
      wake = undefined;
    };
    const liveAnswer = createLiveAnswerPublisher(push);

    let nextPublishAt = startedAtMs;
    const publishTimeline = (force: boolean): void => {
      const now = Date.now();
      if (!force && now < nextPublishAt) return;
      nextPublishAt = now + TIMELINE_PUBLISH_MS;
      push({ type: 'timeline', timeline: timeline.timeline() });
    };

    // Sent before the runtime is even called. A cold container can take tens of
    // seconds to come up and emits nothing while it does, so without this the
    // reader watches an empty stream and cannot tell "starting" from "broken".
    push({ type: 'timeline', timeline: timeline.timeline() });

    const runContext = await this.resolveRunContext(input.runContext, log);
    const incoming = webIncomingMessage({
      runId,
      threadId: input.threadId,
      text: input.text,
      userExternalId: input.userExternalId,
    });
    let answerStarted = false;

    const settled = this.deps.piRuntime.run({
      incoming,
      runContext,
      conversation: {
        channel: 'web',
        chatId: incoming.chatId,
        correlationId: asCorrelationId(runId),
        replyInThread: false,
      },
      threadId: input.threadId,
      sessionId: input.sessionId,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      onProgress: event => {
        if (event.type === 'answer_delta') {
          answerStarted = true;
          liveAnswer.append(event.delta);
          return;
        }
        if (event.type === 'answer_reset') {
          answerStarted = false;
          liveAnswer.reset();
          return;
        }
        // Text before a tool call was narration, not the terminal answer. It
        // remains in the sentence-sized timeline `say` row; clear the live
        // answer lane so the next assistant turn starts from an honest blank.
        if (event.type === 'tool_start' && answerStarted) {
          answerStarted = false;
          liveAnswer.reset();
        }
        publishTimeline(timeline.apply(event) === 'immediate');
      },
      // Asked for at the moment the answer is written down, so the work log a
      // reader watched happen is still attached to it tomorrow. Without this a
      // returning reader gets the answer with no account of how it was reached
      // — which is most of what the web surface is for.
      runRecord: () => runRecord(timeline.timeline().ledger ?? [], startedAtMs),
    }).then(
      result => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    let done: Awaited<typeof settled> | undefined;
    void settled.then(value => {
      done = value;
      liveAnswer.flush();
      push({ type: 'timeline', timeline: timeline.timeline() });
    });

    // Drain until the run has settled *and* the queue is empty, so the last
    // frames are not dropped by the run finishing first.
    for (;;) {
      while (pending.length > 0) yield pending.shift()!;
      if (done) break;
      // The settled handler above pushes a frame, which wakes this — so there is
      // no path where the run finishes and nobody notices.
      await new Promise<void>(resolve => { wake = resolve; });
    }

    timeline.finishing();

    if (!done.ok) {
      const error = done.error;
      const code = error instanceof LarkPiRuntimeError ? error.code : 'run_failed';
      const message = error instanceof LarkPiRuntimeError
        ? error.userMessage
        : 'Divo hit a temporary problem while finishing this request. Please try again.';
      log.error('web_run.failed', { code, error: String(error), runId });
      await this.recordFailure(input, runId, { code, message }, timeline.timeline().ledger ?? [], startedAtMs);
      yield { type: 'error', message, code };
      return;
    }

    if (done.result.protectedDataUsed === true) timeline.observedProtectedData();

    const awaitingApproval = await this.approvalsRaisedBy(input, startedAtMs);

    yield {
      type: 'final',
      text: done.result.text,
      ...(done.result.actions?.length ? { actions: done.result.actions } : {}),
      ...(awaitingApproval.length ? { awaitingApproval } : {}),
      timeline: timeline.timeline(),
    };
  }

  /**
   * A human member token deliberately has no runtime department claim. Resolve
   * the person's backend-owned preference here, before the short-lived Pi lease
   * is issued, and confirm it is still an active membership. This keeps the web
   * and Lark surfaces on one department authority without trusting browser
   * input or teaching Pi how memberships work.
   */
  private async resolveRunContext(runContext: RunContext, log: Logger): Promise<RunContext> {
    if (runContext.departmentId || !this.deps.identity || !this.deps.departments) {
      return runContext;
    }

    const identity = await this.deps.identity.resolveByUserId(
      String(runContext.userId),
      String(runContext.companyId),
    );
    if (!identity.ok) {
      log.warn('web_run.department_identity_failed', { error: identity.error.message });
      return runContext;
    }
    const departmentId = identity.value?.activeDepartmentId;
    if (!departmentId) return runContext;

    const membership = await this.deps.departments.getMembership(
      String(runContext.userId),
      String(runContext.companyId),
      departmentId,
    );
    if (!membership.ok) {
      log.warn('web_run.department_membership_failed', {
        departmentId,
        error: membership.error.message,
      });
      return runContext;
    }
    if (!membership.value) {
      log.warn('web_run.department_preference_stale', { departmentId });
      return runContext;
    }

    return { ...runContext, departmentId: asDepartmentId(departmentId) };
  }

  /**
   * Write down a run that produced no answer.
   *
   * The runtime persists the exchange only once a run succeeds, which is right
   * for Lark — a failure there was posted into the chat as a message, so the
   * conversation already holds it. The web has no such second copy: without
   * this, a failed run leaves the thread empty and the reader comes back to no
   * evidence they ever asked anything.
   *
   * Both turns, because half an exchange is worse than none: an answer with no
   * question above it reads as Divo talking to itself. Written with exactly the
   * dedupe keys the successful path uses, so these can never end up alongside a
   * real answer for the same turn.
   *
   * Failing to record a failure is logged and dropped — the reader has already
   * been told what happened on the stream, and a second failure behind the
   * first helps nobody.
   */
  private async recordFailure(
    input: WebRunInput,
    runId: string,
    failure: { readonly code: string; readonly message: string },
    ledger: readonly ChannelLedgerRow[],
    startedAtMs: number,
  ): Promise<void> {
    if (!this.deps.transcript) return;
    const scope = { companyId: String(input.runContext.companyId), channel: 'web' };
    try {
      await this.deps.transcript.appendTurn(
        input.threadId,
        { role: 'user', content: input.text, timestamp: new Date(startedAtMs).toISOString() },
        scope,
        {
          dedupeKey: `web:${runId}:user`,
          sourceRunId: runId,
          conversationDefaults: {
            createdByUserId: String(input.runContext.userId),
            ...(input.runContext.requesterEmail ? { createdByEmail: input.runContext.requesterEmail } : {}),
            title: webThreadTitle(input.text),
          },
        },
      );
      await this.deps.transcript.appendTurn(
        input.threadId,
        { role: 'assistant', content: failure.message, timestamp: new Date().toISOString() },
        scope,
        {
          dedupeKey: `web:${runId}:assistant`,
          sourceRunId: runId,
          contentJson: runRecord(ledger, startedAtMs, failure),
        },
      );
    } catch (error) {
      this.deps.logger.warn('web_run.failure_not_recorded', { runId, error: String(error) });
    }
  }

  /**
   * What this run asked permission for and has not been answered on.
   *
   * Filtered by when the run started rather than by run id: a member's older
   * pending approvals belong in their inbox, not stapled to an answer they are
   * reading now. An approval subsystem failure is not allowed to lose the
   * answer — the run succeeded, and the inbox is still reachable on its own.
   */
  private async approvalsRaisedBy(
    input: WebRunInput,
    startedAtMs: number,
  ): Promise<readonly ApprovalInboxItem[]> {
    if (!this.deps.approvals) return [];
    try {
      const inbox = await this.deps.approvals.list({
        userId: String(input.runContext.userId),
        companyId: String(input.runContext.companyId),
      });
      return inbox.requestedByMe.filter(item =>
        Date.parse(item.requestedAt) >= startedAtMs
        && (item.status === 'pending' || item.status === 'dispatching'));
    } catch (error) {
      this.deps.logger.warn('web_run.approvals_unavailable', { error: String(error) });
      return [];
    }
  }
}

/**
 * A run's own record, in the shape the thread reads back.
 *
 * Stamped at the end rather than accumulated, because until the run is over
 * there is no elapsed time to state and no ledger that will not change again.
 */
function runRecord(
  ledger: readonly ChannelLedgerRow[],
  startedAtMs: number,
  failure?: { readonly code: string; readonly message: string },
): WebThreadRunRecord & { readonly kind: typeof WEB_RUN_CONTENT_KIND } {
  return {
    kind: WEB_RUN_CONTENT_KIND,
    ledger,
    elapsedMs: Date.now() - startedAtMs,
    ...(failure ? { failure } : {}),
  };
}

/**
 * The turn, in the vocabulary the runtime already speaks.
 *
 * A web turn is a private one-to-one conversation with a run id — which is what
 * `IncomingMessage` already describes. Inventing a parallel shape for it would
 * have meant a second code path through the runtime, and a second code path is
 * how two surfaces stop being one agent.
 */
function webIncomingMessage(input: {
  readonly runId: string;
  readonly threadId: string;
  readonly text: string;
  readonly userExternalId: string;
}): IncomingMessage {
  return {
    channel: 'web',
    messageId: asMessageId(input.runId),
    chatId: asChatId(input.threadId),
    chatType: 'p2p',
    userExternalId: input.userExternalId,
    text: input.text,
    attachments: [],
    timestamp: new Date().toISOString(),
    traceId: asCorrelationId(input.runId),
    // Addressing Divo directly is the only way to reach it here, so the turn is
    // always meant for it and never mentions anybody else.
    mentions: [],
    mentionsSelf: true,
    raw: null,
  };
}
