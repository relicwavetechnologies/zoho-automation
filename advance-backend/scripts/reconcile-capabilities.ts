import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { CONNECTED_PROVIDER_SYSTEM_SKILLS } from '../src/application/skills/connected-provider-system-skills';
import { provisionDivoProductivitySkillForExistingCompanies } from '../src/application/skills/divo-productivity-system-skills';
import { provisionGoogleWorkspaceSkillsForExistingCompanies } from '../src/application/skills/google-workspace-system-skills';
import { provisionLarkSkillsForExistingCompanies } from '../src/application/skills/lark-skill-provisioning';
import { provisionDivoOmsSiteDataForExistingCompanies } from '../src/application/skills/oms-site-data-system-skill';
import { provisionDivoSemrushForExistingCompanies } from '../src/application/skills/semrush-system-skill';
import { provisionZohoFinanceSkillsForExistingCompanies } from '../src/application/skills/zoho-finance-system-skills';
import { seedRegisteredTools } from './seed-registered-tools';
import {
  provisionMailOpsPermissionsForExistingCompanies,
  provisionMailOpsSkillsForExistingCompanies,
} from '../src/application/skills/mail-ops-system-skills';
import { provisionScheduleDivoWorkForExistingCompanies } from '../src/application/skills/scheduled-work-system-skill';
import { provisionSystemSkillRoutesForExistingCompanies } from '../src/application/skills/system-skill-routes';
import { provisionKnowledgeForExistingCompanies } from '../src/application/skills/knowledge-provisioning';
import { provisionFilesAndDocumentsForExistingCompanies } from '../src/application/skills/files-and-documents-system-skills';
import { provisionDivoLocalPythonForExistingCompanies } from '../src/application/skills/divo-local-python-system-skill';
import { provisionMenhoodDataForExistingCompanies } from '../src/application/skills/menhood-data-system-skill';
import { PermissionCache } from '../src/application/permissions/permission.cache';
import { RedisCache } from '../src/infrastructure/cache/redis-cache';
import { disconnectAllRedis, getRedisClient } from '../src/infrastructure/cache/redis.client';
import { retireDataExportCapability } from '../src/application/skills/retired-data-export-capability';

export async function provisionConnectedProviderSkillsForExistingCompanies(prisma: PrismaClient) {
  const totals = { companies: 0, created: 0, updated: 0, existing: 0, skipped: 0 };
  for (const definition of CONNECTED_PROVIDER_SYSTEM_SKILLS) {
    const result = await provisionDivoProductivitySkillForExistingCompanies(prisma, definition);
    totals.companies = result.companies;
    totals.created += result.created;
    totals.updated += result.updated;
    totals.existing += result.existing;
    totals.skipped += result.skipped;
  }
  return totals;
}

export async function reconcileCapabilities(
  prisma: PrismaClient,
  invalidator?: (companyId: string, departmentId: string) => Promise<void>,
) {
  const retiredDataExport = await retireDataExportCapability(prisma);
  const registeredTools = await seedRegisteredTools(prisma);
  const skills = {
    lark: await provisionLarkSkillsForExistingCompanies(prisma),
    google: await provisionGoogleWorkspaceSkillsForExistingCompanies(prisma),
    airtableAndAitable: await provisionConnectedProviderSkillsForExistingCompanies(prisma),
    menhood: await provisionMenhoodDataForExistingCompanies(prisma),
    zoho: await provisionZohoFinanceSkillsForExistingCompanies(prisma),
    semrush: await provisionDivoSemrushForExistingCompanies(prisma),
    oms: await provisionDivoOmsSiteDataForExistingCompanies(prisma),
    scheduling: await provisionScheduleDivoWorkForExistingCompanies(prisma),
    mailOps: await provisionMailOpsSkillsForExistingCompanies(prisma),
    knowledge: await provisionKnowledgeForExistingCompanies(prisma),
    filesAndDocuments: await provisionFilesAndDocumentsForExistingCompanies(prisma),
    localPython: await provisionDivoLocalPythonForExistingCompanies(prisma),
  };
  const skillRoutes = await provisionSystemSkillRoutesForExistingCompanies(prisma);
  const permissions = {
    mailOps: await provisionMailOpsPermissionsForExistingCompanies(prisma, {
      invalidateDept: invalidator,
    }),
  };
  return { retiredDataExport, registeredTools, skills, skillRoutes, permissions };
}

/**
 * Drop the permission cache for a department whose grants just changed.
 *
 * Best-effort by design: this runs from `prestart`, and a Redis that is not up
 * yet must not keep the backend from starting. Without it the grant is still
 * real, just invisible to any already-running instance for up to the
 * 15-minute cache TTL — which is what happened before this existed.
 */
function redisDeptInvalidator():
  | ((companyId: string, departmentId: string) => Promise<void>)
  | undefined {
  const url = process.env.REDIS_CACHE_URL || process.env.REDIS_URL;
  if (!url) return undefined;
  const cache = new PermissionCache(new RedisCache(getRedisClient(url)));
  return async (companyId, departmentId) => {
    try {
      await cache.invalidateDept(companyId, departmentId);
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'capabilities.invalidate_dept_failed',
          companyId,
          departmentId,
          message: String(error),
        }),
      );
    }
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await reconcileCapabilities(prisma, redisDeptInvalidator());
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
    await disconnectAllRedis().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
