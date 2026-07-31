import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma';
import { recordSkillRegistryMutation } from './skill-registry-versioning';

export const SHARE_MEMORY_SKILL_SLUG = 'share-memory';

export const SHARE_MEMORY_SKILL_MARKDOWN = `# Share Memory

Use this skill only when the member explicitly asks to share or save durable conversation memory.

## Review Flow

1. Propose only durable, user-confirmed facts, decisions, and preferences. Exclude secrets, raw tool output, transient task state, and unconfirmed assistant inference.
2. Open exactly one review surface with only \`proposalId\` and the proposed \`bullets\`: use \`divo_memory_review\` on Desktop, or \`review_memory\` in Lark. Never pass \`departmentId\` or \`allowedTargets\` to either review tool.
3. The review surface independently checks storage availability and current canonical targets. If it reports no available target or a denied scope, tell the member and do not retry or downgrade it.
4. Desktop lets the member edit the facts; in Lark, the member approves one exact target or cancels and asks for a revised review.
5. Do not call \`tools.prepare\`, \`tools.commit\`, or \`memoryPublishing\` directly. After approval, the review surface rechecks backend authority and publishes the exact reviewed facts and selected target through the standard backend gateway flow.
6. Use the review tool result as the source of truth. If publish is denied, report the denial. Never retry in a narrower scope unless the member starts and approves a new review.

## Bounds

- Submit between 1 and 10 facts.
- Each fact must be concise and no longer than 500 characters.
- Do not claim memory was saved until the committed backend tool result confirms it.`;

const SHARE_MEMORY_SKILL_FIELDS = {
  departmentId: null,
  scope: 'global',
  name: 'Share Memory',
  slug: SHARE_MEMORY_SKILL_SLUG,
  summary: 'Review durable facts from the current conversation and explicitly publish the selected facts to an available backend memory target.',
  markdown: SHARE_MEMORY_SKILL_MARKDOWN,
  toolIds: ['memoryPublishing'],
  tags: ['memory', 'sharing', 'review'],
  status: 'active',
  isSystem: true,
  sortOrder: 0,
} as const;

type ShareMemorySystemSkillCreate = Prisma.SkillUncheckedCreateInput & { id: string };

export function buildShareMemorySystemSkill(companyId: string): ShareMemorySystemSkillCreate {
  return {
    id: deterministicShareMemorySkillId(companyId),
    companyId,
    ...SHARE_MEMORY_SKILL_FIELDS,
    toolIds: [...SHARE_MEMORY_SKILL_FIELDS.toolIds],
    tags: [...SHARE_MEMORY_SKILL_FIELDS.tags],
  };
}

export async function provisionShareMemorySystemSkill(
  db: Pick<Prisma.TransactionClient, 'skill' | 'skillVersion' | 'skillRegistryRevision'>,
  companyId: string,
): Promise<{ id: string }> {
  const existing = await db.skill.findFirst({
    where: {
      companyId,
      slug: SHARE_MEMORY_SKILL_SLUG,
      status: { not: 'archived' },
    },
    select: { id: true, isSystem: true },
  });
  if (existing && !existing.isSystem) return existing;

  const create = buildShareMemorySystemSkill(companyId);
  const skill = await db.skill.upsert({
    where: { id: existing?.id ?? create.id },
    create,
    update: {
      ...SHARE_MEMORY_SKILL_FIELDS,
      toolIds: [...SHARE_MEMORY_SKILL_FIELDS.toolIds],
      tags: [...SHARE_MEMORY_SKILL_FIELDS.tags],
      revision: { increment: 1 },
    },
  });
  await recordSkillRegistryMutation(db, skill, 'system');
  const grantStore = (
    db as typeof db & Pick<Prisma.TransactionClient, 'skillAccessGrant'>
  ).skillAccessGrant;
  await grantStore.upsert({
    where: {
      skillId_granteeType_granteeId: {
        skillId: skill.id,
        granteeType: 'company',
        granteeId: companyId,
      },
    },
    create: {
      companyId,
      skillId: skill.id,
      granteeType: 'company',
      granteeId: companyId,
    },
    update: {},
  });
  return { id: skill.id };
}

function deterministicShareMemorySkillId(companyId: string): string {
  const hex = createHash('md5')
    .update(`${companyId}:${SHARE_MEMORY_SKILL_SLUG}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
