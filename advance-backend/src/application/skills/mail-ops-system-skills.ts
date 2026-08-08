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
- **A rule delivers the whole message. That is the design, not a shortfall.** Mail Ops is deliberately good at *which* mail and *where it goes* — sender, subject, exclusions, hours, destination — and never rewrites, summarises, or pulls anything out of what it sends. When the user asks for "just the OTP", "just the tracking number", or "just the amount", say plainly that the whole email arrives instead, and move on. It is a correct answer with more in it, not a worse one.
- **Do not build a workaround for that.** There is no Divo path that extracts part of an email on arrival — not the scheduler, not a Gmail filter, not a local script, and **not the judge below**. Offering one would promise something nothing delivers. Set up the forward and tell the user what they will receive.
- **A rule may also carry one AI step.** In its first form, the **judge**, it decides *whether* to act — the answer to "only the real ones", which no combination of substrings can express. In its second, a **routing table**, it decides *which of several people* a message goes to. A rule has one or the other, never both. See **The judge** and **Sorting mail between people** below.
- **A rule can also tidy mail instead of sending it** — label it, archive it, mark it read — with \`destination.type: "organize"\`. That acts on the user's own Gmail and reaches nobody else.
- **Delivering to a Lark chat posts the full message text into that chat**, up to 20,000 characters, plain text only — no HTML and no attachments. Warn the user before delivering personal mail such as login codes into a group chat.
- **Email forwarding** preserves the original Gmail MIME content, including HTML, inline images, and attachments, inside a new message sent by the connected mailbox.

## Before creation

1. Make the deterministic match exact enough: sender, recipient, subject text, body text, attachment presence, or a combination. The \`from\` field takes one mailbox address such as \`alerts@example.com\` or one domain such as \`@example.com\` — see **Match semantics** below for exactly what a domain covers and what shapes are accepted. Never convert a brand, display name, or loose word such as "Anthropic" into a sender criterion. \`to\` and \`notFrom\` are validated the same way and reject a brand word outright. The rule still applies in spirit to \`subjectContains\` and \`bodyContains\` — do not smuggle a brand word into those fields to work around the sender rule, because it produces a much broader rule than the user asked for. If the user gives only a brand/name or refers to "that email", ask whether they mean every message from an exact domain or only a specific mail series, or load \`google-gmail\` and inspect a bounded matching message first. Ask whether subject narrowing is wanted; never silently add or omit it when that changes the stated scope.
2. Ground the destination. Never invent an email address or Lark chat ID. For another Lark chat, load \`lark-messaging\`, list accessible chats, and use one exact returned chat ID after the user identifies it. Use \`current_lark_chat\` only for the current conversation, and only when this run is on Lark — it is rejected on desktop and web, so on those channels ask for an email destination or an exact chat ID instead.
3. Choose the Google account. Loading this recipe does not surface any Google connection, so do not expect a \`connectionId\` to be available already. Call \`mailAutomations\` without \`connectionId\`: if exactly one eligible account exists it is used automatically; if several exist the tool returns \`google_workspace_connection_selection_required\` with a \`connections\` list — show the user the account labels and retry with one exact returned \`connectionId\`. That selection prompt is a normal step, not a failure. If the tool reports that authorization is pending, end the run and wait. If it reports the Google connection is unavailable, tell the user to connect Google and stop.

## Tool contract

- Create: \`{"operation":"create","connectionId":"<UUID when needed>","name":"<short label>","match":{"from":"alerts@example.com","subjectContains":"OTP"},"destination":{"type":"email","email":"person@company.com"}}\`. For every sender at a domain, use \`{"from":"@example.com"}\`.
- Deliver to this Lark conversation: destination \`{"type":"current_lark_chat"}\`.
- Deliver to another grounded chat: destination \`{"type":"lark_chat","chatId":"<exact listed ID>"}\`.
- Sort between people: destination \`{"type":"routed","routes":[...],"otherwise":"hold"}\` — see **Sorting mail between people** below.
- Tidy without sending: destination \`{"type":"organize","label":"Receipts","archive":true,"markRead":false}\`. At least one of \`label\`, \`archive\`, \`markRead\` must be set. A missing label is created in the user's Gmail. No address is involved and nothing leaves the mailbox.
- Cap a busy rule: add \`"rateLimitPerHour": 20\` beside the destination. Email and Lark only. Over the cap a message is **dropped and recorded**, not queued — say that plainly, because a user asking for a cap usually assumes the rest arrives later.
- List: \`{"operation":"list","includeInactive":false}\`. Use \`"includeInactive":true\` whenever the user asks about paused or archived rules, or asks why a rule stopped working — the default hides everything that is not active.
- Test: \`{"operation":"test","ruleId":"<exact ruleId>"}\`. Replays the rule against mail Divo already recorded for that mailbox and reports what it would have matched. **Sends nothing, and calls no model** — on a rule with a judge or a routing table it reports which messages *reach* that step, never what it would decide or who would get them. Say that, or the result reads as a preview of the sorting. Run it after creating or editing any rule that is not obviously narrow, and whenever the user asks why a rule is quiet. \`consideredCount: 0\` means Divo has recorded no mail for that mailbox yet — report that, do not report it as "the rule matches nothing".
- Update: replace the complete match and destination using the exact \`ruleId\`
  and \`connectionId\` returned by list. \`name\` is required too, so carry the existing name forward unless the user asked to rename it. **\`rateLimitPerHour\` works the same way: it is replaced, not merged, so a rule that had a cap loses it unless you re-send it.** Read the current value from the rule's \`action.rateLimitPerHour\` in \`list\` and carry it forward. Update also resumes a paused rule.
- Pause/resume/archive: include the exact \`ruleId\` returned by create or list. Archive is final — an archived rule cannot be resumed.

## The judge

A deterministic match is a filter, and filters cannot tell an invoice from an advert for an invoicing product. \`judge\` closes that gap: one question, asked of every matched message, answered yes or no before the rule acts.

- Shape: \`"judge": {"question":"Is this a real invoice addressed to us, rather than marketing, a quote, or a reminder for something already paid?","onFailure":"closed"}\`.
- **Offer it whenever the user's own words are a judgement, not a pattern** — "the real ones", "actual complaints", "only what needs my reply". Creating a match-only rule there hands them something that forwards the wrong mail, and they find out a week later from the person on the other end.
- **Write \`question\` as one closed yes/no question**, in the user's own terms. Never an instruction, never a list of steps, never a request for a value out of the message.
- **A rejected message is held, not lost.** It is recorded with the model's reason and the user can see it. Say this — a user who thinks rejected mail vanishes will not trust the step.
- **It sees headers and a short preview only** — never the full body, never attachments. Do not promise answers that need the whole document ("is the total over 50,000"). Say what it can actually see.
- **\`onFailure\` decides what happens when the model cannot answer.** \`closed\` (the default) sends nothing; \`open\` acts anyway. Use \`open\` only for a noise-cutting rule where a stray forward is better than a missed message, and **never on a rule whose destination is outside the company**.
- **It cannot move mail.** A judge decides yes or no. To send different mail to different people, use a routing table instead — see below.
- **Narrow the match first.** Every matched message costs a model call, so an exclusion such as \`notFrom: "no-reply@"\` is free and stops those before the judge runs.
- **\`update\` replaces \`judge\` rather than merging it**, exactly like \`rateLimitPerHour\`. Read the current value from the rule's \`judge\` in \`list\` and carry it forward unless the user asked to change or remove it. Renaming a rule without doing so deletes its judge.

## Sorting mail between people

When the user names **different people for different kinds of the same mail** — "invoices to Anish, product mail to Rakshit" — that is **one** rule with a routing table, not two rules and not an unsupported "or". Divo reads each matching message and sends it to exactly one of the destinations the user wrote down.

- Shape: \`"destination":{"type":"routed","routes":[{"key":"invoices","when":"an invoice, bill or payment request","destination":{"type":"email","email":"anish@company.com"}},{"key":"product","when":"about the product, a feature or a bug","destination":{"type":"email","email":"rdx@company.com"}}],"otherwise":"hold"}\`
- \`key\` is a short lowercase label. \`when\` describes what that kind of message **is**, in a few words — not a question. Never \`none\`; that is the answer meaning "nothing fits".
- **Two to six routes**, and **every route must send the same way** — all email, or all Lark. A rule is one action and cannot be both a forward and a Lark delivery.
- **One hourly ceiling for the whole rule**, not per route.
- **A routed rule takes no \`judge\`.** The routes are the question, and sending both is refused.
- **\`otherwise\` decides what happens to mail that fits no route, and you must tell the user which it is before creating the rule.** Say plainly: *anything that fits none of these is held back and shown to you, and nothing is sent* — then offer the alternative in the same breath, that they can name one more person for everything else. Do not create a routed rule without saying which of the two it is doing.
- **There is no failure setting.** \`otherwise\` already is one: \`"hold"\` means a message Divo could not read is held, and naming somebody means it goes to them. That is the only choice, and it is the user's.
- **It can never send anywhere else.** Divo is shown the descriptions and picks one; an answer naming anything the rule does not carry is treated as unreadable and falls to \`otherwise\`. Say this — a user deciding whether to trust a rule with their client's mail is deciding exactly this question.
- **\`update\` replaces the whole table**, exactly like \`judge\` and \`rateLimitPerHour\`. Read \`routes\` and \`otherwise\` from the rule in \`list\` and carry them forward, or renaming the rule deletes its routing.
- **A sender who writes into an email can try to influence how it is sorted.** The worst that does is send that message to one of the people the user already chose, because the set is fixed when the rule is written — but do not widen what Divo reads to make sorting "better".

## Reading rule health

Every \`list\` row carries \`valid\`. When \`valid\` is \`false\` the row also carries \`invalidReason\`, meaning that rule is stored in a shape the current matcher rejects and **is not matching any mail**. Report those rules to the user and offer to repair them with \`update\`; never present an invalid rule as working. This is the only signal that an existing rule has stopped firing, so check it whenever a user asks about their rules or reports that an automation stopped.

## Match semantics

- Every supplied field is combined with AND. There is no OR.
- \`subjectContains\`, \`bodyContains\` and \`notSubjectContains\` are plain case-insensitive substring tests. Regular expressions and wildcards do not work and are refused. **To match any of several phrases, pass a list:** \`{"subjectContains":["OTP","verification code"]}\` fires when the subject contains either. Do not write \`"OTP|verification code"\` — a \`|\` is refused rather than split, because a subject line can legitimately contain one and splitting would silently widen the rule. Surrounding quotes and \`*\`/\`%\` wildcards are stripped for you, so \`"*invoice*"\` is read as \`invoice\`.
- \`@domain\` matches that domain **and every subdomain of it**: \`@example.com\` covers \`alerts@example.com\` and \`receipts@mail.example.com\`. That is what most services need, since transactional mail usually leaves from a sending subdomain. It matches on domain boundaries, so \`@example.com\` never matches a lookalike such as \`billing@notexample.com\`. There is no way to ask for a domain *without* its subdomains — if the user needs that precision, narrow with \`from\` on the exact mailbox address instead.
- A bare registry — \`@com\`, \`@co.uk\`, \`@com.au\` — is rejected, because with subdomains included it would match almost every sender. Name the organisation: \`@acme.co.uk\`.
- **You do not have to clean up what the user says.** \`acme.com\` without the \`@\`, \`Alerts <alerts@acme.com>\` pasted from a mail client, \`mailto:\` prefixes, \`https://acme.com\`, a trailing dot, and any capitalisation are all accepted and normalised. Pass their wording through.
- A brand or team name on its own — "Stripe", "the finance team" — is rejected and is **never** guessed into a domain. If that happens, do not retry with a domain you invented: ask the user for the sending address, or load \`google-gmail\` and read one real message to find it.
- \`to\` takes one exact mailbox address or one \`@domain\`, exactly like \`from\`, and matches the \`To\`, \`Cc\`, \`Bcc\` and \`Delivered-To\` headers together. Mail the user was copied on counts. There is no separate \`cc\` field and none is needed.
- \`hasAttachment\` is true only for a file someone attached. Inline images — signature logos, tracking pixels, embedded screenshots — do not count.
- \`notFrom\` and \`notSubjectContains\` exclude. \`notFrom\` takes an exact address or \`@domain\` like \`from\`; \`notSubjectContains\` is a plain substring. Both are narrowing-only: a rule made of exclusions alone is rejected, because "everything except X" is the broadest rule the system can express and is never what someone writing an exclusion means. An exclusion that cancels its own match — \`from: "@acme.com"\` with \`notFrom: "@acme.com"\` — is rejected too.
- \`activeWindow\` limits a rule to part of the week: \`{"days":["mon","tue","wed","thu","fri"],"start":"09:00","end":"18:00","timeZone":"Asia/Kolkata"}\`. Times are 24-hour local wall clock and the window is half-open — 09:00 is inside, 18:00 is not. An \`end\` at or before \`start\` means overnight, and an overnight window belongs to the day it opened on. \`days\` may be omitted for every day. **\`timeZone\` is required and there is no default** — ask the user which timezone rather than assuming one. The window is judged on when the mail arrived, not when Divo got to it.
- Only the listed fields exist, and any other key is rejected outright. If the user wants narrowing this tool cannot express, say so rather than creating a broader rule.

At least one of \`from\`, \`to\`, \`subjectContains\` or \`bodyContains\` is required; \`{"hasAttachment":true}\` on its own is rejected, because it forwards every message carrying a file. \`hasAttachment\`, \`notFrom\`, \`notSubjectContains\` and \`activeWindow\` only narrow a rule that already has one of the four. Even one narrowing field can still be broad — confirm the scope before creating a rule that matches widely, and prefer running \`test\` over guessing.

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
