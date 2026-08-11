import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import { recordSkillRegistryMutation } from './skill-registry-versioning';

export const SCHEDULE_DIVO_WORK_SKILL_SLUG = 'schedule-divo-work';

export const SCHEDULE_DIVO_WORK_SKILL_ALIASES = [
  'schedule something',
  'schedule work',
  'scheduled work',
  'scheduled workflow',
  'recurring work',
  'recurring task',
  'run later',
  'run every day',
  'daily automation',
  'weekly automation',
  'monitor regularly',
  'one-time reminder',
  'change schedule time',
  'make schedule recurring',
  'convert one-time to recurring',
] as const;

export const SCHEDULE_DIVO_WORK_SKILL_MARKDOWN = `# Schedule Divo Work

Use this skill to make Divo perform work once in the future or on an hourly, daily, weekly, or monthly recurrence.

## Route the request correctly

- Use this skill for recurring reports, inbox reviews, monitoring, reminders, scheduled research, scheduled messages, and other agent work that must run later.
- Use a calendar skill instead when the user wants to reserve time, invite attendees, check free/busy, or create a meeting/event.
- If the user only says "schedule something" and the target is unclear, ask one question: "Do you want to schedule a calendar event, or have Divo run some work later or repeatedly?"
- Scheduling the work and performing the work are different. Include the skills and tools needed by the future task in its self-contained intent; never run the business task immediately unless the user also asks for that.

## Non-negotiable execution contract

Before creating or replacing a schedule, load any separate business recipe the future task will need — you are writing its instructions, so you need to know what that work actually involves.

Build two distinct contracts:

1. **Work contract** — what a fresh agent must actually do at run time: objective, source/account, scope and time window, filters, required business skills and tools, output format, delivery boundary, prohibited side effects, and failure behavior.
2. **Timing contract** — when it runs: schedule type, timezone, and operation-specific timing fields.

Store only the work contract in **intent**. Store recurrence only in the timing fields. A schedule name is a label, never an executable instruction.

Reject these patterns:

- "Run the HDFC research workflow every day at 2 PM."
- "Execute the existing report schedule."
- "Do the same task as before."

They depend on chat history or another schedule. Instead, copy the complete operational instructions into **intent**. Before invoking creation, mentally remove the schedule name and timing: if a fresh agent could not perform the work from **intent** alone, ask one concise clarification and do not schedule.

When changing an existing schedule:

- Preserve the complete existing work contract exactly unless the user changes the work itself.
- Never cancel the old schedule before the replacement is successfully created and verified.
- Never reconstruct the work contract from only the schedule name or recurrence.
- If the available list result does not contain the full work contract and it is not present in the conversation, ask the user for it instead of guessing.

## What a good intent looks like

~~~json
{
  "operation": "create",
  "name": "Daily inbox summary",
  "intent": "Using the approved Gmail skill and selected work account, summarize messages received in the last 24 hours, grouped by sender. Produce the completed summary as the final answer; runtime delivery is handled separately. Read only; do not reply, archive, label, or forward mail. If the account is unavailable, report the failure and do not use another account.",
  "scheduleType": "daily",
  "timezone": "Asia/Kolkata",
  "hour": 10,
  "timeMinute": 0
}
~~~

That intent is the standard: it names the account, the window, the output, the read-only boundary, and the failure behaviour, and a fresh agent could run it having seen nothing else. Write every intent that way, and never name a delivery destination in one — the runtime delivers.

If the user asks for the result in a group, tell them it will arrive in their own Lark DM instead. Never invent a schedule ID; use the exact ID returned by create or list.

## Completion contract

- A request is not scheduled when the tool is merely available, arguments are drafted, approval is pending, or invocation fails.
- Claim success only after create returns a schedule ID and status.
- Report the schedule name, recurrence in the user's local wording, timezone, next run, and schedule ID.
- If approval is required, say it is pending. After approval, retry the exact same invocation; changing arguments requires a new approval.
- Treat pause, resume, cancel, and run-now as complete only when the returned schedule confirms the requested state/action.`;

const SKILL_FIELDS = {
  departmentId: null,
  folderId: null,
  scope: 'company',
  name: 'Schedule Divo Work',
  slug: SCHEDULE_DIVO_WORK_SKILL_SLUG,
  summary: 'Create and manage durable one-time or recurring Divo work, reminders, monitoring, and reports, and tell scheduled agent work apart from a calendar event.',
  markdown: SCHEDULE_DIVO_WORK_SKILL_MARKDOWN,
  toolIds: ['scheduledWorkflows'],
  tags: ['scheduling', 'automation', 'recurring', 'monitoring', 'reminder'],
  status: 'active',
  isSystem: true,
  sortOrder: 5,
} as const;

type SchedulingSkillStore = Pick<
  Prisma.TransactionClient,
  'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'
>;

const EXISTING_SELECT = {
  id: true,
  companyId: true,
  departmentId: true,
  folderId: true,
  scope: true,
  name: true,
  slug: true,
  summary: true,
  markdown: true,
  toolIds: true,
  tags: true,
  status: true,
  isSystem: true,
  sortOrder: true,
  revision: true,
  createdBy: true,
  updatedBy: true,
  aliases: { select: { alias: true }, orderBy: { alias: 'asc' as const } },
} as const;

type ExistingSchedulingSkill = Prisma.SkillGetPayload<{ select: typeof EXISTING_SELECT }>;

export function buildScheduleDivoWorkSystemSkill(
  companyId: string,
): Prisma.SkillUncheckedCreateInput & { id: string } {
  return {
    id: deterministicId(companyId),
    companyId,
    ...SKILL_FIELDS,
    toolIds: [...SKILL_FIELDS.toolIds],
    tags: [...SKILL_FIELDS.tags],
  };
}

export async function provisionScheduleDivoWorkSystemSkill(
  db: SchedulingSkillStore,
  companyId: string,
): Promise<{ id: string; outcome: 'created' | 'updated' | 'existing' | 'skipped' }> {
  const current = await db.skill.findFirst({
    where: { companyId, slug: SCHEDULE_DIVO_WORK_SKILL_SLUG, status: { not: 'archived' } },
    select: EXISTING_SELECT,
  });
  if (current && !current.isSystem) return { id: current.id, outcome: 'skipped' };

  let skill: ExistingSchedulingSkill;
  let outcome: 'created' | 'updated' | 'existing';
  if (!current) {
    skill = await db.skill.create({ data: buildScheduleDivoWorkSystemSkill(companyId), select: EXISTING_SELECT });
    await recordSkillRegistryMutation(db, skill, 'system');
    outcome = 'created';
  } else if (matchesDefinition(current)) {
    skill = current;
    outcome = 'existing';
  } else {
    skill = await db.skill.update({
      where: { id: current.id },
      data: {
        ...SKILL_FIELDS,
        toolIds: [...SKILL_FIELDS.toolIds],
        tags: [...SKILL_FIELDS.tags],
        revision: { increment: 1 },
      },
      select: EXISTING_SELECT,
    });
    await recordSkillRegistryMutation(db, skill, 'system');
    outcome = 'updated';
  }

  await db.skillAccessGrant.upsert({
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
  await syncAliases(db, skill.id);
  return { id: skill.id, outcome };
}

export async function provisionScheduleDivoWorkForExistingCompanies(
  db: Pick<PrismaClient, 'company' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
): Promise<{ companies: number; created: number; updated: number; existing: number; skipped: number }> {
  const companies = await db.company.findMany({ select: { id: true } });
  const totals = { companies: companies.length, created: 0, updated: 0, existing: 0, skipped: 0 };
  for (const company of companies) {
    const result = await provisionScheduleDivoWorkSystemSkill(db, company.id);
    totals[result.outcome] += 1;
  }
  return totals;
}

function matchesDefinition(current: ExistingSchedulingSkill): boolean {
  const currentAliases = current.aliases.map((item) => item.alias);
  const expectedAliases = [...SCHEDULE_DIVO_WORK_SKILL_ALIASES].sort();
  return current.departmentId === null
    && current.folderId === null
    && current.scope === SKILL_FIELDS.scope
    && current.slug === SKILL_FIELDS.slug
    && current.name === SKILL_FIELDS.name
    && current.summary === SKILL_FIELDS.summary
    && current.markdown === SKILL_FIELDS.markdown
    && arraysEqual(current.toolIds, SKILL_FIELDS.toolIds)
    && arraysEqual(current.tags, SKILL_FIELDS.tags)
    && current.status === SKILL_FIELDS.status
    && current.isSystem
    && current.sortOrder === SKILL_FIELDS.sortOrder
    && arraysEqual(currentAliases, expectedAliases);
}

async function syncAliases(db: SchedulingSkillStore, skillId: string): Promise<void> {
  await db.skillAlias.deleteMany({
    where: { skillId, alias: { notIn: [...SCHEDULE_DIVO_WORK_SKILL_ALIASES] } },
  });
  await db.skillAlias.createMany({
    data: SCHEDULE_DIVO_WORK_SKILL_ALIASES.map((alias) => ({ skillId, alias })),
    skipDuplicates: true,
  });
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deterministicId(companyId: string): string {
  const hex = createHash('md5').update(`${companyId}:${SCHEDULE_DIVO_WORK_SKILL_SLUG}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
