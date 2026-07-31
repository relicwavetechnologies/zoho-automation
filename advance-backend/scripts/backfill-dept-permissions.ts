import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { DepartmentAdminService } from '../src/application/departments/department-admin.service';
import { ConsoleLogger } from '../src/shared/logger';
import type { PermissionService } from '../src/application/permissions/permission.service';

/**
 * Backfill MEMBER-template tool grants for department roles that have zero
 * permission rows. Required after switching dept overlay to default-deny.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-dept-permissions.ts
 *   pnpm tsx scripts/backfill-dept-permissions.ts --company <companyId>
 *   pnpm tsx scripts/backfill-dept-permissions.ts --company <companyId> --department <deptId>
 *   pnpm tsx scripts/backfill-dept-permissions.ts --updated-by <userId>
 */

const prisma = new PrismaClient();
const logger = new ConsoleLogger({ service: 'backfill-dept-permissions' });

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const companyFilter = argValue('--company');
  const departmentId = argValue('--department');
  let updatedBy = argValue('--updated-by');

  if (!updatedBy) {
    const admin = await prisma.adminMembership.findFirst({
      where: {
        isActive: true,
        ...(companyFilter ? { companyId: companyFilter } : {}),
      },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!admin) {
      throw new Error('No active admin membership found; pass --updated-by <userId>');
    }
    updatedBy = admin.userId;
  }

  const companies = await prisma.company.findMany({
    where: companyFilter ? { id: companyFilter } : undefined,
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  if (companies.length === 0) {
    console.log('No companies matched.');
    return;
  }

  // Cache invalidation is a no-op here; restart or wait for TTL after running
  // against a live API process, or call the admin backfill route instead.
  const permissions = {
    resolve: async () => ({ ok: false as const, error: new Error('unused') as any }),
    canInvoke: async () => ({ ok: false as const, error: new Error('unused') as any }),
    invalidateCompany: async () => {},
    invalidateDept: async () => {},
  } as unknown as PermissionService;

  const svc = new DepartmentAdminService({
    prisma,
    logger,
    permissions,
  });

  for (const company of companies) {
    const result = await svc.backfillEmptyRolePermissions(company.id, updatedBy!, departmentId);
    if (!result.ok) {
      console.error(`FAIL ${company.name} (${company.id}): ${result.error.message}`);
      continue;
    }
    console.log(
      `OK ${company.name} (${company.id}): ` +
      `departments=${result.value.departmentsTouched} ` +
      `roles=${result.value.rolesSeeded} ` +
      `rows=${result.value.rowsCreated}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
