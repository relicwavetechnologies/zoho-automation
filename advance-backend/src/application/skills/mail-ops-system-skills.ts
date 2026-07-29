import type { PrismaClient } from '../../generated/prisma';
import {
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';

const MAIL_AUTOMATION_ACTIONS = [
  'read',
  'create',
  'update',
  'delete',
  'execute',
] as const;

export const MAIL_OPS_SYSTEM_SKILLS = [
  {
    slug: 'google-workspace-router',
    name: 'Google Workspace Router',
    summary:
      'Route Gmail, mail-arrival automation, scheduled inbox work, and Google Calendar requests to the exact specialist recipe.',
    toolIds: [],
    tags: ['google', 'gmail', 'mail', 'router', 'capabilities'],
    aliases: [
      'google',
      'google workspace',
      'gmail',
      'email',
      'mail',
      'inbox',
      'email automation',
      'mail automation',
    ],
    sortOrder: 2,
    markdown: `# Google Workspace Router

Use this instruction-only router to choose the next exact recipe. It has no executable tools.
Always load the routed specialist before answering or claiming that a connection is unavailable; only the specialist can inspect connections or send a Connect Google card.

## Route

- Read, search, summarize now, draft, send, reply, label, or forward one existing Gmail message now → load \`google-gmail\`.
- React whenever a future matching Gmail message arrives, including automatic OTP forwarding or delivery to a Lark chat → load \`mail-ops\`.
- Run inbox work at a clock time or recurrence, such as a daily digest → load \`schedule-divo-work\` and \`google-gmail\`. Scheduler owns timing; Gmail owns the work performed at run time.
- Reserve time, invite attendees, check free/busy, or create a meeting/event → load \`google-calendar\`.
- Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts, Chat, or Apps Script → load the matching \`google-<product>\` recipe.

If "forward this email" could mean a one-time action or an ongoing arrival rule, ask which one. Never implement a future-arrival rule with the scheduler, and never create a Mail Ops rule for a one-time Gmail action.`,
  },
  {
    slug: 'mail-ops',
    name: 'Mail Ops',
    summary:
      'Create and manage deterministic Gmail-arrival rules for forwarding future matching mail to email or delivering it to Lark.',
    toolIds: ['mailAutomations'],
    tags: ['gmail', 'mail', 'automation', 'forwarding', 'otp', 'watcher'],
    aliases: [
      'whenever email arrives',
      'when mail arrives',
      'forward future email',
      'automatic email forwarding',
      'mail watcher',
      'otp forwarding',
      'send matching mail to lark',
    ],
    sortOrder: 6,
    markdown: `# Mail Ops

Use this recipe only for rules triggered by future Gmail arrivals.

## Before creation

1. Make the deterministic match exact enough: sender, recipient, subject text, body text, attachment presence, or a combination. If the user refers to "that email" without enough detail, load \`google-gmail\` and inspect a bounded matching message first.
2. Ground the destination. Never invent an email address or Lark chat ID. For another Lark chat, load \`lark-messaging\`, list accessible chats, and use one exact returned chat ID after the user identifies it. Use \`current_lark_chat\` only for the current conversation.
3. Reuse an exact user-owned Google \`connectionId\` from the current run. If none is available, call \`mailAutomations\`; it will send the Connect Google card and the current run must end. OAuth completion starts a fresh run with the original request.

## Tool contract

- Create: \`{"operation":"create","connectionId":"<UUID when needed>","name":"<short label>","match":{"from":"alerts@example.com","subjectContains":"OTP"},"destination":{"type":"email","email":"person@company.com"}}\`
- Deliver to this Lark conversation: destination \`{"type":"current_lark_chat"}\`.
- Deliver to another grounded chat: destination \`{"type":"lark_chat","chatId":"<exact listed ID>"}\`.
- List: \`{"operation":"list","includeInactive":false}\`.
- Update: replace the complete match and destination using the exact \`ruleId\`
  and \`connectionId\` returned by list.
- Pause/resume/archive: include the exact \`ruleId\` returned by create or list.

At least one deterministic match field is required. V1 email forwarding sends a bounded plain-text representation and does not retransmit attachments or full MIME content. Matching, OTP extraction/forwarding, and delivery do not invoke an LLM and do not need per-message approval. Do not claim success until create returns an active rule ID. Do not use this tool for a daily summary or other timed work; load \`schedule-divo-work\` instead.
If \`mailAutomations\` returns \`mail_ops_configuration_required\`, stop and report the operator setup requirement. Never substitute Scheduler, a polling loop, or a native Gmail filter for an arrival-triggered Mail Ops rule.`,
  },
] as const satisfies readonly DivoProductivitySystemSkillDefinition[];

export async function provisionMailOpsSystemSkills(
  db: Parameters<typeof provisionDivoProductivitySystemSkill>[0],
  companyId: string,
): Promise<{ created: number; updated: number; existing: number; skipped: number }> {
  const totals = { created: 0, updated: 0, existing: 0, skipped: 0 };
  for (const definition of MAIL_OPS_SYSTEM_SKILLS) {
    const result = await provisionDivoProductivitySystemSkill(db, companyId, definition);
    totals[result.outcome] += 1;
  }
  return totals;
}

export async function provisionMailOpsSkillsForExistingCompanies(
  db: Pick<
    PrismaClient,
    | 'company'
    | 'skillFolder'
    | 'skill'
    | 'skillVersion'
    | 'skillRegistryRevision'
    | 'skillAccessGrant'
    | 'skillAlias'
  >,
): Promise<{
  companies: number;
  created: number;
  updated: number;
  existing: number;
  skipped: number;
}> {
  const companies = await db.company.findMany({ select: { id: true } });
  const totals = {
    companies: companies.length,
    created: 0,
    updated: 0,
    existing: 0,
    skipped: 0,
  };
  for (const company of companies) {
    const result = await provisionMailOpsSystemSkills(db, company.id);
    totals.created += result.created;
    totals.updated += result.updated;
    totals.existing += result.existing;
    totals.skipped += result.skipped;
  }
  return totals;
}

export async function provisionMailOpsPermissionsForExistingCompanies(
  db: Pick<
    PrismaClient,
    | 'company'
    | 'adminMembership'
    | 'departmentRole'
    | 'departmentToolPermission'
  >,
): Promise<{
  companies: number;
  roles: number;
  created: number;
}> {
  const companies = await db.company.findMany({ select: { id: true } });
  let roles = 0;
  let created = 0;
  for (const company of companies) {
    const actor = await db.adminMembership.findFirst({
      where: { companyId: company.id, isActive: true },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!actor) {
      throw new Error(
        `Cannot provision Mail Ops permissions for company ${company.id}: no active administrator.`,
      );
    }
    const companyRoles = await db.departmentRole.findMany({
      where: {
        department: { companyId: company.id, status: 'active' },
      },
      select: { id: true, departmentId: true },
    });
    roles += companyRoles.length;
    if (companyRoles.length === 0) continue;
    const result = await db.departmentToolPermission.createMany({
      data: companyRoles.flatMap(role =>
        MAIL_AUTOMATION_ACTIONS.map(actionGroup => ({
          departmentId: role.departmentId,
          roleId: role.id,
          toolId: 'mailAutomations',
          actionGroup,
          allowed: true,
          updatedBy: actor.userId,
        })),
      ),
      skipDuplicates: true,
    });
    created += result.count;
  }
  return { companies: companies.length, roles, created };
}
