import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { buildSupervisorSystemPrompt } from '../src/application/orchestration/agents/supervisor.prompt';
import { LARK_RUNNER_SYSTEM } from '../src/application/orchestration/agent-runners/prompts/lark.prompt';
import { GOOGLE_RUNNER_SYSTEM } from '../src/application/orchestration/agent-runners/prompts/google.prompt';
import { ZOHO_RUNNER_SYSTEM } from '../src/application/orchestration/agent-runners/prompts/zoho.prompt';
import { CONTEXT_RUNNER_SYSTEM } from '../src/application/orchestration/agent-runners/prompts/context.prompt';

interface SeedAgent {
  readonly name: string;
  readonly slug: string;
  readonly capabilityDescription: string;
  readonly systemPrompt: string;
  readonly isRootAgent?: boolean;
  readonly toolIds: string[];
  readonly hookId: string | null;
  readonly maxSteps: number;
  readonly temperature: number;
}

const WORKSPACE_PROMPT = [
  'You are the Workspace Agent.',
  '',
  'Role:',
  '- Handle workspace operations that do not belong cleanly to one SaaS system, especially document inspection and scheduled-workflow context.',
  '',
  'What you can do:',
  '- Read uploaded/shared documents through document RAG.',
  '- Search workspace context for workflow and operational details.',
  '- Use web search only when public context is needed.',
  '',
  'What you cannot do:',
  '- You cannot run developer shell commands or deploy code.',
  '- You cannot schedule workflows directly unless a dedicated scheduling tool is available.',
  '',
  'Rules:',
  '- Inspect relevant documents before summarizing them.',
  '- Separate facts found in documents from assumptions or missing information.',
  '',
  'Output format:',
  '- Provide a concise operational summary with document/source references when available.',
].join('\n');

const SEED_AGENTS: readonly SeedAgent[] = [
  {
    name: 'Divo Supervisor',
    slug: 'divo-supervisor',
    capabilityDescription: 'Root supervisor that orchestrates all department agents — routes requests, composes multi-agent workflows, and synthesizes final answers',
    systemPrompt: buildSupervisorSystemPrompt().replace(/^Current date\/time:.*\n/, ''),
    isRootAgent: true,
    toolIds: [],
    hookId: null,
    maxSteps: 20,
    temperature: 0,
  },
  {
    name: 'Lark Operations',
    slug: 'lark-ops',
    capabilityDescription: 'Manages Lark tasks, messages, calendar events, meetings, approvals, documents, and Base tables. Handles task creation with assignee logic, calendar scheduling with IST defaults, and Hinglish requests.',
    systemPrompt: LARK_RUNNER_SYSTEM,
    toolIds: ['larkTask', 'larkMessaging', 'larkCalendar', 'larkApproval', 'larkDoc', 'larkBase', 'contextSearch'],
    hookId: null,
    maxSteps: 10,
    temperature: 0,
  },
  {
    name: 'Google Workspace',
    slug: 'google-ops',
    capabilityDescription: 'Handles Gmail (send, draft, search, inbox), Google Calendar (create, list, update events), and Google Drive (search, list, read files). Enforces email composition standards and approval discipline.',
    systemPrompt: GOOGLE_RUNNER_SYSTEM,
    toolIds: ['googleGmail', 'googleCalendar', 'googleDrive'],
    hookId: null,
    maxSteps: 10,
    temperature: 0,
  },
  {
    name: 'Zoho Operations',
    slug: 'zoho-ops',
    capabilityDescription: 'Queries and manages Zoho CRM (contacts, leads, accounts, deals) and Zoho Books (invoices, bills, payments, expenses, overdue reports). Returns full datasets with exact financial figures, supports Hinglish and IST date ranges.',
    systemPrompt: ZOHO_RUNNER_SYSTEM,
    toolIds: ['zohoCrm', 'zohoBooks'],
    hookId: 'zoho-read',
    maxSteps: 12,
    temperature: 0,
  },
  {
    name: 'Context & Research',
    slug: 'context-agent',
    capabilityDescription: 'Retrieval-only agent — searches company knowledge base, Lark contacts, CRM records, uploaded files/images, past conversations, and the live web. Returns raw content verbatim for supervisor to synthesize.',
    systemPrompt: CONTEXT_RUNNER_SYSTEM,
    toolIds: ['contextSearch', 'documentRag', 'webSearch'],
    hookId: 'outreach-read',
    maxSteps: 8,
    temperature: 0,
  },
  {
    name: 'Workspace Agent',
    slug: 'workspace-agent',
    capabilityDescription: 'Inspects workspace documents and operational context for scheduled-workflow and document questions',
    systemPrompt: WORKSPACE_PROMPT,
    toolIds: ['documentRag', 'contextSearch', 'webSearch'],
    hookId: null,
    maxSteps: 8,
    temperature: 0,
  },
];

const prisma = new PrismaClient();

async function upsertAgent(companyId: string, seed: SeedAgent, parentId: string | null) {
  const existing = await prisma.agentDefinition.findUnique({
    where: { companyId_slug: { companyId, slug: seed.slug } },
    select: { id: true },
  });

  const row = await prisma.agentDefinition.upsert({
    where: { companyId_slug: { companyId, slug: seed.slug } },
    create: {
      companyId,
      name: seed.name,
      slug: seed.slug,
      description: seed.capabilityDescription,
      capabilityDescription: seed.capabilityDescription,
      systemPrompt: seed.systemPrompt,
      hookId: seed.hookId,
      maxSteps: seed.maxSteps,
      temperature: seed.temperature,
      isRootAgent: seed.isRootAgent ?? false,
      isActive: true,
      toolIds: [...seed.toolIds],
      parentId,
    },
    update: {
      name: seed.name,
      description: seed.capabilityDescription,
      capabilityDescription: seed.capabilityDescription,
      systemPrompt: seed.systemPrompt,
      hookId: seed.hookId,
      maxSteps: seed.maxSteps,
      temperature: seed.temperature,
      isRootAgent: seed.isRootAgent ?? false,
      isActive: true,
      toolIds: [...seed.toolIds],
      parentId,
    },
  });

  const promptLen = seed.systemPrompt.length;
  console.log(`${existing ? 'updated' : 'created'} ${seed.slug} (${row.id}) — prompt: ${promptLen} chars`);
  return row;
}

async function validateToolIds(toolIds: readonly string[]) {
  const uniqueIds = [...new Set(toolIds)];
  if (uniqueIds.length === 0) return;

  const rows = await prisma.registeredTool.findMany({
    where: { toolId: { in: uniqueIds } },
    select: { toolId: true },
  });
  const registered = new Set(rows.map(row => row.toolId));
  const missing = uniqueIds.filter(toolId => !registered.has(toolId));
  if (missing.length > 0) {
    console.warn(`warning: ${missing.length} seeded tool IDs are not present in RegisteredTool: ${missing.join(', ')}`);
  } else {
    console.log(`validated ${uniqueIds.length} RegisteredTool IDs`);
  }
}

async function main() {
  const companyId = process.argv[2];
  if (!companyId) {
    console.error('Usage: pnpm seed:dynamic-agents <companyId>');
    process.exit(1);
  }

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } });
  if (!company) {
    console.error(`Company not found: ${companyId}`);
    process.exit(1);
  }

  console.log(`Seeding dynamic agents for ${company.name} (${company.id})`);
  await validateToolIds(SEED_AGENTS.flatMap(agent => agent.toolIds));

  const rootSeed = SEED_AGENTS[0];
  if (!rootSeed?.isRootAgent) {
    throw new Error('First seed agent must be the root supervisor');
  }

  const root = await upsertAgent(companyId, rootSeed, null);
  for (const child of SEED_AGENTS.slice(1)) {
    await upsertAgent(companyId, child, root.id);
  }

  const count = await prisma.agentDefinition.count({ where: { companyId } });
  console.log(`done: ${count} total AgentDefinition rows for company ${companyId}`);
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
