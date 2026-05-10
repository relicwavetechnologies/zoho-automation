/**
 * ZohoConnectionRepository — access to ZohoConnection Prisma model.
 *
 * Responsibilities:
 *   - Find an active (CONNECTED, REST-mode) Zoho connection for a company.
 *   - Update tokens after a successful refresh.
 *   - Record token failure codes.
 *
 * Token encryption/decryption uses the shared AES-256-GCM token.crypto module.
 */

import type { PrismaClient, Prisma } from '../../generated/prisma';
import type { TypedEnv } from '../../config/env';
import { encryptToken, decryptToken } from '../shared/token.crypto';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { ok, err, type Result } from '../../shared/result';

// ─── View type ────────────────────────────────────────────────────────────────

export interface ActiveZohoConnection {
  readonly id:                  string;
  readonly companyId:           string;
  readonly environment:         string;
  readonly scopes:              string[];
  readonly accessToken?:        string;  // decrypted
  readonly refreshToken?:       string;  // decrypted
  readonly refreshTokenCipher?: string;  // encrypted, used to preserve refresh token on access-only refreshes
  readonly accessTokenExpiresAt?: Date;
  readonly tokenMetadata?:      Record<string, unknown>;
  /** Zoho API domain (may be in tokenMetadata). */
  readonly apiDomain?:          string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractApiDomain(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const m = meta as Record<string, unknown>;
  return typeof m['apiDomain'] === 'string' ? m['apiDomain'] : undefined;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class ZohoConnectionRepository {
  constructor(
    private readonly db:  PrismaClient,
    private readonly env: TypedEnv,
  ) {}

  private get cryptoKey(): string {
    return this.env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '';
  }

  private decryptConnection(record: {
    id:                    string;
    companyId:             string;
    environment:           string;
    scopes:                string[];
    accessTokenEncrypted?: string | null;
    refreshTokenEncrypted?: string | null;
    accessTokenExpiresAt?: Date | null;
    tokenMetadata?:        unknown;
  }): ActiveZohoConnection {
    let accessToken: string | undefined;
    let refreshToken: string | undefined;

    if (record.accessTokenEncrypted) {
      try { accessToken = decryptToken(record.accessTokenEncrypted, this.cryptoKey); } catch { /* ignore */ }
    }
    if (record.refreshTokenEncrypted) {
      try { refreshToken = decryptToken(record.refreshTokenEncrypted, this.cryptoKey); } catch { /* ignore */ }
    }

    const meta = record.tokenMetadata && typeof record.tokenMetadata === 'object'
      ? record.tokenMetadata as Record<string, unknown>
      : undefined;

    const apiDomain = extractApiDomain(meta);

    return {
      id:          record.id,
      companyId:   record.companyId,
      environment: record.environment,
      scopes:      record.scopes,
      ...(accessToken                  ? { accessToken }                  : {}),
      ...(refreshToken                 ? { refreshToken }                 : {}),
      ...(record.refreshTokenEncrypted ? { refreshTokenCipher: record.refreshTokenEncrypted } : {}),
      ...(record.accessTokenExpiresAt  ? { accessTokenExpiresAt: record.accessTokenExpiresAt } : {}),
      ...(meta                         ? { tokenMetadata: meta }          : {}),
      ...(apiDomain                    ? { apiDomain }                    : {}),
    };
  }

  /** Find the active REST-mode connection for a company. */
  async findActive(
    companyId:   string,
    environment = 'prod',
  ): Promise<Result<ActiveZohoConnection | null, InfraError>> {
    try {
      const record = await this.db.zohoConnection.findUnique({
        where: { companyId_environment: { companyId, environment } },
      });
      if (!record || record.status !== 'CONNECTED' || record.providerMode === 'mcp') {
        return ok(null);
      }
      return ok(this.decryptConnection(record));
    } catch (e) {
      return err(wrapInfra('prisma', 'ZohoConnection.findActive', e));
    }
  }

  /** Update tokens after a successful refresh. */
  async updateTokens(opts: {
    companyId:            string;
    environment:          string;
    accessToken:          string;
    refreshToken?:        string;
    currentRefreshCipher: string;
    accessTokenExpiresAt: Date;
    tokenMetadataPatch?:  Record<string, unknown>;
  }): Promise<Result<void, InfraError>> {
    try {
      const encryptedAccess   = encryptToken(opts.accessToken, this.cryptoKey);
      const encryptedRefresh  = opts.refreshToken
        ? encryptToken(opts.refreshToken, this.cryptoKey).cipherText
        : opts.currentRefreshCipher;

      // Merge tokenMetadata if patch provided
      let metadataUpdate: Prisma.InputJsonValue | undefined;
      if (opts.tokenMetadataPatch) {
        metadataUpdate = opts.tokenMetadataPatch as Prisma.InputJsonValue;
      }

      await this.db.zohoConnection.update({
        where: { companyId_environment: { companyId: opts.companyId, environment: opts.environment } },
        data:  {
          accessTokenEncrypted:  encryptedAccess.cipherText,
          refreshTokenEncrypted: encryptedRefresh,
          accessTokenExpiresAt:  opts.accessTokenExpiresAt,
          tokenFailureCode:      null,
          lastTokenRefreshAt:    new Date(),
          ...(metadataUpdate ? { tokenMetadata: metadataUpdate } : {}),
        },
      });

      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'ZohoConnection.updateTokens', e));
    }
  }

  /** Record a token refresh failure code. */
  async setFailureCode(
    companyId:   string,
    environment: string,
    code:        string,
  ): Promise<void> {
    try {
      await this.db.zohoConnection.update({
        where: { companyId_environment: { companyId, environment } },
        data:  { tokenFailureCode: code },
      });
    } catch { /* best-effort */ }
  }

  /**
   * Create or update a Zoho connection from an OAuth authorization code exchange.
   * Used by the OAuth callback route to persist the initial token set.
   */
  async upsertFromExchange(opts: {
    companyId:    string;
    environment:  string;
    accessToken:  string;
    refreshToken?: string;
    expiresIn:    number;
    scopes:       string[];
    apiDomain?:   string;
    providerMode?: string;
  }): Promise<Result<void, InfraError>> {
    try {
      const now          = new Date();
      const expiresAt    = new Date(Date.now() + opts.expiresIn * 1000);
      const encAccess    = encryptToken(opts.accessToken, this.cryptoKey).cipherText;
      const encRefresh   = opts.refreshToken ? encryptToken(opts.refreshToken, this.cryptoKey).cipherText : undefined;
      const metaValue    = opts.apiDomain ? { apiDomain: opts.apiDomain } as Prisma.InputJsonValue : undefined;

      await this.db.zohoConnection.upsert({
        where:  { companyId_environment: { companyId: opts.companyId, environment: opts.environment } },
        create: {
          companyId:             opts.companyId,
          environment:           opts.environment,
          status:                'CONNECTED',
          providerMode:          opts.providerMode ?? 'rest',
          connectedAt:           now,
          scopes:                opts.scopes,
          accessTokenEncrypted:  encAccess,
          refreshTokenEncrypted: encRefresh ?? null,
          accessTokenExpiresAt:  expiresAt,
          tokenFailureCode:      null,
          lastTokenRefreshAt:    now,
          ...(metaValue ? { tokenMetadata: metaValue } : {}),
        },
        update: {
          status:                'CONNECTED',
          connectedAt:           now,
          scopes:                opts.scopes,
          accessTokenEncrypted:  encAccess,
          ...(encRefresh ? { refreshTokenEncrypted: encRefresh } : {}),
          accessTokenExpiresAt:  expiresAt,
          tokenFailureCode:      null,
          lastTokenRefreshAt:    now,
          ...(metaValue ? { tokenMetadata: metaValue } : {}),
        },
      });

      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'ZohoConnection.upsertFromExchange', e));
    }
  }
}
