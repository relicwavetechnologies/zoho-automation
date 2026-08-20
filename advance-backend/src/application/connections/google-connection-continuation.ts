import { Queue, Worker, type Job } from 'bullmq';
import type { ConversationHandle } from '../channels/channel.adapter';
import type { LaneLeaseHolder } from '../channels/lane-lease.holder';
import type { IncomingMessage } from '../../domain/channel/incoming-message';
import type { RunContext } from '../../domain/orchestration/run-context';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import { buildFinalCard } from '../../infrastructure/channels/lark/lark-card.builder';
import { fenceFinalReplies } from '../../infrastructure/channels/lark/lark-lane-fence';
import { buildLarkIngressLaneKey } from '../../infrastructure/channels/lark/lark-routing';
import type {
  ConnectionSummary,
  IntegrationConnectionRepository,
} from '../../infrastructure/persistence/integration-connection.repository';
import type {
  ConnectionAuthorizationRepository,
  ConnectionContinuationClaim,
} from '../../infrastructure/persistence/connection-authorization.repository';
import {
  isWebConnectionAuthorization,
} from './connection-authorization-intent';
import type { RunOriginStore } from './run-origin.store';
import {
  asChatId,
  asCompanyId,
  asCorrelationId,
  asDepartmentId,
  asMessageId,
  asUserId,
} from '../../shared/ids';
import type { Logger } from '../../shared/logger';
import { googleScopeGroupsForToolIds } from '../google/google-scope-request';

export const GOOGLE_CONNECTION_CONTINUATION_QUEUE_NAME =
  'google-connection-continuation';

export interface GoogleConnectionContinuationJob {
  intentId: string;
}

type ContinuationQueueClient = Pick<
  Queue<GoogleConnectionContinuationJob>,
  'add' | 'getJob' | 'close'
>;

export class GoogleConnectionContinuationQueue {
  private readonly queue: ContinuationQueueClient;

  constructor(
    redisUrl: string,
    queueName = GOOGLE_CONNECTION_CONTINUATION_QUEUE_NAME,
    queue?: ContinuationQueueClient,
  ) {
    this.queue = queue ?? new Queue<GoogleConnectionContinuationJob>(queueName, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 500 },
      },
    });
  }

  async enqueue(intentId: string): Promise<string> {
    const jobId = this.jobId(intentId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      if (await existing.getState() === 'failed') {
        await existing.retry('failed');
      }
      return existing.id ?? jobId;
    }
    const job = await this.queue.add(
      'continue',
      { intentId },
      { jobId },
    );
    return job.id ?? jobId;
  }

  private jobId(intentId: string): string {
    return `google_oauth_${intentId}`;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

type IntentRepo = Pick<
  ConnectionAuthorizationRepository,
  | 'claimContinuation'
  | 'findPendingContinuation'
  | 'finishContinuation'
  | 'listPendingContinuationIds'
>;

type GoogleConnectionRepo = Pick<
  IntegrationConnectionRepository,
  'listAccessibleGoogleConnections'
>;

export interface GoogleConnectionContinuationRunInput {
  incoming: IncomingMessage;
  runContext: RunContext;
  conversation: ConversationHandle;
  channelAdapter: LarkChannelAdapter;
  abortSignal?: AbortSignal;
}

export interface GoogleConnectionContinuationWebRunInput {
  readonly incomingText: string;
  readonly originalRequest: string;
  readonly threadId: string;
  readonly userExternalId: string;
  readonly sessionId: string;
  readonly runContext: RunContext;
}

export interface GoogleConnectionContinuationWorkerDeps {
  redisUrl: string;
  queueName?: string;
  queue: Pick<GoogleConnectionContinuationQueue, 'enqueue'>;
  intentRepo: IntentRepo;
  identityRepo: ChannelIdentityRepoPort;
  connectionRepo: GoogleConnectionRepo;
  runPi: (input: GoogleConnectionContinuationRunInput) => Promise<string | null>;
  /** Web uses the same durable intent and queue, but its existing web runtime owns delivery. */
  runWeb?: (input: GoogleConnectionContinuationWebRunInput) => Promise<string | null>;
  runOrigins?: Pick<RunOriginStore, 'recall'>;
  /**
   * Closes the Connect ask once OAuth has made it moot.
   *
   * Optional because Lark delivers its own card rather than a decision row, and
   * because every test that predates the web surface builds this worker without
   * one. Absent, the card simply expires on its own.
   */
  decisions?: { withdraw(input: { idempotencyKey: string; reason: string }): Promise<number> };
  channelAdapter: LarkChannelAdapter;
  laneLeaseHolder?: LaneLeaseHolder;
  logger: Logger;
  reconcileIntervalMs?: number;
}

export class GoogleConnectionContinuationWorker {
  private worker?: Worker<GoogleConnectionContinuationJob>;
  private reconcileTimer?: NodeJS.Timeout;
  private readonly log: Logger;

  constructor(private readonly deps: GoogleConnectionContinuationWorkerDeps) {
    this.log = deps.logger.child({ service: 'google-connection-continuation' });
  }

  start(): void {
    this.worker = new Worker<GoogleConnectionContinuationJob>(
      this.deps.queueName ?? GOOGLE_CONNECTION_CONTINUATION_QUEUE_NAME,
      async job => this.process(job),
      { connection: { url: this.deps.redisUrl }, concurrency: 5 },
    );
    this.worker.on('failed', (job, error) => {
      this.log.warn('google.continuation.job_failed', {
        jobId: job?.id,
        error: String(error),
      });
    });

    const reconcile = () => {
      void this.reconcile().catch(error => {
        this.log.warn('google.continuation.reconcile_failed', {
          error: String(error),
        });
      });
    };
    reconcile();
    this.reconcileTimer = setInterval(
      reconcile,
      this.deps.reconcileIntervalMs ?? 30_000,
    );
    this.reconcileTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await this.worker?.close();
  }

  async reconcile(): Promise<void> {
    const pending = await this.deps.intentRepo.listPendingContinuationIds();
    if (!pending.ok) throw pending.error;
    await Promise.all(pending.value.map(intentId => this.deps.queue.enqueue(intentId)));
  }

  async process(job: Pick<Job<GoogleConnectionContinuationJob>, 'data' | 'id'>): Promise<void> {
    const pending = await this.deps.intentRepo.findPendingContinuation(job.data.intentId);
    if (!pending.ok) throw pending.error;
    if (!pending.value) return;

    if (isWebConnectionAuthorization(pending.value)) {
      await this.runClaimed(job.data.intentId, this.deps.channelAdapter);
      return;
    }

    if (!this.deps.laneLeaseHolder) {
      await this.runClaimed(job.data.intentId, this.deps.channelAdapter);
      return;
    }

    const laneKey = buildLarkIngressLaneKey(buildContinuationIncoming(pending.value, {
      connectionId: pending.value.connectionId,
      scopes: [],
    }));
    const outcome = await this.deps.laneLeaseHolder.withLane(
      laneKey,
      async (lease, signal) => this.runClaimed(
        job.data.intentId,
        fenceFinalReplies(
          this.deps.channelAdapter,
          () => this.deps.laneLeaseHolder!.holdsLane(lease),
          this.log,
        ),
        signal,
      ),
    );
    if (outcome.outcome === 'deferred') {
      throw new Error(`Google continuation lane is held by ${outcome.ownerId}`);
    }
  }

  private async runClaimed(
    intentId: string,
    channelAdapter: LarkChannelAdapter,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const claimed = await this.deps.intentRepo.claimContinuation(intentId);
    if (!claimed.ok) throw claimed.error;
    if (!claimed.value) return;

    const intent = claimed.value;
    try {
      const identity = await this.resolveCurrentIdentity(intent);
      const connection = await this.resolveCurrentConnection(intent);
      if (isWebConnectionAuthorization(intent)) {
        if (!this.deps.runWeb || !this.deps.runOrigins) {
          throw new Error('Web Google continuation is not configured.');
        }
        const origin = await this.deps.runOrigins.recall({
          runId: intent.originalMessageId,
          companyId: intent.companyId,
          userId: intent.userId,
        });
        if (!origin || origin.channel !== 'web' || !origin.web.sessionId) {
          throw new Error('The web run origin for this Google continuation is no longer available.');
        }
        const result = await this.deps.runWeb(buildWebContinuationInput(intent, identity, origin, connection));
        if (result === null) {
          await this.finish(intent, { failureCode: 'continuation_delivery_failed' });
          this.log.error('google.continuation.web_delivery_failed', {
            intentId: intent.intentId,
            connectionId: connection.connectionId,
          });
          return;
        }
        await this.finish(intent, {
          runId: intent.continuationIdempotencyKey,
        });
        this.log.info('google.continuation.web_completed', {
          intentId: intent.intentId,
          connectionId: connection.connectionId,
          runId: intent.continuationIdempotencyKey,
        });
        return;
      }
      const input = buildContinuationInput(intent, identity, channelAdapter, connection);
      const result = await this.deps.runPi({
        ...input,
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (result === null) {
        await this.finish(intent, {
          failureCode: 'continuation_delivery_failed',
        });
        this.log.error('google.continuation.delivery_failed', {
          intentId: intent.intentId,
          connectionId: connection.connectionId,
        });
        return;
      }

      await this.finish(intent, {
        runId: intent.continuationIdempotencyKey,
      });
      this.log.info('google.continuation.completed', {
        intentId: intent.intentId,
        connectionId: connection.connectionId,
        runId: intent.continuationIdempotencyKey,
      });
    } catch (error) {
      await this.finish(intent, {
        failureCode: classifyContinuationFailure(error),
      });
      this.log.error('google.continuation.failed', {
        intentId: intent.intentId,
        error: String(error),
      });
    }
  }

  private async resolveCurrentIdentity(intent: ConnectionContinuationClaim) {
    if (isWebConnectionAuthorization(intent)) {
      const resolved = await this.deps.identityRepo.resolveByUserId(
        intent.userId,
        intent.companyId,
      );
      if (!resolved.ok) throw resolved.error;
      if (
        !resolved.value
        || resolved.value.companyId !== intent.companyId
        || resolved.value.userId !== intent.userId
      ) {
        throw new Error('The member is no longer active in this company.');
      }
      return resolved.value;
    }
    const resolved = await this.deps.identityRepo.resolveByLarkTenantIdentity(
      intent.larkOpenId,
      intent.larkTenantKey,
    );
    if (!resolved.ok) throw resolved.error;
    if (
      !resolved.value
      || resolved.value.companyId !== intent.companyId
      || resolved.value.userId !== intent.userId
    ) {
      throw new Error('The member or Lark workspace binding is no longer active.');
    }
    return resolved.value;
  }

  private async resolveCurrentConnection(intent: ConnectionContinuationClaim) {
    const listed = await this.deps.connectionRepo.listAccessibleGoogleConnections({
      companyId: intent.companyId,
      userId: intent.userId,
    });
    if (!listed.ok) throw listed.error;
    const connection = listed.value.find(
      candidate => candidate.connectionId === intent.connectionId
        && candidate.ownerType === 'user'
        && candidate.ownerUserId === intent.userId,
    );
    if (!connection) {
      throw new Error('The completed Google connection is no longer accessible.');
    }
    return connection;
  }

  private async finish(
    intent: ConnectionContinuationClaim,
    outcome: { runId?: string; failureCode?: string },
  ): Promise<void> {
    const finished = await this.deps.intentRepo.finishContinuation(
      intent.intentId,
      outcome,
    );
    if (!finished.ok) throw finished.error;

    /*
     * The Connect card is moot the moment the connection exists, which is
     * strictly before this line: nothing reaches `finish` until OAuth has
     * completed. So this runs on the delivery-failure path too, deliberately.
     * A member who has already connected should never be looking at a button
     * asking them to connect, whatever happened to the run afterwards.
     *
     * The decision was opened with the intent id as its idempotency key
     * (`web.courier.ts`), which is what makes it findable from here.
     */
    await this.deps.decisions?.withdraw({
      idempotencyKey: intent.intentId,
      reason: 'google_connected',
    });
  }
}

function buildWebContinuationInput(
  intent: ConnectionContinuationClaim,
  identity: {
    readonly aiRole: string;
    readonly activeDepartmentId?: string;
    readonly email?: string;
  },
  origin: Extract<import('./run-origin.store').RunOrigin, { channel: 'web' }>,
  connection: Pick<ConnectionSummary, 'scopes'>,
): GoogleConnectionContinuationWebRunInput {
  return {
    incomingText: continuationText(intent, connection),
    originalRequest: intent.originalRequest,
    threadId: origin.web.threadId,
    userExternalId: origin.web.userExternalId,
    sessionId: origin.web.sessionId,
    runContext: {
      companyId: asCompanyId(intent.companyId),
      userId: asUserId(intent.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      channel: 'web',
      traceId: intent.continuationIdempotencyKey,
      requestId: intent.continuationIdempotencyKey,
      userExternalId: origin.web.userExternalId,
      chatId: origin.web.threadId,
      ...(identity.activeDepartmentId
        ? { departmentId: asDepartmentId(identity.activeDepartmentId) }
        : {}),
      ...(identity.email ? { requesterEmail: identity.email } : {}),
    },
  };
}

function buildContinuationInput(
  intent: ConnectionContinuationClaim,
  identity: {
    aiRole: string;
    activeDepartmentId?: string;
    email?: string;
  },
  channelAdapter: LarkChannelAdapter,
  connection: Pick<ConnectionSummary, 'connectionId' | 'scopes'>,
) {
  const traceId = asCorrelationId(intent.continuationIdempotencyKey);
  const chatId = asChatId(intent.chatId);

  const incoming = buildContinuationIncoming(intent, connection);

  const runContext: RunContext = {
    companyId: asCompanyId(intent.companyId),
    userId: asUserId(intent.userId),
    companyRole: asCompanyRoleSlug(identity.aiRole),
    channel: 'lark',
    tenantId: intent.larkTenantKey,
    traceId: String(traceId),
    requestId: intent.continuationIdempotencyKey,
    userExternalId: intent.larkOpenId,
    chatId: intent.chatId,
    replyToMessageId: intent.originalMessageId,
    replyInThread: intent.replyInThread,
    ...(identity.activeDepartmentId
      ? { departmentId: asDepartmentId(identity.activeDepartmentId) }
      : {}),
    ...(identity.email ? { requesterEmail: identity.email } : {}),
  };

  const conversation: ConversationHandle = {
    channel: 'lark',
    chatId,
    replyToMessageId: asMessageId(intent.originalMessageId),
    replyInThread: intent.replyInThread,
    correlationId: traceId,
  };

  return { incoming, runContext, conversation, channelAdapter };
}

function buildContinuationIncoming(
  intent: ConnectionContinuationClaim,
  connection: Pick<ConnectionSummary, 'connectionId' | 'scopes'>,
): IncomingMessage {
  if (intent.chatType !== 'p2p' && intent.chatType !== 'group') {
    throw new Error('Stored continuation chat type is invalid.');
  }
  const groupReplyMode = intent.groupReplyMode === 'inline'
    ? 'inline'
    : 'threaded';
  const traceId = asCorrelationId(intent.continuationIdempotencyKey);
  const grantedScopeGroups = grantedGoogleScopeGroups(
    intent.requestedToolIds,
    connection.scopes,
  );
  return {
    channel: 'lark',
    messageId: asMessageId(`oauth-continuation-${intent.intentId}`),
    chatId: asChatId(intent.chatId),
    chatType: intent.chatType,
    tenantKey: intent.larkTenantKey,
    userExternalId: intent.larkOpenId,
    text: continuationText(intent, connection),
    attachments: [],
    timestamp: new Date().toISOString(),
    traceId,
    mentions: [],
    mentionsSelf: true,
    ...(intent.chatType === 'group' ? { groupReplyMode } : {}),
    ...(intent.rootMessageId
      ? { rootMessageId: asMessageId(intent.rootMessageId) }
      : {}),
    raw: {
      source: 'google_oauth_continuation',
      resumeReason: 'google_connected',
      connectionId: intent.connectionId,
      authorizationIntentId: intent.intentId,
      requestedToolIds: intent.requestedToolIds,
      grantedScopes: connection.scopes,
      grantedScopeGroups,
    },
  };
}

function continuationText(
  intent: ConnectionContinuationClaim,
  connection: Pick<ConnectionSummary, 'scopes'>,
): string {
  const grantedScopeGroups = grantedGoogleScopeGroups(
    intent.requestedToolIds,
    connection.scopes,
  );
  const groups = grantedScopeGroups.length > 0
    ? grantedScopeGroups.map((group, index) => `- group ${index + 1}: ${group}`).join('\n')
    : '- no requested Google scope groups were returned';
  return [
    '[DIVO CONTINUATION CONTEXT — trusted backend state]',
    'This run continues the earlier request after Google Workspace OAuth completed.',
    'The Google Workspace connection is now present for this member.',
    'Scope groups actually returned by Google for this authorization are:',
    groups,
    'Treat only the groups listed above as granted. Do not infer a requested or missing group.',
    'Make the continuation visible in your reply: say that Google Workspace is connected and that you are continuing the earlier request.',
    'Earlier request:',
    intent.originalRequest,
    '[END DIVO CONTINUATION CONTEXT]',
  ].join('\n');
}

function grantedGoogleScopeGroups(
  requestedToolIds: readonly string[],
  grantedScopes: readonly string[] | undefined,
): readonly string[] {
  /*
   * A connection with no scope list is treated as having granted nothing, not
   * as an error. Reading `.map` off an absent list throws a TypeError whose
   * message names no cause, and `classifyContinuationFailure` can only file
   * that under the catch-all `continuation_failed` — so a delivery failure
   * downstream would be reported as a generic one, which is the exact
   * substitution this whole path exists to stop making.
   */
  const granted = new Set((grantedScopes ?? []).map(normalizeScope));
  return googleScopeGroupsForToolIds(requestedToolIds).map(group => {
    const actual = group
      .filter(scope => granted.has(normalizeScope(scope)))
      .map(scope => shortScopeName(scope));
    return actual.length > 0 ? actual.join(' or ') : 'none returned';
  });
}

function normalizeScope(scope: string): string {
  return scope.trim().toLowerCase().replace(/\/$/, '');
}

function shortScopeName(scope: string): string {
  const normalized = normalizeScope(scope);
  const marker = normalized.lastIndexOf('/');
  return marker >= 0 ? normalized.slice(marker + 1) : normalized;
}

function classifyContinuationFailure(error: unknown): string {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error);
  if (text.includes('member') || text.includes('workspace')) {
    return 'continuation_identity_changed';
  }
  if (text.includes('connection')) return 'continuation_connection_unavailable';
  if (text.includes('chat type')) return 'continuation_target_invalid';
  return 'continuation_failed';
}
