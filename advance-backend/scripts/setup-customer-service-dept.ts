/**
 * One-off: provision the Customer Service department for RelicWave.
 *
 * Runs the real DepartmentAdminService so the department is seeded exactly the
 * way the admin panel would seed it (two system roles, an agent config, and a
 * MEMBER-template permission matrix), then narrows that matrix to what customer
 * service actually needs and shares the company Airtable connection with the
 * department read-only.
 *
 * The permission overlay is default-deny, so narrowing here means *deleting*
 * seeded rows rather than writing allowed=false: a missing row and a false row
 * resolve identically, and the shorter matrix is the one an administrator can
 * still read.
 *
 * Airtable is granted read_only at the connection layer, so the record tool is
 * granted read only as well. Granting create/update against a read-only
 * connection would advertise a capability the runtime refuses at call time.
 *
 * Idempotent guard: refuses if the department already exists.
 *
 *   tsx scripts/setup-customer-service-dept.ts [--apply]
 */

import { PrismaClient } from '../src/generated/prisma';
import { ConsoleLogger } from '../src/shared/logger';
import { DepartmentAdminService } from '../src/application/departments/department-admin.service';
import type { PermissionService } from '../src/application/permissions/permission.service';

const COMPANY_ID = '9f9360aa-28d1-49df-919f-3b121b7403df'; // RelicWave
const ACTOR_ID = 'f6312e2b-d0d3-49fa-acba-786be69949e4'; // Abhishek Verma (super admin)
const ALEEM_ID = '027ad373-81b0-4236-9194-aef70a3fedb5'; // Mohd Aleem
const AIRTABLE_CONNECTION_ID = 'e0055b86-fea5-4711-a097-99bac7facc14'; // "Airtable EMTL"

const DEPT_NAME = 'Customer Service';
const DEPT_SLUG = 'customer-service';

/**
 * The capability matrix, by department role slug.
 *
 * Anything absent is denied. Zoho is absent because customer service works the
 * D2C order book, not the agency ledger. `menhoodData` is absent because it is
 * not grantable — it aliases off `airtableRecords:read` for this company.
 * `knowledge` is absent because it inherits the company decision.
 */
const MATRIX: Record<'MANAGER' | 'MEMBER', Record<string, readonly string[]>> = {
  MANAGER: {
    larkMessaging: ['read', 'send'],
    larkContacts: ['read'],
    larkTask: ['read', 'create', 'update', 'delete'],
    larkCalendar: ['read', 'create', 'update', 'delete'],
    larkMeeting: ['read'],
    larkDoc: ['read', 'create', 'update'],

    // Deleting a customer's mail thread destroys the record of the complaint.
    googleGmail: ['read', 'create', 'update', 'send'],
    googleDrive: ['read', 'create', 'update'],
    googleDocs: ['read', 'create', 'update'],
    googleSheets: ['read', 'create', 'update'],
    googleSlides: ['read', 'create', 'update'],
    googleForms: ['read', 'create', 'update'],
    googleCalendar: ['read', 'create', 'update', 'delete'],
    googleTasks: ['read', 'create', 'update', 'delete'],
    googleContacts: ['read'],
    googleChat: ['read', 'send', 'update'],

    canvaDesign: ['read', 'create', 'update'],

    airtableBase: ['read'],
    airtableRecords: ['read'],

    webSearch: ['read'],
    dataExport: ['create'],
    mailAutomations: ['read', 'create', 'update', 'delete', 'execute'],
    scheduledWorkflows: ['read', 'create', 'update', 'delete', 'execute'],
  },
  MEMBER: {
    larkMessaging: ['read', 'send'],
    larkContacts: ['read'],
    larkTask: ['read', 'create', 'update'],
    larkCalendar: ['read', 'create', 'update'],
    larkMeeting: ['read'],
    larkDoc: ['read', 'create', 'update'],

    googleGmail: ['read', 'create', 'update', 'send'],
    googleDrive: ['read', 'create', 'update'],
    googleDocs: ['read', 'create', 'update'],
    googleSheets: ['read', 'create', 'update'],
    googleSlides: ['read', 'create', 'update'],
    googleForms: ['read', 'create', 'update'],
    googleCalendar: ['read', 'create', 'update'],
    googleTasks: ['read', 'create', 'update'],
    googleContacts: ['read'],
    googleChat: ['read', 'send'],

    canvaDesign: ['read', 'create', 'update'],

    airtableBase: ['read'],
    airtableRecords: ['read'],

    webSearch: ['read'],
    dataExport: ['create'],
    // A member reads the automation schedule; the manager changes it.
    mailAutomations: ['read'],
    scheduledWorkflows: ['read'],
  },
};

const SYSTEM_PROMPT = `# Divo Customer Service Department Prompt

You are Divo, the customer service department assistant.

Your job is to help the customer service team answer customer questions, track
issues to closure, and keep the team's records and correspondence accurate.

## Operating principles
- Answer from a record you actually retrieved. If you did not read it, say so.
- Order data lives in the company Airtable base and its Menhood reporting copy.
  Both are readable here; neither is writable from this department.
- Never claim an email was sent, a task was created, or a record was changed
  unless the tool output confirms it.
- Be exact with order IDs, dates, amounts, statuses, and customer names. Do not
  reconstruct one from memory of an earlier turn — re-read it.
- Absence of a row is not evidence that something did not happen. Say the window
  was empty and say what window you searched.

## Order data reaches you late
The Menhood reporting data trails real orders. Orders keep arriving into a given
date for about 30 days after that date: roughly 60-68% have landed by day 7,
79-90% by day 14, 95-99% by day 30. COD arrives about five days later than
PREPAID, so the payment mix and the delivered/RTO rates for a recent window are
distorted, not just the counts.
- For anything inside the last 30 days, state that the window is still filling
  and carry that limit into every sentence, including the summary.
- For a question about today or this week, the reporting copy will not have it.
  Read the live Airtable base instead, and say which one you used.

## Customer service behaviour
- Confirm which customer and which order before answering; two orders can share
  a name or a phone number.
- When a customer's claim and the record disagree, present both and say which is
  which. Do not resolve the conflict by picking the more convenient one.
- Draft replies that are short, specific, and free of internal vocabulary. No
  tool names, no IDs the customer did not give you, no system detail.
- Escalate rather than guess on refunds, exceptions, and anything involving
  money that is not already recorded.

## Tool guidance
- Airtable: read-only in this department. If a record needs changing, say what
  needs changing and who should change it.
- Gmail: read, draft, and send customer correspondence. Do not delete mail.
- Sheets, Docs, Drive: build and maintain issue logs and trackers.
- Lark: coordinate with the rest of the team through messages, tasks, and docs.
- Mail Ops and Scheduled Workflows: durable inbound-mail rules and recurring
  reports. The manager configures these; members read them.
- When the task is specialized, search skills first, read the relevant skill,
  then continue.`;

const DESKTOP_PERSONA = `You are the Customer Service department assistant.

Help the team resolve customer issues quickly and accurately. Prefer checking the
connected order records before answering, and say which source you checked.

Default working style:
- Give direct answers, short tables, and a clear next action.
- Verify order IDs, dates, amounts, payment mode, and status before stating them.
- Call out missing information, duplicates, and anything you are unsure about.
- Order data from the last month is still arriving, so recent counts and rates
  are incomplete. Say so whenever you report on a recent period.

User experience:
- Speak in plain business language. Do not expose tool names, internal IDs,
  system architecture, permissions, or implementation details unless asked.
- Do not write code, build dashboards, or start technical projects unless the
  user explicitly asks for that.
- Ask one short clarifying question only when it is needed to answer safely.

Safety:
- Order records are readable here, not writable. If something needs to change,
  say what and who should change it rather than implying you did it.
- Do not guess refund eligibility, delivery dates, or payment status.
- Keep customer contact details limited to what the request needs.`;

// The service only calls invalidate* on these. A department that does not exist
// yet has nothing cached under it, so a no-op is correct rather than merely
// convenient.
const noopPermissions = {
  invalidateCompany: async () => {},
  invalidateDept: async () => {},
} as unknown as PermissionService;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  const logger = new ConsoleLogger({ script: 'setup-customer-service-dept' });

  try {
    const existing = await prisma.department.findFirst({
      where: { companyId: COMPANY_ID, slug: DEPT_SLUG },
      select: { id: true, name: true },
    });
    if (existing) {
      console.log(`REFUSING: department already exists — ${existing.name} (${existing.id})`);
      return;
    }

    const [actor, aleem, connection] = await Promise.all([
      prisma.user.findUnique({ where: { id: ACTOR_ID }, select: { id: true, email: true } }),
      prisma.user.findUnique({ where: { id: ALEEM_ID }, select: { id: true, email: true, name: true } }),
      prisma.integrationConnection.findUnique({
        where: { id: AIRTABLE_CONNECTION_ID },
        select: { id: true, provider: true, label: true, status: true, companyId: true },
      }),
    ]);
    if (!actor) throw new Error(`actor ${ACTOR_ID} not found`);
    if (!aleem) throw new Error(`aleem ${ALEEM_ID} not found`);
    if (!connection) throw new Error(`airtable connection ${AIRTABLE_CONNECTION_ID} not found`);
    if (connection.companyId !== COMPANY_ID) throw new Error('airtable connection belongs to another company');
    if (connection.status !== 'connected') throw new Error(`airtable connection is ${connection.status}`);

    const membership = await prisma.adminMembership.findFirst({
      where: { userId: ALEEM_ID, companyId: COMPANY_ID, isActive: true },
      select: { role: true },
    });
    if (!membership) throw new Error('aleem has no active company membership');

    console.log(`company     : ${COMPANY_ID}`);
    console.log(`manager     : ${aleem.name} <${aleem.email}> (company role ${membership.role})`);
    console.log(`airtable    : ${connection.label} → read_only, granted to the department`);
    console.log(`matrix      : MANAGER ${countGrants('MANAGER')} grants, MEMBER ${countGrants('MEMBER')} grants`);
    if (!apply) {
      console.log('\nDRY RUN — pass --apply to write.');
      return;
    }

    const svc = new DepartmentAdminService({ prisma, logger, permissions: noopPermissions });

    // 1. Department + system roles + agent config + MEMBER-template matrix.
    const created = await svc.createDepartment(COMPANY_ID, ACTOR_ID, {
      name: DEPT_NAME,
      description: 'Customer support: order lookups, customer correspondence, and issue tracking.',
    });
    if (!created.ok) throw new Error(`createDepartment failed: ${created.error.message}`);
    const departmentId = created.value.id;
    console.log(`\ncreated department ${departmentId} (${created.value.slug})`);

    const roles = await prisma.departmentRole.findMany({
      where: { departmentId },
      select: { id: true, slug: true },
    });
    const roleId = (slug: string): string => {
      const found = roles.find(r => r.slug === slug);
      if (!found) throw new Error(`role ${slug} was not seeded`);
      return found.id;
    };

    // 2. Narrow the seeded matrix to the customer-service set.
    for (const slug of ['MANAGER', 'MEMBER'] as const) {
      const id = roleId(slug);
      const wanted = new Set(
        Object.entries(MATRIX[slug]).flatMap(([toolId, actions]) =>
          actions.map(action => `${toolId}:${action}`),
        ),
      );
      const seeded = await prisma.departmentToolPermission.findMany({
        where: { departmentId, roleId: id },
        select: { id: true, toolId: true, actionGroup: true },
      });

      const surplus = seeded.filter(row => !wanted.has(`${row.toolId}:${row.actionGroup}`));
      if (surplus.length > 0) {
        await prisma.departmentToolPermission.deleteMany({
          where: { id: { in: surplus.map(r => r.id) } },
        });
      }

      const present = new Set(seeded.map(r => `${r.toolId}:${r.actionGroup}`));
      const missing = [...wanted].filter(key => !present.has(key));
      for (const key of missing) {
        const [toolId, actionGroup] = key.split(':') as [string, string];
        await prisma.departmentToolPermission.create({
          data: { departmentId, roleId: id, toolId, actionGroup, allowed: true, updatedBy: ACTOR_ID },
        });
      }
      console.log(`  ${slug}: kept ${wanted.size}, removed ${surplus.length}, added ${missing.length}`);
    }

    // 3. Department persona.
    const config = await svc.updateConfig(departmentId, COMPANY_ID, ACTOR_ID, {
      systemPrompt: SYSTEM_PROMPT,
      desktopPersonaPrompt: DESKTOP_PERSONA,
    });
    if (!config.ok) throw new Error(`updateConfig failed: ${config.error.message}`);
    console.log('  agent config written');

    // 4. Aleem as department manager.
    const assigned = await svc.upsertMembership(departmentId, COMPANY_ID, {
      userId: ALEEM_ID,
      roleId: roleId('MANAGER'),
      status: 'active',
    });
    if (!assigned.ok) throw new Error(`upsertMembership failed: ${assigned.error.message}`);
    console.log('  aleem assigned as MANAGER');

    // 5. Land his session in this department rather than nowhere.
    await prisma.userDepartmentPreference.upsert({
      where: { companyId_userId: { companyId: COMPANY_ID, userId: ALEEM_ID } },
      update: { activeDepartmentId: departmentId },
      create: { companyId: COMPANY_ID, userId: ALEEM_ID, activeDepartmentId: departmentId },
    });
    console.log('  active department preference set');

    // 6. Share the company Airtable connection with the department, read-only.
    await prisma.integrationConnectionGrant.upsert({
      where: {
        connectionId_granteeType_granteeId: {
          connectionId: AIRTABLE_CONNECTION_ID,
          granteeType: 'department',
          granteeId: departmentId,
        },
      },
      update: { access: 'read_only', revokedAt: null, grantedBy: ACTOR_ID },
      create: {
        companyId: COMPANY_ID,
        connectionId: AIRTABLE_CONNECTION_ID,
        granteeType: 'department',
        granteeId: departmentId,
        access: 'read_only',
        grantedBy: ACTOR_ID,
      },
    });
    console.log('  airtable connection shared read_only');

    console.log(`\nDONE. departmentId=${departmentId}`);
  } finally {
    await prisma.$disconnect();
  }
}

function countGrants(slug: 'MANAGER' | 'MEMBER'): number {
  return Object.values(MATRIX[slug]).reduce((n, actions) => n + actions.length, 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
