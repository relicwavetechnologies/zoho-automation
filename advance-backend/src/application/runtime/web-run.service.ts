import { randomUUID } from 'node:crypto';
import type { Logger } from '../../shared/logger';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { IncomingMessage } from '../../domain/channel/incoming-message';
import type { ChannelLedgerRow, ChannelTimeline, InteractiveAction } from '../../domain/channel/outbound';
import {
  WEB_RUN_CONTENT_KIND,
  askContent,
  askFor,
  webThreadTitle,
  type AskAttachment,
  type WebThreadRunRecord,
} from '../../domain/channel/web-thread';
import { asChatId, asCorrelationId, asDepartmentId, asMessageId } from '../../shared/ids';
import { createRunTimelineReducer } from '../channels/run-timeline.reducer';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { DepartmentRepoPort } from '../../infrastructure/persistence/department.repository';
import type {
  LarkPiRuntimeAttachment,
  LarkPiRuntimeService,
} from './lark-pi-runtime.service';
import { LarkPiRuntimeError } from './lark-pi-runtime.service';
import type { RunOrigin, RunOriginStore } from '../connections/run-origin.store';
import { createLiveAnswerPublisher } from './live-answer-publisher';
import type { RuntimeModelSelection } from '../observability/pricing';
import type { ConversationVideoService } from '../conversation-video/conversation-video.service';
import { askNoticeFor, fenced } from '../video-understanding/video-understanding.precis';

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
  /**
   * A document is ready to read beside the thread.
   *
   * Carries the address, never the body: the reader may already have this
   * version open, and re-sending a long report on every revision would put a
   * document-sized payload on a stream built for sentences.
   */
  | {
      readonly type: 'artifact';
      readonly artifactId: string;
      readonly title: string;
      readonly mime: string;
      readonly version: number;
    }
  /** The answer. Terminal. */
  | {
      readonly type: 'final';
      readonly text: string;
      readonly actions?: readonly InteractiveAction[];
      readonly timeline: ChannelTimeline;
    }
  /**
   * Divo is still taking in a video that came with the ask.
   *
   * Its own event rather than a timeline step, because it happens before the
   * run has a timeline: the reading has to finish before the model can be asked
   * anything about it. Sent repeatedly as the reading advances, so the wait
   * reads as work rather than as a stall.
   */
  | {
      readonly type: 'watching';
      readonly fileName: string;
      readonly percent: number;
      readonly step: 'watching' | 'transcribing' | 'reading_screens' | 'ready';
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
  /**
   * Videos uploaded to this thread ahead of the ask, which the run waits for.
   *
   * Ids rather than content: the recording is already on the server and being
   * read, and what the run needs back is the reading.
   */
  readonly videoIds?: readonly string[];
  /**
   * The ask as the person made it: their own words, and every file they handed
   * over named with what became of it.
   *
   * `text` above is what the model reads — transcripts and refusals folded in
   * ahead of the question. This is what the thread shows back, which is not the
   * same string and must not be allowed to become it.
   */
  readonly ask?: {
    readonly text: string;
    readonly attachments: readonly AskAttachment[];
  };
  /** The exact model/effort pair selected in the web composer. */
  readonly modelSelection?: RuntimeModelSelection;
  readonly abortSignal?: AbortSignal;
}

export interface WebRunServiceDeps {
  readonly piRuntime: Pick<LarkPiRuntimeService, 'run'>;
  readonly logger: Logger;
  /**
   * Reads the videos an ask arrived with.
   *
   * Optional: without it a run carrying video ids says so in the ask rather
   * than failing, which is the same bargain the transcriber strikes for audio.
   */
  readonly videos?: Pick<ConversationVideoService, 'understandingFor' | 'progressFor' | 'recordFor'>;
  /** Resolves the same backend-owned active department used by Lark turns. */
  readonly identity?: Pick<ChannelIdentityRepoPort, 'resolveByUserId'>;
  /** Rejects a stale preference before it can be minted into a runtime lease. */
  readonly departments?: Pick<DepartmentRepoPort, 'getMembership'>;
  /** Keeps enough of a web turn to replay it after deferred OAuth. */
  readonly runOrigins?: Pick<RunOriginStore, 'remember'>;
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

/** How often the watcher redraws while a reading runs. */
const WATCH_POLL_MS = 700;

export class WebRunService {
  constructor(private readonly deps: WebRunServiceDeps) {}

  /**
   * Take in every video the ask arrived with, out loud.
   *
   * Yields as it goes so the member sees a recording being read rather than a
   * thread that has gone quiet — the whole reason D4 chose to make the run wait
   * instead of answering first and fetching later.
   *
   * A video that cannot be read does not fail the turn. The person asked a
   * question and attached a recording to it; refusing the question because the
   * recording was unreadable throws away the half that still works. The model
   * is told, by name, that it has nothing to look at, exactly as it is for an
   * audio file that could not be heard.
   */
  private async *watch(
    input: WebRunInput,
    log: Logger,
  ): AsyncGenerator<WebRunEvent, { readonly notice: string }[]> {
    if (input.abortSignal?.aborted) return [];
    const videoIds = input.videoIds ?? [];
    if (videoIds.length === 0) return [];
    if (!this.deps.videos) {
      return videoIds.map(() => ({
        notice: '[Video attached — NOT WATCHED. Divo cannot read video in this deployment. '
          + 'Tell the user plainly and do not guess at the contents.]',
      }));
    }

    const owner = {
      companyId: String(input.runContext.companyId),
      userId: input.userExternalId,
      channel: 'web',
      threadId: input.threadId,
    };
    const watched: { notice: string }[] = [];

    for (const videoId of videoIds) {
      let fileName: string;
      try {
        fileName = (await this.deps.videos.recordFor({ owner, videoId })).fileName;
      } catch {
        // An id that names nothing in this conversation is not an error worth
        // failing a question over — but it must never pass silently, or the
        // model answers as though it had watched something.
        log.warn('web_run.video.unknown', { videoId });
        watched.push({
          notice: '[Video attached — NOT WATCHED. Divo could not find that recording in this '
            + 'conversation. Tell the user plainly and ask them to attach it again.]',
        });
        continue;
      }
      const reading = this.deps.videos.understandingFor({
        owner,
        videoId,
        ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      });
      let settled = false;
      // Attached before the poll loop so a rejection can never be unhandled,
      // and swallowed here because the loop below re-awaits the same promise
      // for the real outcome.
      const finished = reading.then(() => { settled = true; }, () => { settled = true; });

      yield { type: 'watching', fileName, percent: 0, step: 'watching' };
      while (!settled && !input.abortSignal?.aborted) {
        await Promise.race([finished, delay(WATCH_POLL_MS)]);
        const progress = this.deps.videos.progressFor(videoId);
        if (progress && !settled) {
          yield { type: 'watching', fileName, percent: progress.percent, step: progress.step };
        }
      }

      try {
        const understanding = await reading;
        yield { type: 'watching', fileName, percent: 100, step: 'ready' };
        watched.push({
          notice: askNoticeFor({ fileName, understanding, question: input.text }),
        });
      } catch (error) {
        /* A stop is not a failure to read. Both arrive here as a rejection, and
           telling them apart matters because this notice is persisted as the
           member's own turn: recording "could not be read" for a reading that
           was merely abandoned would have Divo tell them, for the rest of the
           thread, that a perfectly good recording was corrupt. */
        /* Terminal either way. Only a `ready` frame clears the watcher — in the
           browser and in the registry's replay — so a reading that ended
           without one leaves "reading screens · 40%" shimmering over the whole
           model turn, and over the answer that follows it. */
        yield { type: 'watching', fileName, percent: 100, step: 'ready' };
        if (input.abortSignal?.aborted) return watched;
        log.warn('web_run.video.unreadable', {
          videoId,
          error: error instanceof Error ? error.message : String(error),
        });
        watched.push({
          // Fenced for the same reason the watched notice fences it: the name
          // comes from a header the uploader controls, and a `]` in it would
          // close the block that marks everything inside untrusted.
          notice: `[Video: "${fenced(fileName)}" — NOT WATCHED. Divo could not read this `
            + `recording. Tell the user plainly that it could not be read and ask them to `
            + `try again; never answer from the file name.]`,
        });
      }
    }
    return watched;
  }

  /**
   * Run one turn, yielding events as they happen.
   *
   * An async generator rather than a callback so the HTTP layer owns the
   * transport: the same stream can become SSE today and something else later
   * without this service knowing which.
   */
  async *run(input: WebRunInput): AsyncGenerator<WebRunEvent> {
    const log = this.deps.logger.child({ service: 'web-run' });
    // Before anything else, and deliberately: the model cannot be asked about a
    // recording that has not been read yet, so the reading is the first thing
    // that happens and the member watches it happen.
    const runId = randomUUID();
    const startedAtMs = Date.now();
    const watched = yield* this.watch(input, log);
    const askText = watched.length > 0
      ? [...watched.map(entry => entry.notice), input.text].filter(Boolean).join('\n\n')
      : input.text;
    // Stopping during the reading means stopping, not "stop once the video is
    // done" — otherwise the run spends a model turn on a question the member
    // already withdrew. The turn is still written down, because every other
    // stop path writes one: a thread that loses the question as well as the
    // answer leaves the reader no evidence they ever asked.
    if (input.abortSignal?.aborted) {
      const message = 'Stopped before Divo finished watching.';
      await this.recordFailure(input, runId, { code: 'cancelled', message }, [], startedAtMs, askText);
      yield { type: 'error', code: 'cancelled', message };
      return;
    }
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
      text: askText,
      userExternalId: input.userExternalId,
      timestamp: new Date(startedAtMs).toISOString(),
    });
    if (this.deps.runOrigins) {
      const origin: RunOrigin = {
        version: 1,
        channel: 'web',
        companyId: String(runContext.companyId),
        userId: String(runContext.userId),
        originalRequest: askText,
        conversationKey: input.threadId,
        web: {
          threadId: input.threadId,
          userExternalId: input.userExternalId,
          timestamp: incoming.timestamp,
        },
      };
      try {
        const remembered = await this.deps.runOrigins.remember(runId, origin);
        if (!remembered) {
          log.warn('web_run.origin_not_retained', {
            runId,
            reason: 'request_too_long',
          });
        }
      } catch (error) {
        log.warn('web_run.origin_write_failed', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.ask ? { ask: input.ask } : {}),
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
        // A finished document, forwarded as itself rather than folded into the
        // timeline. It is the one frame here that is not about how the run is
        // going: it says a deliverable now exists and can be opened, and the
        // panel that opens it has no business reading the work log to find out.
        if (event.type === 'artifact') {
          push({
            type: 'artifact',
            artifactId: event.artifactId,
            title: event.title,
            mime: event.mime,
            version: event.version,
          });
          return;
        }
        // Text before a tool call was an aside, not the terminal answer, and the
        // live answer lane has to give it up so the next assistant turn starts
        // from an honest blank.
        //
        // The timeline goes first, and the order is the whole point: the same
        // prose is on screen twice over — as the reply, and as the `say` rows
        // the reducer has just marked `aside`. Resetting the lane first would
        // take it out of the reply before the log had claimed it, and the reader
        // would watch a sentence they were mid-way through vanish from the page
        // entirely. This way it is filed into the log and then released, which
        // is the direction it actually travelled.
        const settlesAside = event.type === 'tool_start' && answerStarted;
        publishTimeline(timeline.apply(event) === 'immediate');
        if (settlesAside) {
          answerStarted = false;
          liveAnswer.reset();
        }
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
      await this.recordFailure(
        input, runId, { code, message }, timeline.timeline().ledger ?? [], startedAtMs, askText,
      );
      yield { type: 'error', message, code };
      return;
    }

    if (done.result.protectedDataUsed === true) timeline.observedProtectedData();

    yield {
      type: 'final',
      text: done.result.text,
      ...(done.result.actions?.length ? { actions: done.result.actions } : {}),
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
    /* What the model was given, not what the person typed — the same string the
       runtime would have persisted had the run reached it. */
    askText: string,
  ): Promise<void> {
    if (!this.deps.transcript) return;
    const scope = { companyId: String(input.runContext.companyId), channel: 'web' };
    try {
      /* The same turn the runtime would have written, files included — a run
         that failed is the case where the reader most needs their own message
         back intact, since there is no answer to read it against. */
      /* Compared against what was *stored*, not against what the person typed.
         `askFor` returns nothing when the two are equal and no file came with
         the ask — and for a video-only message the multipart text is unchanged,
         so comparing against `input.text` dropped the reader's copy and left the
         thread showing the whole evidence block back as their own words. */
      const readerAsk = askFor(input.ask, askText);
      await this.deps.transcript.appendTurn(
        input.threadId,
        { role: 'user', content: askText, timestamp: new Date(startedAtMs).toISOString() },
        scope,
        {
          dedupeKey: `web:${runId}:user`,
          sourceRunId: runId,
          ...(readerAsk ? { contentJson: askContent(readerAsk) } : {}),
          conversationDefaults: {
            createdByUserId: String(input.runContext.userId),
            ...(input.runContext.requesterEmail ? { createdByEmail: input.runContext.requesterEmail } : {}),
            title: webThreadTitle(input.ask?.text.trim() || input.text),
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
export function webIncomingMessage(input: {
  readonly runId: string;
  readonly threadId: string;
  readonly text: string;
  readonly userExternalId: string;
  readonly timestamp: string;
}): IncomingMessage {
  return {
    channel: 'web',
    messageId: asMessageId(input.runId),
    chatId: asChatId(input.threadId),
    chatType: 'p2p',
    userExternalId: input.userExternalId,
    text: input.text,
    attachments: [],
    timestamp: input.timestamp,
    traceId: asCorrelationId(input.runId),
    // Addressing Divo directly is the only way to reach it here, so the turn is
    // always meant for it and never mentions anybody else.
    mentions: [],
    mentionsSelf: true,
    raw: null,
  };
}

/** A promise that settles after `ms`, used to pace the watcher's redraws. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}
