import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { buildSupervisorSystemPrompt } from '../src/application/orchestration/agents/supervisor.prompt';
import { LARK_RUNNER_SYSTEM } from '../src/application/orchestration/agent-runners/prompts/lark.prompt';
import { GOOGLE_RUNNER_SYSTEM } from '../src/application/orchestration/agent-runners/prompts/google.prompt';
import { ZOHO_RUNNER_SYSTEM } from '../src/application/orchestration/agent-runners/prompts/zoho.prompt';
import { CONTEXT_RUNNER_SYSTEM } from '../src/application/orchestration/agent-runners/prompts/context.prompt';
import { GOOGLE_WORKSPACE_TOOL_IDS } from '../src/application/google/google-workspace-mcp-manifest';

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
    toolIds: ['larkTask', 'larkMessaging', 'larkContacts', 'larkCalendar', 'larkApproval', 'larkDoc', 'larkBase', 'contextSearch'],
    hookId: null,
    maxSteps: 10,
    temperature: 0,
  },
  {
    name: 'Google Workspace',
    slug: 'google-ops',
    capabilityDescription: 'Handles governed Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, Tasks, Contacts, Chat, and Apps Script operations through the backend Workspace MCP.',
    systemPrompt: GOOGLE_RUNNER_SYSTEM,
    toolIds: [...GOOGLE_WORKSPACE_TOOL_IDS],
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
    toolIds: ['contextSearch', 'documentRag', 'webSearch', 'larkContacts'],
    hookId: 'outreach-read',
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
  const { companyId, agentSlug } = parseArguments(process.argv.slice(2));
  const selectedSeeds = agentSlug
    ? SEED_AGENTS.filter(agent => agent.slug === agentSlug)
    : SEED_AGENTS;
  if (selectedSeeds.length === 0) {
    throw new Error(`Unknown seeded agent slug: ${agentSlug}`);
  }
  await validateToolIds(selectedSeeds.flatMap(agent => agent.toolIds));

  const companies = companyId
    ? await prisma.company.findMany({ where: { id: companyId }, select: { id: true, name: true } })
    : await prisma.company.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } });
  if (companies.length === 0) {
    throw new Error(companyId ? `Company not found: ${companyId}` : 'No companies found');
  }

  for (const company of companies) {
    await seedCompany(company, selectedSeeds);
  }
}

function parseArguments(args: readonly string[]): { companyId?: string; agentSlug?: string } {
  let companyId: string | undefined;
  let agentSlug: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--') continue;
    if (value === '--agent') {
      agentSlug = args[++index];
      if (!agentSlug) throw new Error('--agent requires a seeded agent slug');
      continue;
    }
    if (value?.startsWith('--')) throw new Error(`Unknown option: ${value}`);
    if (companyId) throw new Error(`Unexpected positional argument: ${value}`);
    companyId = value;
  }
  return {
    ...(companyId ? { companyId } : {}),
    ...(agentSlug ? { agentSlug } : {}),
  };
}

async function seedCompany(
  company: { id: string; name: string },
  selectedSeeds: readonly SeedAgent[],
): Promise<void> {
  console.log(`Seeding ${selectedSeeds.map(seed => seed.slug).join(', ')} for ${company.name} (${company.id})`);

  const rootSeed = SEED_AGENTS[0];
  if (!rootSeed?.isRootAgent) {
    throw new Error('First seed agent must be the root supervisor');
  }

  const selectedRoot = selectedSeeds.find(seed => seed.isRootAgent);
  const root = selectedRoot
    ? await upsertAgent(company.id, selectedRoot, null)
    : await prisma.agentDefinition.findUnique({
      where: { companyId_slug: { companyId: company.id, slug: rootSeed.slug } },
      select: { id: true },
    });
  if (!root) {
    throw new Error(`Cannot seed child agents for ${company.id}: root agent ${rootSeed.slug} does not exist`);
  }

  for (const child of selectedSeeds.filter(seed => !seed.isRootAgent)) {
    await upsertAgent(company.id, child, root.id);
  }

  const count = await prisma.agentDefinition.count({ where: { companyId: company.id } });
  console.log(`done: ${count} total AgentDefinition rows for company ${company.id}`);
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
