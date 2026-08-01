import type { PrismaClient } from '../../generated/prisma';
import { SCHEDULED_SESSION_AUTH_PROVIDER } from '../scheduling/scheduled-runtime-session';
import type { Logger } from '../../shared/logger';
import type { ConversationHandle } from '../channels/channel.adapter';
import type { IncomingMessage } from '../../domain/channel/incoming-message';
import type { RunContext } from '../../domain/orchestration/run-context';
import { issuePiRuntimeLease } from './pi-runtime-lease';
import {
  providerOf,
  type ProxyModel,
} from '../observability/pricing';
import {
  renderContextBlock,
  type GroupContextBlock,
} from '../chat-context/group-context.hydrator';

const MAX_RUNTIME_ATTACHMENTS = 4;
const LARK_RUNTIME_MODEL: ProxyModel = 'deepseek-v4-flash';

function asyncIterableBody(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

export interface LarkPiRuntimeAttachment {
  readonly kind: 'file' | 'image';
  readonly name: string;
  readonly mimeType: string;
  readonly openStream: () => Promise<AsyncIterable<Uint8Array>>;
}

/**
 * Where the Pi session for this run lives.
 *
 * `thread` keeps the durable per-thread session on the user's volume: a DM has
 * one participant, so that session is the conversation and resuming it is what
 * gives continuity.
 *
 * `run` gives the run a session that is discarded when it ends. A group thread
 * has several participants in separate containers, so its conversation is held
 * centrally and handed to each run instead. Persisting it as well would write
 * the same transcript into that user's session on every turn, and each turn
 * would then replay every earlier copy.
 */
export type PiSessionScope = 'thread' | 'run';

export interface LarkPiRuntimeInput {
  readonly incoming: IncomingMessage;
  readonly runContext: RunContext;
  readonly conversation: ConversationHandle;
  readonly threadId: string;
  readonly attachments?: readonly LarkPiRuntimeAttachment[];
  /**
   * Shared conversation the run must read before answering — the room
   * transcript for a group thread. Sent ahead of the ask, never persisted.
   *
   * Structured rather than flat so that shrinking it to fit the request cannot
   * cost the framing that makes it safe to read: the label, the fence rules and
   * the trust policy are re-emitted at every size.
   */
  readonly sharedContext?: GroupContextBlock;
  /** Defaults to `thread`, the durable session, when the caller says nothing. */
  readonly sessionScope?: PiSessionScope;
  /**
   * The session this run must act under, when the caller issued one for it.
   *
   * A scheduled run mints its own machine session, and the run has to carry
   * that one specifically: tools decide whether the runtime owns delivery by
   * looking at how the session was issued, and picking up the member's ordinary
   * sign-in instead would make a scheduled run indistinguishable from the person
   * typing. Session lookup otherwise prefers a real sign-in, so without this the
   * machine row is passed over whenever the member has signed in recently.
   */
  readonly sessionId?: string;
  readonly abortSignal?: AbortSignal;
  readonly onProgress?: (event: LarkPiProgressEvent) => Promise<void> | void;
}

/** A step's status, in the vocabulary the status card renders. */
export type LarkPiStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** One subagent working under a tool call. */
export interface LarkPiProgressChild {
  readonly label: string;
  readonly status: LarkPiStepStatus;
  readonly detail?: string;
}

/** One line of the checklist the run declared. */
export interface LarkPiProgressTodo {
  readonly title: string;
  readonly status: LarkPiStepStatus;
}

/**
 * What a tool reported about the work underneath it. Both arrive as tool
 * details from the container, so they travel on the same events rather than
 * each earning a channel of its own.
 */
interface LarkPiProgressDetail {
  readonly children?: readonly LarkPiProgressChild[];
  readonly todos?: readonly LarkPiProgressTodo[];
  /** What the call turned out to be — a skill's name, known only on the way out. */
  readonly detail?: string;
}

export type LarkPiProgressEvent =
  | {
      readonly type: 'starting';
      readonly stage: 'workspace' | 'container';
      readonly label: string;
    }
  | { readonly type: 'ready' | 'thinking' | 'working' | 'writing' }
  /** A whole sentence the model finished saying between its tool calls. */
  | { readonly type: 'say'; readonly index: number; readonly text: string }
  | {
      readonly type: 'tool_start';
      readonly callId: string;
      readonly toolName: string;
      readonly toolId?: string;
      /** What this call is about, from the argument that names the work. */
      readonly detail?: string;
    }
  | ({
      readonly type: 'tool_progress';
      readonly callId: string;
      readonly toolName: string;
    } & LarkPiProgressDetail)
  | ({
      readonly type: 'tool_end';
      readonly callId: string;
      readonly toolName: string;
      readonly isError: boolean;
    } & LarkPiProgressDetail);

export class LarkPiRuntimeError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
    message = userMessage,
  ) {
    super(message);
    this.name = 'LarkPiRuntimeError';
  }
}

export interface LarkPiRuntimeServiceDeps {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
  readonly memberJwtSecret: string;
  readonly backendUrl: string;
  readonly controllerUrl: string;
  readonly instanceId: string;
  readonly leaseTtlSeconds: number;
  readonly runTimeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The controller refuses a request body over this size, and refusing fails the
 * whole turn. Mirrors `MAX_BODY_BYTES` in divo-pi/divo/local-rpc-server.mjs.
 */
const CONTROLLER_MAX_BODY_BYTES = 64 * 1024;

/**
 * Room left for everything that is not the shared conversation: the lease, the
 * staged attachment descriptors, the JSON envelope, and the escaping
 * `JSON.stringify` adds. Measured rather than guessed — see `fitBodyToController`.
 */
const BODY_SAFETY_MARGIN_BYTES = 2 * 1024;

/**
 * The shared conversation first, the ask last.
 *
 * The controller prepends the attachment manifest to whatever it is given, so
 * the run reads its files, then the room, then the request it must answer —
 * leaving the current message closest to the response.
 */
function composeRuntimeMessage(
  ask: string | undefined,
  sharedContext: string | undefined,
): string | undefined {
  if (!sharedContext?.trim()) return ask;
  return ask ? `${sharedContext}\n\n${ask}` : sharedContext;
}

/**
 * Shrink the shared conversation until the body fits, never the ask.
 *
 * The ask is what the user actually typed and the room is only context for it,
 * so when a long message leaves no space the context yields. Before this the
 * whole budget belonged to the ask; a fixed context allowance would have turned
 * messages that used to be answered into `request_too_large`, which fails the
 * turn outright with no retry that could succeed.
 *
 * Measured on the serialized body rather than the raw strings, because escaping
 * newlines and quotes inflates it by an amount no constant can predict.
 */
export function fitBodyToController<T extends Record<string, unknown>>(
  build: (message: string | undefined) => T,
  ask: string | undefined,
  sharedContext: GroupContextBlock | undefined,
  maxBytes: number = CONTROLLER_MAX_BODY_BYTES,
): { body: T; requestedContextBytes: number; sentContextBytes: number } {
  const requested = sharedContext ? renderContextBlock(sharedContext) : '';
  const requestedContextBytes = Buffer.byteLength(requested, 'utf8');
  const sent = (context: string, body: T) => ({
    body,
    requestedContextBytes,
    sentContextBytes: context ? Buffer.byteLength(context, 'utf8') : 0,
  });

  let allowance = requestedContextBytes;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    // Re-rendered at each size rather than sliced, so a shrunk block keeps its
    // label, its fence rules and its trust policy and loses only transcript.
    const context = sharedContext && allowance > 0
      ? renderContextBlock(sharedContext, allowance)
      : '';
    const body = build(composeRuntimeMessage(ask, context));
    const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (size <= maxBytes || !context) return sent(context, body);

    const room = allowance - (size - maxBytes) - BODY_SAFETY_MARGIN_BYTES;
    // Escaping can inflate a body far past what trimming by the overflow would
    // recover — a participant typing control characters costs six serialized
    // bytes each. Halving rather than giving up keeps that from throwing away a
    // whole transcript when a fraction of it would have fit.
    allowance = room > 0 ? room : Math.floor(allowance / 2);
    // Below the framing there is nothing left worth sending: `renderContextBlock`
    // would return the rules with no transcript under them.
    if (allowance < Buffer.byteLength(sharedContext?.frame ?? '', 'utf8')) break;
  }
  // Sending the ask alone still beats a refused request: it can be answered
  // without the room, but not at all if the controller rejects the body.
  return sent('', build(ask));
}

/**
 * Tell the run about the files it was not given.
 *
 * Written as an instruction rather than a fixed sentence so the shortfall is
 * folded into whatever else the answer says, in Divo's own voice. The naming
 * matters: "I could only open the first four" is actionable, while an answer
 * built from four of six pictures with no mention of the other two is wrong in
 * a way the user cannot see.
 */
export function droppedAttachmentNotice(
  dropped: readonly LarkPiRuntimeAttachment[],
  ask: string | undefined,
): string | undefined {
  if (dropped.length === 0) return ask;
  const names = dropped.map(attachment => `"${attachment.name}"`).join(', ');
  const notice = `[Not saved: ${names}. Only the first ${MAX_RUNTIME_ATTACHMENTS} files in a message are saved to your workspace.\n`
    + 'Answer from the ones you have, then tell the user in your own words which files you could not open '
    + 'and ask them to send those in a separate message. '
    + 'Do not guess at their contents, and do not claim to have read them.]';
  return ask?.trim() ? `${notice}\n\n${ask}` : notice;
}

export class LarkPiRuntimeService {
  private readonly log: Logger;

  constructor(private readonly deps: LarkPiRuntimeServiceDeps) {
    this.log = deps.logger.child({ service: 'lark-pi-runtime' });
  }

  private findActiveSession(
    runContext: LarkPiRuntimeInput['runContext'],
    sessionId?: string,
  ) {
    if (!runContext.tenantId || !runContext.userExternalId) {
      return null;
    }
    const minimumSessionExpiry = new Date(Date.now() + 5 * 60_000);
    // A caller that issued a session for this run gets that one, not whichever
    // is newest. The preference below exists for interactive turns and would
    // otherwise hand a scheduled run the member's own sign-in.
    if (sessionId) {
      return this.deps.prisma.memberSession.findFirst({
        where: {
          sessionId,
          userId: String(runContext.userId),
          companyId: String(runContext.companyId),
          revokedAt: null,
          expiresAt: { gt: minimumSessionExpiry },
        },
        select: { sessionId: true, expiresAt: true },
      });
    }
    // A scheduled run mints its own session and revokes it when the run ends.
    // That row is the newest for the member, so a plain "latest session" lookup
    // would hand it to an interactive turn arriving mid-run — which the
    // scheduler then revokes underneath it. Prefer a real sign-in, and fall
    // back to a machine row only when there is none, which is precisely the
    // scheduled run looking up its own.
    // Deliberately not filtered by `channel`. The security binding is the pair
    // below — this Lark tenant plus this Lark open id resolve to this User, and
    // that is what proves the person in the chat is the account. `channel` only
    // records which surface happened to create the row, and pinning it here is
    // what used to force Lark to mint sessions of its own. A web sign-in via
    // Lark OAuth stamps the same identity, so it is equally valid for this run.
    const where = {
      userId: String(runContext.userId),
      companyId: String(runContext.companyId),
      larkTenantKey: String(runContext.tenantId),
      larkOpenId: String(runContext.userExternalId),
      revokedAt: null,
      expiresAt: { gt: minimumSessionExpiry },
    };
    return this.deps.prisma.memberSession.findFirst({
      where: { ...where, authProvider: { not: SCHEDULED_SESSION_AUTH_PROVIDER } },
      orderBy: { createdAt: 'desc' },
      select: { sessionId: true, expiresAt: true },
    }).then(human => human ?? this.deps.prisma.memberSession.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
      select: { sessionId: true, expiresAt: true },
    }));
  }

  async hasActiveSession(
    runContext: LarkPiRuntimeInput['runContext'],
  ): Promise<boolean> {
    return Boolean(await this.findActiveSession(runContext));
  }

  /**
   * Lark is intentionally pinned independently of member proxy grants. Grants
   * authorize proxy use; they do not choose the channel's runtime model.
   */
  async modelFor(_userId: string): Promise<ProxyModel> {
    return LARK_RUNTIME_MODEL;
  }

  async run(input: LarkPiRuntimeInput): Promise<{ text: string }> {
    const session = await this.findActiveSession(input.runContext, input.sessionId);
    if (!session) {
      throw new LarkPiRuntimeError(
        'runtime_session_missing',
        'Your Divo cloud session is not active. Please sign in to Divo again, then retry.',
      );
    }

    const remainingSeconds = Math.floor((session.expiresAt.getTime() - Date.now()) / 1_000);
    const runtimeLease = issuePiRuntimeLease({
      sessionId: session.sessionId,
      userId: String(input.runContext.userId),
      companyId: String(input.runContext.companyId),
      role: String(input.runContext.companyRole),
      instanceId: this.deps.instanceId,
      threadId: input.threadId,
      // Carried so the container acts in the department the run was launched
      // for, instead of defaulting to the member's first one.
      ...(input.runContext.departmentId
        ? { departmentId: String(input.runContext.departmentId) }
        : {}),
      ttlSeconds: Math.min(this.deps.leaseTtlSeconds, remainingSeconds),
    }, this.deps.memberJwtSecret);

    const timeoutSignal = AbortSignal.timeout(this.deps.runTimeoutMs);
    const signal = input.abortSignal
      ? AbortSignal.any([input.abortSignal, timeoutSignal])
      : timeoutSignal;
    // Sending five screenshots at once is an ordinary thing to do, and refusing
    // the whole turn for it answered nothing at all. Stage what fits, and name
    // the rest in the prompt so the run says which files it did not open rather
    // than quietly working from a subset.
    const offered = input.attachments ?? [];
    const attachments = offered.slice(0, MAX_RUNTIME_ATTACHMENTS);
    const dropped = offered.slice(MAX_RUNTIME_ATTACHMENTS);
    if (dropped.length > 0) {
      this.log.warn('pi.attachments.truncated', {
        offered: offered.length,
        staged: attachments.length,
        correlationId: input.incoming.traceId,
      });
    }

    let response: Response;
    try {
      const stagedAttachments = await this.stageAttachments(
        attachments,
        runtimeLease,
        signal,
      );
      const model = await this.modelFor(String(input.runContext.userId));
      const ask = droppedAttachmentNotice(dropped, input.incoming.text);
      const fitted = fitBodyToController(
        message => ({
          backendUrl: this.deps.backendUrl,
          runtimeLease,
          message,
          model,
          provider: providerOf(model),
          ...(input.sessionScope ? { sessionScope: input.sessionScope } : {}),
          ...(stagedAttachments.length > 0 ? { attachments: stagedAttachments } : {}),
        }),
        ask,
        input.sharedContext,
      );
      // Losing shared context is silent from the outside: the run answers, just
      // without knowing what the room said. Logged so a group thread that stops
      // receiving it is visible rather than a mystery.
      if (fitted.sentContextBytes < fitted.requestedContextBytes) {
        this.log.warn('pi.shared_context.trimmed', {
          correlationId: input.incoming.traceId,
          requestedBytes: fitted.requestedContextBytes,
          sentBytes: fitted.sentContextBytes,
        });
      }
      response = await (this.deps.fetch ?? globalThis.fetch)(
        `${this.deps.controllerUrl.replace(/\/+$/, '')}/v1/lark-runs`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/x-ndjson, application/json',
          },
          body: JSON.stringify(fitted.body),
          signal,
        },
      );
    } catch (error) {
      if (input.abortSignal?.aborted) {
        throw new DOMException('The Pi run was interrupted.', 'AbortError');
      }
      // Staging already decided what the user should be told — that a file is
      // too large, or could not be opened. Rewrapping it as
      // `controller_unreachable` would replace a fixable instruction with a
      // dead end.
      if (error instanceof LarkPiRuntimeError) throw error;
      this.log.error('pi.controller.unreachable', {
        error: String(error),
        correlationId: input.incoming.traceId,
      });
      throw new LarkPiRuntimeError(
        'controller_unreachable',
        'Pi could not start this request (controller_unreachable). No fallback agent was run.',
        String(error),
      );
    }

    if (response.headers.get('content-type')?.includes('application/x-ndjson')) {
      return this.readStream(response, input);
    }

    const body = await response.json().catch(() => null) as {
      text?: unknown;
      error?: { code?: unknown; message?: unknown };
    } | null;
    if (!response.ok) {
      const code = typeof body?.error?.code === 'string'
        ? body.error.code
        : `controller_http_${response.status}`;
      const controllerMessage = typeof body?.error?.message === 'string'
        ? body.error.message
        : undefined;
      const userMessage = code === 'capacity_full' || code === 'user_busy'
        ? controllerMessage ?? 'Your Pi agent is busy. Please try again shortly.'
        : `Pi could not complete this request (${code}). No fallback agent was run.`;
      throw new LarkPiRuntimeError(code, userMessage, controllerMessage);
    }
    if (typeof body?.text !== 'string' || !body.text.trim()) {
      throw new LarkPiRuntimeError(
        'empty_runtime_response',
        'Pi completed without a usable answer (empty_runtime_response). No fallback agent was run.',
      );
    }
    return { text: body.text.trim() };
  }

  private async stageAttachments(
    attachments: readonly LarkPiRuntimeAttachment[],
    runtimeLease: string,
    signal: AbortSignal,
  ): Promise<unknown[]> {
    if (attachments.length === 0) return [];

    const requestId = crypto.randomUUID();
    const staged: unknown[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const stream = await attachment.openStream();
      const body = asyncIterableBody(stream);
      const response = await (this.deps.fetch ?? globalThis.fetch)(
        `${this.deps.controllerUrl.replace(/\/+$/, '')}/v1/runtime-files`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${runtimeLease}`,
            'content-type': attachment.mimeType || 'application/octet-stream',
            'x-divo-backend-url': this.deps.backendUrl,
            'x-divo-request-id': requestId,
            'x-divo-file-id': `file-${index + 1}`,
            'x-divo-file-kind': attachment.kind,
            'x-divo-file-name': Buffer.from(attachment.name, 'utf8').toString('base64url'),
          },
          body,
          signal,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' },
      );
      const value = await response.json().catch(() => null) as {
        attachment?: unknown;
        error?: { code?: unknown; message?: unknown };
      } | null;
      if (!response.ok || !value?.attachment) {
        const code = typeof value?.error?.code === 'string'
          ? value.error.code
          : `controller_http_${response.status}`;
        const detail = typeof value?.error?.message === 'string'
          ? value.error.message
          : undefined;
        throw new LarkPiRuntimeError(
          code,
          `Divo could not securely open "${attachment.name}" (${code}).`,
          detail,
        );
      }
      staged.push(value.attachment);
    }
    return staged;
  }

  private async readStream(
    response: Response,
    input: LarkPiRuntimeInput,
  ): Promise<{ text: string }> {
    if (!response.body) {
      throw new LarkPiRuntimeError(
        'empty_controller_stream',
        'Pi completed without a usable answer (empty_controller_stream). No fallback agent was run.',
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let streamError: { code: string; message?: string } | undefined;

    const consume = async (line: string): Promise<void> => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        throw new LarkPiRuntimeError(
          'invalid_controller_stream',
          'Pi could not complete this request (invalid_controller_stream). No fallback agent was run.',
        );
      }
      if (!event || typeof event !== 'object') return;
      const record = event as Record<string, unknown>;
      if (record['type'] === 'heartbeat') return;
      if (record['type'] === 'progress') {
        const progress = parseProgressEvent(record['progress']);
        if (progress && input.onProgress) {
          try {
            await input.onProgress(progress);
          } catch (error) {
            this.log.warn('pi.progress.delivery_failed', {
              error: String(error),
              correlationId: input.incoming.traceId,
              progressType: progress.type,
            });
          }
        }
        return;
      }
      if (record['type'] === 'result' && typeof record['text'] === 'string') {
        text = record['text'].trim();
        return;
      }
      const error = record['error'];
      if (record['type'] === 'error' && error && typeof error === 'object') {
        const value = error as Record<string, unknown>;
        streamError = {
          code: typeof value['code'] === 'string' ? value['code'] : 'run_failed',
          ...(typeof value['message'] === 'string' ? { message: value['message'] } : {}),
        };
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) await consume(line);
      if (done) break;
    }
    await consume(buffer);

    if (streamError) {
      const userMessage = streamError.code === 'capacity_full' || streamError.code === 'user_busy'
        ? streamError.message ?? 'Your Pi agent is busy. Please try again shortly.'
        : `Pi could not complete this request (${streamError.code}). No fallback agent was run.`;
      throw new LarkPiRuntimeError(streamError.code, userMessage, streamError.message);
    }
    if (!text) {
      throw new LarkPiRuntimeError(
        'empty_runtime_response',
        'Pi completed without a usable answer (empty_runtime_response). No fallback agent was run.',
      );
    }
    return { text };
  }
}

function safeProgressString(value: unknown, maxLength = 120): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

const STEP_STATUSES: ReadonlySet<string> = new Set([
  'pending', 'running', 'done', 'failed', 'skipped',
]);

const MAX_PROGRESS_CHILDREN = 8;
const MAX_PROGRESS_TODOS = 12;

function safeStepStatus(value: unknown, fallback: LarkPiStepStatus): LarkPiStepStatus {
  return typeof value === 'string' && STEP_STATUSES.has(value)
    ? value as LarkPiStepStatus
    : fallback;
}

/**
 * The container is trusted to run the user's work, not to decide what the
 * status card says, so its detail arrays are re-validated and capped here the
 * same way every other field crossing this boundary is.
 */
function safeProgressDetail(event: Record<string, unknown>): LarkPiProgressDetail {
  const rawChildren = event['children'];
  const children = Array.isArray(rawChildren)
    ? rawChildren.slice(0, MAX_PROGRESS_CHILDREN).flatMap((entry): LarkPiProgressChild[] => {
        const row = entry as Record<string, unknown> | null;
        const label = safeProgressString(row?.['label'], 80);
        if (!label) return [];
        const detail = safeProgressString(row?.['detail'], 80);
        return [{
          label,
          status: safeStepStatus(row?.['status'], 'running'),
          ...(detail ? { detail } : {}),
        }];
      })
    : [];

  const rawTodos = event['todos'];
  const todos = Array.isArray(rawTodos)
    ? rawTodos.slice(0, MAX_PROGRESS_TODOS).flatMap((entry): LarkPiProgressTodo[] => {
        const row = entry as Record<string, unknown> | null;
        const title = safeProgressString(row?.['title'], 80);
        if (!title) return [];
        return [{ title, status: safeStepStatus(row?.['status'], 'pending') }];
      })
    : [];

  const detail = safeProgressString(event['detail'], 64);

  return {
    ...(children.length > 0 ? { children } : {}),
    ...(todos.length > 0 ? { todos } : {}),
    ...(detail ? { detail } : {}),
  };
}

function parseProgressEvent(value: unknown): LarkPiProgressEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as Record<string, unknown>;
  const type = event['type'];
  if (type === 'ready' || type === 'thinking' || type === 'working' || type === 'writing') return { type };
  if (type === 'starting') {
    const stage = event['stage'];
    const label = safeProgressString(event['label']);
    if ((stage === 'workspace' || stage === 'container') && label) {
      return { type, stage, label };
    }
    return undefined;
  }
  // Free text the model wrote, so it is capped and flattened here the same way
  // every other string crossing this boundary is — the container is trusted to
  // run the work, not to decide how much of a chat card it may occupy.
  if (type === 'say') {
    const text = safeProgressString(event['text'], 200);
    if (!text) return undefined;
    const rawIndex = event['index'];
    return {
      type,
      index: typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0
        ? rawIndex
        : 0,
      text,
    };
  }
  if (type === 'tool_start') {
    const callId = safeProgressString(event['callId'], 100);
    const toolName = safeProgressString(event['toolName'], 80);
    const toolId = safeProgressString(event['toolId'], 80);
    const detail = safeProgressString(event['detail'], 64);
    if (!callId || !toolName) return undefined;
    return {
      type, callId, toolName,
      ...(toolId ? { toolId } : {}),
      ...(detail ? { detail } : {}),
    };
  }
  if (type === 'tool_progress') {
    const callId = safeProgressString(event['callId'], 100);
    const toolName = safeProgressString(event['toolName'], 80);
    if (!callId || !toolName) return undefined;
    const detail = safeProgressDetail(event);
    // A progress event with nothing to show is a redraw for no reason.
    if (!detail.children && !detail.todos && !detail.detail) return undefined;
    return { type, callId, toolName, ...detail };
  }
  if (type === 'tool_end') {
    const callId = safeProgressString(event['callId'], 100);
    const toolName = safeProgressString(event['toolName'], 80);
    if (!callId || !toolName) return undefined;
    return {
      type, callId, toolName,
      isError: event['isError'] === true,
      ...safeProgressDetail(event),
    };
  }
  return undefined;
}
