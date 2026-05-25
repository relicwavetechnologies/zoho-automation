/**
 * simulate-hitl — end-to-end HITL approval simulation.
 *
 * Impersonates Anish Suman sending "send an email" through the REAL engine
 * with the REAL approval gate. A REAL Lark card lands on Abhishek's DM.
 * When Abhishek clicks Approve on his phone, the webhook fires, the engine
 * resumes, and the tool executes — all in production code paths.
 *
 * This script waits for the approval decision (polling the DB) so you can
 * see the full lifecycle in one terminal.
 *
 * Usage:
 *   pnpm tsx scripts/simulate-hitl.ts
 *   pnpm tsx scripts/simulate-hitl.ts "send an email to shivam@emiactech.com about the Q2 finance report"
 *   pnpm tsx scripts/simulate-hitl.ts --gate-only    # stop after card is sent, don't wait for decision
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { buildContainer } from '../src/composition';
import { loadAndValidateEnv } from '../src/config/env';
import { asMessageId, asChatId, asCorrelationId, asCompanyId, asUserId, asDepartmentId } from '../src/shared/ids';
import { asCompanyRoleSlug } from '../src/domain/permissions/company-role';
import type { IncomingMessage } from '../src/domain/channel/incoming-message';
import type { RunContext } from '../src/domain/orchestration/run-context';
import type { ConversationHandle } from '../src/application/channels/channel.adapter';

const DEFAULT_PROMPT = 'Send an email to shivam@emiactech.com with subject "Q2 Finance Summary" and body "Hi Shivam, please find the Q2 finance summary attached. Let me know if you need anything else. Regards, Anish"';
const ANISH_USER_ID = 'b30c783c-015a-41e0-8c18-0475071e8ac3';

const args = process.argv.slice(2);
const gateOnly = args.includes('--gate-only');
const prompt = args.filter(a => !a.startsWith('--'))[0] ?? DEFAULT_PROMPT;

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   HITL APPROVAL SIMULATION                      ║');
  console.log('║   Impersonating: Anish Suman (NOTHING role)     ║');
  console.log('║   Approval goes to: Abhishek Verma (MANAGER)    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log(`Prompt: ${JSON.stringify(prompt)}`);
  console.log(`Mode:   ${gateOnly ? 'gate-only (stop after card sent)' : 'full lifecycle (wait for approval decision)'}\n`);

  const env = loadAndValidateEnv(process.env);
  const container = await buildContainer(env);
  const { engine, larkAdapter, channelIdentityRepo, prisma, approvalGate } = container;

  // ── 1. Resolve Anish's identity ────────────────────────────────────────────
  console.log('1. Resolving Anish Suman identity...');
  const identityResult = await channelIdentityRepo.resolveByUserId(ANISH_USER_ID);
  if (!identityResult.ok || !identityResult.value) {
    console.error('   ✗ Could not resolve Anish identity. Run Lark sync first.');
    process.exit(1);
  }
  const identity = identityResult.value;
  console.log(`   ✓ userId=${identity.userId} companyId=${identity.companyId} role=${identity.aiRole}`);
  console.log(`     larkOpenId=${identity.larkOpenId ?? '∅'} dept=${identity.activeDepartmentId ?? '∅'}\n`);

  // ── 2. Build synthetic message as Anish ────────────────────────────────────
  const now = new Date();
  const messageId = `om_hitl_sim_${randomUUID()}`;
  const traceId = asCorrelationId(`${messageId}-${now.getTime()}`);

  // Use Anish's P2P chat with Divo (or a synthetic one)
  const chatId = `oc_hitl_sim_${randomUUID().slice(0, 8)}`;

  const incoming: IncomingMessage = {
    channel: 'lark',
    messageId: asMessageId(messageId),
    chatId: asChatId(chatId),
    chatType: 'p2p',
    userExternalId: identity.larkOpenId ?? ANISH_USER_ID,
    text: prompt,
    attachments: [],
    timestamp: now.toISOString(),
    traceId,
    mentions: [],
    mentionsSelf: true,
    raw: { source: 'hitl_simulation' },
  };

  const runContext: RunContext = {
    companyId: asCompanyId(identity.companyId),
    userId: asUserId(identity.userId),
    companyRole: asCompanyRoleSlug(identity.aiRole),
    channel: 'lark',
    traceId: String(traceId),
    requestId: messageId,
    userExternalId: identity.larkOpenId ?? ANISH_USER_ID,
    chatId,
    ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
  };

  const conversation: ConversationHandle = {
    channel: 'lark',
    chatId: incoming.chatId,
    correlationId: traceId,
  };

  console.log('2. Running engine as Anish Suman...');
  console.log(`   chatId: ${chatId}`);
  console.log(`   traceId: ${String(traceId)}\n`);

  // ── 3. Run the engine — this will hit the approval gate ────────────────────
  const start = Date.now();
  const result = await engine.run({
    incoming,
    runContext,
    conversation,
    channelAdapter: larkAdapter,
    approvalGate,
  });
  const elapsedMs = Date.now() - start;

  console.log(`\n3. Engine.run completed in ${elapsedMs}ms`);
  if (!result.ok) {
    console.error(`   ✗ FAILED: ${result.error.message}`);
  } else {
    console.log(`   tools called: [${result.value.toolsCalled.join(', ')}]`);
    console.log(`   reply (first 300 chars):\n   ${result.value.finalReply.text.slice(0, 300)}`);
  }

  // ── 4. Check if an approval was created ────────────────────────────────────
  console.log('\n4. Checking for pending approvals...');
  const pendingApprovals = await prisma.runtimeApproval.findMany({
    where: { requestedBy: ANISH_USER_ID, status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: {
      id: true, toolId: true, actionGroup: true, summary: true,
      status: true, decisionMessageId: true, createdAt: true,
      metadataJson: true,
    },
  });

  if (pendingApprovals.length === 0) {
    console.log('   ⓘ No pending approvals found.');
    console.log('   This could mean:');
    console.log('     - The LLM chose a read-only operation (no gate needed)');
    console.log('     - The permission or approval config is not set up correctly');
    console.log('     - The gate resolved Anish as the manager (self-bypass)');
  } else {
    for (const a of pendingApprovals) {
      const meta = a.metadataJson as Record<string, unknown>;
      console.log(`   ✓ PENDING APPROVAL:`);
      console.log(`     id:       ${a.id}`);
      console.log(`     tool:     ${a.toolId}.${a.actionGroup}`);
      console.log(`     summary:  ${a.summary}`);
      console.log(`     manager:  ${meta['resolvedManagerName']} (${meta['resolvedManagerOpenId']})`);
      console.log(`     cardMsg:  ${a.decisionMessageId ?? '(not yet set)'}`);
      console.log(`     created:  ${a.createdAt.toISOString()}`);
    }
  }

  if (gateOnly) {
    console.log('\n── gate-only mode: stopping here. Check your Lark DM for the approval card. ──\n');
    await prisma.$disconnect();
    process.exit(0);
  }

  // ── 5. Wait for manager decision ───────────────────────────────────────────
  if (pendingApprovals.length > 0) {
    const approvalId = pendingApprovals[0].id;
    console.log(`\n5. Waiting for manager decision on ${approvalId}...`);
    console.log('   → Check your Lark DM and click Approve or Reject');
    console.log('   → (Ctrl+C to abort)\n');

    const pollStart = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    while (Date.now() - pollStart < TIMEOUT_MS) {
      const approval = await prisma.runtimeApproval.findUnique({
        where: { id: approvalId },
        select: { status: true, approvedBy: true, approvedAt: true, rejectedAt: true, executionResultJson: true },
      });

      if (approval && approval.status !== 'pending') {
        const elapsed = Math.round((Date.now() - pollStart) / 1000);
        console.log(`   ✓ Decision received in ${elapsed}s: ${approval.status.toUpperCase()}`);
        console.log(`     resolvedBy: ${approval.approvedBy}`);
        if (approval.approvedAt) console.log(`     approvedAt: ${approval.approvedAt.toISOString()}`);
        if (approval.rejectedAt) console.log(`     rejectedAt: ${approval.rejectedAt.toISOString()}`);
        if (approval.executionResultJson) {
          const execResult = approval.executionResultJson as Record<string, unknown>;
          console.log(`     executionResult: ${JSON.stringify(execResult).slice(0, 500)}`);
        }
        break;
      }

      await new Promise(r => setTimeout(r, 3000));
      process.stdout.write('.');
    }
  }

  console.log('\n\n═══ SIMULATION COMPLETE ═══\n');
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(e => { console.error('CRASH:', e); process.exit(2); });
