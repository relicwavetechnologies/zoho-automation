/**
 * LarkUserAuthLinkRepository — persists and retrieves per-user Lark OAuth tokens.
 *
 * Tokens are stored AES-256-GCM encrypted. All read methods return decrypted
 * plaintext tokens ready for use. Callers never handle raw ciphertext.
 */

import type { PrismaClient } from '../../generated/prisma';
import { encryptToken, decryptToken, TokenCryptoError } from '../shared/token.crypto';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra } from '../../shared/errors';
import type { InfraError } from '../../shared/errors';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LarkUserAuthLinkRecord {
  userId:                string;
  companyId:             string;
  larkTenantKey:         string;
  larkOpenId:            string | null;
  larkUserId:            string | null;
  larkEmail:             string;
  larkName:              string | null;
  accessToken:           string;           // plaintext
  refreshToken:          string | null;    // plaintext
  tokenType:             string | null;
  accessTokenExpiresAt:  Date   | null;
  refreshTokenExpiresAt: Date   | null;
}

export interface UpsertLarkUserAuthLinkInput {
  userId:                string;
  companyId:             string;
  larkTenantKey:         string;
  larkEmail:             string;
  accessToken:           string;           // plaintext — will be encrypted
  refreshToken?:         string | null;
  tokenType?:            string;
  larkOpenId?:           string | null;
  larkUserId?:           string | null;
  larkName?:             string | null;
  accessTokenExpiresAt?: Date   | null;
  refreshTokenExpiresAt?:Date   | null;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class LarkUserAuthLinkRepository {
  constructor(
    private readonly prisma:         PrismaClient,
    private readonly encryptionKey:  string,
  ) {}

  async upsert(input: UpsertLarkUserAuthLinkInput): Promise<Result<void, InfraError>> {
    try {
      const accessTokenEncrypted  = encryptToken(input.accessToken, this.encryptionKey).cipherText;
      const refreshTokenEncrypted = input.refreshToken
        ? encryptToken(input.refreshToken, this.encryptionKey).cipherText
        : null;

      await this.prisma.larkUserAuthLink.upsert({
        where:  { userId_companyId: { userId: input.userId, companyId: input.companyId } },
        create: {
          userId:                input.userId,
          companyId:             input.companyId,
          larkTenantKey:         input.larkTenantKey,
          larkEmail:             input.larkEmail,
          accessTokenEncrypted,
          ...(refreshTokenEncrypted            ? { refreshTokenEncrypted }                       : {}),
          ...(input.tokenType                  ? { tokenType: input.tokenType }                  : {}),
          ...(input.larkOpenId   !== undefined ? { larkOpenId:   input.larkOpenId }              : {}),
          ...(input.larkUserId   !== undefined ? { larkUserId:   input.larkUserId }              : {}),
          ...(input.larkName     !== undefined ? { larkName:     input.larkName }                : {}),
          ...(input.accessTokenExpiresAt  != null ? { accessTokenExpiresAt:  input.accessTokenExpiresAt }  : {}),
          ...(input.refreshTokenExpiresAt != null ? { refreshTokenExpiresAt: input.refreshTokenExpiresAt } : {}),
          linkedAt:   new Date(),
          lastUsedAt: new Date(),
        },
        update: {
          larkTenantKey:         input.larkTenantKey,
          larkEmail:             input.larkEmail,
          accessTokenEncrypted,
          ...(refreshTokenEncrypted            ? { refreshTokenEncrypted }                       : {}),
          ...(input.tokenType                  ? { tokenType: input.tokenType }                  : {}),
          ...(input.larkOpenId   !== undefined ? { larkOpenId:   input.larkOpenId }              : {}),
          ...(input.larkUserId   !== undefined ? { larkUserId:   input.larkUserId }              : {}),
          ...(input.larkName     !== undefined ? { larkName:     input.larkName }                : {}),
          ...(input.accessTokenExpiresAt  != null ? { accessTokenExpiresAt:  input.accessTokenExpiresAt }  : {}),
          ...(input.refreshTokenExpiresAt != null ? { refreshTokenExpiresAt: input.refreshTokenExpiresAt } : {}),
          revokedAt:  null,
          lastUsedAt: new Date(),
        },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'lark_user_auth_link', e));
    }
  }

  async findByUserId(
    userId:    string,
    companyId: string,
  ): Promise<Result<LarkUserAuthLinkRecord | null, InfraError>> {
    try {
      const row = await this.prisma.larkUserAuthLink.findUnique({
        where: { userId_companyId: { userId, companyId } },
      });
      if (!row || row.revokedAt) return ok(null);
      return ok(this.decrypt(row));
    } catch (e) {
      return err(wrapInfra('prisma', 'lark_user_auth_link', e));
    }
  }

  async findByLarkOpenId(
    larkOpenId: string,
    companyId:  string,
  ): Promise<Result<LarkUserAuthLinkRecord | null, InfraError>> {
    try {
      const row = await this.prisma.larkUserAuthLink.findFirst({
        where: { larkOpenId, companyId, revokedAt: null },
      });
      if (!row) return ok(null);
      return ok(this.decrypt(row));
    } catch (e) {
      return err(wrapInfra('prisma', 'lark_user_auth_link', e));
    }
  }

  async revoke(userId: string, companyId: string): Promise<Result<boolean, InfraError>> {
    try {
      const existing = await this.prisma.larkUserAuthLink.findUnique({
        where:  { userId_companyId: { userId, companyId } },
        select: { id: true },
      });
      if (!existing) return ok(false);

      await this.prisma.larkUserAuthLink.update({
        where: { userId_companyId: { userId, companyId } },
        data:  { revokedAt: new Date() },
      });
      return ok(true);
    } catch (e) {
      return err(wrapInfra('prisma', 'lark_user_auth_link', e));
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private decrypt(row: {
    userId:                string;
    companyId:             string;
    larkTenantKey:         string;
    larkOpenId:            string | null;
    larkUserId:            string | null;
    larkEmail:             string;
    larkName:              string | null;
    accessTokenEncrypted:  string;
    refreshTokenEncrypted: string | null;
    tokenType:             string | null;
    accessTokenExpiresAt:  Date   | null;
    refreshTokenExpiresAt: Date   | null;
  }): LarkUserAuthLinkRecord {
    let accessToken: string;
    try {
      accessToken = decryptToken(row.accessTokenEncrypted, this.encryptionKey);
    } catch (e) {
      throw new TokenCryptoError(`Failed to decrypt Lark access token for user ${row.userId}: ${String(e)}`);
    }

    let refreshToken: string | null = null;
    if (row.refreshTokenEncrypted) {
      try {
        refreshToken = decryptToken(row.refreshTokenEncrypted, this.encryptionKey);
      } catch {
        // Non-fatal — access token may still be valid
        refreshToken = null;
      }
    }

    return {
      userId:                row.userId,
      companyId:             row.companyId,
      larkTenantKey:         row.larkTenantKey,
      larkOpenId:            row.larkOpenId,
      larkUserId:            row.larkUserId,
      larkEmail:             row.larkEmail,
      larkName:              row.larkName,
      accessToken,
      refreshToken,
      tokenType:             row.tokenType,
      accessTokenExpiresAt:  row.accessTokenExpiresAt,
      refreshTokenExpiresAt: row.refreshTokenExpiresAt,
    };
  }
}
