import { AGENT_CAPABILITY_PROFILES } from '../src/company/orchestration/engine/vercel-orchestration.engine';
import { prisma } from '../src/utils/prisma';

const CHILD_AGENT_MAPPINGS = [
  { name: 'Lark Ops Agent', agentId: 'lark-ops-agent' },
  { name: 'Google Workspace Agent', agentId: 'google-workspace-agent' },
  { name: 'Zoho Ops Agent', agentId: 'zoho-ops-agent' },
  { name: 'Context Agent', agentId: 'context-agent' },
  { name: 'Workspace Agent', agentId: 'workspace-agent' },
] as const;

const readCompanyId = (): string => process.argv[2]?.trim() ?? '';

async function main(): Promise<void> {
  const companyId = readCompanyId();
  if (!companyId) {
    console.error('Missing companyId. Usage: pnpm seed:child-prompts <companyId>');
    process.exitCode = 1;
    return;
  }

  const results: Array<{
    name: string;
    id: string;
    promptLength: number;
    status: string;
  }> = [];

  for (const mapping of CHILD_AGENT_MAPPINGS) {
    const agent = await prisma.agentDefinition.findFirst({
      where: {
        companyId,
        name: mapping.name,
      },
      select: {
        id: true,
        name: true,
      },
    });

    if (!agent) {
      console.warn(`Agent not found for companyId=${companyId}: ${mapping.name}`);
      results.push({
        name: mapping.name,
        id: mapping.agentId,
        promptLength: 0,
        status: 'missing_db_agent',
      });
      continue;
    }

    const profileText = AGENT_CAPABILITY_PROFILES[mapping.agentId];
    if (!profileText?.trim()) {
      results.push({
        name: mapping.name,
        id: mapping.agentId,
        promptLength: 0,
        status: 'missing_profile',
      });
      continue;
    }

    await prisma.agentDefinition.update({
      where: { id: agent.id },
      data: { systemPrompt: profileText },
    });

    results.push({
      name: mapping.name,
      id: mapping.agentId,
      promptLength: profileText.length,
      status: 'updated',
    });
  }

  console.table(results);
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
