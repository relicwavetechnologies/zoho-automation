import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { KNOWLEDGE_REGISTERED_TOOL } from '../src/application/skills/knowledge-provisioning';
import { GOOGLE_WORKSPACE_PRODUCTS } from '../src/application/google/google-workspace-mcp-manifest';
import { AIRTABLE_PRODUCTS } from '../src/application/airtable/airtable-mcp-manifest';

/**
 * Seeds the RegisteredTool catalog (the table the admin panel lists tools from).
 *
 * Create-missing-only: existing rows are NEVER modified (update: {}), so any
 * manually-curated names/descriptions are preserved. Run any time a new tool
 * is added to the registry.
 *
 *   pnpm tsx scripts/seed-registered-tools.ts
 */

export interface RegisteredToolSeed {
  readonly toolId: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly domain: string;
  readonly hitlRequired?: boolean;
  readonly guardrails?: readonly string[];
}

export const REGISTERED_TOOL_SEEDS: readonly RegisteredToolSeed[] = [
  { toolId: 'connectApp', name: 'Connect App', description: 'Ask a member to connect or widen a provider account for governed Divo tools.', category: 'connections', domain: 'context' },
  { toolId: 'larkMessaging', name: 'Lark Messaging', description: 'Send and reply to Lark messages and DMs.', category: 'communication', domain: 'lark' },
  { toolId: 'larkContacts', name: 'Lark Contacts', description: 'Resolve and search Lark employee contacts.', category: 'directory', domain: 'lark' },
  { toolId: 'larkTask', name: 'Lark Tasks', description: 'Create, read, update and complete Lark tasks and tasklists.', category: 'productivity', domain: 'lark' },
  { toolId: 'larkCalendar', name: 'Lark Calendar', description: 'List, create and update Lark calendar events.', category: 'calendar', domain: 'lark' },
  { toolId: 'larkMeeting', name: 'Lark Meetings', description: 'Search Lark video meetings, view their details, and retrieve recording links.', category: 'meetings', domain: 'lark' },
  { toolId: 'larkDoc', name: 'Lark Docs', description: 'Read and write Lark documents.', category: 'documents', domain: 'lark' },
  { toolId: 'larkBase', name: 'Lark Base', description: 'Read and write Lark Base tables and records.', category: 'data', domain: 'lark' },
  { toolId: 'larkApproval', name: 'Lark Approval', description: 'Manage Lark approval workflows.', category: 'workflow', domain: 'lark', hitlRequired: true },
  ...GOOGLE_WORKSPACE_PRODUCTS.map((product): RegisteredToolSeed => ({
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
  ...AIRTABLE_PRODUCTS.map((product): RegisteredToolSeed => ({
    toolId: product.toolId,
    name: product.name,
    description: product.description,
    category: product.category,
    domain: 'airtable',
    // Schema and automation reshape a base and include destructive operations.
    hitlRequired: product.toolId !== 'airtableRecords',
    guardrails: [
      'Uses a Divo OAuth connection selected by connection ID',
      'Airtable credentials remain server-side',
      'Only manifest-approved Airtable operations are callable',
      'Airtable enforces its own base permissions on top of Divo RBAC',
    ],
  })),
  {
    toolId: 'menhoodData',
    name: 'Menhood Data',
    description: 'Query the company-managed Menhood Airtable sync for filtered business analysis.',
    category: 'analytics',
    domain: 'menhood',
    guardrails: [
      'Uses only the backend-managed company database connection',
      'Accepts one read-only SELECT with bound parameters',
      'Queries only the approved order, customer, product, and city/pincode tables',
      'Returns a bounded preview; bulk data stays outside model context',
    ],
  },
  // Written literally rather than mapped from a manifest: the AITable manifest
  // lands with the client in a later wave, and a catalogue row is needed before
  // then so the admin panel can list the tool an administrator already holds.
  {
    toolId: 'aitableDatasheets',
    name: 'AITable Datasheets',
    description:
      'Browse AITable spaces and nodes, and read, create, update, or delete records in a datasheet.',
    category: 'data',
    domain: 'aitable',
    guardrails: [
      'Uses a Divo connection selected by connection ID',
      'AITable API keys are encrypted and remain server-side',
      'Only manifest-approved AITable operations are callable',
      'AITable enforces the key owner\'s own space permissions on top of Divo RBAC',
    ],
  },
  {
    toolId: 'aitableFields',
    name: 'AITable Fields',
    description:
      'Inspect the field schema of an AITable datasheet, and add or remove fields. Removing a field deletes its data.',
    category: 'data',
    domain: 'aitable',
    // Adding a field is harmless; deleting one destroys a column of data.
    hitlRequired: true,
    guardrails: [
      'Uses a Divo connection selected by connection ID',
      'AITable API keys are encrypted and remain server-side',
      'Deleting a field is irreversible and always requires human approval',
      'AITable enforces the key owner\'s own space permissions on top of Divo RBAC',
    ],
  },
  { toolId: 'zohoCrm', name: 'Zoho CRM', description: 'Read and write Zoho CRM records, pipeline and lead reports.', category: 'crm', domain: 'zoho' },
  { toolId: 'zohoBooks', name: 'Zoho Books', description: 'Read and write invoices, bills and expenses; financial reports.', category: 'finance', domain: 'zoho' },
  {
    toolId: 'shopifyAnalytics',
    name: 'Shopify Analytics',
    description: 'Run bounded sales, channel, UTM, and attribution reports through server-compiled ShopifyQL.',
    category: 'analytics',
    domain: 'shopify',
    guardrails: ['Read-only', 'Raw ShopifyQL is rejected', 'Requires an explicitly accessible store connection', 'Shopify credentials remain server-side'],
  },
  {
    toolId: 'shopifyOrders',
    name: 'Shopify Orders',
    description: 'Read bounded order lists, order details, and order-level journey attribution.',
    category: 'commerce',
    domain: 'shopify',
    guardrails: ['Read-only protected-data tool', 'Requires explicit deployment enablement and read_orders scope', 'Defaults to Shopify\'s 60-day order window', 'Requires a separately granted capability and store connection', 'Durable approval storage is rejected; direct read access must be explicitly granted'],
  },
  {
    toolId: 'shopifyCustomers',
    name: 'Shopify Customers',
    description: 'List, search, count, and inspect protected Shopify customer metadata without returning names or contact fields.',
    category: 'crm',
    domain: 'shopify',
    guardrails: ['Read-only protected-data tool', 'Requires explicit deployment enablement and read_customers scope', 'Separately grantable protected-data capability', 'Names and contact fields are never returned', 'Durable approval storage is rejected; direct read access must be explicitly granted'],
  },
  { toolId: 'webSearch', name: 'Web Search', description: 'Search the web for current information.', category: 'knowledge', domain: 'context' },
  KNOWLEDGE_REGISTERED_TOOL,
  {
    toolId: 'mailAutomations',
    name: 'Mail Ops',
    description: 'Create and manage durable Gmail arrival rules for forwarding and Lark delivery.',
    category: 'workflow',
    domain: 'scheduling',
    guardrails: [
      'Rules use only user-owned Google connections',
      'Matching and OTP forwarding are deterministic and do not invoke an LLM',
      'Google credentials remain server-side',
      'Every background execution re-checks current Divo permissions',
    ],
  },
  { toolId: 'scheduledWorkflows', name: 'Scheduled Workflows', description: 'Create, manage, and run governed scheduled workflows.', category: 'workflow', domain: 'scheduling', hitlRequired: true },
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

type RegisteredToolStore = Pick<PrismaClient, 'registeredTool'>;

export async function seedRegisteredTools(db: RegisteredToolStore) {
  const result = await db.registeredTool.createMany({
    data: REGISTERED_TOOL_SEEDS.map(t => ({
      toolId: t.toolId,
      name: t.name,
      description: t.description,
      category: t.category,
      domain: t.domain,
      hitlRequired: t.hitlRequired ?? false,
      guardrails: [...(t.guardrails ?? [])],
      engines: [],
      deprecated: false,
    })),
    skipDuplicates: true,
  });
  return {
    created: result.count,
    skipped: REGISTERED_TOOL_SEEDS.length - result.count,
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await seedRegisteredTools(prisma);
    console.log(`\nDone — ${result.created} created, ${result.skipped} already present (untouched).`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
