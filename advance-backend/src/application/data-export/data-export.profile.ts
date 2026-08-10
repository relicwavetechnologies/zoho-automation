import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import { GOOGLE_SCOPE, hasGoogleScopeGroups } from '../../domain/google/google-workspace-scope';

export const DATA_EXPORT_CAPABILITY_ID = 'dataExport';

export const dataExportProfileSchema = z.object({
  version: z.literal(1),
  enabled: z.literal(true),
  acknowledged: z.literal(true),
  googleConnectionId: z.string().uuid(),
  accountEmail: z.string().email(),
  readerDomain: z.string().min(1),
  access: z.literal('company_reader'),
}).strict();

export type DataExportProfile = z.infer<typeof dataExportProfileSchema>;

export function parseDataExportProfile(value: unknown): DataExportProfile | null {
  const parsed = dataExportProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readerDomainForAccount(accountEmail: string): string {
  const normalized = accountEmail.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) {
    throw new Error('The selected Google connection has no valid account email');
  }
  return normalized.slice(at + 1);
}

type DataExportProfileStore = Pick<PrismaClient, 'companyCapabilityGovernance' | 'integrationConnection'>;

export async function getDataExportProfile(
  db: DataExportProfileStore,
  companyId: string,
) {
  const row = await db.companyCapabilityGovernance.findUnique({
    where: {
      companyId_capabilityId: { companyId, capabilityId: DATA_EXPORT_CAPABILITY_ID },
    },
    select: { policyJson: true, configuredAt: true, configuredBy: true, version: true },
  });
  return {
    profile: row ? parseDataExportProfile(row.policyJson) : null,
    configuredAt: row?.configuredAt ?? null,
    configuredBy: row?.configuredBy ?? null,
    version: row?.version ?? 0,
  };
}

export async function configureDataExportProfile(
  db: DataExportProfileStore,
  input: {
    readonly companyId: string;
    readonly googleConnectionId: string;
    readonly configuredBy: string;
  },
) {
  const connection = await db.integrationConnection.findFirst({
    where: {
      id: input.googleConnectionId,
      companyId: input.companyId,
      provider: 'google_workspace',
      ownerType: 'company',
      status: 'connected',
      revokedAt: null,
    },
    select: { id: true, accountEmail: true, scopes: true },
  });
  if (!connection) throw new Error('Connected company-owned Google Workspace account not found');
  if (!connection.accountEmail) throw new Error('The selected Google connection has no verified account email');
  if (!hasGoogleScopeGroups(connection.scopes, [
    [GOOGLE_SCOPE.driveFull, GOOGLE_SCOPE.driveFile],
    [GOOGLE_SCOPE.sheetsFull],
  ])) {
    throw new Error('The selected Google connection needs Drive write and Sheets write scopes');
  }
  const profile: DataExportProfile = {
    version: 1,
    enabled: true,
    acknowledged: true,
    googleConnectionId: connection.id,
    accountEmail: connection.accountEmail.trim().toLowerCase(),
    readerDomain: readerDomainForAccount(connection.accountEmail),
    access: 'company_reader',
  };
  const row = await db.companyCapabilityGovernance.upsert({
    where: {
      companyId_capabilityId: {
        companyId: input.companyId,
        capabilityId: DATA_EXPORT_CAPABILITY_ID,
      },
    },
    create: {
      companyId: input.companyId,
      capabilityId: DATA_EXPORT_CAPABILITY_ID,
      policyJson: profile as Prisma.InputJsonValue,
      configuredBy: input.configuredBy,
      configuredAt: new Date(),
    },
    update: {
      policyJson: profile as Prisma.InputJsonValue,
      configuredBy: input.configuredBy,
      configuredAt: new Date(),
      version: { increment: 1 },
    },
    select: { configuredAt: true, configuredBy: true, version: true },
  });
  return { profile, ...row };
}
