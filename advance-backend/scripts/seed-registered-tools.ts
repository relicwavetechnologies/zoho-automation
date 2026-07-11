import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { MEMORY_PUBLISHING_REGISTERED_TOOL } from '../src/application/skills/share-memory-provisioning';

/**
 * Seeds the RegisteredTool catalog (the table the admin panel lists tools from).
 *
 * Create-missing-only: existing rows are NEVER modified (update: {}), so any
 * manually-curated names/descriptions are preserved. Run any time a new tool
 * is added to the registry.
 *
 *   pnpm tsx scripts/seed-registered-tools.ts
 */

interface ToolSeed {
  toolId: string;
  name: string;
  description: string;
  category: string;
  domain: string;
  hitlRequired?: boolean;
  guardrails?: string[];
}

const TOOLS: ToolSeed[] = [
  { toolId: 'larkMessaging', name: 'Lark Messaging', description: 'Send and reply to Lark messages and DMs.', category: 'communication', domain: 'lark' },
  { toolId: 'larkContacts', name: 'Lark Contacts', description: 'Resolve and search Lark employee contacts.', category: 'directory', domain: 'lark' },
  { toolId: 'larkTask', name: 'Lark Tasks', description: 'Create, read, update and complete Lark tasks and tasklists.', category: 'productivity', domain: 'lark' },
  { toolId: 'larkCalendar', name: 'Lark Calendar', description: 'List, create and update Lark calendar events.', category: 'calendar', domain: 'lark' },
  { toolId: 'larkDoc', name: 'Lark Docs', description: 'Read and write Lark documents.', category: 'documents', domain: 'lark' },
  { toolId: 'larkBase', name: 'Lark Base', description: 'Read and write Lark Base tables and records.', category: 'data', domain: 'lark' },
  { toolId: 'larkApproval', name: 'Lark Approval', description: 'Manage Lark approval workflows.', category: 'workflow', domain: 'lark', hitlRequired: true },
  { toolId: 'googleGmail', name: 'Gmail', description: 'Send, reply, draft and search email with attachments.', category: 'communication', domain: 'google', hitlRequired: true },
  { toolId: 'googleDrive', name: 'Google Drive', description: 'List, read and download Drive files.', category: 'documents', domain: 'google' },
  { toolId: 'googleCalendar', name: 'Google Calendar', description: 'List, create and update Google Calendar events.', category: 'calendar', domain: 'google' },
  { toolId: 'zohoCrm', name: 'Zoho CRM', description: 'Read and write Zoho CRM records, pipeline and lead reports.', category: 'crm', domain: 'zoho' },
  { toolId: 'zohoBooks', name: 'Zoho Books', description: 'Read and write invoices, bills and expenses; financial reports.', category: 'finance', domain: 'zoho' },
  { toolId: 'contextSearch', name: 'Context Search', description: 'RAG search over ingested company documents.', category: 'knowledge', domain: 'context' },
  { toolId: 'webSearch', name: 'Web Search', description: 'Search the web for current information.', category: 'knowledge', domain: 'context' },
  { toolId: 'skillPublishing', name: 'Skill Publishing', description: 'Check sharing authority and publish explicitly shared skills to company or department scope.', category: 'knowledge', domain: 'skills', hitlRequired: true },
  MEMORY_PUBLISHING_REGISTERED_TOOL,
  { toolId: 'documentRag', name: 'Document RAG', description: 'Ingest and retrieve uploaded documents.', category: 'knowledge', domain: 'rag' },
  { toolId: 'dataProcessor', name: 'Data Processor', description: 'Transform and process datasets in a sandbox.', category: 'data', domain: 'data' },
  {
    toolId: 'runCommand',
    name: 'Terminal',
    description:
      "Run shell commands on the user's own machine (desktop app), streaming a live terminal. Always on and local — every command requires the user's Run/Decline approval, so it is exempt from company RBAC.",
    category: 'execution',
    domain: 'execution',
    hitlRequired: true,
    guardrails: [
      "Runs on the user's machine via the desktop app — never the server",
      'Every command requires the user\'s Run/Decline approval',
      'Catastrophic commands (rm -rf /, fork bombs, mkfs, dd, shutdown) are hard-blocked',
      'Not governed by company/department RBAC — always on, locally gated',
    ],
  },
];

async function main() {
  const prisma = new PrismaClient();
  let created = 0;
  let skipped = 0;
  try {
    for (const t of TOOLS) {
      const existing = await prisma.registeredTool.findUnique({ where: { toolId: t.toolId } });
      if (existing) {
        skipped += 1;
        continue;
      }
      await prisma.registeredTool.create({
        data: {
          toolId: t.toolId,
          name: t.name,
          description: t.description,
          category: t.category,
          domain: t.domain,
          hitlRequired: t.hitlRequired ?? false,
          guardrails: t.guardrails ?? [],
          engines: [],
          deprecated: false,
        },
      });
      created += 1;
      console.log(`+ created RegisteredTool: ${t.toolId}`);
    }
    console.log(`\nDone — ${created} created, ${skipped} already present (untouched).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
