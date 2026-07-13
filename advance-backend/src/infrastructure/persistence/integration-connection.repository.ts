import type { Prisma, PrismaClient } from '../../generated/prisma';
import type { TypedEnv } from '../../config/env';
import { encryptToken, decryptToken } from '../shared/token.crypto';
import { err, ok, type Result } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';

export type IntegrationProvider = 'google_workspace' | 'zoho';
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
  readonly tokenMetadata?: Record<string, unknown>;
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
}

const GOOGLE_PROVIDER: IntegrationProvider = 'google_workspace';
const ZOHO_PROVIDER: IntegrationProvider = 'zoho';

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
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    tokenMetadata?: unknown;
    connectedAt: Date;
    lastUsedAt?: Date | null;
    revokedAt?: Date | null;
    createdBy?: string | null;
  }): DecryptedIntegrationConnection {
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
      ...(record.accessTokenEncrypted ? { accessToken: decryptToken(record.accessTokenEncrypted, this.key) } : {}),
      ...(record.refreshTokenEncrypted ? { refreshToken: decryptToken(record.refreshTokenEncrypted, this.key) } : {}),
      ...(record.tokenType ? { tokenType: record.tokenType } : {}),
      ...(record.accessTokenExpiresAt ? { accessTokenExpiresAt: record.accessTokenExpiresAt } : {}),
      ...(record.refreshTokenExpiresAt ? { refreshTokenExpiresAt: record.refreshTokenExpiresAt } : {}),
      ...(record.tokenMetadata ? { tokenMetadata: record.tokenMetadata as Record<string, unknown> } : {}),
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

      const record = await this.db.integrationConnection.upsert({
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

  async grantConnection(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly granteeType: IntegrationGranteeType;
    readonly granteeId: string;
    readonly access: IntegrationGrantAccess;
    readonly grantedBy?: string;
  }): Promise<Result<void, InfraError>> {
    try {
      if (!input.granteeId.trim()) return ok(undefined);
      await this.db.integrationConnectionGrant.upsert({
        where: {
          connectionId_granteeType_granteeId: {
            connectionId: input.connectionId,
            granteeType: input.granteeType,
            granteeId:   input.granteeId,
          },
        },
        create: {
          companyId:    input.companyId,
          connectionId: input.connectionId,
          granteeType:  input.granteeType,
          granteeId:    input.granteeId,
          access:       input.access,
          grantedBy:    input.grantedBy ?? null,
        },
        update: {
          access:    input.access,
          grantedBy: input.grantedBy ?? null,
          grantedAt: new Date(),
          revokedAt: null,
        },
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
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.integrationConnectionGrant.updateMany({
        where: {
          id:           input.grantId,
          companyId:    input.companyId,
          connectionId: input.connectionId,
          revokedAt:    null,
        },
        data: { revokedAt: new Date() },
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
  }): Promise<Result<boolean, InfraError>> {
    try {
      const result = await this.db.integrationConnection.updateMany({
        where: {
          id:        input.connectionId,
          companyId: input.companyId,
          provider:  input.provider,
          status:    'connected',
          revokedAt: null,
        },
        data: { status: 'revoked', revokedAt: new Date() },
      });
      return ok(result.count > 0);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.revokeConnection', e));
    }
  }

  async listAccessibleGoogleConnections(input: {
    readonly companyId: string;
    readonly userId: string;
  }): Promise<Result<ConnectionSummary[], InfraError>> {
    try {
      const memberships = await this.db.departmentMembership.findMany({
        where:  { userId: input.userId, status: 'active', department: { companyId: input.companyId, status: 'active' } },
        select: { departmentId: true, roleId: true },
      });
      const departmentIds = memberships.map(m => m.departmentId);
      const departmentRoleIds = memberships.map(m => m.roleId);
      const adminMembership = await this.db.adminMembership.findFirst({
        where:  { userId: input.userId, companyId: input.companyId, isActive: true },
        select: { role: true },
      });
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
  }): Promise<Result<DecryptedIntegrationConnection | null, InfraError>> {
    try {
      const accessible = await this.listAccessibleGoogleConnections({
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
          provider:  GOOGLE_PROVIDER,
          revokedAt: null,
          status:    'connected',
        },
      });
      return ok(record ? this.decrypt(record) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'IntegrationConnection.findAccessibleGoogleConnection', e));
    }
  }

  async listAccessibleZohoConnections(input: {
    readonly companyId: string;
    readonly userId: string;
  }): Promise<Result<ConnectionSummary[], InfraError>> {
    try {
      const memberships = await this.db.departmentMembership.findMany({
        where:  { userId: input.userId, status: 'active', department: { companyId: input.companyId, status: 'active' } },
        select: { departmentId: true, roleId: true },
      });
      const departmentIds = memberships.map(m => m.departmentId);
      const departmentRoleIds = memberships.map(m => m.roleId);
      const adminMembership = await this.db.adminMembership.findFirst({
        where:  { userId: input.userId, companyId: input.companyId, isActive: true },
        select: { role: true },
      });
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
