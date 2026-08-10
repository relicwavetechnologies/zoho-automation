import type { PrismaClient } from '../../generated/prisma';

const RETIRED_TOOL_ID = 'dataExport';
const RETIRED_SYSTEM_SKILL_SLUG = 'secure-data-export';
const RETIRED_TEXT_MARKERS = [
  RETIRED_TOOL_ID,
  RETIRED_SYSTEM_SKILL_SLUG,
  'exportCandidate',
] as const;

function mentionsRetiredDataExport(markdown: string): boolean {
  const normalized = markdown.toLowerCase();
  return RETIRED_TEXT_MARKERS.some(marker => normalized.includes(marker.toLowerCase()));
}

export async function retireDataExportCapability(prisma: PrismaClient) {
  return prisma.$transaction(async tx => {
    const affectedSkills = await tx.skill.findMany({
      where: {
        OR: [
          { toolIds: { has: RETIRED_TOOL_ID } },
          {
            status: { not: 'archived' },
            OR: [
              { markdown: { contains: RETIRED_TOOL_ID, mode: 'insensitive' } },
              { markdown: { contains: RETIRED_SYSTEM_SKILL_SLUG, mode: 'insensitive' } },
              { markdown: { contains: 'exportCandidate', mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: {
        id: true,
        companyId: true,
        isSystem: true,
        slug: true,
        markdown: true,
        toolIds: true,
      },
    });
    const affectedCompanyIds = new Set(affectedSkills.map(skill => skill.companyId));

    const staleSystemSkillIds = affectedSkills
      .filter(skill => skill.isSystem && mentionsRetiredDataExport(skill.markdown))
      .map(skill => skill.id);
    const retiredSystemSkills = await tx.skill.findMany({
      where: {
        isSystem: true,
        OR: [
          { slug: RETIRED_SYSTEM_SKILL_SLUG },
          ...(staleSystemSkillIds.length > 0 ? [{ id: { in: staleSystemSkillIds } }] : []),
        ],
      },
      select: { id: true, companyId: true },
    });
    const retiredSystemSkillIds = new Set(retiredSystemSkills.map(skill => skill.id));
    for (const skill of retiredSystemSkills) affectedCompanyIds.add(skill.companyId);

    let skillsRewritten = 0;
    for (const skill of affectedSkills) {
      if (retiredSystemSkillIds.has(skill.id)) continue;
      await tx.skill.update({
        where: { id: skill.id },
        data: {
          toolIds: skill.toolIds.filter(toolId => toolId !== RETIRED_TOOL_ID),
          ...(!skill.isSystem ? { status: 'archived' } : {}),
          revision: { increment: 1 },
        },
      });
      skillsRewritten += 1;
    }

    await tx.skill.deleteMany({
      where: { id: { in: [...retiredSystemSkillIds] } },
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
      skillsRewritten,
      companiesInvalidated: affectedCompanyIds.size,
    };
  });
}
