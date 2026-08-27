import type { PrismaClient } from '../../generated/prisma';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';
import type {
  BroadcastRecipientStatus,
  BroadcastStatus,
} from '../../domain/follow-ups/broadcast';

/**
 * Broadcasts, stored.
 *
 * Two things here differ from the rest of the follow-ups persistence, and both
 * follow from this being the one path that writes to WhatsApp.
 *
 * The row is written *before* the gateway is called, not after. A crash between
 * the two then leaves a broadcast marked `queued` that names exactly which
 * recipients may already have been messaged — where the other order would leave
 * a send nobody can trace. `queued` is honest about the uncertainty; the poller
 * resolves it by asking the gateway what actually happened to that batch id.
 *
 * And every write is scoped in the `where`, never checked beforehand. A
 * broadcast belonging to another department matches nothing, so "not yours" and
 * "not found" are indistinguishable — which is the only pair of answers that
 * does not confirm the existence of another department's outbound message.
 */

export interface BroadcastRecipientRow {
  readonly id: string;
  readonly waChatId: string;
  readonly displayName: string;
  readonly isGroup: boolean;
  readonly status: string;
  readonly waMessageId: string | null;
  readonly error: string | null;
  readonly sentAt: Date | null;
}

export interface BroadcastRow {
  readonly id: string;
  readonly label: string;
  readonly body: string;
  readonly status: string;
  readonly total: number;
  readonly sent: number;
  readonly failed: number;
  readonly sessionId: string;
  readonly sessionLabel: string;
  readonly gatewayBatchId: string;
  readonly requestedByName: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

/** A broadcast the poller is responsible for, with what it needs to ask. */
export interface PollableBroadcast {
  readonly id: string;
  readonly gatewayBatchId: string;
  /** The gateway's own session id, not Divo's row id — that is what it keys on. */
  readonly openwaSessionId: string;
  readonly status: string;
  readonly createdAt: Date;
}

/**
 * A chat that could receive a broadcast.
 *
 * `cold` is derived rather than stored: a tracked chat has message history by
 * definition, so nothing reached through this list is a first contact. Only a
 * number typed in by hand can be, and that is decided where those are resolved.
 */
export interface BroadcastCandidate {
  readonly chatId: string;
  readonly waChatId: string;
  readonly name: string | null;
  readonly isGroup: boolean;
  readonly lastMessageAt: Date | null;
  readonly sessionId: string;
  readonly sessionLabel: string;
  /** Open follow-ups on this chat, so "everyone we owe" can be built from it. */
  readonly openFollowUps: number;
  /** `us` when we owe them, `them` when we are waiting — null when neither. */
  readonly followUpOwners: readonly string[];
}

export interface BroadcastsRepoPort {
  listCandidates(scope: {
    companyId: string;
    departmentId: string;
    sessionId?: string;
    limit: number;
  }): Promise<Result<readonly BroadcastCandidate[], InfraError>>;
  resolveKnownChats(input: {
    companyId: string;
    sessionId?: string;
    waChatIds: readonly string[];
  }): Promise<Result<ReadonlySet<string>, InfraError>>;
  findIdempotent(input: {
    sessionId: string;
    gatewayBatchId: string;
  }): Promise<Result<string | null, InfraError>>;
  create(input: {
    companyId: string;
    departmentId: string;
    sessionId: string;
    gatewayBatchId: string;
    label: string;
    body: string;
    requestedById: string;
    recipients: readonly {
      waChatId: string;
      displayName: string;
      isGroup: boolean;
      renderedBody: string;
    }[];
  }): Promise<Result<{ broadcastId: string; created: boolean }, InfraError>>;
  markStatus(input: {
    broadcastId: string;
    status: BroadcastStatus;
    startedAt?: Date;
    completedAt?: Date;
  }): Promise<Result<void, InfraError>>;
  applyBatchStatus(input: {
    broadcastId: string;
    status: BroadcastStatus;
    sent: number;
    failed: number;
    completedAt: Date | null;
    results: readonly {
      waChatId: string;
      status: BroadcastRecipientStatus;
      waMessageId?: string;
      error?: string;
      sentAt?: Date;
    }[];
  }): Promise<Result<void, InfraError>>;
  touchPoll(broadcastId: string): Promise<Result<void, InfraError>>;
  list(scope: {
    companyId: string;
    departmentId: string;
    sessionId?: string;
    limit: number;
  }): Promise<Result<readonly BroadcastRow[], InfraError>>;
  get(scope: {
    companyId: string;
    departmentId: string;
    broadcastId: string;
  }): Promise<Result<
    { broadcast: BroadcastRow; recipients: readonly BroadcastRecipientRow[] } | null,
    InfraError
  >>;
  /** Scoped lookup for the routes, which must not act on another department's row. */
  findForScope(scope: {
    companyId: string;
    departmentId: string;
    broadcastId: string;
  }): Promise<Result<PollableBroadcast | null, InfraError>>;
  claimPollable(input: { limit: number; olderThan: Date }): Promise<
    Result<readonly PollableBroadcast[], InfraError>
  >;
}

/** Non-terminal states. The poller's whole job is to move rows out of these. */
const LIVE_STATUSES = ['queued', 'sending'] as const;

export class BroadcastsRepository implements BroadcastsRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async listCandidates(scope: {
    companyId: string;
    departmentId: string;
    sessionId?: string;
    limit: number;
  }): Promise<Result<readonly BroadcastCandidate[], InfraError>> {
    try {
      const rows = await this.db.whatsappChat.findMany({
        where: {
          companyId: scope.companyId,
          departmentId: scope.departmentId,
          ...(scope.sessionId ? { owningSessionId: scope.sessionId } : {}),
        },
        orderBy: { lastMessageAt: 'desc' },
        take: scope.limit,
        select: {
          id: true, waChatId: true, name: true, isGroup: true, lastMessageAt: true,
          owningSession: { select: { id: true, label: true } },
          followUps: { where: { status: 'open' }, select: { owner: true } },
        },
      });
      return ok(rows.map(row => ({
        chatId: row.id,
        waChatId: row.waChatId,
        name: row.name,
        isGroup: row.isGroup,
        lastMessageAt: row.lastMessageAt,
        sessionId: row.owningSession.id,
        sessionLabel: row.owningSession.label,
        openFollowUps: row.followUps.length,
        // Deduped: a chat with four things we owe is still one recipient, and
        // the picker only needs to know *whether* it belongs in each list.
        followUpOwners: [...new Set(row.followUps.map(f => f.owner))],
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'broadcasts.listCandidates', cause));
    }
  }

  /**
   * Which of these WhatsApp ids Divo has already seen a conversation with.
   *
   * Sending-session scoped when one is named. WhatsApp's first-contact limits
   * belong to the handset doing the sending, so a conversation on another team
   * number does not make this sender warm.
   */
  async resolveKnownChats(input: {
    companyId: string;
    sessionId?: string;
    waChatIds: readonly string[];
  }): Promise<Result<ReadonlySet<string>, InfraError>> {
    if (input.waChatIds.length === 0) return ok(new Set());
    try {
      const rows = await this.db.whatsappChat.findMany({
        where: {
          companyId: input.companyId,
          ...(input.sessionId ? { owningSessionId: input.sessionId } : {}),
          waChatId: { in: [...input.waChatIds] },
        },
        select: { waChatId: true },
      });
      return ok(new Set(rows.map(row => row.waChatId)));
    } catch (cause) {
      return err(wrapInfra('prisma', 'broadcasts.resolveKnownChats', cause));
    }
  }

  async findIdempotent(input: {
    sessionId: string;
    gatewayBatchId: string;
  }): Promise<Result<string | null, InfraError>> {
    try {
      const row = await this.db.whatsappBroadcast.findUnique({
        where: {
          sessionId_gatewayBatchId: {
            sessionId: input.sessionId,
            gatewayBatchId: input.gatewayBatchId,
          },
        },
        select: { id: true },
      });
      return ok(row?.id ?? null);
    } catch (cause) {
      return err(wrapInfra('prisma', 'broadcasts.findIdempotent', cause));
    }
  }

  async create(input: {
    companyId: string;
    departmentId: string;
    sessionId: string;
    gatewayBatchId: string;
    label: string;
    body: string;
    requestedById: string;
    recipients: readonly {
      waChatId: string;
      displayName: string;
      isGroup: boolean;
      renderedBody: string;
    }[];
  }): Promise<Result<{ broadcastId: string; created: boolean }, InfraError>> {
    try {
      const created = await this.db.whatsappBroadcast.create({
        data: {
          companyId: input.companyId,
          departmentId: input.departmentId,
          sessionId: input.sessionId,
          gatewayBatchId: input.gatewayBatchId,
          label: input.label,
          body: input.body,
          requestedById: input.requestedById,
          status: 'queued',
          total: input.recipients.length,
          recipients: {
            create: input.recipients.map(recipient => ({
              waChatId: recipient.waChatId,
              displayName: recipient.displayName,
              isGroup: recipient.isGroup,
              renderedBody: recipient.renderedBody,
            })),
          },
        },
        select: { id: true },
      });
      return ok({ broadcastId: created.id, created: true });
    } catch (cause) {
      if ((cause as { code?: string }).code === 'P2002') {
        const existing = await this.findIdempotent(input);
        if (!existing.ok) return existing;
        if (existing.value) return ok({ broadcastId: existing.value, created: false });
      }
      return err(wrapInfra('prisma', 'broadcasts.create', cause));
    }
  }

  async markStatus(input: {
    broadcastId: string;
    status: BroadcastStatus;
    startedAt?: Date;
    completedAt?: Date;
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.whatsappBroadcast.updateMany({
        where: { id: input.broadcastId, status: { in: [...LIVE_STATUSES] } },
        data: {
          status: input.status,
          ...(input.startedAt ? { startedAt: input.startedAt } : {}),
          ...(input.completedAt ? { completedAt: input.completedAt } : {}),
        },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'broadcasts.markStatus', cause));
    }
  }

  /**
   * Fold one gateway reading into the stored broadcast.
   *
   * The counters come from the gateway rather than being recomputed from the
   * recipient rows we just wrote. Those two can legitimately disagree for a
   * moment — the gateway persists batch progress every ten messages, so its
   * `results` array can lag its own counters — and the counters are the figure
   * it will still be reporting after the batch ends. Trusting the rows instead
   * would leave a finished broadcast showing eight of ten sent forever.
   *
   * Recipient rows are updated one at a time rather than in a single
   * `updateMany`, because each carries its own message id and its own error.
   */
  async applyBatchStatus(input: {
    broadcastId: string;
    status: BroadcastStatus;
    sent: number;
    failed: number;
    completedAt: Date | null;
    results: readonly {
      waChatId: string;
      status: BroadcastRecipientStatus;
      waMessageId?: string;
      error?: string;
      sentAt?: Date;
    }[];
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.$transaction(async tx => {
        // Claim a monotonic parent transition first. A slower queued reading
        // cannot move a sending batch backwards, and a reading that reaches
        // this transaction after terminalization changes nothing at all.
        const currentStatuses: readonly BroadcastStatus[] = input.status === 'queued'
          ? ['queued']
          : [...LIVE_STATUSES];
        const parent = await tx.whatsappBroadcast.updateMany({
          where: { id: input.broadcastId, status: { in: [...currentStatuses] } },
          data: {
            status: input.status,
            sent: input.sent,
            failed: input.failed,
            lastPolledAt: new Date(),
            ...(input.completedAt ? { completedAt: input.completedAt } : {}),
          },
        });
        if (parent.count === 0) return;

        for (const result of input.results) {
          await tx.whatsappBroadcastRecipient.updateMany({
            where: { broadcastId: input.broadcastId, waChatId: result.waChatId },
            data: {
              status: result.status,
              ...(result.waMessageId ? { waMessageId: result.waMessageId } : {}),
              // Cleared on success as well as set on failure: a recipient that
              // failed and was later retried must not keep the old reason
              // beside a `sent` badge.
              error: result.status === 'failed' ? (result.error ?? 'unknown error') : null,
              ...(result.sentAt ? { sentAt: result.sentAt } : {}),
            },
          });
        }
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'broadcasts.applyBatchStatus', cause));
    }
  }

  async touchPoll(broadcastId: string): Promise<Result<void, InfraError>> {
    try {
      await this.db.whatsappBroadcast.updateMany({
        where: { id: broadcastId, status: { in: [...LIVE_STATUSES] } },
        data: { lastPolledAt: new Date() },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'broadcasts.touchPoll', cause));
    }
  }

  async list(scope: {
    companyId: string;
    departmentId: string;
    sessionId?: string;
    limit: number;
  }): Promise<Result<readonly BroadcastRow[], InfraError>> {
    try {
      const rows = await this.db.whatsappBroadcast.findMany({
        where: {
          companyId: scope.companyId,
          departmentId: scope.departmentId,
          ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: scope.limit,
        select: BROADCAST_SELECT,
      });
      return ok(rows.map(toBroadcastRow));
    } catch (cause) {
      return err(wrapInfra('prisma', 'broadcasts.list', cause));
    }
  }

  async get(scope: {
    companyId: string;
    departmentId: string;
    broadcastId: string;
  }): Promise<Result<
    { broadcast: BroadcastRow; recipients: readonly BroadcastRecipientRow[] } | null,
    InfraError
  >> {
    try {
      const row = await this.db.whatsappBroadcast.findFirst({
        where: {
          id: scope.broadcastId,
          companyId: scope.companyId,
          departmentId: scope.departmentId,
        },
        select: {
          ...BROADCAST_SELECT,
          recipients: {
            orderBy: { displayName: 'asc' },
            select: {
              id: true, waChatId: true, displayName: true, isGroup: true,
              status: true, waMessageId: true, error: true, sentAt: true,
            },
          },
        },
      });
      if (!row) return ok(null);
      return ok({ broadcast: toBroadcastRow(row), recipients: row.recipients });
    } catch (cause) {
      return err(wrapInfra('prisma', 'broadcasts.get', cause));
    }
  }

  async findForScope(scope: {
    companyId: string;
    departmentId: string;
    broadcastId: string;
  }): Promise<Result<PollableBroadcast | null, InfraError>> {
    try {
      const row = await this.db.whatsappBroadcast.findFirst({
        where: {
          id: scope.broadcastId,
          companyId: scope.companyId,
          departmentId: scope.departmentId,
        },
        select: {
          id: true, gatewayBatchId: true, status: true, createdAt: true,
          session: { select: { openwaSessionId: true } },
        },
      });
      if (!row) return ok(null);
      return ok({
        id: row.id,
        gatewayBatchId: row.gatewayBatchId,
        openwaSessionId: row.session.openwaSessionId,
        status: row.status,
        createdAt: row.createdAt,
      });
    } catch (cause) {
      return err(wrapInfra('prisma', 'broadcasts.findForScope', cause));
    }
  }

  /**
   * Broadcasts that are still running and have not been read recently.
   *
   * There is no lease token here, unlike the digest runner. Polling is a read
   * followed by an idempotent write of what the gateway said, so two workers
   * doing it at once produce the same row rather than two sends — the cost of a
   * duplicate is a wasted request, not a duplicate message. `olderThan` keeps
   * that cost down without pretending to be a lock.
   */
  async claimPollable(input: { limit: number; olderThan: Date }): Promise<
    Result<readonly PollableBroadcast[], InfraError>
  > {
    try {
      const rows = await this.db.whatsappBroadcast.findMany({
        where: {
          status: { in: [...LIVE_STATUSES] },
          OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: input.olderThan } }],
        },
        orderBy: { lastPolledAt: { sort: 'asc', nulls: 'first' } },
        take: input.limit,
        select: {
          id: true, gatewayBatchId: true, status: true, createdAt: true,
          session: { select: { openwaSessionId: true } },
        },
      });
      return ok(rows.map(row => ({
        id: row.id,
        gatewayBatchId: row.gatewayBatchId,
          openwaSessionId: row.session.openwaSessionId,
          status: row.status,
          createdAt: row.createdAt,
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'broadcasts.claimPollable', cause));
    }
  }
}

const BROADCAST_SELECT = {
  id: true, label: true, body: true, status: true,
  total: true, sent: true, failed: true, gatewayBatchId: true,
  startedAt: true, completedAt: true, createdAt: true,
  session: { select: { id: true, label: true } },
  requestedBy: { select: { name: true } },
} as const;

type RawBroadcast = {
  id: string; label: string; body: string; status: string;
  total: number; sent: number; failed: number; gatewayBatchId: string;
  startedAt: Date | null; completedAt: Date | null; createdAt: Date;
  session: { id: string; label: string };
  requestedBy: { name: string | null };
};

const toBroadcastRow = (row: RawBroadcast): BroadcastRow => ({
  id: row.id,
  label: row.label,
  body: row.body,
  status: row.status,
  total: row.total,
  sent: row.sent,
  failed: row.failed,
  sessionId: row.session.id,
  sessionLabel: row.session.label,
  gatewayBatchId: row.gatewayBatchId,
  requestedByName: row.requestedBy.name,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
  createdAt: row.createdAt,
});
