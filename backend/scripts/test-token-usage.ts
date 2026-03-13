import { randomUUID } from 'crypto';
import { prisma } from '../src/utils/prisma';
import { aiTokenUsageService } from '../src/company/ai-usage/ai-token-usage.service';

async function run() {
  console.log('--- Seeding Mock Data for Token Dashboard ---');

  // Find an active company and user, or create a mock ones
  const user = await prisma.user.findFirst();
  if (!user) {
    console.error('No users found in database to attach mock data to.');
    process.exit(1);
  }

  const adminMembership = await prisma.adminMembership.findFirst({
    where: { userId: user.id },
  });

  const companyId = adminMembership?.companyId;

  if (!companyId) {
    console.error('Company ID is missing on AdminMembership.');
    process.exit(1);
  }

  console.log(`Using Company ID: ${companyId}`);
  console.log(`Using User ID: ${user.id} (${user.name})`);

  const threadId = randomUUID();

  // 1. Insert a mock HIGH mode record
  await aiTokenUsageService.record({
    companyId,
    userId: user.id,
    agentTarget: 'mastra.supervisor',
    modelId: 'claude-3-opus',
    provider: 'anthropic',
    channel: 'desktop',
    threadId,
    mode: 'high',
    estimatedInputTokens: 100,
    estimatedOutputTokens: 50,
    actualInputTokens: 110,
    actualOutputTokens: 55,
    wasCompacted: false,
  });
  console.log('Inserted HIGH mode mock usage record.');

  // 2. Insert a mock FAST mode record
  await aiTokenUsageService.record({
    companyId,
    userId: user.id,
    agentTarget: 'mastra.supervisor',
    modelId: 'gemini-1.5-flash',
    provider: 'google',
    channel: 'desktop',
    threadId,
    mode: 'fast',
    estimatedInputTokens: 200,
    estimatedOutputTokens: 100,
    actualInputTokens: 195,
    actualOutputTokens: 115,
    wasCompacted: true,
  });
  console.log('Inserted FAST mode mock usage record.');

  console.log('\n--- Fetching Dashboard Breakdown ---');

  const breakdown = await aiTokenUsageService.getCompanyBreakdown(companyId);

  console.log(JSON.stringify(breakdown, null, 2));

  console.log('\n--- Test Successful ---');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
