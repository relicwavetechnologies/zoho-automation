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
] as const;

export const SCHEDULE_DIVO_WORK_SKILL_MARKDOWN = `# Schedule Divo Work

Use this skill to make Divo perform work once in the future or on an hourly, daily, weekly, or monthly recurrence.

## Route the request correctly

- Use this skill for recurring reports, inbox reviews, monitoring, reminders, scheduled research, scheduled messages, and other agent work that must run later.
- Use a calendar skill instead when the user wants to reserve time, invite attendees, check free/busy, or create a meeting/event.
- If the user only says "schedule something" and the target is unclear, ask one question: "Do you want to schedule a calendar event, or have Divo run some work later or repeatedly?"
- Scheduling the work and performing the work are different. Include the skills and tools needed by the future task in its self-contained intent; never run the business task immediately unless the user also asks for that.

## Required gateway sequence

1. Resolve the task normally so the intent uses the correct company skills, accounts, filters, output, and safety rules.
2. Before the first scheduler invocation, call:

```json
{
  "op": "tools.list",
  "payload": { "toolId": "scheduledWorkflows" }
}
```

3. Read the returned schema. Invoke the scheduler only through:

```json
{
  "op": "tools.invoke",
  "payload": {
    "toolId": "scheduledWorkflows",
    "args": { "operation": "<operation>", "...": "operation-specific fields" }
  }
}
```

Keep `operation` and every schedule field inside `payload.args`. Never put scheduler fields beside `payload` or `toolId`.

## Create contract

Every create requires:

- `name`: short label, at most 120 characters.
- `intent`: complete instructions that can run without this chat history. State the task, source/account, time window, filters, required skills/tools, output format, delivery expectation, external-action boundary, and what to do when data is missing or a tool fails.
- `timezone`: exact IANA timezone such as `Asia/Kolkata`.
- `scheduleType` and only the timing fields for that type.

Do not guess a material task, time, timezone, recurrence, monitoring scope, recipient, external side effect, or failure behavior. Ask only for missing material details.

### One time

```json
{
  "operation": "create",
  "name": "Send launch reminder",
  "intent": "At run time, send a concise reminder in the originating conversation that the launch review begins in 30 minutes. Do not contact anyone elsewhere. If delivery fails, report the failure in the originating conversation.",
  "scheduleType": "one_time",
  "timezone": "Asia/Kolkata",
  "runAt": "2026-07-20T09:30:00+05:30"
}
```

### Hourly

```json
{
  "operation": "create",
  "name": "Check urgent support mail",
  "intent": "Using the approved Gmail skill and account, inspect mail received since the previous run for urgent support incidents. Return only new incidents to the originating conversation. Do not reply to or modify mail. If Gmail is unavailable, report the failure without retrying another account.",
  "scheduleType": "hourly",
  "timezone": "Asia/Kolkata",
  "intervalHours": 2,
  "minute": 15
}

```

### Daily

```json
{
  "operation": "create",
  "name": "Daily inbox summary",
  "intent": "Using the approved Gmail skill and selected work account, summarize messages received in the last 24 hours, grouped by sender. Return the summary to the originating conversation. Read only; do not reply, archive, label, or forward mail. If the account is unavailable, report the failure and do not use another account.",
  "scheduleType": "daily",
  "timezone": "Asia/Kolkata",
  "hour": 10,
  "timeMinute": 0
}
```

### Weekly

```json
{
  "operation": "create",
  "name": "Monday pipeline review",
  "intent": "Using the approved CRM reporting skill, summarize open pipeline changes since the previous run and return the report to the originating conversation. Read only. If the CRM query fails, report the error and do not fabricate totals.",
  "scheduleType": "weekly",
  "timezone": "Asia/Kolkata",
  "daysOfWeek": ["MO"],
  "hour": 9,
  "timeMinute": 30
}
```

### Monthly

```json
{
  "operation": "create",
  "name": "Monthly finance pack",
  "intent": "Using the approved finance reporting skill, prepare the previous calendar month's summary and return it to the originating conversation. Read only. Call out missing data explicitly and do not estimate unavailable values.",
  "scheduleType": "monthly",
  "timezone": "Asia/Kolkata",
  "dayOfMonth": 1,
  "hour": 10,
  "timeMinute": 0
}
```

For recurring schedules, `hour` uses 0-23 local time and `timeMinute` uses 0-59. For one-time schedules, `runAt` must be a future ISO 8601 timestamp with an explicit UTC offset.

## Manage schedules

- List: `{ "operation": "list", "includeInactive": false }`
- List including paused/archived: `{ "operation": "list", "includeInactive": true }`
- Pause: `{ "operation": "pause", "scheduleId": "<UUID from create/list>" }`
- Resume: `{ "operation": "resume", "scheduleId": "<UUID from create/list>" }`
- Cancel: `{ "operation": "cancel", "scheduleId": "<UUID from create/list>" }`
- Run now: `{ "operation": "run_now", "scheduleId": "<UUID from create/list>" }`

Never invent a schedule ID. Use the exact ID returned by create or list.

## Completion contract

- A request is not scheduled when the tool is merely available, arguments are drafted, approval is pending, or invocation fails.
- Claim success only after `tools.invoke` returns `operation: "create"` with a schedule ID and status.
- Report the schedule name, recurrence in the user's local wording, timezone, next run, and schedule ID.
- If approval is required, say it is pending. After approval, retry the exact same invocation; changing arguments requires a new approval.
- Treat pause, resume, cancel, and run-now as complete only when the returned schedule confirms the requested state/action.`;

const SKILL_FIELDS = {
  departmentId: null,
  folderId: null,
  scope: 'global',
  name: 'Schedule Divo Work',
  slug: SCHEDULE_DIVO_WORK_SKILL_SLUG,
  summary: 'Create and manage durable one-time or recurring Divo work, reminders, monitoring, and reports; distinguish agent work from calendar events and use the exact governed gateway contract.',
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
