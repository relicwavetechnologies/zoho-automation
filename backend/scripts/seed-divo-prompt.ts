import { buildSharedAgentSystemPrompt } from '../src/company/orchestration/prompting/shared-agent-prompt';
import { prisma } from '../src/utils/prisma';

const DIVO_ROOT_AGENT_NAME = 'Divo Root Agent';

const readCompanyId = (): string => process.argv[2]?.trim() ?? '';

async function main(): Promise<void> {
  const companyId = readCompanyId();
  if (!companyId) {
    console.error('Missing companyId. Usage: pnpm seed:divo-prompt <companyId>');
    process.exitCode = 1;
    return;
  }

  const divoAgent = await prisma.agentDefinition.findFirst({
    where: {
      companyId,
      name: DIVO_ROOT_AGENT_NAME,
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!divoAgent) {
    console.error(`Divo Root Agent not found for companyId: ${companyId}`);
    process.exitCode = 1;
    return;
  }

  const hardcodedPrompt = buildSharedAgentSystemPrompt({
    agentDefinition: undefined,
    runtimeLabel: 'You are Divo, EMIAC\'s internal AI colleague.',
    conversationKey: '',
  });

  await prisma.agentDefinition.update({
    where: { id: divoAgent.id },
    data: { systemPrompt: hardcodedPrompt },
  });

  console.log(`Seeded Divo Root Agent systemPrompt — ${hardcodedPrompt.length} characters`);
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
