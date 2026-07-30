import { Queue, Worker, type Job } from 'bullmq';
import type { ConversationHandle } from '../channels/channel.adapter';
import type { LaneLeaseHolder } from '../orchestration/lane-lease.holder';
import type { IncomingMessage } from '../../domain/channel/incoming-message';
import type { RunContext } from '../../domain/orchestration/run-context';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import { fenceFinalReplies } from '../../infrastructure/channels/lark/lark-lane-fence';
import { buildLarkIngressLaneKey } from '../../infrastructure/channels/lark/lark-routing';
import type { IntegrationConnectionRepository } from '../../infrastructure/persistence/integration-connection.repository';
import type {
  ConnectionAuthorizationRepository,
  ConnectionContinuationClaim,
} from '../../infrastructure/persistence/connection-authorization.repository';
import {
  asChatId,
  asCompanyId,
  asCorrelationId,
  asDepartmentId,
  asMessageId,
  asUserId,
} from '../../shared/ids';
import type { Logger } from '../../shared/logger';

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

export interface GoogleConnectionContinuationWorkerDeps {
  redisUrl: string;
  queueName?: string;
  queue: Pick<GoogleConnectionContinuationQueue, 'enqueue'>;
  intentRepo: IntentRepo;
  identityRepo: ChannelIdentityRepoPort;
  connectionRepo: GoogleConnectionRepo;
  runPi: (input: GoogleConnectionContinuationRunInput) => Promise<string | null>;
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

    if (!this.deps.laneLeaseHolder) {
      await this.runClaimed(job.data.intentId, this.deps.channelAdapter);
      return;
    }

    const laneKey = buildLarkIngressLaneKey(buildContinuationIncoming(pending.value));
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
      const input = buildContinuationInput(intent, identity, channelAdapter);
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
  }
}

function buildContinuationInput(
  intent: ConnectionContinuationClaim,
  identity: {
    aiRole: string;
    activeDepartmentId?: string;
    email?: string;
  },
  channelAdapter: LarkChannelAdapter,
) {
  const traceId = asCorrelationId(intent.continuationIdempotencyKey);
  const chatId = asChatId(intent.chatId);

  const incoming = buildContinuationIncoming(intent);

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
    continuationToolIds: intent.requestedToolIds,
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
): IncomingMessage {
  if (intent.chatType !== 'p2p' && intent.chatType !== 'group') {
    throw new Error('Stored continuation chat type is invalid.');
  }
  const groupReplyMode = intent.groupReplyMode === 'inline'
    ? 'inline'
    : 'threaded';
  const traceId = asCorrelationId(intent.continuationIdempotencyKey);
  return {
    channel: 'lark',
    messageId: asMessageId(`oauth-continuation-${intent.intentId}`),
    chatId: asChatId(intent.chatId),
    chatType: intent.chatType,
    tenantKey: intent.larkTenantKey,
    userExternalId: intent.larkOpenId,
    text: intent.originalRequest,
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
    },
  };
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
