/**
 * zoho-query-test-suite — comprehensive Zoho Books query battery
 * Tests the unified agent (Brain mode) with every query dynamic:
 * simple lookups, aggregations, filters, cross-entity, hinglish, vague, edge cases.
 *
 * Usage: pnpm tsx scripts/zoho-query-test-suite.ts
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
  category: string;
  prompt: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'edge';
}

const TEST_CASES: TestCase[] = [
  // ─── Simple Lookups (does it even work?) ─────────────────────────────────
  { id: 'simple-01', category: 'simple-lookup',   difficulty: 'easy',   prompt: 'show me all invoices' },
  { id: 'simple-02', category: 'simple-lookup',   difficulty: 'easy',   prompt: 'list all customers' },
  { id: 'simple-03', category: 'simple-lookup',   difficulty: 'easy',   prompt: 'show me all bills' },
  { id: 'simple-04', category: 'simple-lookup',   difficulty: 'easy',   prompt: 'what items/services do we sell?' },
  { id: 'simple-05', category: 'simple-lookup',   difficulty: 'easy',   prompt: 'show me recent expenses' },

  // ─── Filtered Queries ────────────────────────────────────────────────────
  { id: 'filter-01', category: 'filtered',        difficulty: 'medium', prompt: 'show me all overdue invoices' },
  { id: 'filter-02', category: 'filtered',        difficulty: 'medium', prompt: 'which invoices are paid?' },
  { id: 'filter-03', category: 'filtered',        difficulty: 'medium', prompt: 'show me unpaid bills' },
  { id: 'filter-04', category: 'filtered',        difficulty: 'medium', prompt: 'list invoices for Flipkart' },
  { id: 'filter-05', category: 'filtered',        difficulty: 'medium', prompt: 'show me all vendor contacts' },

  // ─── Aggregation / Analytics ─────────────────────────────────────────────
  { id: 'agg-01',   category: 'aggregation',      difficulty: 'medium', prompt: 'what is our total outstanding receivable amount?' },
  { id: 'agg-02',   category: 'aggregation',      difficulty: 'medium', prompt: 'how much have we spent on AWS this year?' },
  { id: 'agg-03',   category: 'aggregation',      difficulty: 'hard',   prompt: 'who are our top 5 customers by revenue?' },
  { id: 'agg-04',   category: 'aggregation',      difficulty: 'hard',   prompt: 'what is our total revenue from January to March 2026?' },
  { id: 'agg-05',   category: 'aggregation',      difficulty: 'hard',   prompt: 'show me expense breakdown by category' },

  // ─── Specific Entity Detail ──────────────────────────────────────────────
  { id: 'detail-01', category: 'entity-detail',   difficulty: 'medium', prompt: 'show me the details of invoice INV-000002' },
  { id: 'detail-02', category: 'entity-detail',   difficulty: 'medium', prompt: 'what are the line items on invoice INV-000001?' },
  { id: 'detail-03', category: 'entity-detail',   difficulty: 'medium', prompt: 'show me Razorpay\'s contact details and their invoices' },

  // ─── Time-based Queries ──────────────────────────────────────────────────
  { id: 'time-01',  category: 'time-based',       difficulty: 'medium', prompt: 'show me invoices from this month' },
  { id: 'time-02',  category: 'time-based',       difficulty: 'hard',   prompt: 'compare our Q1 vs Q2 revenue' },
  { id: 'time-03',  category: 'time-based',       difficulty: 'medium', prompt: 'what bills are due this week?' },

  // ─── Cross-entity / Complex ──────────────────────────────────────────────
  { id: 'cross-01', category: 'cross-entity',     difficulty: 'hard',   prompt: 'which customers have partially paid invoices and how much is still outstanding?' },
  { id: 'cross-02', category: 'cross-entity',     difficulty: 'hard',   prompt: 'give me a summary: total revenue, total expenses, total bills paid, and net position' },
  { id: 'cross-03', category: 'cross-entity',     difficulty: 'hard',   prompt: 'how much do we owe WeWork in total including all unpaid bills?' },

  // ─── Natural / Conversational ────────────────────────────────────────────
  { id: 'nat-01',   category: 'natural-language',  difficulty: 'easy',   prompt: 'kitna paisa aana baaki hai customers se?' },
  { id: 'nat-02',   category: 'natural-language',  difficulty: 'medium', prompt: 'bhai flipkart ka invoice status kya hai?' },
  { id: 'nat-03',   category: 'natural-language',  difficulty: 'easy',   prompt: 'how much money do we have coming in?' },

  // ─── Dumb / Vague Queries (edge cases) ───────────────────────────────────
  { id: 'dumb-01',  category: 'vague',             difficulty: 'edge',   prompt: 'invoices' },
  { id: 'dumb-02',  category: 'vague',             difficulty: 'edge',   prompt: 'money' },
  { id: 'dumb-03',  category: 'vague',             difficulty: 'edge',   prompt: 'check zoho' },
  { id: 'dumb-04',  category: 'vague',             difficulty: 'edge',   prompt: 'kuch dikhao' },
  { id: 'dumb-05',  category: 'vague',             difficulty: 'edge',   prompt: 'how are we doing financially?' },

  // ─── Impossible / Out of Scope ───────────────────────────────────────────
  { id: 'oos-01',   category: 'out-of-scope',      difficulty: 'edge',   prompt: 'create an invoice for Tata Consultancy Services for ₹5,00,000' },
  { id: 'oos-02',   category: 'out-of-scope',      difficulty: 'edge',   prompt: 'delete all overdue invoices' },
  { id: 'oos-03',   category: 'out-of-scope',      difficulty: 'edge',   prompt: 'send payment reminder emails to all overdue customers' },
];

interface TestResult {
  id: string;
  category: string;
  difficulty: string;
  prompt: string;
  status: 'pass' | 'fail' | 'error';
  toolsCalled: string[];
  replyPreview: string;
  durationMs: number;
  error?: string;
}

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ZOHO QUERY TEST SUITE — ${new Date().toISOString()}`);
  console.log(`  ${TEST_CASES.length} queries across ${new Set(TEST_CASES.map(t => t.category)).size} categories`);
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
  console.log(`Identity: ${identity.companyId} / ${identity.userId} / ${identity.aiRole}`);
  console.log(`Mode: UNIFIED_AGENT_MODE=${env.UNIFIED_AGENT_MODE}\n`);

  const results: TestResult[] = [];
  let passed = 0, failed = 0, errors = 0;

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i]!;
    const num = `[${i + 1}/${TEST_CASES.length}]`;
    console.log(`${num} ${tc.category.padEnd(18)} ${tc.difficulty.padEnd(6)} | ${tc.prompt.slice(0, 55)}`);

    const now = new Date();
    const messageId = `om_zoho_test_${randomUUID()}`;
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
        console.log(`  ✗ FAIL (${durationMs}ms) — ${result.error.message.slice(0, 80)}`);
        results.push({
          id: tc.id, category: tc.category, difficulty: tc.difficulty, prompt: tc.prompt,
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
        id: tc.id, category: tc.category, difficulty: tc.difficulty, prompt: tc.prompt,
        status: 'pass', toolsCalled: [...tools],
        replyPreview: reply.slice(0, 300),
        durationMs,
      });
      passed++;

    } catch (e) {
      const durationMs = Date.now() - start;
      const errMsg = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ ERROR (${durationMs}ms) — ${errMsg.slice(0, 80)}`);
      results.push({
        id: tc.id, category: tc.category, difficulty: tc.difficulty, prompt: tc.prompt,
        status: 'error', toolsCalled: [], replyPreview: '',
        durationMs, error: errMsg,
      });
      errors++;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  const avgMs = Math.round(totalMs / results.length);
  const byCategory = new Map<string, { pass: number; fail: number; avgMs: number; count: number }>();
  for (const r of results) {
    const entry = byCategory.get(r.category) ?? { pass: 0, fail: 0, avgMs: 0, count: 0 };
    entry.count++;
    if (r.status === 'pass') entry.pass++;
    else entry.fail++;
    entry.avgMs = Math.round((entry.avgMs * (entry.count - 1) + r.durationMs) / entry.count);
    byCategory.set(r.category, entry);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${errors} errors / ${TEST_CASES.length} total`);
  console.log(`  Total time: ${(totalMs / 1000).toFixed(1)}s | Avg: ${avgMs}ms per query`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`\n  Category Breakdown:`);
  for (const [cat, stats] of byCategory) {
    console.log(`    ${cat.padEnd(18)} ${stats.pass}/${stats.count} passed | avg ${stats.avgMs}ms`);
  }
  console.log('');

  // ── Write detailed report ─────────────────────────────────────────────────
  const report = [
    `# Zoho Query Test Report — ${new Date().toISOString()}`,
    '',
    `**Mode:** UNIFIED_AGENT_MODE=${process.env.UNIFIED_AGENT_MODE ?? 'false'}`,
    `**Model:** ${process.env.MODEL_PROVIDER ?? 'unknown'}/${process.env.MODEL_ID ?? 'unknown'}`,
    `**Results:** ${passed}/${TEST_CASES.length} passed, ${failed} failed, ${errors} errors`,
    `**Total time:** ${(totalMs / 1000).toFixed(1)}s | **Avg:** ${avgMs}ms/query`,
    '',
    '## Category Breakdown',
    '',
    '| Category | Pass Rate | Avg Latency |',
    '|----------|-----------|-------------|',
    ...[...byCategory.entries()].map(([cat, s]) =>
      `| ${cat} | ${s.pass}/${s.count} | ${s.avgMs}ms |`
    ),
    '',
    '## All Results',
    '',
    '| # | ID | Category | Difficulty | Prompt | Status | Tools | Duration | Reply Preview |',
    '|---|----|----------|------------|--------|--------|-------|----------|---------------|',
    ...results.map((r, i) =>
      `| ${i + 1} | ${r.id} | ${r.category} | ${r.difficulty} | ${r.prompt.slice(0, 35)} | ${r.status === 'pass' ? '✓' : '✗'} | ${r.toolsCalled.join(', ') || '-'} | ${r.durationMs}ms | ${(r.error ?? r.replyPreview).slice(0, 60).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`
    ),
    '',
    '## Detailed Responses',
    '',
    ...results.map(r => [
      `### ${r.id} — ${r.category} (${r.difficulty})`,
      `**Prompt:** ${r.prompt}`,
      `**Status:** ${r.status} | **Duration:** ${r.durationMs}ms`,
      `**Tools:** ${r.toolsCalled.join(', ') || 'none'}`,
      r.error ? `**Error:** ${r.error}` : `**Reply:**\n\`\`\`\n${r.replyPreview}\n\`\`\``,
      '',
    ].join('\n')),
  ].join('\n');

  writeFileSync('zoho-test-report.md', report);
  console.log('Report written to zoho-test-report.md');

  await prisma.$disconnect();
  process.exit(failed + errors > 0 ? 1 : 0);
}

main().catch(e => { console.error('CRASH:', e); process.exit(2); });
