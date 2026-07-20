import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { MEMORY_PUBLISHING_REGISTERED_TOOL } from '../src/application/skills/share-memory-provisioning';
import { GOOGLE_WORKSPACE_PRODUCTS } from '../src/application/google/google-workspace-mcp-manifest';

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
  { toolId: 'larkMeeting', name: 'Lark Meetings', description: 'Search Lark video meetings, view their details, and retrieve recording links.', category: 'meetings', domain: 'lark' },
  { toolId: 'larkDoc', name: 'Lark Docs', description: 'Read and write Lark documents.', category: 'documents', domain: 'lark' },
  { toolId: 'larkBase', name: 'Lark Base', description: 'Read and write Lark Base tables and records.', category: 'data', domain: 'lark' },
  { toolId: 'larkApproval', name: 'Lark Approval', description: 'Manage Lark approval workflows.', category: 'workflow', domain: 'lark', hitlRequired: true },
  ...GOOGLE_WORKSPACE_PRODUCTS.map((product): ToolSeed => ({
    toolId: product.toolId,
    name: product.name,
    description: product.description,
    category: product.category,
    domain: 'google',
    hitlRequired: product.toolId === 'googleGmail',
    guardrails: [
      'Uses a Divo OAuth connection selected by connection ID',
      'Google credentials remain server-side',
      'Every operation is authorized by Divo before the private Workspace MCP is called',
    ],
  })),
  {
    toolId: 'canvaDesign',
    name: 'Canva',
    description: 'Search, create, and update Canva designs through a connected Canva account.',
    category: 'design',
    domain: 'canva',
    guardrails: [
      'Uses an OAuth connection selected by its connection ID',
      'Canva credentials remain server-side',
      'Each operation is authorized by the backend before the Canva MCP is called',
    ],
  },
  { toolId: 'zohoCrm', name: 'Zoho CRM', description: 'Read and write Zoho CRM records, pipeline and lead reports.', category: 'crm', domain: 'zoho' },
  { toolId: 'zohoBooks', name: 'Zoho Books', description: 'Read and write invoices, bills and expenses; financial reports.', category: 'finance', domain: 'zoho' },
  { toolId: 'contextSearch', name: 'Context Search', description: 'RAG search over ingested company documents.', category: 'knowledge', domain: 'context' },
  { toolId: 'webSearch', name: 'Web Search', description: 'Search the web for current information.', category: 'knowledge', domain: 'context' },
  { toolId: 'skillPublishing', name: 'Skill Publishing', description: 'Check sharing authority and publish explicitly shared skills to company or department scope.', category: 'knowledge', domain: 'skills', hitlRequired: true },
  MEMORY_PUBLISHING_REGISTERED_TOOL,
  {
    toolId: 'memoryRecall',
    name: 'Memory Recall',
    description: 'Recall relevant personal, current-department, and company memory within the authenticated member boundaries.',
    category: 'knowledge',
    domain: 'memory',
    guardrails: [
      'The backend derives member, company, and selected department scope',
      'Read access does not use configurable RBAC or approval within valid organisational boundaries',
      'Returns facts only; no vector IDs, scores, metadata, or embeddings',
    ],
  },
  { toolId: 'documentRag', name: 'Document RAG', description: 'Ingest and retrieve uploaded documents.', category: 'knowledge', domain: 'rag' },
  { toolId: 'dataProcessor', name: 'Data Processor', description: 'Transform and process datasets in a sandbox.', category: 'data', domain: 'data' },
  {
    toolId: 'semrush',
    name: 'Semrush SEO Research',
    description: 'Run read-only Semrush domain and organic-search research through official APIs.',
    category: 'analytics',
    domain: 'semrush',
    guardrails: [
      'Uses only the backend-configured Semrush API key',
      'Uses fixed official API operations with ordinary Divo RBAC',
      'Supports a fixed operation allow-list; arbitrary endpoints, exports, and headers are rejected',
    ],
  },
  {
    toolId: 'omsSiteData',
    name: 'OMS Site Inventory',
    description: 'Search the governed, read-only OMS website inventory for site shortlists, profiles, and catalog values.',
    category: 'analytics',
    domain: 'oms',
    guardrails: [
      'Uses only a company-owned server-side OMS Site Data API key',
      'Available only to active company administrators',
      'Supports fixed operations; SQL, raw webhook requests, headers, and provider filters are rejected',
      'OMS responses are capped at 100 rows and have no pagination',
    ],
  },
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
