import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  CONNECTION_AUTHORIZATION_PROVIDER,
  CONNECTION_AUTHORIZATION_TTL_MS,
  connectionAuthorizationDedupeKey,
  createConnectionAuthorizationSecrets,
  hashConnectionAuthorizationState,
  type ConnectionAuthorizationTarget,
} from '../../application/connections/connection-authorization-intent';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';
import { decryptToken, encryptToken } from '../shared/token.crypto';

export interface CreateConnectionAuthorizationIntentInput
  extends ConnectionAuthorizationTarget {
  now?: Date;
  ttlMs?: number;
}

export interface CreatedConnectionAuthorizationIntent {
  outcome: 'issued';
  intentId: string;
  state: string;
  expiresAt: Date;
  correlationId: string;
}

export interface ExistingConnectionAuthorizationIntent {
  outcome: 'already_pending';
  intentId: string;
  expiresAt: Date;
  correlationId: string;
}

export interface ClaimedConnectionAuthorizationIntent
  extends ConnectionAuthorizationTarget {
  intentId: string;
  provider: typeof CONNECTION_AUTHORIZATION_PROVIDER;
  correlationId: string;
  continuationIdempotencyKey: string;
}

export type AuthorizationCallbackClaim =
  | { outcome: 'claimed'; intent: ClaimedConnectionAuthorizationIntent }
  | { outcome: 'invalid' }
  | { outcome: 'expired' }
  | { outcome: 'already_consumed' };

export interface ConnectionContinuationClaim extends ConnectionAuthorizationTarget {
  intentId: string;
  connectionId: string;
  correlationId: string;
  continuationIdempotencyKey: string;
}

export interface RecoverableGoogleExchange {
  intent: ClaimedConnectionAuthorizationIntent;
  authorizationCode: string;
  tokens?: Record<string, unknown>;
}

type ConnectionAuthorizationDb = Pick<
  PrismaClient,
  'connectionAuthorizationIntent'
>;

const continuationSelect = {
  id: true,
  companyId: true,
  userId: true,
  departmentId: true,
  connectionId: true,
  larkOpenId: true,
  larkTenantKey: true,
  chatId: true,
  chatType: true,
  originalMessageId: true,
  rootMessageId: true,
  replyInThread: true,
  groupReplyMode: true,
  originalRequest: true,
  requestedToolIds: true,
  correlationId: true,
  continuationIdempotencyKey: true,
} as const;

export class ConnectionAuthorizationRepository {
  constructor(
    private readonly db: ConnectionAuthorizationDb,
    private readonly encryptionKey = '',
  ) {}

  async create(
    input: CreateConnectionAuthorizationIntentInput,
  ): Promise<Result<
    CreatedConnectionAuthorizationIntent | ExistingConnectionAuthorizationIntent,
    InfraError
  >> {
    const now = input.now ?? new Date();
    const expiresAt = new Date(
      now.getTime() + (input.ttlMs ?? CONNECTION_AUTHORIZATION_TTL_MS),
    );
    const secrets = createConnectionAuthorizationSecrets();
    const activeDedupeKey = connectionAuthorizationDedupeKey(input);

    try {
      const created = await this.db.connectionAuthorizationIntent.create({
        data: {
          stateHash: secrets.stateHash,
          activeDedupeKey,
          provider: CONNECTION_AUTHORIZATION_PROVIDER,
          companyId: input.companyId,
          userId: input.userId,
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          larkOpenId: input.larkOpenId,
          larkTenantKey: input.larkTenantKey,
          chatId: input.chatId,
          chatType: input.chatType,
          originalMessageId: input.originalMessageId,
          ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
          replyInThread: input.replyInThread,
          ...(input.groupReplyMode ? { groupReplyMode: input.groupReplyMode } : {}),
          originalRequest: input.originalRequest,
          requestedToolIds: input.requestedToolIds,
          continuationIdempotencyKey: secrets.continuationIdempotencyKey,
          correlationId: secrets.correlationId,
          expiresAt,
        },
        select: { id: true },
      });
      return ok({
        outcome: 'issued',
        intentId: created.id,
        state: secrets.state,
        expiresAt,
        correlationId: secrets.correlationId,
      });
    } catch (cause) {
      if ((cause as { code?: string }).code === 'P2002') {
        try {
          const existing = await this.db.connectionAuthorizationIntent.findFirst({
            where: {
              activeDedupeKey,
              status: 'pending',
              expiresAt: { gt: now },
            },
            select: {
              id: true,
              expiresAt: true,
              correlationId: true,
            },
          });
          if (existing) {
            return ok({
              outcome: 'already_pending',
              intentId: existing.id,
              expiresAt: existing.expiresAt,
              correlationId: existing.correlationId,
            });
          }
        } catch (lookupCause) {
          return err(wrapInfra(
            'prisma',
            'connectionAuthorizationIntent.findActiveDuplicate',
            lookupCause,
          ));
        }
      }
      return err(wrapInfra('prisma', 'connectionAuthorizationIntent.create', cause));
    }
  }

  async claimCallback(
    rawState: string,
    now = new Date(),
    authorizationCode?: string,
  ): Promise<Result<AuthorizationCallbackClaim, InfraError>> {
    try {
      const existing = await this.db.connectionAuthorizationIntent.findUnique({
        where: { stateHash: hashConnectionAuthorizationState(rawState) },
        select: {
          ...continuationSelect,
          provider: true,
          status: true,
          expiresAt: true,
        },
      });
      if (!existing || existing.provider !== CONNECTION_AUTHORIZATION_PROVIDER) {
        return ok({ outcome: 'invalid' });
      }
      if (existing.expiresAt.getTime() <= now.getTime()) {
        await this.db.connectionAuthorizationIntent.updateMany({
          where: { id: existing.id, status: 'pending' },
          data: {
            status: 'expired',
            failureCode: 'authorization_expired',
            activeDedupeKey: null,
          },
        });
        return ok({ outcome: 'expired' });
      }
      if (existing.status !== 'pending') {
        return ok({ outcome: 'already_consumed' });
      }

      const claimed = await this.db.connectionAuthorizationIntent.updateMany({
        where: {
          id: existing.id,
          status: 'pending',
          expiresAt: { gt: now },
        },
        data: {
          status: 'exchanging',
          consumedAt: now,
          activeDedupeKey: null,
          exchangeStartedAt: now,
          exchangeAttempts: { increment: 1 },
          ...(authorizationCode
            ? {
                authorizationCodeEncrypted: encryptToken(
                  authorizationCode,
                  this.encryptionKey,
                ).cipherText,
              }
            : {}),
        },
      });
      if (claimed.count !== 1) return ok({ outcome: 'already_consumed' });

      return ok({
        outcome: 'claimed',
        intent: {
          intentId: existing.id,
          provider: CONNECTION_AUTHORIZATION_PROVIDER,
          companyId: existing.companyId,
          userId: existing.userId,
          ...(existing.departmentId ? { departmentId: existing.departmentId } : {}),
          larkOpenId: existing.larkOpenId,
          larkTenantKey: existing.larkTenantKey,
          chatId: existing.chatId,
          chatType: existing.chatType,
          originalMessageId: existing.originalMessageId,
          ...(existing.rootMessageId ? { rootMessageId: existing.rootMessageId } : {}),
          replyInThread: existing.replyInThread,
          ...(existing.groupReplyMode
            ? { groupReplyMode: existing.groupReplyMode }
            : {}),
          originalRequest: existing.originalRequest,
          requestedToolIds: existing.requestedToolIds,
          correlationId: existing.correlationId,
          continuationIdempotencyKey: existing.continuationIdempotencyKey,
        },
      });
    } catch (cause) {
      return err(
        wrapInfra('prisma', 'connectionAuthorizationIntent.claimCallback', cause),
      );
    }
  }

  async stageExchangeTokens(
    intentId: string,
    tokens: Record<string, unknown>,
  ): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.connectionAuthorizationIntent.updateMany({
        where: { id: intentId, status: 'exchanging' },
        data: {
          exchangeTokensEncrypted: encryptToken(
            JSON.stringify(tokens),
            this.encryptionKey,
          ).cipherText,
        },
      });
      return ok(updated.count === 1);
    } catch (cause) {
      return err(wrapInfra(
        'prisma',
        'connectionAuthorizationIntent.stageExchangeTokens',
        cause,
      ));
    }
  }

  async loadRecoverableExchange(
    intentId: string,
  ): Promise<Result<RecoverableGoogleExchange | null, InfraError>> {
    try {
      const row = await this.db.connectionAuthorizationIntent.findFirst({
        where: { id: intentId, status: 'exchanging' },
        select: {
          ...continuationSelect,
          provider: true,
          authorizationCodeEncrypted: true,
          exchangeTokensEncrypted: true,
        },
      });
      if (
        !row
        || row.provider !== CONNECTION_AUTHORIZATION_PROVIDER
        || !row.authorizationCodeEncrypted
      ) {
        return ok(null);
      }
      const intent: ClaimedConnectionAuthorizationIntent = {
        intentId: row.id,
        provider: CONNECTION_AUTHORIZATION_PROVIDER,
        companyId: row.companyId,
        userId: row.userId,
        ...(row.departmentId ? { departmentId: row.departmentId } : {}),
        larkOpenId: row.larkOpenId,
        larkTenantKey: row.larkTenantKey,
        chatId: row.chatId,
        chatType: row.chatType,
        originalMessageId: row.originalMessageId,
        ...(row.rootMessageId ? { rootMessageId: row.rootMessageId } : {}),
        replyInThread: row.replyInThread,
        ...(row.groupReplyMode ? { groupReplyMode: row.groupReplyMode } : {}),
        originalRequest: row.originalRequest,
        requestedToolIds: row.requestedToolIds,
        correlationId: row.correlationId,
        continuationIdempotencyKey: row.continuationIdempotencyKey,
      };
      return ok({
        intent,
        authorizationCode: decryptToken(
          row.authorizationCodeEncrypted,
          this.encryptionKey,
        ),
        ...(row.exchangeTokensEncrypted
          ? {
              tokens: JSON.parse(decryptToken(
                row.exchangeTokensEncrypted,
                this.encryptionKey,
              )) as Record<string, unknown>,
            }
          : {}),
      });
    } catch (cause) {
      return err(wrapInfra(
        'prisma',
        'connectionAuthorizationIntent.loadRecoverableExchange',
        cause,
      ));
    }
  }

  async listStaleExchangeIds(
    staleBefore: Date,
    limit = 50,
  ): Promise<Result<string[], InfraError>> {
    try {
      const rows = await this.db.connectionAuthorizationIntent.findMany({
        where: {
          status: 'exchanging',
          exchangeStartedAt: { lt: staleBefore },
          authorizationCodeEncrypted: { not: null },
        },
        orderBy: [{ exchangeStartedAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: { id: true },
      });
      return ok(rows.map(row => row.id));
    } catch (cause) {
      return err(wrapInfra(
        'prisma',
        'connectionAuthorizationIntent.listStaleExchanges',
        cause,
      ));
    }
  }

  async markConnected(
    intentId: string,
    connectionId: string,
    now = new Date(),
  ): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.connectionAuthorizationIntent.updateMany({
        where: { id: intentId, status: 'exchanging' },
        data: {
          status: 'connected',
          connectionId,
          connectedAt: now,
          continuationStatus: 'pending',
          continuationQueuedAt: now,
          failureCode: null,
        },
      });
      return ok(updated.count === 1);
    } catch (cause) {
      return err(
        wrapInfra('prisma', 'connectionAuthorizationIntent.markConnected', cause),
      );
    }
  }

  async markAuthorizationFailed(
    intentId: string,
    failureCode: string,
  ): Promise<Result<void, InfraError>> {
    try {
      await this.db.connectionAuthorizationIntent.updateMany({
        where: { id: intentId, status: { in: ['pending', 'exchanging'] } },
        data: {
          status: 'failed',
          continuationStatus: 'failed',
          failureCode: failureCode.slice(0, 120),
          continuationFinishedAt: new Date(),
          activeDedupeKey: null,
          authorizationCodeEncrypted: null,
          exchangeTokensEncrypted: null,
        },
      });
      return ok(undefined);
    } catch (cause) {
      return err(
        wrapInfra('prisma', 'connectionAuthorizationIntent.markAuthorizationFailed', cause),
      );
    }
  }

  async claimContinuation(
    intentId: string,
    now = new Date(),
  ): Promise<Result<ConnectionContinuationClaim | null, InfraError>> {
    try {
      const claimed = await this.db.connectionAuthorizationIntent.updateMany({
        where: {
          id: intentId,
          status: 'connected',
          continuationStatus: 'pending',
          connectionId: { not: null },
        },
        data: {
          continuationStatus: 'running',
          continuationStartedAt: now,
        },
      });
      if (claimed.count !== 1) return ok(null);

      const intent = await this.db.connectionAuthorizationIntent.findUnique({
        where: { id: intentId },
        select: continuationSelect,
      });
      if (!intent?.connectionId) {
        throw new Error('Claimed connection continuation is missing its connection.');
      }
      return ok({
        intentId: intent.id,
        companyId: intent.companyId,
        userId: intent.userId,
        ...(intent.departmentId ? { departmentId: intent.departmentId } : {}),
        connectionId: intent.connectionId,
        larkOpenId: intent.larkOpenId,
        larkTenantKey: intent.larkTenantKey,
        chatId: intent.chatId,
        chatType: intent.chatType,
        originalMessageId: intent.originalMessageId,
        ...(intent.rootMessageId ? { rootMessageId: intent.rootMessageId } : {}),
        replyInThread: intent.replyInThread,
        ...(intent.groupReplyMode ? { groupReplyMode: intent.groupReplyMode } : {}),
        originalRequest: intent.originalRequest,
        requestedToolIds: intent.requestedToolIds,
        correlationId: intent.correlationId,
        continuationIdempotencyKey: intent.continuationIdempotencyKey,
      });
    } catch (cause) {
      return err(
        wrapInfra('prisma', 'connectionAuthorizationIntent.claimContinuation', cause),
      );
    }
  }

  async findPendingContinuation(
    intentId: string,
  ): Promise<Result<ConnectionContinuationClaim | null, InfraError>> {
    try {
      const intent = await this.db.connectionAuthorizationIntent.findFirst({
        where: {
          id: intentId,
          status: 'connected',
          continuationStatus: 'pending',
          connectionId: { not: null },
        },
        select: continuationSelect,
      });
      if (!intent?.connectionId) return ok(null);
      return ok({
        intentId: intent.id,
        companyId: intent.companyId,
        userId: intent.userId,
        ...(intent.departmentId ? { departmentId: intent.departmentId } : {}),
        connectionId: intent.connectionId,
        larkOpenId: intent.larkOpenId,
        larkTenantKey: intent.larkTenantKey,
        chatId: intent.chatId,
        chatType: intent.chatType,
        originalMessageId: intent.originalMessageId,
        ...(intent.rootMessageId ? { rootMessageId: intent.rootMessageId } : {}),
        replyInThread: intent.replyInThread,
        ...(intent.groupReplyMode ? { groupReplyMode: intent.groupReplyMode } : {}),
        originalRequest: intent.originalRequest,
        requestedToolIds: intent.requestedToolIds,
        correlationId: intent.correlationId,
        continuationIdempotencyKey: intent.continuationIdempotencyKey,
      });
    } catch (cause) {
      return err(
        wrapInfra('prisma', 'connectionAuthorizationIntent.findPending', cause),
      );
    }
  }

  async listPendingContinuationIds(
    limit = 100,
  ): Promise<Result<string[], InfraError>> {
    try {
      const intents = await this.db.connectionAuthorizationIntent.findMany({
        where: {
          status: 'connected',
          continuationStatus: 'pending',
          connectionId: { not: null },
        },
        orderBy: [{ continuationQueuedAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: { id: true },
      });
      return ok(intents.map(intent => intent.id));
    } catch (cause) {
      return err(
        wrapInfra('prisma', 'connectionAuthorizationIntent.listPending', cause),
      );
    }
  }

  async finishContinuation(
    intentId: string,
    outcome: { runId?: string; failureCode?: string },
    now = new Date(),
  ): Promise<Result<void, InfraError>> {
    try {
      await this.db.connectionAuthorizationIntent.updateMany({
        where: { id: intentId, continuationStatus: 'running' },
        data: {
          continuationStatus: outcome.failureCode ? 'failed' : 'completed',
          continuationFinishedAt: now,
          failureCode: outcome.failureCode?.slice(0, 120) ?? null,
          ...(outcome.runId ? { continuationRunId: outcome.runId } : {}),
        },
      });
      return ok(undefined);
    } catch (cause) {
      return err(
        wrapInfra('prisma', 'connectionAuthorizationIntent.finishContinuation', cause),
      );
    }
  }
}
