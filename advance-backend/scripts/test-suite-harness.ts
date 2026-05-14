/**
 * test-suite-harness — run a battery of prompts through the real engine
 * and collect results. Delivers replies to the test group chat.
 *
 * Usage: pnpm tsx scripts/test-suite-harness.ts
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { buildContainer } from '../src/composition';
import { loadAndValidateEnv } from '../src/config/env';
import { asMessageId, asChatId, asCorrelationId, asCompanyId, asUserId, asDepartmentId } from '../src/shared/ids';
import { asCompanyRoleSlug } from '../src/domain/permissions/company-role';
import type { IncomingMessage } from '../src/domain/channel/incoming-message';
import type { RunContext } from '../src/domain/orchestration/run-context';
import type { ConversationHandle } from '../src/application/channels/channel.adapter';

const ABHISHEK_OPEN_ID = 'ou_48b958c283635491b756c0ef23f47159';
const GROUP_CHAT_ID    = 'oc_b9169aab0765f46b2fe9147068e3c79f';

interface TestCase {
  id: string;
  domain: string;
  prompt: string;
  expectTools?: string[];
  expectNoTools?: boolean;
}

const TEST_CASES: TestCase[] = [
  // ─── Lark Tasks ──────────────────────────────────────────────────────────
  { id: 'task-01', domain: 'lark-task',     prompt: 'show me my open tasks' },
  { id: 'task-02', domain: 'lark-task',     prompt: 'create a task "Review Q3 budget report" with due date tomorrow' },
  { id: 'task-03', domain: 'lark-task',     prompt: 'list all my tasklists' },

  // ─── Lark Calendar ───────────────────────────────────────────────────────
  { id: 'cal-01',  domain: 'lark-calendar', prompt: "what's on my calendar today?" },
  { id: 'cal-02',  domain: 'lark-calendar', prompt: 'schedule a 30 min meeting with Anish tomorrow at 3pm IST titled "Sprint Review"' },

  // ─── Lark Messaging ──────────────────────────────────────────────────────
  { id: 'msg-01',  domain: 'lark-messaging', prompt: 'send a DM to Anish saying "Hey, can you review the PR?"' },

  // ─── Lark Contacts ───────────────────────────────────────────────────────
  { id: 'contact-01', domain: 'lark-contacts', prompt: "who is Anish? find his details" },

  // ─── Google Gmail ────────────────────────────────────────────────────────
  { id: 'gmail-01', domain: 'google-gmail', prompt: 'show me my recent emails' },

  // ─── Zoho Books ──────────────────────────────────────────────────────────
  { id: 'zoho-01', domain: 'zoho-books',    prompt: 'show me overdue invoices for this month' },
  { id: 'zoho-02', domain: 'zoho-books',    prompt: 'what is our total outstanding receivable?' },

  // ─── Context Search / RAG ────────────────────────────────────────────────
  { id: 'ctx-01',  domain: 'context-search', prompt: 'search for any documents about "AI Engineering"' },

  // ─── Web Search ──────────────────────────────────────────────────────────
  { id: 'web-01',  domain: 'web-search',    prompt: 'what is the latest news about LLM agents in 2026?' },

  // ─── Multi-tool / Cross-domain ───────────────────────────────────────────
  { id: 'multi-01', domain: 'multi',        prompt: 'check my calendar for today and list my open tasks, give me a quick daily briefing' },

  // ─── Hinglish / Mixed Language ───────────────────────────────────────────
  { id: 'hindi-01', domain: 'hinglish',     prompt: 'mujhe aaj ke pending tasks dikhao' },

  // ─── Chitchat / Out of Domain ────────────────────────────────────────────
  { id: 'chat-01', domain: 'chitchat',      prompt: 'hey divo, how are you?', expectNoTools: true },
  { id: 'chat-02', domain: 'out-of-domain', prompt: 'write me a poem about the moon' },

  // ─── Edge Cases ──────────────────────────────────────────────────────────
  { id: 'edge-01', domain: 'ambiguous',     prompt: 'check it' },
  { id: 'edge-02', domain: 'vague',         prompt: 'do the thing we talked about yesterday' },
];

interface TestResult {
  id: string;
  domain: string;
  prompt: string;
  status: 'pass' | 'fail' | 'error';
  toolsCalled: string[];
  replyPreview: string;
  durationMs: number;
  error?: string;
}

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  DIVO END-TO-END TEST SUITE — ${new Date().toISOString()}`);
  console.log(`  ${TEST_CASES.length} test cases across ${new Set(TEST_CASES.map(t => t.domain)).size} domains`);
  console.log(`  Delivery chat: ${GROUP_CHAT_ID}`);
  console.log(`${'═'.repeat(70)}\n`);

  const env       = loadAndValidateEnv(process.env);
  const container = await buildContainer(env);
  const { engine, larkAdapter, channelIdentityRepo, prisma, approvalGate } = container;

  const identityResult = await channelIdentityRepo.resolveByLarkOpenId(ABHISHEK_OPEN_ID);
  if (!identityResult.ok || !identityResult.value) {
    console.error('Identity not found');
    process.exit(1);
  }
  const identity = identityResult.value;
  console.log(`Identity: ${identity.companyId} / ${identity.userId} / ${identity.aiRole}\n`);

  const results: TestResult[] = [];
  let passed = 0, failed = 0, errors = 0;

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i]!;
    const num = `[${i + 1}/${TEST_CASES.length}]`;
    console.log(`${num} ${tc.domain.padEnd(16)} | ${tc.prompt.slice(0, 60)}...`);

    const now = new Date();
    const messageId = `om_test_${randomUUID()}`;
    const traceId = asCorrelationId(`${messageId}-${now.getTime()}`);

    const incoming: IncomingMessage = {
      channel: 'lark',
      messageId: asMessageId(messageId),
      chatId: asChatId(GROUP_CHAT_ID),
      chatType: 'group',
      userExternalId: ABHISHEK_OPEN_ID,
      text: tc.prompt,
      attachments: [],
      timestamp: now.toISOString(),
      traceId,
      mentions: [],
      mentionsSelf: true,
      raw: {},
    };

    const runContext: RunContext = {
      companyId: asCompanyId(identity.companyId),
      userId: asUserId(identity.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      channel: 'lark',
      traceId: String(traceId),
      requestId: messageId,
      userExternalId: ABHISHEK_OPEN_ID,
      chatId: GROUP_CHAT_ID,
      ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
    };

    const conversation: ConversationHandle = {
      channel: 'lark',
      chatId: incoming.chatId,
      replyToMessageId: incoming.messageId,
      replyInThread: true,
      correlationId: traceId,
    };

    const start = Date.now();
    try {
      const result = await engine.run({
        incoming,
        runContext,
        conversation,
        channelAdapter: larkAdapter,
        approvalGate,
      });

      const durationMs = Date.now() - start;

      if (!result.ok) {
        console.log(`  ✗ FAILED (${durationMs}ms) — ${result.error.message.slice(0, 80)}`);
        results.push({
          id: tc.id, domain: tc.domain, prompt: tc.prompt,
          status: 'fail', toolsCalled: [], replyPreview: '',
          durationMs, error: result.error.message,
        });
        failed++;
        continue;
      }

      const tools = result.value.toolsCalled;
      const reply = result.value.finalReply.text
        .replace(/<!--TOOL_TRACE:.*?-->/gs, '')
        .trim();

      console.log(`  ✓ OK (${durationMs}ms) tools=[${tools.join(', ')}] reply=${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}`);

      results.push({
        id: tc.id, domain: tc.domain, prompt: tc.prompt,
        status: 'pass', toolsCalled: tools,
        replyPreview: reply.slice(0, 200),
        durationMs,
      });
      passed++;

    } catch (e) {
      const durationMs = Date.now() - start;
      const errMsg = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ ERROR (${durationMs}ms) — ${errMsg.slice(0, 80)}`);
      results.push({
        id: tc.id, domain: tc.domain, prompt: tc.prompt,
        status: 'error', toolsCalled: [], replyPreview: '',
        durationMs, error: errMsg,
      });
      errors++;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${errors} errors / ${TEST_CASES.length} total`);
  console.log(`  Total time: ${results.reduce((s, r) => s + r.durationMs, 0)}ms`);
  console.log(`${'═'.repeat(70)}\n`);

  // Detailed report
  const report = [
    `# Divo E2E Test Report — ${new Date().toISOString()}`,
    '',
    `**Results:** ${passed}/${TEST_CASES.length} passed, ${failed} failed, ${errors} errors`,
    `**Total time:** ${(results.reduce((s, r) => s + r.durationMs, 0) / 1000).toFixed(1)}s`,
    '',
    '| # | Domain | Prompt | Status | Tools | Duration | Reply |',
    '|---|--------|--------|--------|-------|----------|-------|',
    ...results.map((r, i) =>
      `| ${i + 1} | ${r.domain} | ${r.prompt.slice(0, 40)} | ${r.status === 'pass' ? '✓' : '✗'} ${r.status} | ${r.toolsCalled.join(', ') || '-'} | ${r.durationMs}ms | ${(r.error ?? r.replyPreview).slice(0, 60)} |`
    ),
    '',
    '## Detailed Results',
    '',
    ...results.map(r => [
      `### ${r.id} — ${r.domain}`,
      `**Prompt:** ${r.prompt}`,
      `**Status:** ${r.status} (${r.durationMs}ms)`,
      `**Tools:** ${r.toolsCalled.join(', ') || 'none'}`,
      r.error ? `**Error:** ${r.error}` : `**Reply:** ${r.replyPreview}`,
      '',
    ].join('\n')),
  ].join('\n');

  writeFileSync('test-suite-report.md', report);
  console.log('Report written to test-suite-report.md');

  await prisma.$disconnect();
  process.exit(failed + errors > 0 ? 1 : 0);
}

main().catch(e => { console.error('CRASH:', e); process.exit(2); });
