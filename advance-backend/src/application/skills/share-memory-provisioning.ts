import type { Prisma, PrismaClient } from '../../generated/prisma';
import { provisionShareMemorySystemSkill } from './share-memory-system-skill';

export const MEMORY_PUBLISHING_REGISTERED_TOOL = {
  toolId: 'memoryPublishing',
  name: 'Memory Publishing',
  description: 'Check memory sharing availability and authorized targets, then publish explicitly reviewed durable facts.',
  category: 'knowledge',
  domain: 'memory',
  hitlRequired: true,
  guardrails: [
    'Only explicitly reviewed durable facts may be published',
    'Backend authorization is re-evaluated before every publish',
    'Denied shared scopes are never downgraded to personal memory',
  ],
} as const;

type ProvisioningDatabase = Pick<PrismaClient, 'company' | 'registeredTool' | 'skill' | 'skillVersion' | 'skillRegistryRevision'>;

export async function provisionShareMemoryForExistingCompanies(
  db: ProvisioningDatabase,
): Promise<{
  registeredToolCreated: boolean;
  skillsCreated: number;
  skillsUpdated: number;
  skillsExisting: number;
}> {
  const existingTool = await db.registeredTool.findUnique({
    where: { toolId: MEMORY_PUBLISHING_REGISTERED_TOOL.toolId },
    select: { id: true },
  });
  if (!existingTool) {
    await db.registeredTool.create({
      data: {
        ...MEMORY_PUBLISHING_REGISTERED_TOOL,
        guardrails: [...MEMORY_PUBLISHING_REGISTERED_TOOL.guardrails],
        engines: [],
        deprecated: false,
      },
    });
  }

  const companies = await db.company.findMany({ select: { id: true } });
  let skillsCreated = 0;
  let skillsUpdated = 0;
  let skillsExisting = 0;
  for (const company of companies) {
    const existingSkill = await db.skill.findFirst({
      where: { companyId: company.id, slug: 'share-memory', status: { not: 'archived' } },
      select: { id: true, isSystem: true },
    });
    if (existingSkill && !existingSkill.isSystem) {
      skillsExisting += 1;
      continue;
    }
    await provisionShareMemorySystemSkill(
      db as Pick<Prisma.TransactionClient, 'skill' | 'skillVersion' | 'skillRegistryRevision'>,
      company.id,
    );
    if (existingSkill) skillsUpdated += 1;
    else skillsCreated += 1;
  }

  return {
    registeredToolCreated: !existingTool,
    skillsCreated,
    skillsUpdated,
    skillsExisting,
  };
}
