/**
 * GoogleUserAuthLinkRepository — per-user Google OAuth token storage.
 *
 * Tokens are AES-256-GCM encrypted before writing to Postgres.
 * The decryption key comes from env.ZOHO_TOKEN_ENCRYPTION_KEY (shared with Zoho).
 */

import type { PrismaClient, Prisma } from '../../generated/prisma';
import type { TypedEnv } from '../../config/env';
import { encryptToken, decryptToken } from '../shared/token.crypto';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { ok, err, type Result } from '../../shared/result';

// ─── Decrypted view type ──────────────────────────────────────────────────────

export interface DecryptedGoogleUserAuthLink {
  readonly id: string;
  readonly userId: string;
  readonly companyId: string;
  readonly googleUserId?: string;
  readonly googleEmail?: string;
  readonly googleName?: string;
  readonly scope?: string;
  /** Space-delimited scopes split into an array. */
  readonly scopes: string[];
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType?: string;
  readonly accessTokenExpiresAt?: Date;
  readonly refreshTokenExpiresAt?: Date;
  readonly tokenMetadata?: Record<string, unknown>;
  readonly linkedAt: Date;
  readonly lastUsedAt?: Date;
  readonly revokedAt?: Date;
  readonly updatedAt: Date;
}

// ─── Input types ──────────────────────────────────────────────────────────────

export interface UpsertGoogleUserAuthLinkInput {
  userId: string;
  companyId: string;
  googleUserId?: string;
  googleEmail?: string;
  googleName?: string;
  scope?: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
  tokenMetadata?: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const splitScopes = (scope?: string | null): string[] =>
  scope?.split(' ').map(s => s.trim()).filter(Boolean) ?? [];

// ─── Repository ───────────────────────────────────────────────────────────────

export class GoogleUserAuthLinkRepository {
  constructor(
    private readonly db:  PrismaClient,
    private readonly env: TypedEnv,
  ) {}

  private get key(): string {
    return this.env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '';
  }

  private decrypt(record: {
    accessTokenEncrypted: string;
    refreshTokenEncrypted?: string | null;
    googleUserId?: string | null;
    googleEmail?: string | null;
    googleName?: string | null;
    scope?: string | null;
    tokenType?: string | null;
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    tokenMetadata?: unknown;
    lastUsedAt?: Date | null;
    revokedAt?: Date | null;
    id: string;
    userId: string;
    companyId: string;
    linkedAt: Date;
    updatedAt: Date;
  }): DecryptedGoogleUserAuthLink {
    return {
      id:         record.id,
      userId:     record.userId,
      companyId:  record.companyId,
      ...(record.googleUserId         ? { googleUserId:         record.googleUserId }               : {}),
      ...(record.googleEmail          ? { googleEmail:          record.googleEmail }                : {}),
      ...(record.googleName           ? { googleName:           record.googleName }                 : {}),
      ...(record.scope                ? { scope:                record.scope }                      : {}),
      scopes:     splitScopes(record.scope),
      accessToken: decryptToken(record.accessTokenEncrypted, this.key),
      ...(record.refreshTokenEncrypted ? { refreshToken: decryptToken(record.refreshTokenEncrypted, this.key) } : {}),
      ...(record.tokenType            ? { tokenType:            record.tokenType }                  : {}),
      ...(record.accessTokenExpiresAt  ? { accessTokenExpiresAt:  record.accessTokenExpiresAt }     : {}),
      ...(record.refreshTokenExpiresAt ? { refreshTokenExpiresAt: record.refreshTokenExpiresAt }    : {}),
      ...(record.tokenMetadata         ? { tokenMetadata: record.tokenMetadata as Record<string, unknown> } : {}),
      linkedAt:   record.linkedAt,
      ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
      ...(record.revokedAt  ? { revokedAt:  record.revokedAt }  : {}),
      updatedAt:  record.updatedAt,
    };
  }

  async upsert(
    input: UpsertGoogleUserAuthLinkInput,
  ): Promise<Result<DecryptedGoogleUserAuthLink, InfraError>> {
    try {
      const encryptedAccess   = encryptToken(input.accessToken, this.key);
      const encryptedRefresh  = input.refreshToken ? encryptToken(input.refreshToken, this.key) : undefined;

      const record = await this.db.googleUserAuthLink.upsert({
        where:  { userId_companyId: { userId: input.userId, companyId: input.companyId } },
        create: {
          userId:                input.userId,
          companyId:             input.companyId,
          googleUserId:          input.googleUserId ?? null,
          googleEmail:           input.googleEmail  ?? null,
          googleName:            input.googleName   ?? null,
          scope:                 input.scope         ?? null,
          accessTokenEncrypted:  encryptedAccess.cipherText,
          ...(encryptedRefresh ? { refreshTokenEncrypted: encryptedRefresh.cipherText } : {}),
          tokenType:             input.tokenType            ?? null,
          accessTokenExpiresAt:  input.accessTokenExpiresAt  ?? null,
          refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
          ...(input.tokenMetadata ? { tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue } : {}),
          revokedAt:             null,
          linkedAt:              new Date(),
        },
        update: {
          googleUserId:          input.googleUserId ?? null,
          googleEmail:           input.googleEmail  ?? null,
          googleName:            input.googleName   ?? null,
          scope:                 input.scope         ?? null,
          accessTokenEncrypted:  encryptedAccess.cipherText,
          ...(encryptedRefresh ? { refreshTokenEncrypted: encryptedRefresh.cipherText } : {}),
          tokenType:             input.tokenType            ?? null,
          accessTokenExpiresAt:  input.accessTokenExpiresAt  ?? null,
          refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
          ...(input.tokenMetadata ? { tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue } : {}),
          revokedAt:             null,
          linkedAt:              new Date(),
        },
      });

      return ok(this.decrypt(record));
    } catch (e) {
      return err(wrapInfra('prisma', 'GoogleUserAuthLink.upsert', e));
    }
  }

  async findActiveByUser(
    userId: string,
    companyId: string,
  ): Promise<Result<DecryptedGoogleUserAuthLink | null, InfraError>> {
    try {
      const record = await this.db.googleUserAuthLink.findUnique({
        where: { userId_companyId: { userId, companyId } },
      });
      if (!record || record.revokedAt) return ok(null);
      return ok(this.decrypt(record));
    } catch (e) {
      return err(wrapInfra('prisma', 'GoogleUserAuthLink.findActiveByUser', e));
    }
  }

  async touchLastUsed(id: string): Promise<Result<void, InfraError>> {
    try {
      await this.db.googleUserAuthLink.update({
        where: { id },
        data:  { lastUsedAt: new Date() },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'GoogleUserAuthLink.touchLastUsed', e));
    }
  }

  async revokeByUser(userId: string, companyId: string): Promise<Result<void, InfraError>> {
    try {
      await this.db.googleUserAuthLink.updateMany({
        where: { userId, companyId, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'GoogleUserAuthLink.revokeByUser', e));
    }
  }
}
