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
- React whenever a future matching Gmail message arrives, including forwarding a matching message or delivering it to a Lark chat → load \`mail-ops\`.
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

## What this can and cannot do

- **Gmail only.** There is no Outlook, Microsoft 365, or IMAP support. If the user's mail is not Gmail, say so instead of creating a rule.
- **Only new mail that lands in the inbox** triggers a rule. Mail that a native Gmail filter archives, or that lands in Spam, is never seen.
- **A rule delivers the whole message.** It cannot extract a code, a link, or any part of the mail. If the user asks for "just the OTP" or "just the tracking number", tell them the entire email will be forwarded or posted, and let them decide.
- **Delivering to a Lark chat posts the full message text into that chat**, up to 20,000 characters, plain text only — no HTML and no attachments. Warn the user before delivering personal mail such as login codes into a group chat.
- **Email forwarding** preserves the original Gmail MIME content, including HTML, inline images, and attachments, inside a new message sent by the connected mailbox.

## Before creation

1. Make the deterministic match exact enough: sender, recipient, subject text, body text, attachment presence, or a combination. The \`from\` field accepts only one exact mailbox address such as \`alerts@example.com\` or one exact domain such as \`@example.com\`; never convert a brand, display name, or loose word such as "Anthropic" into a sender criterion. The same rule applies in spirit to \`to\`, \`subjectContains\`, and \`bodyContains\` — do not smuggle a brand word into those fields to work around the sender rule, because it produces a much broader rule than the user asked for. If the user gives only a brand/name or refers to "that email", ask whether they mean every message from an exact domain or only a specific mail series, or load \`google-gmail\` and inspect a bounded matching message first. Ask whether subject narrowing is wanted; never silently add or omit it when that changes the stated scope.
2. Ground the destination. Never invent an email address or Lark chat ID. For another Lark chat, load \`lark-messaging\`, list accessible chats, and use one exact returned chat ID after the user identifies it. Use \`current_lark_chat\` only for the current conversation, and only when this run is on Lark — it is rejected on desktop and web, so on those channels ask for an email destination or an exact chat ID instead.
3. Choose the Google account. Loading this recipe does not surface any Google connection, so do not expect a \`connectionId\` to be available already. Call \`mailAutomations\` without \`connectionId\`: if exactly one eligible account exists it is used automatically; if several exist the tool returns \`google_workspace_connection_selection_required\` with a \`connections\` list — show the user the account labels and retry with one exact returned \`connectionId\`. That selection prompt is a normal step, not a failure. If the tool reports that authorization is pending, end the run and wait. If it reports the Google connection is unavailable, tell the user to connect Google and stop.

## Tool contract

- Create: \`{"operation":"create","connectionId":"<UUID when needed>","name":"<short label>","match":{"from":"alerts@example.com","subjectContains":"OTP"},"destination":{"type":"email","email":"person@company.com"}}\`. For every sender at a domain, use \`{"from":"@example.com"}\`.
- Deliver to this Lark conversation: destination \`{"type":"current_lark_chat"}\`.
- Deliver to another grounded chat: destination \`{"type":"lark_chat","chatId":"<exact listed ID>"}\`.
- List: \`{"operation":"list","includeInactive":false}\`. Use \`"includeInactive":true\` whenever the user asks about paused or archived rules, or asks why a rule stopped working — the default hides everything that is not active.
- Update: replace the complete match and destination using the exact \`ruleId\`
  and \`connectionId\` returned by list. \`name\` is required too, so carry the existing name forward unless the user asked to rename it. Update also resumes a paused rule.
- Pause/resume/archive: include the exact \`ruleId\` returned by create or list. Archive is final — an archived rule cannot be resumed.

## Reading rule health

Every \`list\` row carries \`valid\`. When \`valid\` is \`false\` the row also carries \`invalidReason\`, meaning that rule is stored in a shape the current matcher rejects and **is not matching any mail**. Report those rules to the user and offer to repair them with \`update\`; never present an invalid rule as working. This is the only signal that an existing rule has stopped firing, so check it whenever a user asks about their rules or reports that an automation stopped.

## Match semantics

- Every supplied field is combined with AND. There is no OR and no negation.
- \`subjectContains\` and \`bodyContains\` are plain case-insensitive substring tests. Regular expressions, wildcards, and \`|\` alternation do not work — \`"OTP|code"\` matches the literal text \`OTP|code\` and will never fire.
- \`@domain\` matches that exact domain only, not its subdomains: \`@example.com\` does **not** match \`alerts@mail.example.com\`. Many services send from a subdomain, so when the user names a company, prefer inspecting one real message with \`google-gmail\` to read the true sending address.
- \`to\` matches the \`To\` header only — not Cc, Bcc, or Delivered-To. A rule keyed on \`to\` will miss mail where the user was copied.
- \`hasAttachment\` is true whenever any part carries a filename, which includes inline signature images. It is not a reliable "has a real attachment" test.
- Only the listed fields exist. Any other key is silently ignored rather than rejected, so never invent a field such as \`cc\` or \`labelIs\`; the rule would be created without it and would match far more mail than the user asked for.

At least one deterministic match field is required, but one broad field is rarely what the user means — \`{"hasAttachment":true}\` alone forwards every attachment-bearing message. Confirm the scope before creating a rule that matches broadly.

Matching and delivery do not invoke an LLM and do not need per-message approval. Do not claim success until create returns an active rule ID, and describe the result as active only for the rule itself — the mailbox watch is registered in the background shortly afterwards. Do not use this tool for a daily summary or other timed work; load \`schedule-divo-work\` instead.
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
