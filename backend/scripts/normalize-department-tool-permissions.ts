import { prisma } from '../src/utils/prisma';
import { CONSOLIDATED_TOOL_ALIAS_MAP } from '../src/company/tools/tool-registry';

const main = async (): Promise<void> => {
  const aliasEntries = Object.entries(CONSOLIDATED_TOOL_ALIAS_MAP);
  const deprecatedToolIds = aliasEntries.map(([deprecated]) => deprecated);

  const [roleRows, overrideRows] = await Promise.all([
    prisma.departmentToolPermission.findMany({
      where: { toolId: { in: deprecatedToolIds } },
    }),
    prisma.departmentUserToolOverride.findMany({
      where: { toolId: { in: deprecatedToolIds } },
    }),
  ]);

  console.log(`Found ${roleRows.length} role permission row(s) with deprecated tool IDs.`);
  console.log(`Found ${overrideRows.length} user override row(s) with deprecated tool IDs.`);

  // Track counts per mapping for the summary
  const roleCounts = new Map<string, number>();
  const overrideCounts = new Map<string, number>();

  // --- Role permissions ---
  for (const row of roleRows) {
    const canonicalToolId = CONSOLIDATED_TOOL_ALIAS_MAP[row.toolId];
    if (!canonicalToolId) continue;

    await prisma.departmentToolPermission.upsert({
      where: {
        departmentId_roleId_toolId_actionGroup: {
          departmentId: row.departmentId,
          roleId: row.roleId,
          toolId: canonicalToolId,
          actionGroup: row.actionGroup,
        },
      },
      create: {
        departmentId: row.departmentId,
        roleId: row.roleId,
        toolId: canonicalToolId,
        actionGroup: row.actionGroup,
        allowed: row.allowed,
        updatedBy: row.updatedBy,
      },
      update: {
        allowed: row.allowed,
        updatedBy: row.updatedBy,
      },
    });

    const mapKey = `${row.toolId} → ${canonicalToolId}`;
    roleCounts.set(mapKey, (roleCounts.get(mapKey) ?? 0) + 1);
  }

  // Delete deprecated role permission rows only after all upserts succeed
  if (roleRows.length > 0) {
    const deleted = await prisma.departmentToolPermission.deleteMany({
      where: { toolId: { in: deprecatedToolIds } },
    });
    console.log(`Deleted ${deleted.count} deprecated role permission row(s).`);
  }

  // --- User overrides ---
  for (const row of overrideRows) {
    const canonicalToolId = CONSOLIDATED_TOOL_ALIAS_MAP[row.toolId];
    if (!canonicalToolId) continue;

    await prisma.departmentUserToolOverride.upsert({
      where: {
        departmentId_userId_toolId_actionGroup: {
          departmentId: row.departmentId,
          userId: row.userId,
          toolId: canonicalToolId,
          actionGroup: row.actionGroup,
        },
      },
      create: {
        departmentId: row.departmentId,
        userId: row.userId,
        toolId: canonicalToolId,
        actionGroup: row.actionGroup,
        allowed: row.allowed,
        updatedBy: row.updatedBy,
      },
      update: {
        allowed: row.allowed,
        updatedBy: row.updatedBy,
      },
    });

    const mapKey = `${row.toolId} → ${canonicalToolId}`;
    overrideCounts.set(mapKey, (overrideCounts.get(mapKey) ?? 0) + 1);
  }

  // Delete deprecated override rows after all upserts succeed
  if (overrideRows.length > 0) {
    const deleted = await prisma.departmentUserToolOverride.deleteMany({
      where: { toolId: { in: deprecatedToolIds } },
    });
    console.log(`Deleted ${deleted.count} deprecated user override row(s).`);
  }

  // --- Summary ---
  console.log('\n=== Role permission normalization summary ===');
  if (roleCounts.size === 0) {
    console.log('  (nothing to normalize)');
  } else {
    for (const [mapping, count] of [...roleCounts.entries()].sort()) {
      console.log(`  ${mapping}: ${count} row(s)`);
    }
  }

  console.log('\n=== User override normalization summary ===');
  if (overrideCounts.size === 0) {
    console.log('  (nothing to normalize)');
  } else {
    for (const [mapping, count] of [...overrideCounts.entries()].sort()) {
      console.log(`  ${mapping}: ${count} row(s)`);
    }
  }

  console.log('\nDone.');
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
