import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';

/**
 * Grant the Airtable tools to a department role.
 *
 * The department overlay is default-deny: a canonical tool with no
 * DepartmentToolPermission row is denied for every member, company admin
 * included. Airtable was registered and connected but never granted, so every
 * channel resolved an empty toolset and the agent answered, correctly, that no
 * Airtable integration was available.
 *
 * `delete` is deliberately not granted. On airtableSchema it drops tables.
 *
 * Usage:
 *   pnpm tsx scripts/grant-airtable-department-access.ts --role Manager
 *   pnpm tsx scripts/grant-airtable-department-access.ts --role Manager --dry-run
 */

const AIRTABLE_TOOL_IDS = ['airtableRecords', 'airtableSchema', 'airtableAutomation'] as const;
const ACTION_GROUPS = ['read', 'create', 'update'] as const;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main() {
  const roleName = argValue('--role') ?? 'Manager';
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient();

  try {
    const roles = await prisma.departmentRole.findMany({
      where: { name: roleName },
      select: { id: true, name: true, departmentId: true },
    });
    if (roles.length === 0) throw new Error(`No department role named "${roleName}"`);

    const updatedBy = argValue('--updated-by')
      ?? (await prisma.adminMembership.findFirst({
        where: { isActive: true },
        select: { userId: true },
        orderBy: { createdAt: 'asc' },
      }))?.userId;
    if (!updatedBy) throw new Error('No active admin membership found; pass --updated-by <userId>');

    let written = 0;
    for (const role of roles) {
      for (const toolId of AIRTABLE_TOOL_IDS) {
        for (const actionGroup of ACTION_GROUPS) {
          if (dryRun) {
            console.log(`would grant ${toolId}:${actionGroup} to ${role.name} (${role.departmentId})`);
            continue;
          }
          const existing = await prisma.departmentToolPermission.findFirst({
            where: { departmentId: role.departmentId, roleId: role.id, toolId, actionGroup },
            select: { id: true },
          });
          if (existing) {
            await prisma.departmentToolPermission.update({
              where: { id: existing.id },
              data: { allowed: true, updatedBy },
            });
          } else {
            await prisma.departmentToolPermission.create({
              data: { departmentId: role.departmentId, roleId: role.id, toolId, actionGroup, allowed: true, updatedBy },
            });
          }
          written++;
        }
      }
    }

    console.log(dryRun
      ? `Dry run over ${roles.length} "${roleName}" role(s).`
      : `Granted ${written} Airtable permission(s) across ${roles.length} "${roleName}" role(s). Restart the backend or let the permission cache expire.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
