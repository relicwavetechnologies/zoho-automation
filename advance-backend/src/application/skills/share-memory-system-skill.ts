import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma';

export const SHARE_MEMORY_SKILL_SLUG = 'share-memory';

export const SHARE_MEMORY_SKILL_MARKDOWN = `# Share Memory

Use this skill only when the member explicitly asks to share or save durable conversation memory.

## Review Flow

1. Call \`memoryPublishing\` with \`operation: "check_authority"\` before proposing a review. Read \`availability\`, exact \`targets\`, and \`scopeOutcomes\`.
2. If availability is \`storage_unavailable\`, or there are no targets, tell the member memory sharing is unavailable and do not open a review. If a requested scope is \`not_authorized\`, state that scope is unavailable and do not retry it or downgrade it.
3. Propose only durable, user-confirmed facts, decisions, and preferences. Exclude secrets, raw tool output, transient task state, and unconfirmed assistant inference.
4. Call the local \`divo_memory_review\` tool with only \`proposalId\` and the proposed \`bullets\`. Never pass \`departmentId\` or \`allowedTargets\` to the local tool.
5. \`divo_memory_review\` uses the desktop-configured department context to independently obtain the current canonical targets, owns the custom review card, and lets the member edit the facts, choose one exact returned target, approve, revise, or cancel.
6. Do not call \`tools.prepare\`, \`tools.commit\`, or \`memoryPublishing.publish\` directly. After approval, \`divo_memory_review\` prepares and commits the final reviewed facts and exact selected target through the standard backend gateway flow.
7. Use the local tool result as the source of truth. If publish is denied, report the denial. Never retry in a narrower scope unless the member starts and approves a new review.

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
  db: Pick<Prisma.TransactionClient, 'skill'>,
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
  return db.skill.upsert({
    where: { id: existing?.id ?? create.id },
    create,
    update: {
      ...SHARE_MEMORY_SKILL_FIELDS,
      toolIds: [...SHARE_MEMORY_SKILL_FIELDS.toolIds],
      tags: [...SHARE_MEMORY_SKILL_FIELDS.tags],
    },
    select: { id: true },
  });
}

function deterministicShareMemorySkillId(companyId: string): string {
  const hex = createHash('md5')
    .update(`${companyId}:${SHARE_MEMORY_SKILL_SLUG}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
