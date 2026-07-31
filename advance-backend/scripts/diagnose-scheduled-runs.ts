import 'dotenv/config';
import { getPrismaClient, disconnectPrisma } from '../src/infrastructure/persistence/prisma.client';

function trunc(s: string | null | undefined, max: number): string {
  if (!s) return '(null)';
  return s.length > max ? s.slice(0, max) + '...' : s;
}

void (async () => {
  const prisma = getPrismaClient();

  try {
    // ── 1. Last 5 ScheduledWorkflowRun records ──────────────────────────
    console.log('\n' + '='.repeat(80));
    console.log('  SECTION 1: Last 5 ScheduledWorkflowRun records (by scheduledFor DESC)');
    console.log('='.repeat(80));

    const runs = await prisma.scheduledWorkflowRun.findMany({
      orderBy: { scheduledFor: 'desc' },
      take: 5,
    });

    if (runs.length === 0) {
      console.log('  (no ScheduledWorkflowRun records found)');
    }

    for (const r of runs) {
      console.log(`\n  ── Run ${r.id} ──`);
      console.log(`     workflowId:     ${r.workflowId}`);
      console.log(`     scheduledFor:   ${r.scheduledFor.toISOString()}`);
      console.log(`     status:         ${r.status}`);
      console.log(`     executionRunId: ${r.executionRunId ?? '(null)'}`);
      console.log(`     attemptNumber:  ${r.attemptNumber}`);
      console.log(`     startedAt:      ${r.startedAt?.toISOString() ?? '(null)'}`);
      console.log(`     finishedAt:     ${r.finishedAt?.toISOString() ?? '(null)'}`);
      console.log(`     resultSummary:  ${trunc(r.resultSummary, 300)}`);
      console.log(`     errorSummary:   ${trunc(r.errorSummary, 300)}`);
      console.log(`     deliveryStatus: ${r.deliveryStatusJson ? JSON.stringify(r.deliveryStatusJson).slice(0, 200) : '(null)'}`);
    }

    // ── 2. ScheduledWorkflow for each run's workflowId ──────────────────
    console.log('\n' + '='.repeat(80));
    console.log('  SECTION 2: ScheduledWorkflow details for each workflowId');
    console.log('='.repeat(80));

    const workflowIds = [...new Set(runs.map(r => r.workflowId))];

    if (workflowIds.length === 0) {
      console.log('  (no workflows to look up)');
    }

    for (const wId of workflowIds) {
      const wf = await prisma.scheduledWorkflow.findUnique({ where: { id: wId } });
      if (!wf) {
        console.log(`\n  ── Workflow ${wId}: NOT FOUND ──`);
        continue;
      }
      console.log(`\n  ── Workflow ${wf.id} ──`);
      console.log(`     name:             ${wf.name}`);
      console.log(`     status:           ${wf.status}`);
      console.log(`     scheduleType:     ${wf.scheduleType}`);
      console.log(`     scheduleEnabled:  ${wf.scheduleEnabled}`);
      console.log(`     timezone:         ${wf.timezone}`);
      console.log(`     nextRunAt:        ${wf.nextRunAt?.toISOString() ?? '(null)'}`);
      console.log(`     lastRunAt:        ${wf.lastRunAt?.toISOString() ?? '(null)'}`);
      console.log(`     compiledPrompt:   ${trunc(wf.compiledPrompt, 200)}`);
      console.log(`     scheduleConfig:   ${JSON.stringify(wf.scheduleConfigJson)}`);
      console.log(`     outputConfig:     ${JSON.stringify(wf.outputConfigJson).slice(0, 200)}`);
      console.log(`     userIntent:       ${trunc(wf.userIntent, 200)}`);
    }

    // ── 3. Last 5 scheduled-related ExecutionRun + RuntimeRun records ───
    console.log('\n' + '='.repeat(80));
    console.log('  SECTION 3: Last 5 ExecutionRun records with entrypoint containing "sched"');
    console.log('='.repeat(80));

    const execRuns = await prisma.executionRun.findMany({
      where: {
        OR: [
          { entrypoint: { contains: 'sched', mode: 'insensitive' } },
          { requestId:  { contains: 'sched', mode: 'insensitive' } },
          { taskId:     { contains: 'sched', mode: 'insensitive' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    if (execRuns.length === 0) {
      console.log('  (no matching ExecutionRun records found)');
      // Fall back: try looking up executionRunIds from the ScheduledWorkflowRuns
      const execIds = runs.map(r => r.executionRunId).filter(Boolean) as string[];
      if (execIds.length > 0) {
        console.log(`  Falling back: looking up executionRunIds from ScheduledWorkflowRun: ${execIds.join(', ')}`);
        const fallbackRuns = await prisma.executionRun.findMany({
          where: { id: { in: execIds } },
          orderBy: { createdAt: 'desc' },
        });
        for (const er of fallbackRuns) {
          console.log(`\n  ── ExecutionRun ${er.id} ──`);
          console.log(`     status:        ${er.status}`);
          console.log(`     entrypoint:    ${er.entrypoint}`);
          console.log(`     channel:       ${er.channel}`);
          console.log(`     mode:          ${er.mode ?? '(null)'}`);
          console.log(`     agentTarget:   ${er.agentTarget ?? '(null)'}`);
          console.log(`     requestId:     ${er.requestId ?? '(null)'}`);
          console.log(`     createdAt:     ${er.createdAt.toISOString()}`);
          console.log(`     latestSummary: ${trunc(er.latestSummary, 300)}`);
          console.log(`     errorCode:     ${er.errorCode ?? '(null)'}`);
          console.log(`     errorMessage:  ${trunc(er.errorMessage, 300)}`);
        }
      }
    } else {
      for (const er of execRuns) {
        console.log(`\n  ── ExecutionRun ${er.id} ──`);
        console.log(`     status:        ${er.status}`);
        console.log(`     entrypoint:    ${er.entrypoint}`);
        console.log(`     channel:       ${er.channel}`);
        console.log(`     mode:          ${er.mode ?? '(null)'}`);
        console.log(`     agentTarget:   ${er.agentTarget ?? '(null)'}`);
        console.log(`     requestId:     ${er.requestId ?? '(null)'}`);
        console.log(`     createdAt:     ${er.createdAt.toISOString()}`);
        console.log(`     latestSummary: ${trunc(er.latestSummary, 300)}`);
        console.log(`     errorCode:     ${er.errorCode ?? '(null)'}`);
        console.log(`     errorMessage:  ${trunc(er.errorMessage, 300)}`);
      }
    }

    // ── 3b. RuntimeRun records with entrypoint containing "sched" ────────
    console.log('\n' + '='.repeat(80));
    console.log('  SECTION 3b: Last 5 RuntimeRun records with entrypoint containing "sched"');
    console.log('='.repeat(80));

    const rtRuns = await prisma.runtimeRun.findMany({
      where: {
        entrypoint: { contains: 'sched', mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        messages: {
          where: {
            role: 'assistant',
            messageKind: 'final-reply',
          },
          orderBy: { sequence: 'desc' },
          take: 1,
        },
      },
    });

    if (rtRuns.length === 0) {
      console.log('  (no matching RuntimeRun records found)');
      // Fall back: look up via executionRunIds linked to ScheduledWorkflowRuns
      const execIds = runs.map(r => r.executionRunId).filter(Boolean) as string[];
      if (execIds.length > 0) {
        console.log(`  Trying to find RuntimeRun via metadataJson for executionRunIds...`);
        // RuntimeRun doesn't have executionRunId directly, so we just query recent scheduled-like
        // by channel = 'scheduled' or similar
        const rtFallback = await prisma.runtimeRun.findMany({
          where: {
            OR: [
              { channel: { contains: 'sched', mode: 'insensitive' } },
              { entrypoint: { contains: 'workflow', mode: 'insensitive' } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: {
            messages: {
              where: { role: 'assistant' },
              orderBy: { sequence: 'desc' },
              take: 1,
            },
          },
        });
        for (const rr of rtFallback) {
          const reply = rr.messages[0];
          console.log(`\n  ── RuntimeRun ${rr.id} ──`);
          console.log(`     status:       ${rr.status}`);
          console.log(`     entrypoint:   ${rr.entrypoint}`);
          console.log(`     engineMode:   ${rr.engineMode}`);
          console.log(`     channel:      ${rr.channel}`);
          console.log(`     stopReason:   ${rr.stopReason ?? '(null)'}`);
          console.log(`     createdAt:    ${rr.createdAt.toISOString()}`);
          console.log(`     finishedAt:   ${rr.finishedAt?.toISOString() ?? '(null)'}`);
          console.log(`     metadata:     ${rr.metadataJson ? JSON.stringify(rr.metadataJson).slice(0, 200) : '(null)'}`);
          console.log(`     finalReply:   ${reply ? trunc(reply.contentText, 300) : '(no assistant message found)'}`);
        }
      }
    } else {
      for (const rr of rtRuns) {
        const reply = rr.messages[0];
        console.log(`\n  ── RuntimeRun ${rr.id} ──`);
        console.log(`     status:       ${rr.status}`);
        console.log(`     entrypoint:   ${rr.entrypoint}`);
        console.log(`     engineMode:   ${rr.engineMode}`);
        console.log(`     channel:      ${rr.channel}`);
        console.log(`     stopReason:   ${rr.stopReason ?? '(null)'}`);
        console.log(`     createdAt:    ${rr.createdAt.toISOString()}`);
        console.log(`     finishedAt:   ${rr.finishedAt?.toISOString() ?? '(null)'}`);
        console.log(`     metadata:     ${rr.metadataJson ? JSON.stringify(rr.metadataJson).slice(0, 200) : '(null)'}`);
        console.log(`     finalReply:   ${reply ? trunc(reply.contentText, 300) : '(no assistant message found)'}`);
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('  DONE');
    console.log('='.repeat(80) + '\n');
  } finally {
    await disconnectPrisma();
  }
})();
