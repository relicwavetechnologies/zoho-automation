import { prisma } from '../src/utils/prisma';

type SeedAgentDefinition = {
  name: string;
  description: string;
  systemPrompt: string;
  isRootAgent: boolean;
  isActive: boolean;
  toolIds: string[];
};

const ROOT_AGENT_NAME = 'Divo Root Agent';

const AGENTS: readonly SeedAgentDefinition[] = [
  {
    name: 'Divo Root Agent',
    description: 'Root supervisor agent. Plans and delegates to specialist child agents based on request type.',
    systemPrompt: 'You are Divo, the primary AI assistant for this company. Analyze each request and delegate to the correct specialist agent. Available agents handle Lark operations, Google Workspace, Zoho CRM and Books, context search, and workspace tasks.',
    isRootAgent: true,
    isActive: true,
    toolIds: [],
  },
  {
    name: 'Lark Ops Agent',
    description: 'Handles Lark tasks, messages, calendar, meetings, approvals, docs, and base collaboration operations.',
    systemPrompt: 'You are the Lark Ops agent. Handle all Lark operations including tasks, messages, calendar events, meetings, approvals, documents, and base tables. Always confirm before sending messages or creating approvals.',
    isRootAgent: false,
    isActive: true,
    toolIds: [
      'larkTask',
      'larkMessage',
      'larkCalendar',
      'larkMeeting',
      'larkApproval',
      'larkDoc',
      'larkBase',
    ],
  },
  {
    name: 'Google Workspace Agent',
    description: 'Handles Gmail, Google Calendar, and Google Drive.',
    systemPrompt: 'You are the Google Workspace agent. Handle Gmail, Google Calendar, and Google Drive operations. Always confirm before sending emails or creating calendar events.',
    isRootAgent: false,
    isActive: true,
    toolIds: ['googleWorkspace'],
  },
  {
    name: 'Zoho Ops Agent',
    description: 'Handles Zoho Books and Zoho CRM operations.',
    systemPrompt: 'You are the Zoho Ops agent. Handle Zoho Books financial records and Zoho CRM contact and deal management. Never guess field names. Always confirm amounts before any mutation.',
    isRootAgent: false,
    isActive: true,
    toolIds: ['zohoBooks', 'zohoCrm'],
  },
  {
    name: 'Context Agent',
    description: 'Handles retrieval through the unified context broker, outreach lookup, and contact resolution.',
    systemPrompt: 'You are the Context agent. Handle all retrieval and search operations including context search, web search, outreach publisher lookup, and cross-source contact resolution.',
    isRootAgent: false,
    isActive: true,
    toolIds: ['contextSearch', 'outreach'],
  },
  {
    name: 'Workspace Agent',
    description: 'Handles workflows, coding, repo inspection, OCR, and document parsing.',
    systemPrompt: 'You are the Workspace agent. Handle workflow authoring, code and repo tasks, document OCR, invoice and statement parsing.',
    isRootAgent: false,
    isActive: true,
    toolIds: ['workflow', 'devTools', 'documentRead'],
  },
] as const;

const readCompanyId = (): string => process.argv[2]?.trim() ?? '';

async function main(): Promise<void> {
  const companyId = readCompanyId();
  if (!companyId) {
    console.error('Missing companyId. Usage: pnpm seed:agents <companyId>');
    process.exitCode = 1;
    return;
  }

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true },
  });

  if (!company) {
    console.error(`Company not found for id: ${companyId}`);
    process.exitCode = 1;
    return;
  }

  await prisma.agentDefinition.deleteMany({
    where: { companyId },
  });
  console.log('Cleaned up existing agent definitions for company');

  const passOneResults = new Map<string, Awaited<ReturnType<typeof prisma.agentDefinition.upsert>>>();

  for (const agent of AGENTS) {
    const upsertedAgent = await prisma.agentDefinition.upsert({
      where: {
        companyId_name: {
          companyId,
          name: agent.name,
        },
      },
      create: {
        companyId,
        name: agent.name,
        description: agent.description,
        systemPrompt: agent.systemPrompt,
        isRootAgent: agent.isRootAgent,
        isActive: agent.isActive,
        toolIds: agent.toolIds,
        parentId: null,
      },
      update: {
        description: agent.description,
        systemPrompt: agent.systemPrompt,
        isRootAgent: agent.isRootAgent,
        isActive: agent.isActive,
        toolIds: agent.toolIds,
        parentId: null,
      },
    });

    passOneResults.set(agent.name, upsertedAgent);
  }

  const rootAgent = passOneResults.get(ROOT_AGENT_NAME);
  if (!rootAgent) {
    throw new Error('seed_agents_root_missing_after_upsert');
  }

  const passTwoResults = new Map<string, Awaited<ReturnType<typeof prisma.agentDefinition.update>>>();
  passTwoResults.set(rootAgent.name, rootAgent);

  for (const agent of AGENTS) {
    if (agent.name === ROOT_AGENT_NAME) {
      continue;
    }

    const seededAgent = passOneResults.get(agent.name);
    if (!seededAgent) {
      throw new Error(`seed_agents_missing_pass_one_result:${agent.name}`);
    }

    const updatedAgent = await prisma.agentDefinition.update({
      where: { id: seededAgent.id },
      data: { parentId: rootAgent.id },
    });

    passTwoResults.set(agent.name, updatedAgent);
  }

  console.log(`Seeded agents for company: ${company.name} (${company.id})`);
  console.table(
    AGENTS.map((agent) => {
      const seededAgent = passTwoResults.get(agent.name);
      return {
        name: agent.name,
        id: seededAgent?.id ?? '',
        parentId: seededAgent?.parentId ?? null,
        toolCount: agent.toolIds.length,
      };
    }),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (process.exitCode && process.exitCode !== 0) {
      process.exit(process.exitCode);
    }
  });
