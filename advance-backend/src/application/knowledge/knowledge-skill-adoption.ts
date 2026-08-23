import type { Prisma, PrismaClient } from '../../generated/prisma';
import { sha256CanonicalJson } from '../../shared/hash';
import { larkSkillEnglishOnlyError } from '../skills/lark-skill-language-policy';
import { unknownSkillToolIds } from '../skills/skill-tool-validation';
import { knowledgeSkillContentSchema } from './knowledge-content-validator';

const CANDIDATE_SELECT = {
  id: true,
  companyId: true,
  departmentId: true,
  knowledgeResourceId: true,
  scope: true,
  name: true,
  slug: true,
  summary: true,
  markdown: true,
  toolIds: true,
  tags: true,
  status: true,
  isSystem: true,
  revision: true,
  createdBy: true,
  updatedBy: true,
  accessGrants: {
    select: { granteeType: true, granteeId: true },
  },
} as const;

type Candidate = Prisma.SkillGetPayload<{ select: typeof CANDIDATE_SELECT }>;
type Tx = Prisma.TransactionClient;

export type KnowledgeSkillAdoptionSkipReason =
  | 'invalid_revision'
  | 'invalid_content'
  | 'unavailable_tools'
  | 'non_english_content'
  | 'unsupported_scope'
  | 'scope_identity_missing'
  | 'access_not_scope_derived'
  | 'creator_missing';

export interface KnowledgeSkillAdoptionResult {
  readonly candidates: number;
  readonly adopted: number;
  readonly existing: number;
  readonly skipped: readonly {
    readonly skillId: string;
    readonly slug: string;
    readonly reason: KnowledgeSkillAdoptionSkipReason;
  }[];
}

/**
 * Move legacy editable skills under the central knowledge authority.
 *
 * This is an adoption, not a copy. The existing Skill stays in place as the
 * runtime projection and receives one KnowledgeResource link. Its current
 * instructions become the immutable starting KnowledgeVersion. Every later
 * content change must then cross KnowledgeMutation and project back into that
 * same Skill row.
 *
 * Access is the hard eligibility rule. A governed skill derives access from
 * its knowledge scope, so adopting a row with custom grants would silently
 * change who can use it after the first update. Such rows remain unlinked and
 * are reported for an administrator to resolve explicitly.
 */
export async function adoptLegacySkillsIntoKnowledge(
  db: PrismaClient,
): Promise<KnowledgeSkillAdoptionResult> {
  const candidates = await db.skill.findMany({
    where: {
      status: 'active',
      isSystem: false,
      knowledgeResourceId: null,
    },
    select: CANDIDATE_SELECT,
    orderBy: [{ companyId: 'asc' }, { slug: 'asc' }, { id: 'asc' }],
  });
  let adopted = 0;
  let existing = 0;
  const skipped: Array<KnowledgeSkillAdoptionResult['skipped'][number]> = [];

  for (const candidate of candidates) {
    const plan = adoptionPlan(candidate);
    if (!plan.ok) {
      skipped.push({ skillId: candidate.id, slug: candidate.slug, reason: plan.reason });
      continue;
    }
    const outcome = await adoptOneWithRaceRecovery(db, candidate.id);
    if (outcome === 'adopted') adopted += 1;
    else if (outcome === 'existing') existing += 1;
    else skipped.push({ skillId: candidate.id, slug: candidate.slug, reason: outcome.reason });
  }

  return { candidates: candidates.length, adopted, existing, skipped };
}

async function adoptOneWithRaceRecovery(
  db: PrismaClient,
  skillId: string,
): Promise<'adopted' | 'existing' | { readonly reason: KnowledgeSkillAdoptionSkipReason }> {
  try {
    return await db.$transaction(tx => adoptOne(tx, skillId));
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'P2002') throw error;
    // Two instances can reconcile at the same deployment boundary. The unique
    // resource identity chooses one winner; a fresh transaction verifies and
    // links the winner rather than treating the harmless race as corruption.
    return db.$transaction(tx => adoptOne(tx, skillId));
  }
}

async function adoptOne(
  tx: Tx,
  skillId: string,
): Promise<'adopted' | 'existing' | { readonly reason: KnowledgeSkillAdoptionSkipReason }> {
  const skill = await tx.skill.findUnique({ where: { id: skillId }, select: CANDIDATE_SELECT });
  if (!skill || skill.status !== 'active' || skill.isSystem) {
    return { reason: 'invalid_content' };
  }
  if (skill.knowledgeResourceId) return 'existing';
  const plan = adoptionPlan(skill);
  if (!plan.ok) return { reason: plan.reason };

  const actorIds = [...new Set([skill.updatedBy, skill.createdBy].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  ))];
  const actors = actorIds.length > 0
    ? await tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true } })
    : [];
  const availableActors = new Set(actors.map(actor => actor.id));
  const actorId = actorIds.find(id => availableActors.has(id));
  if (!actorId) return { reason: 'creator_missing' };

  const identity = {
    companyId: skill.companyId,
    kind: 'skill' as const,
    targetKey: plan.targetKey,
    logicalKey: skill.slug,
  };
  let resource = await tx.knowledgeResource.findUnique({
    where: { companyId_kind_targetKey_logicalKey: identity },
    include: { projectedSkill: { select: { id: true } } },
  });
  if (!resource) {
    resource = await tx.knowledgeResource.create({
      data: {
        companyId: skill.companyId,
        kind: 'skill',
        scope: plan.scope,
        targetKey: plan.targetKey,
        ownerUserId: plan.ownerUserId,
        departmentId: plan.departmentId,
        logicalKey: skill.slug,
        status: 'active',
        currentVersion: skill.revision,
        createdById: actorId,
      },
      include: { projectedSkill: { select: { id: true } } },
    });
  }
  if (
    resource.companyId !== skill.companyId
    || resource.kind !== 'skill'
    || resource.scope !== plan.scope
    || resource.targetKey !== plan.targetKey
    || resource.ownerUserId !== plan.ownerUserId
    || resource.departmentId !== plan.departmentId
    || resource.logicalKey !== skill.slug
    || resource.status !== 'active'
    || resource.currentVersion !== skill.revision
    || (resource.projectedSkill && resource.projectedSkill.id !== skill.id)
  ) {
    throw new Error(`Knowledge skill adoption conflict for ${skill.slug} (${skill.id}).`);
  }

  const contentHash = sha256CanonicalJson(plan.content);
  const version = await tx.knowledgeVersion.findUnique({
    where: {
      resourceId_version: { resourceId: resource.id, version: skill.revision },
    },
    select: { contentHash: true },
  });
  if (version && version.contentHash !== contentHash) {
    throw new Error(`Knowledge skill adoption content conflict for ${skill.slug} (${skill.id}).`);
  }
  if (!version) {
    await tx.knowledgeVersion.create({
      data: {
        resourceId: resource.id,
        version: skill.revision,
        contentJson: plan.content,
        contentHash,
        searchText: [skill.slug, skill.name, skill.summary, ...skill.tags].join('\n'),
        evidenceJson: {
          kind: 'legacy_skill_adoption',
          skillId: skill.id,
          skillRevision: skill.revision,
        },
        sourceType: 'migration',
        sourceRef: `skill:${skill.id}:revision:${skill.revision}`,
        createdById: actorId,
      },
    });
  }

  const linked = await tx.skill.updateMany({
    where: {
      id: skill.id,
      companyId: skill.companyId,
      status: 'active',
      isSystem: false,
      knowledgeResourceId: null,
    },
    data: { knowledgeResourceId: resource.id },
  });
  if (linked.count === 1) return 'adopted';
  const winner = await tx.skill.findUnique({
    where: { id: skill.id },
    select: { knowledgeResourceId: true },
  });
  if (winner?.knowledgeResourceId === resource.id) return 'existing';
  throw new Error(`Knowledge skill adoption link conflict for ${skill.slug} (${skill.id}).`);
}

type AdoptionPlan =
  | {
      readonly ok: true;
      readonly scope: 'personal' | 'department' | 'company';
      readonly targetKey: string;
      readonly ownerUserId: string | null;
      readonly departmentId: string | null;
      readonly content: {
        readonly name: string;
        readonly slug: string;
        readonly summary: string;
        readonly markdown: string;
        readonly toolIds: readonly string[];
        readonly tags: readonly string[];
      };
    }
  | { readonly ok: false; readonly reason: KnowledgeSkillAdoptionSkipReason };

function adoptionPlan(skill: Candidate): AdoptionPlan {
  if (!Number.isInteger(skill.revision) || skill.revision < 1) {
    return { ok: false, reason: 'invalid_revision' };
  }
  const content = knowledgeSkillContentSchema.safeParse({
    name: skill.name,
    slug: skill.slug,
    summary: skill.summary,
    markdown: skill.markdown,
    toolIds: skill.toolIds,
    tags: skill.tags,
  });
  if (!content.success) {
    return { ok: false, reason: 'invalid_content' };
  }
  if (unknownSkillToolIds(content.data.toolIds).length > 0) {
    return { ok: false, reason: 'unavailable_tools' };
  }
  if (larkSkillEnglishOnlyError(content.data)) {
    return { ok: false, reason: 'non_english_content' };
  }

  if (skill.scope === 'department') {
    if (!skill.departmentId) return { ok: false, reason: 'scope_identity_missing' };
    if (!hasExactGrant(skill, 'department', skill.departmentId)) {
      return { ok: false, reason: 'access_not_scope_derived' };
    }
    return {
      ok: true,
      scope: 'department',
      targetKey: `department:${skill.departmentId}`,
      ownerUserId: null,
      departmentId: skill.departmentId,
      content: content.data,
    };
  }
  if (skill.scope === 'company') {
    if (skill.departmentId) return { ok: false, reason: 'scope_identity_missing' };
    if (!hasExactGrant(skill, 'company', skill.companyId)) {
      return { ok: false, reason: 'access_not_scope_derived' };
    }
    return {
      ok: true,
      scope: 'company',
      targetKey: 'company',
      ownerUserId: null,
      departmentId: null,
      content: content.data,
    };
  }
  if (skill.scope === 'personal') {
    if (skill.departmentId || skill.accessGrants.length !== 1) {
      return { ok: false, reason: 'access_not_scope_derived' };
    }
    const grant = skill.accessGrants[0]!;
    if (grant.granteeType !== 'user') {
      return { ok: false, reason: 'access_not_scope_derived' };
    }
    return {
      ok: true,
      scope: 'personal',
      targetKey: `personal:${grant.granteeId}`,
      ownerUserId: grant.granteeId,
      departmentId: null,
      content: content.data,
    };
  }
  return { ok: false, reason: 'unsupported_scope' };
}

function hasExactGrant(
  skill: Candidate,
  granteeType: 'department' | 'company',
  granteeId: string,
): boolean {
  return skill.accessGrants.length === 1
    && skill.accessGrants[0]?.granteeType === granteeType
    && skill.accessGrants[0]?.granteeId === granteeId;
}
