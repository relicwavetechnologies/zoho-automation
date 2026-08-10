import type { PrismaClient } from '../../generated/prisma';

const RETIRED_TOOL_ID = 'dataExport';
const RETIRED_SYSTEM_SKILL_SLUG = 'secure-data-export';

export async function retireDataExportCapability(prisma: PrismaClient) {
  return prisma.$transaction(async tx => {
    const affectedSkills = await tx.skill.findMany({
      where: {
        OR: [
          { toolIds: { has: RETIRED_TOOL_ID } },
          {
            isSystem: false,
            status: { not: 'archived' },
            OR: [
              { markdown: { contains: RETIRED_TOOL_ID, mode: 'insensitive' } },
              { markdown: { contains: RETIRED_SYSTEM_SKILL_SLUG, mode: 'insensitive' } },
              { markdown: { contains: 'exportCandidate', mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: { id: true, companyId: true, isSystem: true, toolIds: true },
    });
    const affectedCompanyIds = new Set(affectedSkills.map(skill => skill.companyId));

    for (const skill of affectedSkills) {
      await tx.skill.update({
        where: { id: skill.id },
        data: {
          toolIds: skill.toolIds.filter(toolId => toolId !== RETIRED_TOOL_ID),
          ...(!skill.isSystem ? { status: 'archived' } : {}),
          revision: { increment: 1 },
        },
      });
    }

    const retiredSystemSkills = await tx.skill.findMany({
      where: { isSystem: true, slug: RETIRED_SYSTEM_SKILL_SLUG },
      select: { id: true, companyId: true },
    });
    for (const skill of retiredSystemSkills) affectedCompanyIds.add(skill.companyId);

    await tx.skill.deleteMany({
      where: { isSystem: true, slug: RETIRED_SYSTEM_SKILL_SLUG },
    });
    await tx.skillCapability.deleteMany({ where: { toolId: RETIRED_TOOL_ID } });
    await tx.departmentUserToolOverride.deleteMany({ where: { toolId: RETIRED_TOOL_ID } });
    await tx.departmentToolPermission.deleteMany({ where: { toolId: RETIRED_TOOL_ID } });
    await tx.toolActionPermission.deleteMany({ where: { toolId: RETIRED_TOOL_ID } });
    await tx.toolPermission.deleteMany({ where: { toolId: RETIRED_TOOL_ID } });
    await tx.companyCapabilityGovernance.deleteMany({ where: { capabilityId: RETIRED_TOOL_ID } });
    await tx.connectionAuthorizationIntent.deleteMany({
      where: {
        requestedToolIds: { has: RETIRED_TOOL_ID },
        continuationStatus: { in: ['blocked', 'pending', 'running'] },
      },
    });
    const tools = await tx.registeredTool.deleteMany({ where: { toolId: RETIRED_TOOL_ID } });

    for (const companyId of affectedCompanyIds) {
      await tx.skillRegistryRevision.upsert({
        where: { companyId },
        create: { companyId, revision: 2 },
        update: { revision: { increment: 1 } },
      });
    }

    return {
      registeredToolsDeleted: tools.count,
      systemSkillsDeleted: retiredSystemSkills.length,
      skillsRewritten: affectedSkills.length,
      companiesInvalidated: affectedCompanyIds.size,
    };
  });
}
