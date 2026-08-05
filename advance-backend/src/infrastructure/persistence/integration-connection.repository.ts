import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import type { TypedEnv } from '../../config/env';
import { encryptToken, decryptToken } from '../shared/token.crypto';
import { err, ok, type Result } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type { ConnectionProvider } from '../../domain/connections/connection-provider';
import { normalizeShopDomain } from '../../domain/shopify/shopify-shop';

export type IntegrationProvider = ConnectionProvider;

/**
 * A connection whose stored credential no longer works and cannot be repaired
 * without the owner supplying a new one.
 *
 * Every OAuth provider here refreshes itself, so this state never applied to
 * them. AITable authenticates with a personal API key that its owner can
 * regenerate at any time, which silently invalidates the stored copy — without
 * a state of its own that failure is indistinguishable from a permissions
 * problem and repeats forever.
 */
export const CONNECTION_NEEDS_KEY = 'needs_key';
export const CONNECTION_REAUTHORIZATION_REQUIRED = 'reauthorization_required';

/** Statuses a connection can hold and still be worth showing to its owner. */
const LISTABLE_STATUSES = ['connected', CONNECTION_NEEDS_KEY];

/**
 * Stable identifier for a raw API key. Only ever used to recognise the same key
 * again — the key itself is encrypted, and this never leaves the backend.
 */
export const apiKeyFingerprint = (apiKey: string): string =>
  createHash('sha256').update(apiKey.trim()).digest('hex');
export type IntegrationOwnerType = 'user' | 'company';
export type IntegrationGrantAccess = 'read_only' | 'read_write' | 'admin';
export type IntegrationGranteeType = 'user' | 'department' | 'role' | 'company';

export interface DecryptedIntegrationConnection {
  readonly id: string;
  readonly companyId: string;
  readonly provider: IntegrationProvider;
  readonly ownerType: IntegrationOwnerType;
  readonly ownerUserId?: string;
  readonly label: string;
  readonly accountEmail?: string;
  readonly accountName?: string;
  readonly externalAccountId?: string;
  readonly status: string;
  readonly scopes: string[];
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly tokenType?: string;
  readonly accessTokenExpiresAt?: Date;
  readonly refreshTokenExpiresAt?: Date;
  readonly tokenVersion: number;
  readonly tokenMetadata?: Record<string, unknown>;
  /** Decrypted only in backend memory for this Zoho connection's refresh call. */
  readonly zohoClientCredentials?: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly accountsBaseUrl: string;
  };
  readonly connectedAt: Date;
  readonly lastUsedAt?: Date;
  readonly revokedAt?: Date;
  readonly createdBy?: string;
}

export interface ConnectionSummary {
  readonly connectionId: string;
  readonly provider: IntegrationProvider;
  readonly label: string;
  readonly accountEmail?: string;
  readonly accountName?: string;
  readonly ownerType: IntegrationOwnerType;
  readonly ownerUserId?: string;
  readonly access: IntegrationGrantAccess;
  readonly scopes: string[];
  readonly connectedAt: Date;
  readonly lastUsedAt?: Date;
  /** Only set by providers that list unusable connections — see CONNECTION_NEEDS_KEY. */
  readonly status?: string;
}

export interface ManageableShopifyConnection {
  readonly connectionId: string;
  readonly shopDomain: string;
  readonly label: string;
  readonly status: 'connected' | typeof CONNECTION_REAUTHORIZATION_REQUIRED;
  readonly connectedAt: Date;
}

export interface UpsertGoogleConnectionInput {
  readonly companyId: string;
  readonly ownerType: IntegrationOwnerType;
  readonly ownerUserId?: string;
  readonly createdBy?: string;
  readonly label?: string;
  readonly googleUserId?: string;
  readonly googleEmail?: string;
  readonly googleName?: string;
  readonly scope?: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType?: string;
  readonly accessTokenExpiresAt?: Date;
  readonly refreshTokenExpiresAt?: Date;
  readonly tokenMetadata?: Record<string, unknown>;
  readonly initialAccess?: IntegrationGrantAccess;
  /** Atomically releases this OAuth continuation with the connection/grant. */
  readonly authorizationIntentId?: string;
}

/**
 * An OAuth authorization to Canva's remote MCP server. `externalAccountId` is
 * provider-derived when available; the OAuth subject is otherwise stored in
 * token metadata so a user may intentionally link more than one Canva account.
 */
export interface UpsertCanvaConnectionInput {
  readonly companyId: string;
  readonly ownerType: IntegrationOwnerType;
  readonly ownerUserId?: string;
  readonly createdBy?: string;
  readonly label?: string;
  readonly externalAccountId: string;
  readonly accountEmail?: string;
  readonly accountName?: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType?: string;
  readonly accessTokenExpiresAt?: Date;
  readonly scopes?: string[];
  readonly tokenMetadata?: Record<string, unknown>;
  readonly initialAccess?: IntegrationGrantAccess;
}

/**
 * An OAuth authorization to Airtable's hosted MCP server. Airtable registers
 * clients dynamically, so the resulting client registration and OAuth server
 * discovery state travel with the connection in `tokenMetadata` — they are what
 * lets a later token refresh rebuild the exact client that received the grant.
 */
export interface UpsertAirtableConnectionInput {
  readonly companyId: string;
  readonly ownerType: IntegrationOwnerType;
  readonly ownerUserId?: string;
  readonly createdBy?: string;
  readonly label?: string;
  readonly externalAccountId: string;
  readonly accountEmail?: string;
  readonly accountName?: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType?: string;
  readonly accessTokenExpiresAt?: Date;
  readonly scopes?: string[];
  readonly tokenMetadata?: Record<string, unknown>;
  readonly initialAccess?: IntegrationGrantAccess;
}

/**
 * An AITable personal API key that has already been proven to work.
 *
 * There is no OAuth here and nothing to refresh: the key is minted by hand in
 * AITable's User Center and is valid until its owner regenerates it. So the
 * only safe moment to find out whether a key works is before it is stored,
 * which is why callers must supply the workspace list a live check returned —
 * a caller cannot construct this input without having made that call.
 */
export interface UpsertAitableConnectionInput {
  readonly companyId: string;
  readonly ownerType: IntegrationOwnerType;
  readonly ownerUserId?: string;
  readonly createdBy?: string;
  readonly label?: string;
  readonly apiKey: string;
  /** Workspaces the live check saw. Names the connection and reports its reach. */
  readonly spaces: readonly { readonly id: string; readonly name: string }[];
  readonly initialAccess?: IntegrationGrantAccess;
}

/** One Shopify shop installation. The canonical myshopify domain is the account ID. */
export interface UpsertShopifyConnectionInput {
  readonly companyId: string;
  readonly ownerType: IntegrationOwnerType;
  readonly ownerUserId?: string;
  readonly createdBy?: string;
  readonly label?: string;
  readonly shopDomain: string;
  readonly shopName?: string;
  readonly shopGraphqlId?: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accessTokenExpiresAt?: Date;
  readonly refreshTokenExpiresAt?: Date;
  readonly scopes: string[];
  readonly apiVersion: string;
  /** Atomically completes this claimed OAuth attempt and writes its audit row. */
  readonly authorizationAttemptId?: string;
}

/** A user-authorised Lark account. One Divo member may own multiple accounts. */
export interface UpsertLarkConnectionInput {
  readonly companyId: string;
  readonly ownerType: IntegrationOwnerType;
  readonly ownerUserId?: string;
  readonly createdBy?: string;
  readonly label?: string;
  readonly larkOpenId: string;
  readonly larkUserId?: string | null;
  readonly larkTenantKey?: string | null;
  readonly larkEmail?: string | null;
  readonly larkName?: string | null;
  readonly accessToken: string;
  readonly refreshToken?: string | null;
  readonly tokenType?: string | null;
  readonly accessTokenExpiresAt?: Date | null;
  readonly refreshTokenExpiresAt?: Date | null;
  readonly scopes: string[];
  readonly initialAccess?: IntegrationGrantAccess;
}

const GOOGLE_PROVIDER: IntegrationProvider = 'google_workspace';
const ZOHO_PROVIDER: IntegrationProvider = 'zoho';
const CANVA_PROVIDER: IntegrationProvider = 'canva';
const AIRTABLE_PROVIDER: IntegrationProvider = 'airtable';
const AITABLE_PROVIDER: IntegrationProvider = 'aitable';
const LARK_PROVIDER: IntegrationProvider = 'lark';
const SHOPIFY_PROVIDER: IntegrationProvider = 'shopify';
const COMPANY_ROLE_GRANTEES = new Set(['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN']);

const splitScopes = (scope?: string | null): string[] =>
  scope?.split(' ').map(s => s.trim()).filter(Boolean) ?? [];

const accessRank: Record<IntegrationGrantAccess, number> = {
  read_only:  1,
  read_write: 2,
  admin:      3,
};

function bestAccess(values: IntegrationGrantAccess[]): IntegrationGrantAccess {
  return values.sort((a, b) => accessRank[b] - accessRank[a])[0] ?? 'read_only';
}

function dedupeKey(input: {
  readonly provider?: IntegrationProvider;
  readonly ownerType: IntegrationOwnerType;
  readonly ownerUserId?: string | undefined;
  readonly accountEmail?: string | undefined;
  readonly externalAccountId?: string | undefined;
  readonly googleEmail?: string | undefined;
  readonly googleUserId?: string | undefined;
}): string {
  const provider = input.provider ?? GOOGLE_PROVIDER;
  const account = (
    input.accountEmail ||
    input.externalAccountId ||
    input.googleEmail ||
    input.googleUserId ||
    'unknown'
  ).trim().toLowerCase();
  if (input.ownerType === 'user') return `${provider}:user:${input.ownerUserId ?? 'unknown'}:${account}`;
  return `${provider}:company:${account}`;
}

export class IntegrationConnectionRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly env: TypedEnv,
  ) {}

  private get key(): string {
    return this.env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '';
  }

  private get integrationKey(): string {
    return this.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ?? this.key;
  }

  private decrypt(record: {
    id: string;
    companyId: string;
    provider: string;
    ownerType: string;
    ownerUserId?: string | null;
    label: string;
    accountEmail?: string | null;
    accountName?: string | null;
    externalAccountId?: string | null;
    status: string;
    scopes: string[];
    accessTokenEncrypted?: string | null;
    refreshTokenEncrypted?: string | null;
    tokenType?: string | null;
    tokenCipherVersion: number;
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    tokenVersion: number;
    tokenMetadata?: unknown;
    connectedAt: Date;
    lastUsedAt?: Date | null;
    revokedAt?: Date | null;
    createdBy?: string | null;
  }): DecryptedIntegrationConnection {
    const tokenMetadata = record.tokenMetadata
      && typeof record.tokenMetadata === 'object'
      && !Array.isArray(record.tokenMetadata)
      ? record.tokenMetadata as Record<string, unknown>
      : undefined;
    const storedZohoClient = tokenMetadata?.['zohoClient'];
    let zohoClientCredentials: DecryptedIntegrationConnection['zohoClientCredentials'];
    if (
      record.provider === ZOHO_PROVIDER
      && storedZohoClient
      && typeof storedZohoClient === 'object'
      && !Array.isArray(storedZohoClient)
    ) {
      const client = storedZohoClient as Record<string, unknown>;
      if (
        typeof client['clientId'] === 'string'
        && typeof client['clientSecretEncrypted'] === 'string'
        && typeof client['accountsBaseUrl'] === 'string'
      ) {
        zohoClientCredentials = {
          clientId: client['clientId'],
          clientSecret: decryptToken(client['clientSecretEncrypted'], this.key),
          accountsBaseUrl: client['accountsBaseUrl'],
        };
      }
    }

    const credentialKey = record.tokenCipherVersion >= 2 ? this.integrationKey : this.key;
    return {
      id:          record.id,
      companyId:   record.companyId,
      provider:    record.provider as IntegrationProvider,
      ownerType:   record.ownerType as IntegrationOwnerType,
      ...(record.ownerUserId ? { ownerUserId: record.ownerUserId } : {}),
      label:       record.label,
      ...(record.accountEmail ? { accountEmail: record.accountEmail } : {}),
      ...(record.accountName ? { accountName: record.accountName } : {}),
      ...(record.externalAccountId ? { externalAccountId: record.externalAccountId } : {}),
      status:      record.status,
      scopes:      record.scopes,
      ...(record.accessTokenEncrypted ? { accessToken: decryptToken(record.accessTokenEncrypted, credentialKey) } : {}),
      ...(record.refreshTokenEncrypted ? { refreshToken: decryptToken(record.refreshTokenEncrypted, credentialKey) } : {}),
      ...(record.tokenType ? { tokenType: record.tokenType } : {}),
      ...(record.accessTokenExpiresAt ? { accessTokenExpiresAt: record.accessTokenExpiresAt } : {}),
      ...(record.refreshTokenExpiresAt ? { refreshTokenExpiresAt: record.refreshTokenExpiresAt } : {}),
      tokenVersion: record.tokenVersion,
      ...(tokenMetadata ? { tokenMetadata } : {}),
      ...(zohoClientCredentials ? { zohoClientCredentials } : {}),
      connectedAt: record.connectedAt,
      ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
      ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
      ...(record.createdBy ? { createdBy: record.createdBy } : {}),
    };
  }

  async upsertGoogleConnection(
    input: UpsertGoogleConnectionInput,
  ): Promise<Result<DecryptedIntegrationConnection, InfraError>> {
    try {
      const encryptedAccess = encryptToken(input.accessToken, this.key);
      const encryptedRefresh = input.refreshToken ? encryptToken(input.refreshToken, this.key) : undefined;
      const scopes = splitScopes(input.scope);
      const accountEmail = input.googleEmail?.trim().toLowerCase() || null;
      const accountName = input.googleName?.trim() || accountEmail || 'Google Workspace';
      const label = input.label?.trim() || `${accountName} Google Workspace`;
      const key = dedupeKey({
        provider: GOOGLE_PROVIDER,
        ownerType: input.ownerType,
        ownerUserId: input.ownerUserId,
        accountEmail: input.googleEmail,
        externalAccountId: input.googleUserId,
      });
      if (input.authorizationIntentId && !input.ownerUserId) {
        throw new Error('A Google authorization intent requires a user-owned connection.');
      }

      const record = await this.db.$transaction(async (tx) => {
        const saved = await tx.integrationConnection.upsert({
          where: { companyId_dedupeKey: { companyId: input.companyId, dedupeKey: key } },
          create: {
          companyId:             input.companyId,
          provider:              GOOGLE_PROVIDER,
          ownerType:             input.ownerType,
          ownerUserId:           input.ownerType === 'user' ? input.ownerUserId ?? null : null,
          label,
          accountEmail,
          accountName,
          externalAccountId:     input.googleUserId ?? null,
          dedupeKey:             key,
          status:                'connected',
          scopes,
          accessTokenEncrypted:  encryptedAccess.cipherText,
          ...(encryptedRefresh ? { refreshTokenEncrypted: encryptedRefresh.cipherText } : {}),
          tokenType:             input.tokenType ?? null,
          accessTokenExpiresAt:  input.accessTokenExpiresAt ?? null,
          refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
          ...(input.tokenMetadata ? { tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue } : {}),
          createdBy:             input.createdBy ?? input.ownerUserId ?? null,
          connectedAt:           new Date(),
        },
          update: {
          label,
          accountEmail,
          accountName,
          externalAccountId:     input.googleUserId ?? null,
          status:                'connected',
          scopes,
          accessTokenEncrypted:  encryptedAccess.cipherText,
          ...(encryptedRefresh ? { refreshTokenEncrypted: encryptedRefresh.cipherText } : {}),
          tokenType:             input.tokenType ?? null,
          accessTokenExpiresAt:  input.accessTokenExpiresAt ?? null,
          refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
          ...(input.tokenMetadata ? { tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue } : {}),
          revokedAt:             null,
          connectedAt:           new Date(),
          },
        });

        const initialUserGrant = input.ownerType === 'user' ? input.ownerUserId : input.createdBy;
        if (initialUserGrant) {
          await tx.integrationConnectionGrant.upsert({
            where: {
              connectionId_granteeType_granteeId: {
                connectionId: saved.id,
                granteeType: 'user',
                granteeId: initialUserGrant,
              },
            },
            create: {
              companyId: input.companyId,
              connectionId: saved.id,
              granteeType: 'user',
              granteeId: initialUserGrant,
              access: input.initialAccess ?? 'admin',
              grantedBy: input.createdBy ?? initialUserGrant,
            },
            update: {
              access: input.initialAccess ?? 'admin',
              grantedBy: input.createdBy ?? initialUserGrant,
              grantedAt: new Date(),
              revokedAt: null,
            },
          });
        }

        if (input.authorizationIntentId) {
          const completed = await tx.connectionAuthorizationIntent.updateMany({
            where: {
              id: input.authorizationIntentId,
              companyId: input.companyId,
              userId: input.ownerUserId!,
              status: 'exchanging',
            },
            data: {
              status: 'connected',
              connectionId: saved.id,
              connectedAt: new Date(),
              continuationStatus: 'pending',
              continuationQueuedAt: new Date(),
              failureCode: null,
              authorizationCodeEncrypted: null,
              exchangeTokensEncrypted: null,
            },
          });
          if (completed.count !== 1) {
            throw new Error('Google authorization intent was no longer claimable.');
          }
        }
        return saved;
      });

      return ok(this.decrypt(record));
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.upsertGoogleConnection', e));
    }
  }

  async upsertZohoConnection(input: {
    readonly companyId: string;
    readonly ownerType: IntegrationOwnerType;
    readonly ownerUserId?: string;
    readonly createdBy?: string;
    readonly label?: string;
    readonly accountEmail?: string;
    readonly accountName?: string;
    readonly externalAccountId?: string;
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly tokenType?: string;
    readonly accessTokenExpiresAt?: Date;
    readonly refreshTokenExpiresAt?: Date;
    readonly scopes: string[];
    readonly apiDomain?: string;
    readonly accountsBaseUrl?: string;
    readonly apiBaseUrl?: string;
    readonly selfClientOAuth?: {
      readonly clientId: string;
      readonly clientSecret: string;
    };
    readonly environment?: string;
    readonly initialAccess?: IntegrationGrantAccess;
  }): Promise<Result<DecryptedIntegrationConnection, InfraError>> {
    try {
      const encryptedAccess = encryptToken(input.accessToken, this.key);
      const encryptedRefresh = input.refreshToken ? encryptToken(input.refreshToken, this.key) : undefined;
      const account = input.accountEmail?.trim().toLowerCase()
        || input.externalAccountId?.trim()
        || input.ownerUserId
        || 'zoho-account';
      const label = input.label?.trim()
        || `${input.accountName?.trim() || input.accountEmail?.trim() || 'Zoho'} connection`;
      const key = dedupeKey({
        provider: ZOHO_PROVIDER,
        ownerType: input.ownerType,
        ownerUserId: input.ownerUserId,
        accountEmail: input.accountEmail,
        externalAccountId: input.externalAccountId ?? account,
      });
      const tokenMetadata = {
        ...(input.apiDomain ? { apiDomain: input.apiDomain } : {}),
        ...(input.accountsBaseUrl ? { accountsBaseUrl: input.accountsBaseUrl } : {}),
        ...(input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {}),
        ...(input.selfClientOAuth ? {
          enforcedAccess: 'read_only',
          zohoClient: {
            clientId: input.selfClientOAuth.clientId.trim(),
            clientSecretEncrypted: encryptToken(input.selfClientOAuth.clientSecret.trim(), this.key).cipherText,
            accountsBaseUrl: input.accountsBaseUrl,
          },
        } : {}),
        environment: input.environment ?? 'prod',
      };

      const record = await this.db.integrationConnection.upsert({
        where: { companyId_dedupeKey: { companyId: input.companyId, dedupeKey: key } },
        create: {
          companyId:             input.companyId,
          provider:              ZOHO_PROVIDER,
          ownerType:             input.ownerType,
          ownerUserId:           input.ownerType === 'user' ? input.ownerUserId ?? null : null,
          label,
          accountEmail:          input.accountEmail?.trim().toLowerCase() ?? null,
          accountName:           input.accountName?.trim() ?? null,
          externalAccountId:     input.externalAccountId ?? account,
          dedupeKey:             key,
          status:                'connected',
          scopes:                input.scopes,
          accessTokenEncrypted:  encryptedAccess.cipherText,
          ...(encryptedRefresh ? { refreshTokenEncrypted: encryptedRefresh.cipherText } : {}),
          tokenType:             input.tokenType ?? null,
          accessTokenExpiresAt:  input.accessTokenExpiresAt ?? null,
          refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
          tokenMetadata:         tokenMetadata as Prisma.InputJsonValue,
          createdBy:             input.createdBy ?? input.ownerUserId ?? null,
          connectedAt:           new Date(),
        },
        update: {
          label,
          accountEmail:          input.accountEmail?.trim().toLowerCase() ?? null,
          accountName:           input.accountName?.trim() ?? null,
          externalAccountId:     input.externalAccountId ?? account,
          status:                'connected',
          scopes:                input.scopes,
          accessTokenEncrypted:  encryptedAccess.cipherText,
          ...(encryptedRefresh ? { refreshTokenEncrypted: encryptedRefresh.cipherText } : {}),
          tokenType:             input.tokenType ?? null,
          accessTokenExpiresAt:  input.accessTokenExpiresAt ?? null,
          refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
          tokenMetadata:         tokenMetadata as Prisma.InputJsonValue,
          revokedAt:             null,
          connectedAt:           new Date(),
        },
      });

      const initialUserGrant = input.ownerType === 'user' ? input.ownerUserId : input.createdBy;
      if (initialUserGrant) {
        await this.grantConnection({
          companyId:    input.companyId,
          connectionId: record.id,
          granteeType:  'user',
          granteeId:    initialUserGrant,
          access:       input.initialAccess ?? 'admin',
          grantedBy:    input.createdBy ?? initialUserGrant,
        });
      }

      return ok(this.decrypt(record));
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.upsertZohoConnection', e));
    }
  }

  async upsertCanvaConnection(
    input: UpsertCanvaConnectionInput,
  ): Promise<Result<DecryptedIntegrationConnection, InfraError>> {
    try {
      const encryptedAccess = encryptToken(input.accessToken, this.key);
      const encryptedRefresh = input.refreshToken ? encryptToken(input.refreshToken, this.key) : undefined;
      const externalAccountId = input.externalAccountId.trim();
      const accountEmail = input.accountEmail?.trim().toLowerCase() ?? null;
      const accountName = input.accountName?.trim() ?? null;
      const label = input.label?.trim()
        || `${accountName ?? accountEmail ?? 'Canva'} connection`;
      const key = dedupeKey({
        provider: CANVA_PROVIDER,
        ownerType: input.ownerType,
        ownerUserId: input.ownerUserId,
        accountEmail: input.accountEmail,
        externalAccountId,
      });

      const record = await this.db.integrationConnection.upsert({
        where: { companyId_dedupeKey: { companyId: input.companyId, dedupeKey: key } },
        create: {
          companyId:             input.companyId,
          provider:              CANVA_PROVIDER,
          ownerType:             input.ownerType,
          ownerUserId:           input.ownerType === 'user' ? input.ownerUserId ?? null : null,
          label,
          accountEmail,
          accountName,
          externalAccountId,
          dedupeKey:             key,
          status:                'connected',
          scopes:                input.scopes ?? [],
          accessTokenEncrypted:  encryptedAccess.cipherText,
          ...(encryptedRefresh ? { refreshTokenEncrypted: encryptedRefresh.cipherText } : {}),
          tokenType:             input.tokenType ?? null,
          accessTokenExpiresAt:  input.accessTokenExpiresAt ?? null,
          ...(input.tokenMetadata ? { tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue } : {}),
          createdBy:             input.createdBy ?? input.ownerUserId ?? null,
          connectedAt:           new Date(),
        },
        update: {
          label,
          accountEmail,
          accountName,
          externalAccountId,
          status:                'connected',
          scopes:                input.scopes ?? [],
          accessTokenEncrypted:  encryptedAccess.cipherText,
          ...(encryptedRefresh ? { refreshTokenEncrypted: encryptedRefresh.cipherText } : {}),
          tokenType:             input.tokenType ?? null,
          accessTokenExpiresAt:  input.accessTokenExpiresAt ?? null,
          ...(input.tokenMetadata ? { tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue } : {}),
          revokedAt:             null,
          connectedAt:           new Date(),
        },
      });

      const initialUserGrant = input.ownerType === 'user' ? input.ownerUserId : input.createdBy;
      if (initialUserGrant) {
        await this.grantConnection({
          companyId:    input.companyId,
          connectionId: record.id,
          granteeType:  'user',
          granteeId:    initialUserGrant,
          access:       input.initialAccess ?? 'admin',
          grantedBy:    input.createdBy ?? initialUserGrant,
        });
      }

      return ok(this.decrypt(record));
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.upsertCanvaConnection', e));
    }
  }

  async upsertLarkConnection(
    input: UpsertLarkConnectionInput,
  ): Promise<Result<DecryptedIntegrationConnection, InfraError>> {
    try {
      const tenantKey = input.larkTenantKey?.trim();
      const actorUserId = input.ownerType === 'user' ? input.ownerUserId : input.createdBy;
      if (!tenantKey || !actorUserId) {
        throw new Error('A verified Lark tenant and owner are required');
      }
      const encryptedAccess = encryptToken(input.accessToken, this.key);
      const encryptedRefresh = input.refreshToken ? encryptToken(input.refreshToken, this.key) : undefined;
      const externalAccountId = input.larkOpenId.trim();
      const accountEmail = input.larkEmail?.trim().toLowerCase() ?? null;
      const accountName = input.larkName?.trim() ?? accountEmail ?? null;
      const label = input.label?.trim() || `${accountName ?? accountEmail ?? 'Lark'} connection`;
      const key = dedupeKey({
        provider: LARK_PROVIDER,
        ownerType: input.ownerType,
        ownerUserId: input.ownerUserId,
        externalAccountId: `${tenantKey}:${externalAccountId}`,
      });
      const tokenMetadata = {
        larkOpenId: externalAccountId,
        ...(input.larkUserId ? { larkUserId: input.larkUserId } : {}),
        larkTenantKey: tenantKey,
      };

      const record = await this.db.$transaction(async tx => {
        const [binding, identity, membership] = await Promise.all([
          tx.larkTenantBinding.findFirst({
            where: {
              companyId: input.companyId,
              larkTenantKey: tenantKey,
              isActive: true,
            },
            select: { id: true },
          }),
          tx.channelIdentity.findFirst({
            where: {
              companyId: input.companyId,
              channel: 'lark',
              externalTenantId: tenantKey,
              larkOpenId: externalAccountId,
            },
            select: { id: true },
          }),
          tx.adminMembership.findFirst({
            where: {
              companyId: input.companyId,
              userId: actorUserId,
              isActive: true,
            },
            select: { id: true },
          }),
        ]);
        if (!binding || !identity || !membership) {
          throw new Error('The Lark tenant, account identity, or company membership is no longer active');
        }

        const connectionData = {
          label,
          accountEmail,
          accountName,
          externalAccountId,
          status: 'connected',
          scopes: input.scopes,
          accessTokenEncrypted: encryptedAccess.cipherText,
          ...(encryptedRefresh ? { refreshTokenEncrypted: encryptedRefresh.cipherText } : {}),
          tokenType: input.tokenType ?? null,
          accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
          refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
          tokenMetadata: tokenMetadata as Prisma.InputJsonValue,
          revokedAt: null,
          connectedAt: new Date(),
        };
        const current = await tx.integrationConnection.findUnique({
          where: { companyId_dedupeKey: { companyId: input.companyId, dedupeKey: key } },
        });
        const legacy = current ?? await tx.integrationConnection.findFirst({
          where: {
            companyId: input.companyId,
            provider: LARK_PROVIDER,
            ownerType: input.ownerType,
            ownerUserId: input.ownerType === 'user' ? input.ownerUserId ?? null : null,
            externalAccountId,
            tokenMetadata: {
              path: ['larkTenantKey'],
              equals: tenantKey,
            },
          },
          orderBy: { updatedAt: 'desc' },
        });
        const saved = legacy
          ? await tx.integrationConnection.update({
              where: { id: legacy.id },
              data: { ...connectionData, dedupeKey: key },
            })
          : await tx.integrationConnection.create({
              data: {
                companyId: input.companyId,
                provider: LARK_PROVIDER,
                ownerType: input.ownerType,
                ownerUserId: input.ownerType === 'user' ? input.ownerUserId ?? null : null,
                dedupeKey: key,
                createdBy: input.createdBy ?? input.ownerUserId ?? null,
                ...connectionData,
              },
            });

        await tx.integrationConnectionGrant.upsert({
          where: {
            connectionId_granteeType_granteeId: {
              connectionId: saved.id,
              granteeType: 'user',
              granteeId: actorUserId,
            },
          },
          create: {
            companyId: input.companyId,
            connectionId: saved.id,
            granteeType: 'user',
            granteeId: actorUserId,
            access: input.initialAccess ?? 'admin',
            grantedBy: input.createdBy ?? actorUserId,
          },
          update: {
            access: input.initialAccess ?? 'admin',
            grantedBy: input.createdBy ?? actorUserId,
            grantedAt: new Date(),
            revokedAt: null,
          },
        });
        return saved;
      });

      return ok(this.decrypt(record));
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.upsertLarkConnection', e));
    }
  }

  async grantConnection(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly granteeType: IntegrationGranteeType;
    readonly granteeId: string;
    readonly access: IntegrationGrantAccess;
    readonly grantedBy: string;
  }): Promise<Result<void, InfraError>> {
    try {
      if (!input.granteeId.trim()) throw new Error('Connection grantee is required.');
      await this.db.$transaction(async tx => {
        const connection = await tx.integrationConnection.findFirst({
          where: { id: input.connectionId, companyId: input.companyId, revokedAt: null },
          select: { provider: true },
        });
        if (!connection) throw new Error('Connection does not belong to this company.');
        if (connection.provider === SHOPIFY_PROVIDER && input.access !== 'read_only') {
          throw new Error('Shopify connections expose read-only grants.');
        }
        const granteeExists = input.granteeType === 'company'
          ? Boolean(await tx.company.findUnique({ where: { id: input.granteeId }, select: { id: true } })
            && input.granteeId === input.companyId)
          : input.granteeType === 'user'
            ? Boolean(await tx.adminMembership.findFirst({
              where: { companyId: input.companyId, userId: input.granteeId, isActive: true },
              select: { id: true },
            }))
            : input.granteeType === 'department'
              ? Boolean(await tx.department.findFirst({
                where: { id: input.granteeId, companyId: input.companyId, status: 'active' },
                select: { id: true },
              }))
              : COMPANY_ROLE_GRANTEES.has(input.granteeId) || Boolean(await tx.departmentRole.findFirst({
                where: { id: input.granteeId, department: { companyId: input.companyId, status: 'active' } },
                select: { id: true },
              }));
        if (!granteeExists) throw new Error('Connection grantee does not belong to this company.');
        const grantor = await tx.adminMembership.findFirst({
          where: { companyId: input.companyId, userId: input.grantedBy, isActive: true },
          select: { id: true },
        });
        if (!grantor) throw new Error('Connection grantor is not an active company member.');
        await tx.integrationConnectionGrant.upsert({
          where: {
            connectionId_granteeType_granteeId: {
              connectionId: input.connectionId,
              granteeType: input.granteeType,
              granteeId: input.granteeId,
            },
          },
          create: {
            companyId: input.companyId,
            connectionId: input.connectionId,
            granteeType: input.granteeType,
            granteeId: input.granteeId,
            access: input.access,
            grantedBy: input.grantedBy,
          },
          update: {
            access: input.access,
            grantedBy: input.grantedBy,
            grantedAt: new Date(),
            revokedAt: null,
          },
        });
        await tx.auditLog.create({
            data: {
              actorId: input.grantedBy,
              companyId: input.companyId,
              action: 'connection.grant.created',
              outcome: 'success',
              metadata: {
                connectionId: input.connectionId,
                provider: connection.provider,
                granteeType: input.granteeType,
                granteeId: input.granteeId,
                access: input.access,
              },
            },
          });
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnectionGrant.upsert', e));
    }
  }

  async revokeConnectionGrant(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly grantId: string;
    readonly actorId: string;
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.$transaction(async tx => {
        const connection = await tx.integrationConnection.findFirst({
          where: { id: input.connectionId, companyId: input.companyId, revokedAt: null },
          select: { provider: true },
        });
        if (!connection) throw new Error('Connection does not belong to this company.');
        const revoked = await tx.integrationConnectionGrant.updateMany({
          where: {
            id: input.grantId,
            companyId: input.companyId,
            connectionId: input.connectionId,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
        if (revoked.count > 0) {
          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              companyId: input.companyId,
              action: 'connection.grant.revoked',
              outcome: 'success',
              metadata: { connectionId: input.connectionId, provider: connection.provider, grantId: input.grantId },
            },
          });
        }
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnectionGrant.revoke', e));
    }
  }

  async revokeConnection(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly provider: IntegrationProvider;
    readonly actorId: string;
  }): Promise<Result<boolean, InfraError>> {
    try {
      const changed = await this.db.$transaction(async tx => {
        const result = await tx.integrationConnection.updateMany({
          where: {
            id: input.connectionId,
            companyId: input.companyId,
            provider: input.provider,
            status: { in: ['connected', CONNECTION_NEEDS_KEY, CONNECTION_REAUTHORIZATION_REQUIRED] },
            revokedAt: null,
          },
          data: { status: 'revoked', revokedAt: new Date() },
        });
        if (result.count > 0) {
          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              companyId: input.companyId,
              action: 'connection.disconnected',
              outcome: 'success',
              metadata: { connectionId: input.connectionId, provider: input.provider },
            },
          });
        }
        return result.count > 0;
      });
      return ok(changed);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.revokeConnection', e));
    }
  }

  async upsertShopifyConnection(
    input: UpsertShopifyConnectionInput,
  ): Promise<Result<DecryptedIntegrationConnection, InfraError>> {
    try {
      if (input.ownerType !== 'company') {
        throw new Error('Shopify installations are company-owned; member access must use connection grants.');
      }
      const shopDomain = normalizeShopDomain(input.shopDomain);
      if (!shopDomain) throw new Error('Invalid Shopify myshopify domain.');
      const encryptedAccess = encryptToken(input.accessToken, this.integrationKey).cipherText;
      const encryptedRefresh = input.refreshToken
        ? encryptToken(input.refreshToken, this.integrationKey).cipherText
        : null;
      const key = dedupeKey({
        provider: SHOPIFY_PROVIDER,
        ownerType: input.ownerType,
        ownerUserId: input.ownerUserId,
        externalAccountId: shopDomain,
      });
      const label = input.label?.trim() || input.shopName?.trim() || shopDomain;
      const tokenMetadata: Prisma.InputJsonValue = {
        apiVersion: input.apiVersion,
        shopDomain,
        ...(input.shopGraphqlId ? { shopGraphqlId: input.shopGraphqlId } : {}),
      };

      const record = await this.db.$transaction(async tx => {
        const saved = await tx.integrationConnection.upsert({
          where: { companyId_dedupeKey: { companyId: input.companyId, dedupeKey: key } },
          create: {
            companyId: input.companyId,
            provider: SHOPIFY_PROVIDER,
            ownerType: input.ownerType,
            ownerUserId: input.ownerType === 'user' ? input.ownerUserId ?? null : null,
            label,
            accountName: input.shopName?.trim() || shopDomain,
            externalAccountId: shopDomain,
            dedupeKey: key,
            status: 'connected',
            scopes: input.scopes,
            accessTokenEncrypted: encryptedAccess,
            refreshTokenEncrypted: encryptedRefresh,
            tokenType: 'offline',
            tokenCipherVersion: 2,
            accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
            refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
            tokenMetadata,
            createdBy: input.createdBy ?? input.ownerUserId ?? null,
            connectedAt: new Date(),
          },
          update: {
            label,
            accountName: input.shopName?.trim() || shopDomain,
            externalAccountId: shopDomain,
            status: 'connected',
            scopes: input.scopes,
            accessTokenEncrypted: encryptedAccess,
            refreshTokenEncrypted: encryptedRefresh,
            tokenType: 'offline',
            tokenCipherVersion: 2,
            accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
            refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
            tokenMetadata,
            tokenVersion: { increment: 1 },
            revokedAt: null,
            connectedAt: new Date(),
          },
        });

        const initialUserGrant = input.ownerType === 'user' ? input.ownerUserId : input.createdBy;
        if (initialUserGrant) {
          await tx.integrationConnectionGrant.upsert({
            where: {
              connectionId_granteeType_granteeId: {
                connectionId: saved.id,
                granteeType: 'user',
                granteeId: initialUserGrant,
              },
            },
            create: {
              companyId: input.companyId,
              connectionId: saved.id,
              granteeType: 'user',
              granteeId: initialUserGrant,
              access: 'read_only',
              grantedBy: input.createdBy ?? initialUserGrant,
            },
            update: {
              access: 'read_only',
              grantedBy: input.createdBy ?? initialUserGrant,
              grantedAt: new Date(),
              revokedAt: null,
            },
          });
        }
        if (input.authorizationAttemptId) {
          const authorizationActor = input.createdBy;
          if (!authorizationActor) throw new Error('Shopify OAuth completion requires an authenticated actor.');
          await tx.auditLog.create({
            data: {
              actorId: authorizationActor,
              companyId: input.companyId,
              action: 'shopify.connection.created',
              outcome: 'success',
              metadata: { connectionId: saved.id, ownerType: 'company', scopes: input.scopes },
            },
          });
          const completed = await tx.integrationOAuthAttempt.updateMany({
            where: {
              id: input.authorizationAttemptId,
              provider: SHOPIFY_PROVIDER,
              companyId: input.companyId,
              userId: authorizationActor,
              externalAccountId: shopDomain,
              status: 'exchanging',
            },
            data: { status: 'completed', completedAt: new Date(), failureCode: null },
          });
          if (completed.count !== 1) {
            throw new Error('Shopify OAuth attempt is not in an exchangeable state.');
          }
        }
        return saved;
      });
      return ok(this.decrypt(record));
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.upsertShopifyConnection', e));
    }
  }

  async listAccessibleShopifyConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<ConnectionSummary[], InfraError>> {
    return this.listAccessibleProviderConnections(input, SHOPIFY_PROVIDER);
  }

  async listManageableShopifyConnections(input: {
    readonly companyId: string;
  }): Promise<Result<ManageableShopifyConnection[], InfraError>> {
    try {
      const records = await this.db.integrationConnection.findMany({
        where: {
          companyId: input.companyId,
          provider: SHOPIFY_PROVIDER,
          ownerType: 'company',
          revokedAt: null,
          status: { in: ['connected', CONNECTION_REAUTHORIZATION_REQUIRED] },
        },
        select: { id: true, externalAccountId: true, label: true, status: true, connectedAt: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      });
      const connections: ManageableShopifyConnection[] = [];
      for (const record of records) {
        const shopDomain = normalizeShopDomain(record.externalAccountId ?? '');
        if (!shopDomain) continue;
        connections.push({
          connectionId: record.id,
          shopDomain,
          label: record.label,
          status: record.status as ManageableShopifyConnection['status'],
          connectedAt: record.connectedAt,
        });
      }
      return ok(connections);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.listManageableShopifyConnections', e));
    }
  }

  async findShopifyConnectionForReconnect(input: {
    readonly companyId: string;
    readonly connectionId: string;
  }): Promise<Result<ManageableShopifyConnection | null, InfraError>> {
    const listed = await this.listManageableShopifyConnections({ companyId: input.companyId });
    if (!listed.ok) return listed;
    return ok(listed.value.find(connection => connection.connectionId === input.connectionId) ?? null);
  }

  async findAccessibleShopifyConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: IntegrationGrantAccess;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<DecryptedIntegrationConnection | null, InfraError>> {
    try {
      input.abortSignal?.throwIfAborted();
      const accessible = await this.listAccessibleShopifyConnections(input);
      if (!accessible.ok) return accessible;
      const summary = accessible.value.find(connection => connection.connectionId === input.connectionId);
      if (!summary || accessRank[summary.access] < accessRank[input.minimumAccess]) return ok(null);
      const record = await this.db.integrationConnection.findFirst({
        where: {
          id: input.connectionId,
          companyId: input.companyId,
          provider: SHOPIFY_PROVIDER,
          revokedAt: null,
          status: 'connected',
        },
      });
      input.abortSignal?.throwIfAborted();
      return ok(record ? this.decrypt(record) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.findAccessibleShopifyConnection', e));
    }
  }

  /**
   * Persists one rotating Shopify token pair only if no other process already
   * refreshed the same version. The loser must reload and use the winner.
   */
  async compareAndSwapShopifyTokens(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly expectedTokenVersion: number;
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly accessTokenExpiresAt: Date;
    readonly refreshTokenExpiresAt: Date;
    readonly scopes: string[];
  }): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.integrationConnection.updateMany({
        where: {
          id: input.connectionId,
          companyId: input.companyId,
          provider: SHOPIFY_PROVIDER,
          tokenVersion: input.expectedTokenVersion,
          status: 'connected',
          revokedAt: null,
        },
        data: {
          accessTokenEncrypted: encryptToken(input.accessToken, this.integrationKey).cipherText,
          refreshTokenEncrypted: encryptToken(input.refreshToken, this.integrationKey).cipherText,
          tokenCipherVersion: 2,
          accessTokenExpiresAt: input.accessTokenExpiresAt,
          refreshTokenExpiresAt: input.refreshTokenExpiresAt,
          scopes: input.scopes,
          tokenVersion: { increment: 1 },
          lastUsedAt: new Date(),
        },
      });
      return ok(updated.count === 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.compareAndSwapShopifyTokens', e));
    }
  }

  async acquireShopifyRefreshLease(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly leaseOwner: string;
    readonly expiresAt: Date;
  }): Promise<Result<boolean, InfraError>> {
    try {
      const now = new Date();
      const updated = await this.db.integrationConnection.updateMany({
        where: {
          id: input.connectionId,
          companyId: input.companyId,
          provider: SHOPIFY_PROVIDER,
          status: 'connected',
          revokedAt: null,
          OR: [
            { refreshLeaseExpiresAt: null },
            { refreshLeaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          refreshLeaseOwner: input.leaseOwner,
          refreshLeaseExpiresAt: input.expiresAt,
        },
      });
      return ok(updated.count === 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.acquireShopifyRefreshLease', e));
    }
  }

  async releaseShopifyRefreshLease(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly leaseOwner: string;
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.integrationConnection.updateMany({
        where: {
          id: input.connectionId,
          companyId: input.companyId,
          provider: SHOPIFY_PROVIDER,
          refreshLeaseOwner: input.leaseOwner,
        },
        data: { refreshLeaseOwner: null, refreshLeaseExpiresAt: null },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.releaseShopifyRefreshLease', e));
    }
  }

  async markShopifyReauthorizationRequired(input: {
    readonly companyId: string;
    readonly connectionId: string;
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.integrationConnection.updateMany({
        where: {
          id: input.connectionId,
          companyId: input.companyId,
          provider: SHOPIFY_PROVIDER,
          revokedAt: null,
        },
        data: {
          status: CONNECTION_REAUTHORIZATION_REQUIRED,
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          refreshLeaseOwner: null,
          refreshLeaseExpiresAt: null,
        },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.markShopifyReauthorizationRequired', e));
    }
  }

  async listAccessibleGoogleConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<ConnectionSummary[], InfraError>> {
    try {
      input.abortSignal?.throwIfAborted();
      const memberships = await this.db.departmentMembership.findMany({
        where:  { userId: input.userId, status: 'active', department: { companyId: input.companyId, status: 'active' } },
        select: { departmentId: true, roleId: true },
      });
      input.abortSignal?.throwIfAborted();
      const departmentIds = memberships.map(m => m.departmentId);
      const departmentRoleIds = memberships.map(m => m.roleId);
      const adminMembership = await this.db.adminMembership.findFirst({
        where:  { userId: input.userId, companyId: input.companyId, isActive: true },
        select: { role: true },
      });
      input.abortSignal?.throwIfAborted();
      const grantOr = [
        { granteeType: 'user', granteeId: input.userId },
        { granteeType: 'company', granteeId: input.companyId },
        ...(departmentIds.length ? [{ granteeType: 'department', granteeId: { in: departmentIds } }] : []),
        ...(departmentRoleIds.length ? [{ granteeType: 'role', granteeId: { in: departmentRoleIds } }] : []),
        ...(adminMembership?.role ? [{ granteeType: 'role', granteeId: adminMembership.role }] : []),
      ];

      const rows = await this.db.integrationConnection.findMany({
        where: {
          companyId: input.companyId,
          provider:  GOOGLE_PROVIDER,
          revokedAt: null,
          status:    'connected',
          OR: [
            { ownerUserId: input.userId },
            { grants: { some: { revokedAt: null, OR: grantOr } } },
          ],
        },
        include: {
          grants: {
            where: { revokedAt: null, OR: grantOr },
            select: { access: true },
          },
        },
        orderBy: [{ ownerType: 'asc' }, { updatedAt: 'desc' }],
      });
      input.abortSignal?.throwIfAborted();

      return ok(rows.map(row => {
        const directOwnerAccess: IntegrationGrantAccess[] = row.ownerUserId === input.userId ? ['admin'] : [];
        const grantAccess = row.grants.map(g => g.access as IntegrationGrantAccess);
        return {
          connectionId: row.id,
          provider:     row.provider as IntegrationProvider,
          label:        row.label,
          ...(row.accountEmail ? { accountEmail: row.accountEmail } : {}),
          ...(row.accountName ? { accountName: row.accountName } : {}),
          ownerType:    row.ownerType as IntegrationOwnerType,
          ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
          access:       bestAccess([...directOwnerAccess, ...grantAccess]),
          scopes:       row.scopes,
          connectedAt:  row.connectedAt,
          ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
        };
      }));
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.listAccessibleGoogleConnections', e));
    }
  }

  async findAccessibleGoogleConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: IntegrationGrantAccess;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<DecryptedIntegrationConnection | null, InfraError>> {
    try {
      input.abortSignal?.throwIfAborted();
      const accessible = await this.listAccessibleGoogleConnections({
        companyId: input.companyId,
        userId:    input.userId,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      input.abortSignal?.throwIfAborted();
      if (!accessible.ok) return accessible;
      const summary = accessible.value.find(c => c.connectionId === input.connectionId);
      if (!summary || accessRank[summary.access] < accessRank[input.minimumAccess]) return ok(null);

      const record = await this.db.integrationConnection.findFirst({
        where: {
          id:        input.connectionId,
          companyId: input.companyId,
          provider:  GOOGLE_PROVIDER,
          revokedAt: null,
          status:    'connected',
        },
      });
      input.abortSignal?.throwIfAborted();
      return ok(record ? this.decrypt(record) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.findAccessibleGoogleConnection', e));
    }
  }

  /**
   * Internal-only resolver for the single Google connection an administrator
   * acknowledged as the company export sink. Member tools must continue to use
   * findAccessibleGoogleConnection; this path grants no general Google access.
   */
  async findCompanyGoogleExportConnection(input: {
    readonly companyId: string;
    readonly connectionId: string;
  }): Promise<Result<DecryptedIntegrationConnection | null, InfraError>> {
    try {
      const record = await this.db.integrationConnection.findFirst({
        where: {
          id: input.connectionId,
          companyId: input.companyId,
          provider: GOOGLE_PROVIDER,
          revokedAt: null,
          status: 'connected',
        },
      });
      return ok(record ? this.decrypt(record) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.findCompanyGoogleExportConnection', e));
    }
  }

  async listAccessibleLarkConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<ConnectionSummary[], InfraError>> {
    return this.listAccessibleProviderConnections(input, LARK_PROVIDER);
  }

  async findAccessibleLarkConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: IntegrationGrantAccess;
  }): Promise<Result<DecryptedIntegrationConnection | null, InfraError>> {
    try {
      const accessible = await this.listAccessibleLarkConnections({
        companyId: input.companyId,
        userId: input.userId,
      });
      if (!accessible.ok) return accessible;
      const summary = accessible.value.find(connection => connection.connectionId === input.connectionId);
      if (!summary || accessRank[summary.access] < accessRank[input.minimumAccess]) return ok(null);
      const record = await this.db.integrationConnection.findFirst({
        where: {
          id: input.connectionId,
          companyId: input.companyId,
          provider: LARK_PROVIDER,
          revokedAt: null,
          status: 'connected',
        },
      });
      return ok(record ? this.decrypt(record) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.findAccessibleLarkConnection', e));
    }
  }

  async updateLarkTokens(input: {
    readonly connectionId: string;
    readonly accessToken: string;
    readonly refreshToken?: string | null;
    readonly tokenType?: string | null;
    readonly accessTokenExpiresAt?: Date | null;
    readonly refreshTokenExpiresAt?: Date | null;
  }): Promise<Result<void, InfraError>> {
    try {
      const access = encryptToken(input.accessToken, this.key).cipherText;
      const refresh = input.refreshToken ? encryptToken(input.refreshToken, this.key).cipherText : null;
      const updated = await this.db.integrationConnection.updateMany({
        where: { id: input.connectionId, provider: LARK_PROVIDER, status: 'connected', revokedAt: null },
        data: {
          accessTokenEncrypted: access,
          ...(input.refreshToken !== undefined ? { refreshTokenEncrypted: refresh } : {}),
          ...(input.tokenType !== undefined ? { tokenType: input.tokenType } : {}),
          ...(input.accessTokenExpiresAt !== undefined ? { accessTokenExpiresAt: input.accessTokenExpiresAt } : {}),
          ...(input.refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt: input.refreshTokenExpiresAt } : {}),
          lastUsedAt: new Date(),
        },
      });
      if (updated.count !== 1) return err(wrapInfra('prisma', 'IntegrationConnection.updateLarkTokens', new Error('Lark connection not found')));
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.updateLarkTokens', e));
    }
  }

  /** Canonical Lark identity lookup used by desktop sign-in and inbound chat. */
  async findLarkConnectionOwner(input: {
    readonly companyId: string;
    readonly larkOpenId: string;
    readonly larkTenantKey: string;
  }): Promise<Result<{ userId: string } | null, InfraError>> {
    try {
      const row = await this.db.integrationConnection.findFirst({
        where: {
          companyId: input.companyId,
          provider: LARK_PROVIDER,
          externalAccountId: input.larkOpenId,
          tokenMetadata: {
            path: ['larkTenantKey'],
            equals: input.larkTenantKey,
          },
          ownerUserId: { not: null },
          status: 'connected',
          revokedAt: null,
        },
        select: { ownerUserId: true },
        orderBy: { updatedAt: 'desc' },
      });
      return ok(row?.ownerUserId ? { userId: row.ownerUserId } : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.findLarkConnectionOwner', e));
    }
  }

  /** Owner-only details for status surfaces; shared tokens are never exposed. */
  async findOwnedLarkConnection(input: {
    readonly companyId: string;
    readonly userId: string;
  }): Promise<Result<DecryptedIntegrationConnection | null, InfraError>> {
    try {
      const row = await this.db.integrationConnection.findFirst({
        where: {
          companyId: input.companyId,
          provider: LARK_PROVIDER,
          ownerUserId: input.userId,
          status: 'connected',
          revokedAt: null,
        },
        orderBy: { updatedAt: 'desc' },
      });
      return ok(row ? this.decrypt(row) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.findOwnedLarkConnection', e));
    }
  }

  async revokeLarkConnectionsForUser(
    companyId: string,
    userId: string,
  ): Promise<Result<number, InfraError>> {
    try {
      const result = await this.db.integrationConnection.updateMany({
        where: {
          companyId,
          provider: LARK_PROVIDER,
          ownerUserId: userId,
          status: 'connected',
          revokedAt: null,
        },
        data: { status: 'revoked', revokedAt: new Date() },
      });
      return ok(result.count);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.revokeLarkConnectionsForUser', e));
    }
  }

  async listAccessibleCanvaConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<ConnectionSummary[], InfraError>> {
    try {
      input.abortSignal?.throwIfAborted();
      const memberships = await this.db.departmentMembership.findMany({
        where:  { userId: input.userId, status: 'active', department: { companyId: input.companyId, status: 'active' } },
        select: { departmentId: true, roleId: true },
      });
      input.abortSignal?.throwIfAborted();
      const departmentIds = memberships.map(m => m.departmentId);
      const departmentRoleIds = memberships.map(m => m.roleId);
      const adminMembership = await this.db.adminMembership.findFirst({
        where:  { userId: input.userId, companyId: input.companyId, isActive: true },
        select: { role: true },
      });
      input.abortSignal?.throwIfAborted();
      const grantOr = [
        { granteeType: 'user', granteeId: input.userId },
        { granteeType: 'company', granteeId: input.companyId },
        ...(departmentIds.length ? [{ granteeType: 'department', granteeId: { in: departmentIds } }] : []),
        ...(departmentRoleIds.length ? [{ granteeType: 'role', granteeId: { in: departmentRoleIds } }] : []),
        ...(adminMembership?.role ? [{ granteeType: 'role', granteeId: adminMembership.role }] : []),
      ];

      const rows = await this.db.integrationConnection.findMany({
        where: {
          companyId: input.companyId,
          provider:  CANVA_PROVIDER,
          revokedAt: null,
          status:    'connected',
          OR: [
            { ownerUserId: input.userId },
            { grants: { some: { revokedAt: null, OR: grantOr } } },
          ],
        },
        include: {
          grants: {
            where: { revokedAt: null, OR: grantOr },
            select: { access: true },
          },
        },
        orderBy: [{ ownerType: 'asc' }, { updatedAt: 'desc' }],
      });
      input.abortSignal?.throwIfAborted();

      return ok(rows.map(row => {
        const directOwnerAccess: IntegrationGrantAccess[] = row.ownerUserId === input.userId ? ['admin'] : [];
        const grantAccess = row.grants.map(g => g.access as IntegrationGrantAccess);
        return {
          connectionId: row.id,
          provider:     row.provider as IntegrationProvider,
          label:        row.label,
          ...(row.accountEmail ? { accountEmail: row.accountEmail } : {}),
          ...(row.accountName ? { accountName: row.accountName } : {}),
          ownerType:    row.ownerType as IntegrationOwnerType,
          ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
          access:       bestAccess([...directOwnerAccess, ...grantAccess]),
          scopes:       row.scopes,
          connectedAt:  row.connectedAt,
          ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
        };
      }));
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.listAccessibleCanvaConnections', e));
    }
  }

  async listAccessibleAirtableConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<ConnectionSummary[], InfraError>> {
    try {
      input.abortSignal?.throwIfAborted();
      const grantOr = await this.grantScopeFor(
        input.companyId,
        input.userId,
        input.abortSignal,
      );
      input.abortSignal?.throwIfAborted();
      const rows = await this.db.integrationConnection.findMany({
        where: {
          companyId: input.companyId,
          provider:  AIRTABLE_PROVIDER,
          revokedAt: null,
          status:    'connected',
          OR: [
            { ownerUserId: input.userId },
            { grants: { some: { revokedAt: null, OR: grantOr } } },
          ],
        },
        include: {
          grants: {
            where: { revokedAt: null, OR: grantOr },
            select: { access: true },
          },
        },
        orderBy: [{ ownerType: 'asc' }, { updatedAt: 'desc' }],
      });
      input.abortSignal?.throwIfAborted();

      return ok(rows.map(row => {
        const directOwnerAccess: IntegrationGrantAccess[] = row.ownerUserId === input.userId ? ['admin'] : [];
        const grantAccess = row.grants.map(g => g.access as IntegrationGrantAccess);
        return {
          connectionId: row.id,
          provider:     row.provider as IntegrationProvider,
          label:        row.label,
          ...(row.accountEmail ? { accountEmail: row.accountEmail } : {}),
          ...(row.accountName ? { accountName: row.accountName } : {}),
          ownerType:    row.ownerType as IntegrationOwnerType,
          ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
          access:       bestAccess([...directOwnerAccess, ...grantAccess]),
          scopes:       row.scopes,
          connectedAt:  row.connectedAt,
          ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
        };
      }));
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.listAccessibleAirtableConnections', e));
    }
  }

  async findAccessibleAirtableConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: IntegrationGrantAccess;
  }): Promise<Result<DecryptedIntegrationConnection | null, InfraError>> {
    try {
      const accessible = await this.listAccessibleAirtableConnections({
        companyId: input.companyId,
        userId:    input.userId,
      });
      if (!accessible.ok) return accessible;
      const summary = accessible.value.find(c => c.connectionId === input.connectionId);
      if (!summary || accessRank[summary.access] < accessRank[input.minimumAccess]) return ok(null);

      const record = await this.db.integrationConnection.findFirst({
        where: {
          id:        input.connectionId,
          companyId: input.companyId,
          provider:  AIRTABLE_PROVIDER,
          revokedAt: null,
          status:    'connected',
        },
      });
      return ok(record ? this.decrypt(record) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.findAccessibleAirtableConnection', e));
    }
  }

  async upsertAirtableConnection(
    input: UpsertAirtableConnectionInput,
  ): Promise<Result<DecryptedIntegrationConnection, InfraError>> {
    try {
      const encryptedAccess = encryptToken(input.accessToken, this.key);
      const encryptedRefresh = input.refreshToken ? encryptToken(input.refreshToken, this.key) : undefined;
      const externalAccountId = input.externalAccountId.trim();
      const accountEmail = input.accountEmail?.trim().toLowerCase() ?? null;
      const accountName = input.accountName?.trim() ?? null;
      const label = input.label?.trim()
        || `${accountName ?? accountEmail ?? 'Airtable'} connection`;
      const key = dedupeKey({
        provider: AIRTABLE_PROVIDER,
        ownerType: input.ownerType,
        ownerUserId: input.ownerUserId,
        accountEmail: input.accountEmail,
        externalAccountId,
      });

      const record = await this.db.integrationConnection.upsert({
        where: { companyId_dedupeKey: { companyId: input.companyId, dedupeKey: key } },
        create: {
          companyId:             input.companyId,
          provider:              AIRTABLE_PROVIDER,
          ownerType:             input.ownerType,
          ownerUserId:           input.ownerType === 'user' ? input.ownerUserId ?? null : null,
          label,
          accountEmail,
          accountName,
          externalAccountId,
          dedupeKey:             key,
          status:                'connected',
          scopes:                input.scopes ?? [],
          accessTokenEncrypted:  encryptedAccess.cipherText,
          ...(encryptedRefresh ? { refreshTokenEncrypted: encryptedRefresh.cipherText } : {}),
          tokenType:             input.tokenType ?? null,
          accessTokenExpiresAt:  input.accessTokenExpiresAt ?? null,
          ...(input.tokenMetadata ? { tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue } : {}),
          createdBy:             input.createdBy ?? input.ownerUserId ?? null,
          connectedAt:           new Date(),
        },
        update: {
          label,
          accountEmail,
          accountName,
          externalAccountId,
          status:                'connected',
          scopes:                input.scopes ?? [],
          accessTokenEncrypted:  encryptedAccess.cipherText,
          ...(encryptedRefresh ? { refreshTokenEncrypted: encryptedRefresh.cipherText } : {}),
          tokenType:             input.tokenType ?? null,
          accessTokenExpiresAt:  input.accessTokenExpiresAt ?? null,
          ...(input.tokenMetadata ? { tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue } : {}),
          revokedAt:             null,
          connectedAt:           new Date(),
        },
      });

      const initialUserGrant = input.ownerType === 'user' ? input.ownerUserId : input.createdBy;
      if (initialUserGrant) {
        await this.grantConnection({
          companyId:    input.companyId,
          connectionId: record.id,
          granteeType:  'user',
          granteeId:    initialUserGrant,
          access:       input.initialAccess ?? 'admin',
          grantedBy:    input.createdBy ?? initialUserGrant,
        });
      }

      return ok(this.decrypt(record));
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.upsertAirtableConnection', e));
    }
  }

  /**
   * Airtable rotates the refresh token on every refresh and kills the previous
   * one immediately, so both tokens are written in a single update. A partial
   * write would strand the connection.
   */
  async updateAirtableTokens(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly accessToken?: string;
    readonly refreshToken?: string;
    readonly tokenType?: string;
    readonly accessTokenExpiresAt?: Date;
    readonly scopes?: string[];
    readonly tokenMetadata?: Record<string, unknown>;
  }): Promise<Result<void, InfraError>> {
    try {
      const data: Prisma.IntegrationConnectionUpdateInput = {};
      if (input.accessToken) data.accessTokenEncrypted = encryptToken(input.accessToken, this.key).cipherText;
      if (input.refreshToken) data.refreshTokenEncrypted = encryptToken(input.refreshToken, this.key).cipherText;
      if (input.tokenType) data.tokenType = input.tokenType;
      if (input.accessTokenExpiresAt) data.accessTokenExpiresAt = input.accessTokenExpiresAt;
      if (input.scopes) data.scopes = input.scopes;
      if (input.tokenMetadata) data.tokenMetadata = input.tokenMetadata as Prisma.InputJsonValue;
      if (Object.keys(data).length === 0) return ok(undefined);
      await this.db.integrationConnection.update({
        where: { id: input.connectionId, companyId: input.companyId },
        data,
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.updateAirtableTokens', e));
    }
  }

  /**
   * Unlike every other lister here, this one returns connections whose key has
   * stopped working as well as live ones, tagged with their status. A dead key
   * that vanished from the list would leave its owner with a tool that fails
   * and no connection to point at; the caller decides what to do with a
   * `needs_key` row, but it has to be able to see one.
   */
  async listAccessibleAitableConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<ConnectionSummary[], InfraError>> {
    try {
      input.abortSignal?.throwIfAborted();
      const grantOr = await this.grantScopeFor(
        input.companyId,
        input.userId,
        input.abortSignal,
      );
      input.abortSignal?.throwIfAborted();
      const rows = await this.db.integrationConnection.findMany({
        where: {
          companyId: input.companyId,
          provider:  AITABLE_PROVIDER,
          revokedAt: null,
          status:    { in: LISTABLE_STATUSES },
          OR: [
            { ownerUserId: input.userId },
            { grants: { some: { revokedAt: null, OR: grantOr } } },
          ],
        },
        include: {
          grants: {
            where: { revokedAt: null, OR: grantOr },
            select: { access: true },
          },
        },
        orderBy: [{ ownerType: 'asc' }, { updatedAt: 'desc' }],
      });
      input.abortSignal?.throwIfAborted();

      return ok(rows.map(row => {
        const directOwnerAccess: IntegrationGrantAccess[] = row.ownerUserId === input.userId ? ['admin'] : [];
        const grantAccess = row.grants.map(g => g.access as IntegrationGrantAccess);
        return {
          connectionId: row.id,
          provider:     row.provider as IntegrationProvider,
          label:        row.label,
          ...(row.accountEmail ? { accountEmail: row.accountEmail } : {}),
          ...(row.accountName ? { accountName: row.accountName } : {}),
          ownerType:    row.ownerType as IntegrationOwnerType,
          ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
          access:       bestAccess([...directOwnerAccess, ...grantAccess]),
          scopes:       row.scopes,
          connectedAt:  row.connectedAt,
          ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
          status:       row.status,
        };
      }));
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.listAccessibleAitableConnections', e));
    }
  }

  /**
   * Resolves a single connection for use. A `needs_key` row is deliberately not
   * returned: it is listable so it can be repaired, never usable.
   */
  async findAccessibleAitableConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: IntegrationGrantAccess;
  }): Promise<Result<DecryptedIntegrationConnection | null, InfraError>> {
    try {
      const accessible = await this.listAccessibleAitableConnections({
        companyId: input.companyId,
        userId:    input.userId,
      });
      if (!accessible.ok) return accessible;
      const summary = accessible.value.find(c => c.connectionId === input.connectionId);
      if (!summary || accessRank[summary.access] < accessRank[input.minimumAccess]) return ok(null);

      const record = await this.db.integrationConnection.findFirst({
        where: {
          id:        input.connectionId,
          companyId: input.companyId,
          provider:  AITABLE_PROVIDER,
          revokedAt: null,
          status:    'connected',
        },
      });
      return ok(record ? this.decrypt(record) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.findAccessibleAitableConnection', e));
    }
  }

  /**
   * Identity is the key itself, because AITable gives us nothing else to
   * identify an account by — the Fusion API has no "who am I" endpoint, and the
   * workspace list a key can reach changes as its owner is added to and removed
   * from spaces. So re-pasting the same key updates one row, and pasting a
   * different key makes a new connection rather than silently rebinding an
   * existing one to an account we cannot prove is the same. Rotating a key on a
   * connection that already has grants is `replaceAitableApiKey`, not this.
   */
  async upsertAitableConnection(
    input: UpsertAitableConnectionInput,
  ): Promise<Result<DecryptedIntegrationConnection, InfraError>> {
    try {
      const apiKey = input.apiKey.trim();
      const encrypted = encryptToken(apiKey, this.key);
      const fingerprint = apiKeyFingerprint(apiKey);
      const primarySpace = input.spaces[0];
      const accountName = primarySpace?.name?.trim() || null;
      // Several keys are expected per company, so an identical label on each
      // would make the account picker useless. The workspace name is the only
      // thing AITable gives us that tells two keys apart.
      const label = input.label?.trim() || accountName || 'AITable connection';
      const key = dedupeKey({
        provider: AITABLE_PROVIDER,
        ownerType: input.ownerType,
        ownerUserId: input.ownerUserId,
        externalAccountId: fingerprint,
      });

      const shared = {
        label,
        accountName,
        externalAccountId:    fingerprint,
        status:               'connected',
        // AITable keys carry no scopes. An invented scope string here would be
        // read as a capability claim by every scope-group check downstream.
        scopes:               [] as string[],
        accessTokenEncrypted: encrypted.cipherText,
        tokenType:            'api_key',
        // No refresh token and no expiry: a key is valid until revoked upstream,
        // which we only ever learn from a 401 on a real call.
        refreshTokenEncrypted: null,
        accessTokenExpiresAt:  null,
        tokenMetadata:        { spaces: input.spaces } as Prisma.InputJsonValue,
        connectedAt:          new Date(),
      };

      const record = await this.db.integrationConnection.upsert({
        where: { companyId_dedupeKey: { companyId: input.companyId, dedupeKey: key } },
        create: {
          companyId:   input.companyId,
          provider:    AITABLE_PROVIDER,
          ownerType:   input.ownerType,
          ownerUserId: input.ownerType === 'user' ? input.ownerUserId ?? null : null,
          dedupeKey:   key,
          createdBy:   input.createdBy ?? input.ownerUserId ?? null,
          ...shared,
        },
        update: { ...shared, revokedAt: null },
      });

      const initialUserGrant = input.ownerType === 'user' ? input.ownerUserId : input.createdBy;
      if (initialUserGrant) {
        await this.grantConnection({
          companyId:    input.companyId,
          connectionId: record.id,
          granteeType:  'user',
          granteeId:    initialUserGrant,
          access:       input.initialAccess ?? 'admin',
          grantedBy:    input.createdBy ?? initialUserGrant,
        });
      }

      return ok(this.decrypt(record));
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.upsertAitableConnection', e));
    }
  }

  /**
   * Records that a stored key was rejected upstream. Idempotent, and scoped to
   * connections that are currently live so a repair racing with an in-flight
   * call cannot be undone by the loser.
   */
  async markAitableConnectionNeedsKey(input: {
    readonly companyId: string;
    readonly connectionId: string;
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.integrationConnection.updateMany({
        where: {
          id:        input.connectionId,
          companyId: input.companyId,
          provider:  AITABLE_PROVIDER,
          revokedAt: null,
          status:    'connected',
        },
        data: { status: CONNECTION_NEEDS_KEY },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.markAitableConnectionNeedsKey', e));
    }
  }

  /**
   * Rotates the key on an existing connection, keeping the row and therefore
   * every grant and governance record attached to it. Deleting and re-adding
   * would silently drop who the connection was shared with.
   */
  async replaceAitableApiKey(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly apiKey: string;
    readonly spaces: readonly { readonly id: string; readonly name: string }[];
  }): Promise<Result<boolean, InfraError>> {
    try {
      const apiKey = input.apiKey.trim();
      const fingerprint = apiKeyFingerprint(apiKey);
      const existing = await this.db.integrationConnection.findFirst({
        where: {
          id:        input.connectionId,
          companyId: input.companyId,
          provider:  AITABLE_PROVIDER,
          revokedAt: null,
          status:    { in: LISTABLE_STATUSES },
        },
      });
      if (!existing) return ok(false);

      // The row is identified by its key, so rotating the key has to move the
      // dedupe identity with it. Leaving the old fingerprint behind meant the
      // next Add Connection with the same new key missed this row and created
      // a second one holding the same credential.
      const dedupe = dedupeKey({
        provider: AITABLE_PROVIDER,
        ownerType: existing.ownerType as IntegrationOwnerType,
        ownerUserId: existing.ownerUserId ?? undefined,
        externalAccountId: fingerprint,
      });
      const accountName = input.spaces[0]?.name?.trim() || null;
      // The label follows the workspace only while it still is the workspace
      // name; a label someone typed themselves is theirs to keep.
      const renameLabel = accountName !== null && existing.label === existing.accountName;

      const result = await this.db.integrationConnection.updateMany({
        where: { id: existing.id, companyId: input.companyId },
        data: {
          accessTokenEncrypted: encryptToken(apiKey, this.key).cipherText,
          externalAccountId:    fingerprint,
          dedupeKey:            dedupe,
          accountName,
          ...(renameLabel ? { label: accountName } : {}),
          tokenMetadata:        { spaces: input.spaces } as Prisma.InputJsonValue,
          status:               'connected',
          connectedAt:          new Date(),
        },
      });
      return ok(result.count > 0);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.replaceAitableApiKey', e));
    }
  }

  /**
   * Grant-matching predicate shared by accessible-connection queries: direct
   * user grants, company-wide grants, the caller's departments, their
   * department roles, and their admin role.
   */
  private async grantScopeFor(
    companyId: string,
    userId: string,
    abortSignal?: AbortSignal,
  ) {
    abortSignal?.throwIfAborted();
    const memberships = await this.db.departmentMembership.findMany({
      where:  { userId, status: 'active', department: { companyId, status: 'active' } },
      select: { departmentId: true, roleId: true },
    });
    abortSignal?.throwIfAborted();
    const departmentIds = memberships.map(m => m.departmentId);
    const departmentRoleIds = memberships.map(m => m.roleId);
    const adminMembership = await this.db.adminMembership.findFirst({
      where:  { userId, companyId, isActive: true },
      select: { role: true },
    });
    abortSignal?.throwIfAborted();
    return [
      { granteeType: 'user', granteeId: userId },
      { granteeType: 'company', granteeId: companyId },
      ...(departmentIds.length ? [{ granteeType: 'department', granteeId: { in: departmentIds } }] : []),
      ...(departmentRoleIds.length ? [{ granteeType: 'role', granteeId: { in: departmentRoleIds } }] : []),
      ...(adminMembership?.role ? [{ granteeType: 'role', granteeId: adminMembership.role }] : []),
    ];
  }

  async findAccessibleCanvaConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: IntegrationGrantAccess;
  }): Promise<Result<DecryptedIntegrationConnection | null, InfraError>> {
    try {
      const accessible = await this.listAccessibleCanvaConnections({
        companyId: input.companyId,
        userId:    input.userId,
      });
      if (!accessible.ok) return accessible;
      const summary = accessible.value.find(c => c.connectionId === input.connectionId);
      if (!summary || accessRank[summary.access] < accessRank[input.minimumAccess]) return ok(null);

      const record = await this.db.integrationConnection.findFirst({
        where: {
          id:        input.connectionId,
          companyId: input.companyId,
          provider:  CANVA_PROVIDER,
          revokedAt: null,
          status:    'connected',
        },
      });
      return ok(record ? this.decrypt(record) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.findAccessibleCanvaConnection', e));
    }
  }

  async listAccessibleZohoConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<ConnectionSummary[], InfraError>> {
    try {
      input.abortSignal?.throwIfAborted();
      const memberships = await this.db.departmentMembership.findMany({
        where:  { userId: input.userId, status: 'active', department: { companyId: input.companyId, status: 'active' } },
        select: { departmentId: true, roleId: true },
      });
      input.abortSignal?.throwIfAborted();
      const departmentIds = memberships.map(m => m.departmentId);
      const departmentRoleIds = memberships.map(m => m.roleId);
      const adminMembership = await this.db.adminMembership.findFirst({
        where:  { userId: input.userId, companyId: input.companyId, isActive: true },
        select: { role: true },
      });
      input.abortSignal?.throwIfAborted();
      const grantOr = [
        { granteeType: 'user', granteeId: input.userId },
        { granteeType: 'company', granteeId: input.companyId },
        ...(departmentIds.length ? [{ granteeType: 'department', granteeId: { in: departmentIds } }] : []),
        ...(departmentRoleIds.length ? [{ granteeType: 'role', granteeId: { in: departmentRoleIds } }] : []),
        ...(adminMembership?.role ? [{ granteeType: 'role', granteeId: adminMembership.role }] : []),
      ];

      const rows = await this.db.integrationConnection.findMany({
        where: {
          companyId: input.companyId,
          provider:  ZOHO_PROVIDER,
          revokedAt: null,
          status:    'connected',
          OR: [
            { ownerUserId: input.userId },
            { grants: { some: { revokedAt: null, OR: grantOr } } },
          ],
        },
        include: {
          grants: {
            where: { revokedAt: null, OR: grantOr },
            select: { access: true },
          },
        },
        orderBy: [{ ownerType: 'asc' }, { updatedAt: 'desc' }],
      });
      input.abortSignal?.throwIfAborted();

      return ok(rows.map(row => {
        const directOwnerAccess: IntegrationGrantAccess[] = row.ownerUserId === input.userId ? ['admin'] : [];
        const grantAccess = row.grants.map(g => g.access as IntegrationGrantAccess);
        return {
          connectionId: row.id,
          provider:     row.provider as IntegrationProvider,
          label:        row.label,
          ...(row.accountEmail ? { accountEmail: row.accountEmail } : {}),
          ...(row.accountName ? { accountName: row.accountName } : {}),
          ownerType:    row.ownerType as IntegrationOwnerType,
          ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
          access:       bestAccess([...directOwnerAccess, ...grantAccess]),
          scopes:       row.scopes,
          connectedAt:  row.connectedAt,
          ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
        };
      }));
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.listAccessibleZohoConnections', e));
    }
  }

  async findAccessibleZohoConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: IntegrationGrantAccess;
  }): Promise<Result<DecryptedIntegrationConnection | null, InfraError>> {
    try {
      const accessible = await this.listAccessibleZohoConnections({
        companyId: input.companyId,
        userId:    input.userId,
      });
      if (!accessible.ok) return accessible;
      const summary = accessible.value.find(c => c.connectionId === input.connectionId);
      if (!summary || accessRank[summary.access] < accessRank[input.minimumAccess]) return ok(null);

      const record = await this.db.integrationConnection.findFirst({
        where: {
          id:        input.connectionId,
          companyId: input.companyId,
          provider:  ZOHO_PROVIDER,
          revokedAt: null,
          status:    'connected',
        },
      });
      return ok(record ? this.decrypt(record) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.findAccessibleZohoConnection', e));
    }
  }

  async touchLastUsed(connectionId: string): Promise<Result<void, InfraError>> {
    try {
      await this.db.integrationConnection.update({
        where: { id: connectionId },
        data:  { lastUsedAt: new Date() },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.touchLastUsed', e));
    }
  }

  private async listAccessibleProviderConnections(
    input: {
      readonly companyId: string;
      readonly userId: string;
      readonly abortSignal?: AbortSignal;
    },
    provider: IntegrationProvider,
  ): Promise<Result<ConnectionSummary[], InfraError>> {
    try {
      input.abortSignal?.throwIfAborted();
      const memberships = await this.db.departmentMembership.findMany({
        where: { userId: input.userId, status: 'active', department: { companyId: input.companyId, status: 'active' } },
        select: { departmentId: true, roleId: true },
      });
      input.abortSignal?.throwIfAborted();
      const departmentIds = memberships.map(membership => membership.departmentId);
      const departmentRoleIds = memberships.map(membership => membership.roleId);
      const adminMembership = await this.db.adminMembership.findFirst({
        where: { userId: input.userId, companyId: input.companyId, isActive: true },
        select: { role: true },
      });
      input.abortSignal?.throwIfAborted();
      const grantOr = [
        { granteeType: 'user', granteeId: input.userId },
        { granteeType: 'company', granteeId: input.companyId },
        ...(departmentIds.length ? [{ granteeType: 'department', granteeId: { in: departmentIds } }] : []),
        ...(departmentRoleIds.length ? [{ granteeType: 'role', granteeId: { in: departmentRoleIds } }] : []),
        ...(adminMembership?.role ? [{ granteeType: 'role', granteeId: adminMembership.role }] : []),
      ];
      const rows = await this.db.integrationConnection.findMany({
        where: {
          companyId: input.companyId,
          provider,
          revokedAt: null,
          status: 'connected',
          OR: [
            { ownerUserId: input.userId },
            { grants: { some: { revokedAt: null, OR: grantOr } } },
          ],
        },
        include: { grants: { where: { revokedAt: null, OR: grantOr }, select: { access: true } } },
        orderBy: [{ ownerType: 'asc' }, { updatedAt: 'desc' }],
      });
      input.abortSignal?.throwIfAborted();
      return ok(rows.map(row => {
        const directOwnerAccess: IntegrationGrantAccess[] = row.ownerUserId === input.userId ? ['admin'] : [];
        const grantAccess = row.grants.map(grant => grant.access as IntegrationGrantAccess);
        return {
          connectionId: row.id,
          provider: row.provider as IntegrationProvider,
          label: row.label,
          ...(row.accountEmail ? { accountEmail: row.accountEmail } : {}),
          ...(row.accountName ? { accountName: row.accountName } : {}),
          ownerType: row.ownerType as IntegrationOwnerType,
          ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
          access: bestAccess([...directOwnerAccess, ...grantAccess]),
          scopes: row.scopes,
          connectedAt: row.connectedAt,
          ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
        };
      }));
    } catch (e) {
      return err(wrapInfra('prisma', `IntegrationConnection.listAccessible(${provider})`, e));
    }
  }

  async updateGoogleTokens(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly accessToken?: string;
    readonly refreshToken?: string;
    readonly tokenType?: string;
    readonly accessTokenExpiresAt?: Date;
    readonly scope?: string;
    readonly tokenMetadata?: Record<string, unknown>;
  }): Promise<Result<void, InfraError>> {
    try {
      const data: Prisma.IntegrationConnectionUpdateInput = {};
      if (input.accessToken) {
        data.accessTokenEncrypted = encryptToken(input.accessToken, this.key).cipherText;
      }
      if (input.refreshToken) {
        data.refreshTokenEncrypted = encryptToken(input.refreshToken, this.key).cipherText;
      }
      if (input.tokenType) data.tokenType = input.tokenType;
      if (input.accessTokenExpiresAt) data.accessTokenExpiresAt = input.accessTokenExpiresAt;
      if (input.scope) data.scopes = splitScopes(input.scope);
      if (input.tokenMetadata) data.tokenMetadata = input.tokenMetadata as Prisma.InputJsonValue;

      if (Object.keys(data).length === 0) return ok(undefined);

      await this.db.integrationConnection.update({
        where: { id: input.connectionId, companyId: input.companyId },
        data,
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.updateGoogleTokens', e));
    }
  }

  async updateZohoTokens(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly accessToken?: string;
    readonly refreshToken?: string;
    readonly tokenType?: string;
    readonly accessTokenExpiresAt?: Date;
    readonly scopes?: string[];
    readonly tokenMetadata?: Record<string, unknown>;
  }): Promise<Result<void, InfraError>> {
    try {
      const data: Prisma.IntegrationConnectionUpdateInput = {};
      if (input.accessToken) {
        data.accessTokenEncrypted = encryptToken(input.accessToken, this.key).cipherText;
      }
      if (input.refreshToken) {
        data.refreshTokenEncrypted = encryptToken(input.refreshToken, this.key).cipherText;
      }
      if (input.tokenType) data.tokenType = input.tokenType;
      if (input.accessTokenExpiresAt) data.accessTokenExpiresAt = input.accessTokenExpiresAt;
      if (input.scopes) data.scopes = input.scopes;
      if (input.tokenMetadata) data.tokenMetadata = input.tokenMetadata as Prisma.InputJsonValue;

      if (Object.keys(data).length === 0) return ok(undefined);

      await this.db.integrationConnection.update({
        where: { id: input.connectionId, companyId: input.companyId },
        data,
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.updateZohoTokens', e));
    }
  }

  async updateCanvaTokens(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly accessToken?: string;
    readonly refreshToken?: string;
    readonly tokenType?: string;
    readonly accessTokenExpiresAt?: Date;
    readonly scopes?: string[];
    readonly tokenMetadata?: Record<string, unknown>;
  }): Promise<Result<void, InfraError>> {
    try {
      const data: Prisma.IntegrationConnectionUpdateInput = {};
      if (input.accessToken) data.accessTokenEncrypted = encryptToken(input.accessToken, this.key).cipherText;
      if (input.refreshToken) data.refreshTokenEncrypted = encryptToken(input.refreshToken, this.key).cipherText;
      if (input.tokenType) data.tokenType = input.tokenType;
      if (input.accessTokenExpiresAt) data.accessTokenExpiresAt = input.accessTokenExpiresAt;
      if (input.scopes) data.scopes = input.scopes;
      if (input.tokenMetadata) data.tokenMetadata = input.tokenMetadata as Prisma.InputJsonValue;
      if (Object.keys(data).length === 0) return ok(undefined);
      await this.db.integrationConnection.update({
        where: { id: input.connectionId, companyId: input.companyId },
        data,
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.updateCanvaTokens', e));
    }
  }

  async revokeGoogleConnectionsForUser(companyId: string, userId: string): Promise<Result<void, InfraError>> {
    try {
      await this.db.integrationConnection.updateMany({
        where: { companyId, provider: GOOGLE_PROVIDER, ownerUserId: userId, revokedAt: null },
        data:  { revokedAt: new Date(), status: 'revoked' },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.revokeGoogleConnectionsForUser', e));
    }
  }

  async revokeCompanyGoogleConnections(companyId: string): Promise<Result<void, InfraError>> {
    try {
      await this.db.integrationConnection.updateMany({
        where: { companyId, provider: GOOGLE_PROVIDER, ownerType: 'company', revokedAt: null },
        data:  { revokedAt: new Date(), status: 'revoked' },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.revokeCompanyGoogleConnections', e));
    }
  }
}
