import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma';
import { recordSkillRegistryMutation } from './skill-registry-versioning';

// The stable slug preserves existing skill links while the skill itself now
// routes every governed knowledge kind through one authority.
export const KNOWLEDGE_MANAGEMENT_SKILL_SLUG = 'share-memory';

export const KNOWLEDGE_MANAGEMENT_SKILL_MARKDOWN = `# Manage Knowledge

Use this skill when the member naturally asks Divo to remember, forget, update, teach, save, share, or remove durable knowledge. Classify the meaning with the model and structured tool schemas; never route by keyword or regex.

## Choose the resource

- A short personal preference, correction, or stable convention is **personal memory**. When the user explicitly asks to remember, correct, or forget it, use the dedicated synchronous personal-memory command and report completion only from its verified result; no confirmation is required. Qualifying implicit personal facts may be evaluated asynchronously after a successful private turn, but never expose or promise that background process.
- Concise durable facts or decisions meant for a department or the company are **shared memory**.
- A reusable, multi-step method taught in conversation is a **procedure** (skill), not a bag of memory facts. Preserve the complete corrected version and exclude unrelated conversation.
- An uploaded artifact that must remain available later is a **governed file**. Raw bytes stay private and the review binds their backend-verified fingerprint.

When the member clearly finishes teaching a reusable procedure, prepare the complete corrected version and open its normal owner review even if they do not know words such as "skill", "scope", or "approval". The review itself is their consent to save it. Do not publish unfinished teaching, one-off task details, or unrelated conversation.

## Required review path

1. Shared memory must use \`divo_memory_review\` on Desktop or \`review_memory\` in Lark with only a bounded proposal ID and 1–10 exact facts. The backend derives targets; never provide target IDs.
2. Every personal, department, or company procedure/file create, update, publish, or delete must use \`divo_knowledge_review\`. Pass the complete replacement content or exact workspace file path as required by that tool.
3. Personal procedures/files apply only after their owner reviews the exact content. They never go to a manager.
4. Department changes require requester review and current department-manager authority. A current manager may confirm their own department skill change when the backend policy permits manager self-approval; department memory, files, and ordinary-member skill changes still require the configured manager path. Company changes require requester review and a different active company administrator.
5. Scope, membership, RBAC, optimistic version, content hash, and approver authority are rechecked by the backend at execution time. Never call \`knowledge.propose\` or \`knowledge.apply\` directly.
6. A denial in one scope is final for that request. Never downgrade, redirect, duplicate, or offer an unreviewed company/personal fallback.
7. Report only verified status: synchronous personal memory may be reported after its successful receipt; reviewed knowledge may be reported as review pending, authority approval pending, applied, rejected, or failed. For automatic personal learning, follow the preference without reporting persistence. Never claim saved/moved/published from conversational intent alone.
8. Before an update or delete, use the read-only knowledge resource catalogue to fetch the exact canonical \`logicalKey\`, \`currentVersion\`, and complete current content. Never infer a base version from chat history or a projected skill revision.
9. Use the governed file-download operation for a retained file. It resolves only the current approved file version and returns a short-lived link after a live scope check.
10. When \`divo_knowledge_review\` opens a Decision, reply only that the review is open. Do not repeat the skill body, diff, fingerprint, catalogue checks, or pending-status explanation in chat. The server-built Decision card is the canonical review copy and the backend writes the applied, rejected, or failed outcome after the person answers.

## Memory bounds

- Submit 1–10 concise facts, each no longer than 500 characters.
- Exclude credentials, secrets, transient task state, raw tool output, sensitive personal data, assistant inference, and unrelated notes.`;

const KNOWLEDGE_MANAGEMENT_SKILL_FIELDS = {
  departmentId: null,
  scope: 'company',
  name: 'Manage Knowledge',
  slug: KNOWLEDGE_MANAGEMENT_SKILL_SLUG,
  summary: 'Safely manage personal, department, and company memory, procedures, and governed files through exact review, RBAC, and approval.',
  markdown: KNOWLEDGE_MANAGEMENT_SKILL_MARKDOWN,
  toolIds: ['knowledge'],
  tags: ['knowledge', 'memory', 'procedures', 'files', 'review'],
  status: 'active',
  isSystem: true,
  sortOrder: 0,
} as const;

type KnowledgeManagementSystemSkillCreate = Prisma.SkillUncheckedCreateInput & { id: string };

export function buildKnowledgeManagementSystemSkill(
  companyId: string,
): KnowledgeManagementSystemSkillCreate {
  return {
    id: deterministicKnowledgeManagementSkillId(companyId),
    companyId,
    ...KNOWLEDGE_MANAGEMENT_SKILL_FIELDS,
    toolIds: [...KNOWLEDGE_MANAGEMENT_SKILL_FIELDS.toolIds],
    tags: [...KNOWLEDGE_MANAGEMENT_SKILL_FIELDS.tags],
  };
}

export async function provisionKnowledgeManagementSystemSkill(
  db: Pick<Prisma.TransactionClient, 'skill' | 'skillVersion' | 'skillRegistryRevision'>,
  companyId: string,
): Promise<{ id: string }> {
  const existing = await db.skill.findFirst({
    where: {
      companyId,
      slug: KNOWLEDGE_MANAGEMENT_SKILL_SLUG,
      status: { not: 'archived' },
    },
    select: { id: true, isSystem: true },
  });
  if (existing && !existing.isSystem) return existing;

  const create = buildKnowledgeManagementSystemSkill(companyId);
  const skill = await db.skill.upsert({
    where: { id: existing?.id ?? create.id },
    create,
    update: {
      ...KNOWLEDGE_MANAGEMENT_SKILL_FIELDS,
      toolIds: [...KNOWLEDGE_MANAGEMENT_SKILL_FIELDS.toolIds],
      tags: [...KNOWLEDGE_MANAGEMENT_SKILL_FIELDS.tags],
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

function deterministicKnowledgeManagementSkillId(companyId: string): string {
  const hex = createHash('md5')
    .update(`${companyId}:${KNOWLEDGE_MANAGEMENT_SKILL_SLUG}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
