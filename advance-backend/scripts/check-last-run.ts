import 'dotenv/config';
import { getPrismaClient, disconnectPrisma } from '../src/infrastructure/persistence/prisma.client';

void (async () => {
  const prisma = getPrismaClient();

  const runs = await prisma.executionRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: 3,
    include: {
      events:      { orderBy: { sequence: 'asc' } },
      stepResults: { orderBy: { sequence: 'asc' } },
    },
  });

  for (const run of runs) {
    console.log(`\n=== Run ${run.id} === status:${run.status} createdAt:${run.createdAt.toISOString()}`);
    if (run.errorCode) console.log(`  ERROR: ${run.errorCode} — ${run.errorMessage}`);
    if (run.latestSummary) console.log(`  Summary: ${run.latestSummary}`);

    for (const e of run.events) {
      console.log(`  [event ${e.sequence}] ${e.phase}/${e.eventType} actor:${e.actorKey ?? e.actorType} status:${e.status ?? ''} ${e.title}`);
      if (e.summary) console.log(`    ${e.summary}`);
    }

    for (const s of run.stepResults) {
      console.log(`  [step ${s.sequence}] ${s.toolName} success:${s.success} ${s.title ?? ''}`);
      if (s.summary) console.log(`    ${s.summary}`);
      if (s.rawOutput) console.log(`    output: ${JSON.stringify(s.rawOutput).slice(0, 200)}`);
    }
  }

  await disconnectPrisma();
})();
