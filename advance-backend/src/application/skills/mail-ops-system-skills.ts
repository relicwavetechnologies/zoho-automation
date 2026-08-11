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
- React whenever a future matching Gmail message arrives, including forwarding a matching message, delivering it to a Lark chat, or sending different kinds of it to different people → load \`mail-ops\`.
- Run inbox work at a clock time or recurrence, such as a daily digest → load \`schedule-divo-work\` and \`google-gmail\`. Scheduler owns timing; Gmail owns the work performed at run time.
- Reserve time, invite attendees, check free/busy, or create a meeting/event → load \`google-calendar\`.
- Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts, Chat, or Apps Script → load the matching \`google-<product>\` recipe.

"Send invoices to one person and product mail to another" is one arrival rule that sorts, not two rules — still \`mail-ops\`.
If "forward this email" could mean a one-time action or an ongoing arrival rule, ask which one. Never implement a future-arrival rule with the scheduler, and never create a Mail Ops rule for a one-time Gmail action.`,
  },
  {
    slug: 'mail-ops',
    name: 'Mail Ops',
    summary:
      'Create and manage deterministic Gmail-arrival rules for forwarding future matching mail to email, delivering it to Lark, or sorting each arriving message to the right person.',
    toolIds: ['mailAutomations'],
    tags: ['gmail', 'mail', 'automation', 'forwarding', 'otp', 'watcher', 'routing', 'triage'],
    /*
     * Routing needs its own vocabulary, or the recipe describing it is never
     * reached. Nobody asking Divo to "sort my client's mail between the team"
     * says "forward future email" — and the router scores alias tokens, so a
     * capability the catalogue cannot be searched for is a capability that
     * exists only for whoever already knows it does.
     */
    aliases: [
      'whenever email arrives',
      'when mail arrives',
      'forward future email',
      'automatic email forwarding',
      'mail watcher',
      'otp forwarding',
      'send matching mail to lark',
      'sort mail between people',
      'route mail to the right person',
      'send different mail to different people',
      'split incoming mail by kind',
      'triage arriving mail',
    ],
    sortOrder: 6,
    markdown: `# Mail Ops

Use this recipe only for rules triggered by future Gmail arrivals. The \`mailAutomations\` tool states the rule contract itself — every match field, destination shape, the judge and routing shapes, and what each operation replaces. This recipe covers the decisions that contract cannot make.

## What to tell the user before building anything

- **A rule delivers the whole message. That is the design, not a shortfall.** Mail Ops is deliberately good at *which* mail and *where it goes* — sender, subject, exclusions, hours, destination — and never rewrites, summarises, or pulls anything out of what it sends. When the user asks for "just the OTP", "just the tracking number", or "just the amount", say plainly that the whole email arrives instead, and move on. It is a correct answer with more in it, not a worse one.
- **Do not build a workaround for that.** No Divo path extracts part of an email on arrival — not the scheduler, not a Gmail filter, not a local script, and **not the judge**. Offering one would promise something nothing delivers. Never substitute Scheduler, a polling loop, or a native Gmail filter for an arrival-triggered Mail Ops rule.
- **Delivering to a Lark chat posts the full message text into that chat.** Warn the user before delivering personal mail such as login codes into a group chat.
- If the user's mail is not Gmail, say so instead of creating a rule.

## Before creation

1. **Make the deterministic match exact enough, and never widen it to get around a rejection.** \`from\`, \`to\` and \`notFrom\` refuse a brand or display name outright — do not smuggle that word into \`subjectContains\` or \`bodyContains\` instead, because it produces a much broader rule than the user asked for. If the user gives only a brand or refers to "that email", ask whether they mean every message from an exact domain or only a specific mail series, or load \`google-gmail\` and inspect one bounded matching message to find the real address. Ask whether subject narrowing is wanted; never silently add or omit it when that changes the stated scope.
2. **Even one narrowing field can still be broad.** Confirm the scope before creating a rule that matches widely, and prefer running \`test\` over guessing.
3. **Ground the destination.** Never invent an email address or Lark chat ID. For another Lark chat, load \`lark-messaging\`, list accessible chats, and use one exact returned chat ID after the user identifies it. \`current_lark_chat\` is rejected on desktop and web, so on those channels ask for an email destination or an exact chat ID instead.
4. **Choose the Google account.** Loading this recipe surfaces no Google connection, so do not expect a \`connectionId\` to be available already. Call \`mailAutomations\` without one; when it asks for a selection, show the user the account labels and retry with one exact returned ID. If it reports authorization pending, end the run and wait. If it reports the Google connection is unavailable, tell the user to connect Google and stop. If it returns \`mail_ops_configuration_required\`, stop and report the operator setup requirement.

## Offering the AI step

A deterministic match is a filter, and filters cannot tell an invoice from an advert for an invoicing product. A rule may carry one AI step: a **judge** deciding *whether* to act, or a **routing table** deciding *which of several people* a message goes to. One or the other, never both.

- **Offer a judge whenever the user's own words are a judgement, not a pattern** — "the real ones", "actual complaints", "only what needs my reply". Creating a match-only rule there hands them something that forwards the wrong mail, and they find out a week later from the person on the other end.
- **A rejected message is held, not lost.** Say this — a user who thinks rejected mail vanishes will not trust the step.
- **The judge sees headers and a short preview only.** Do not promise answers that need the whole document ("is the total over 50,000"). Say what it can actually see.
- **Never set \`onFailure\` to \`open\` on a rule whose destination is outside the company.**

## Sorting mail between people

When the user names **different people for different kinds of the same mail** — "invoices to Anish, product mail to Rakshit" — that is **one** rule with a routing table, not two rules and not an unsupported "or". Divo reads each matching message and sends it to exactly one of the destinations the user wrote down.

- **\`otherwise\` decides what happens to mail that fits no route, and you must tell the user which it is before creating the rule.** Say plainly: *anything that fits none of these is held back and shown to you, and nothing is sent* — then offer the alternative in the same breath, that they can name one more person for everything else. Do not create a routed rule without saying which of the two it is doing.
- **The set of recipients is closed.** That is the whole safety case, so say it — a user deciding whether to trust a rule with their client's mail is deciding exactly this question.
- **A sender who writes into an email can try to influence how it is sorted.** The worst that does is send that message to one of the people the user already chose, because the set is fixed when the rule is written — but do not widen what Divo reads to make sorting "better".

## Checking your work

- **\`test\` sends nothing and calls no model.** On a rule with a judge or a routing table it reports which messages *reach* that step, never what it would decide or who would get them. Say that, or the result reads as a preview of the sorting. Run it after creating or editing any rule that is not obviously narrow, and whenever the user asks why a rule is quiet. \`consideredCount: 0\` means Divo has recorded no mail for that mailbox yet — report that, do not report it as "the rule matches nothing".
- **\`valid: false\` on a \`list\` row is the only signal that an existing rule has stopped firing.** Check it whenever a user asks about their rules or reports that an automation stopped, and offer to repair it with \`update\`; never present an invalid rule as working.
- **Every \`update\` replaces rather than merges** — the match, the destination, the cap, the judge, the whole routing table. Read the rule from \`list\` and carry forward everything the user did not ask to change. Renaming a rule without doing so deletes its judge.
- Do not claim success until create returns an active rule ID, and describe the result as active only for the rule itself — the mailbox watch is registered in the background shortly afterwards.
- Do not use this tool for a daily summary or other timed work; load \`schedule-divo-work\` instead.`,
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

export interface MailOpsPermissionProvisionResult {
  companies: number;
  /** System roles considered — the two every department is created with. */
  roles: number;
  created: number;
  /** Roles left alone because someone had already decided about this tool. */
  alreadyDecided: number;
  /** Companies passed over rather than failed on, with the reason. */
  skippedCompanies: Array<{ companyId: string; reason: 'no_active_administrator' }>;
  departmentsInvalidated: number;
}

/**
 * Give existing departments the `mailAutomations` rows a department created
 * today would already have.
 *
 * Scoped to **system roles** on purpose. `createDepartment` seeds its two
 * system roles from `memberTemplateGrants()` and nothing else, so a department
 * predating this tool in the taxonomy is missing exactly those rows and no
 * others. A custom "Intern" or "Contractor" role was configured by hand, and
 * this provisioner used to grant all five actions to every one of them on every
 * run — which, since `prestart` runs it, meant every backend boot silently
 * re-widened roles an admin had deliberately narrowed.
 *
 * A role that already holds any `mailAutomations` row is left alone whether the
 * row allows or denies: the decision has been made, and re-asserting `allowed`
 * over a deliberate denial is the same defect in a smaller window.
 *
 * `invalidateDept` is best-effort. Without it the grant is real in the database
 * immediately but invisible to a running instance until its 15-minute
 * permission cache expires.
 */
export async function provisionMailOpsPermissionsForExistingCompanies(
  db: Pick<
    PrismaClient,
    | 'company'
    | 'adminMembership'
    | 'departmentRole'
    | 'departmentToolPermission'
  >,
  options: {
    invalidateDept?: (companyId: string, departmentId: string) => Promise<void>;
  } = {},
): Promise<MailOpsPermissionProvisionResult> {
  const companies = await db.company.findMany({ select: { id: true } });
  const result: MailOpsPermissionProvisionResult = {
    companies: companies.length,
    roles: 0,
    created: 0,
    alreadyDecided: 0,
    skippedCompanies: [],
    departmentsInvalidated: 0,
  };

  for (const company of companies) {
    const actor = await db.adminMembership.findFirst({
      where: { companyId: company.id, isActive: true },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!actor) {
      // A company between administrators is not a reason to fail the run. This
      // used to throw, and because `prestart` runs the reconciler, one such
      // company kept the whole backend from starting.
      result.skippedCompanies.push({
        companyId: company.id,
        reason: 'no_active_administrator',
      });
      continue;
    }

    const systemRoles = await db.departmentRole.findMany({
      where: {
        isSystem: true,
        department: { companyId: company.id, status: 'active' },
      },
      select: { id: true, departmentId: true },
    });
    result.roles += systemRoles.length;
    if (systemRoles.length === 0) continue;

    const decided = new Set(
      (
        await db.departmentToolPermission.findMany({
          where: {
            toolId: 'mailAutomations',
            roleId: { in: systemRoles.map(role => role.id) },
          },
          select: { roleId: true },
        })
      ).map(row => row.roleId),
    );
    const pending = systemRoles.filter(role => !decided.has(role.id));
    result.alreadyDecided += systemRoles.length - pending.length;
    if (pending.length === 0) continue;

    const written = await db.departmentToolPermission.createMany({
      data: pending.flatMap(role =>
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
    result.created += written.count;

    if (written.count === 0) continue;
    for (const departmentId of new Set(pending.map(role => role.departmentId))) {
      if (!options.invalidateDept) continue;
      await options.invalidateDept(company.id, departmentId);
      result.departmentsInvalidated += 1;
    }
  }

  return result;
}
