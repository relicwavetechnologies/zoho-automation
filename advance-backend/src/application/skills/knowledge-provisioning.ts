import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  KNOWLEDGE_MANAGEMENT_SKILL_SLUG,
  provisionKnowledgeManagementSystemSkill,
} from './knowledge-system-skill';
import { bumpSkillRegistryRevision } from './skill-registry-versioning';

export const KNOWLEDGE_REGISTERED_TOOL = {
  toolId: 'knowledge',
  name: 'Divo Knowledge',
  description: 'Propose and apply governed memory, procedure, and file knowledge through one backend authority.',
  category: 'knowledge',
  domain: 'memory',
  hitlRequired: true,
  guardrails: [
    'Personal writes can target only the authenticated user',
    'Personal procedures and files require exact owner review',
    'Department and company writes require exact requester review and a different approver',
    'RBAC and policy are re-evaluated before every apply',
    'Denied targets are never downgraded or redirected',
  ],
} as const;

type ProvisioningDatabase = Pick<
  PrismaClient,
  '$transaction' | 'company' | 'knowledgePolicy' | 'registeredTool' | 'skill' | 'skillVersion' | 'skillRegistryRevision'
>;

const KNOWLEDGE_KINDS = ['memory', 'skill', 'file'] as const;
const KNOWLEDGE_SCOPES = ['personal', 'department', 'company'] as const;
const KNOWLEDGE_ACTIONS = ['create', 'update', 'publish', 'delete'] as const;
const RETIRED_KNOWLEDGE_TOOL_IDS = ['memoryPublishing', 'memoryRecall', 'skillPublishing'] as const;

export const DEFAULT_KNOWLEDGE_POLICIES = KNOWLEDGE_KINDS.flatMap(kind =>
  KNOWLEDGE_SCOPES.flatMap(scope => KNOWLEDGE_ACTIONS.map(action => ({
    id: `kp-global-${kind}-${scope}-${action}`,
    tenantKey: 'global',
    kind,
    scope,
    action,
    requesterReviewRequired: scope !== 'personal' || kind !== 'memory',
    requiredAuthority: scope === 'department'
      ? 'department_manager' as const
      : scope === 'company'
        ? 'company_admin' as const
        : 'none' as const,
    distinctApprover: scope !== 'personal',
    enabled: true,
    version: 1,
  }))),
);

export async function provisionKnowledgeForExistingCompanies(
  db: ProvisioningDatabase,
): Promise<{
  registeredToolCreated: boolean;
  policiesCreated: number;
  legacySkillsArchived: number;
  retiredToolsDeleted: number;
  skillsCreated: number;
  skillsUpdated: number;
  skillsExisting: number;
}> {
  const retired = await db.$transaction(async tx => {
    const legacyWhere = {
      status: { not: 'archived' },
      toolIds: { hasSome: [...RETIRED_KNOWLEDGE_TOOL_IDS] },
      NOT: { isSystem: true, slug: KNOWLEDGE_MANAGEMENT_SKILL_SLUG },
    } satisfies Prisma.SkillWhereInput;
    const affectedCompanies = await tx.skill.findMany({
      where: legacyWhere,
      select: { companyId: true },
      distinct: ['companyId'],
    });
    const legacySkills = await tx.skill.updateMany({
      where: legacyWhere,
      data: { status: 'archived' },
    });
    for (const { companyId } of affectedCompanies) {
      await bumpSkillRegistryRevision(tx, companyId);
    }
    await tx.skillCapability.deleteMany({ where: { toolId: { in: [...RETIRED_KNOWLEDGE_TOOL_IDS] } } });
    await tx.departmentUserToolOverride.deleteMany({ where: { toolId: { in: [...RETIRED_KNOWLEDGE_TOOL_IDS] } } });
    await tx.departmentToolPermission.deleteMany({ where: { toolId: { in: [...RETIRED_KNOWLEDGE_TOOL_IDS] } } });
    await tx.toolActionPermission.deleteMany({ where: { toolId: { in: [...RETIRED_KNOWLEDGE_TOOL_IDS] } } });
    await tx.toolPermission.deleteMany({ where: { toolId: { in: [...RETIRED_KNOWLEDGE_TOOL_IDS] } } });
    const tools = await tx.registeredTool.deleteMany({
      where: { toolId: { in: [...RETIRED_KNOWLEDGE_TOOL_IDS] } },
    });
    return { legacySkillsArchived: legacySkills.count, retiredToolsDeleted: tools.count };
  });
  const policies = await db.knowledgePolicy.createMany({
    data: DEFAULT_KNOWLEDGE_POLICIES,
    skipDuplicates: true,
  });
  const existingTool = await db.registeredTool.findUnique({
    where: { toolId: KNOWLEDGE_REGISTERED_TOOL.toolId },
    select: { id: true },
  });
  if (!existingTool) {
    await db.registeredTool.create({
      data: {
        ...KNOWLEDGE_REGISTERED_TOOL,
        guardrails: [...KNOWLEDGE_REGISTERED_TOOL.guardrails],
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
      where: {
        companyId: company.id,
        slug: KNOWLEDGE_MANAGEMENT_SKILL_SLUG,
        status: { not: 'archived' },
      },
      select: { id: true, isSystem: true },
    });
    if (existingSkill && !existingSkill.isSystem) {
      skillsExisting += 1;
      continue;
    }
    await provisionKnowledgeManagementSystemSkill(
      db as Pick<Prisma.TransactionClient, 'skill' | 'skillVersion' | 'skillRegistryRevision'>,
      company.id,
    );
    if (existingSkill) skillsUpdated += 1;
    else skillsCreated += 1;
  }

  return {
    registeredToolCreated: !existingTool,
    policiesCreated: policies.count,
    ...retired,
    skillsCreated,
    skillsUpdated,
    skillsExisting,
  };
}
