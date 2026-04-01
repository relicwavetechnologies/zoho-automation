import { prisma } from '../src/utils/prisma';
import { CONSOLIDATED_TOOL_ALIAS_MAP } from '../src/company/tools/tool-registry';

const main = async (): Promise<void> => {
  const aliasEntries = Object.entries(CONSOLIDATED_TOOL_ALIAS_MAP);
  const deprecatedToolIds = aliasEntries.map(([deprecated]) => deprecated);

  const [roleRows, overrideRows] = await Promise.all([
    prisma.departmentToolPermission.findMany({
      where: {
        toolId: {
          in: deprecatedToolIds,
        },
      },
    }),
    prisma.departmentUserToolOverride.findMany({
      where: {
        toolId: {
          in: deprecatedToolIds,
        },
      },
    }),
  ]);

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
    console.log(`normalized: ${row.toolId} -> ${canonicalToolId} for dept ${row.departmentId}`);
  }

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
    console.log(`normalized: ${row.toolId} -> ${canonicalToolId} for dept ${row.departmentId}`);
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
