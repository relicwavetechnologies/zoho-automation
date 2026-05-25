/**
 * run-engine-harness — drive the production orchestration engine end-to-end
 * with a configurable prompt, using REAL composition (Gemini + Lark + DB).
 *
 * This bypasses the webhook so we can iterate fast, but every other layer
 * (engine, supervisor, lark runner, lark API, status card) is the real one.
 * The bot will deliver the reply to the configured chat in Lark, exactly
 * like a real user message would.
 *
 * Usage:
 *   pnpm tsx scripts/run-engine-harness.ts                     # default prompt (P2P)
 *   pnpm tsx scripts/run-engine-harness.ts "your prompt here"
 *   pnpm tsx scripts/run-engine-harness.ts --group "your prompt here"
 *   pnpm tsx scripts/run-engine-harness.ts --debug-sigs        # dump every transformParams call
 *
 * UI / finance smoke test (status bubble + table final card):
 *   pnpm tsx scripts/run-engine-harness.ts --group "Give me a complete financial overview as of today: top 5 overdue invoices from Zoho Books with customer name, due date, and amount in a table; total outstanding AR; and Q1 2026 expenses broken down by category. Summarize in plain language for Finance."
 *
 * Group mode sends to the test group chat instead of P2P, including group
 * context (conversation array) in the engine run — mirrors real group behavior.
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

const DEFAULT_PROMPT = "make a task 'hrm8 deployment' and assign it to anish";
const ABHISHEK_OPEN_ID = 'ou_48b958c283635491b756c0ef23f47159';
const ANISH_OPEN_ID    = 'ou_a1c4b19abc483d674dde1955142e6b7d';
const P2P_CHAT_ID      = 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50';
const GROUP_CHAT_ID    = 'oc_b9169aab0765f46b2fe9147068e3c79f';

const args = process.argv.slice(2);
const debugSigs = args.includes('--debug-sigs');
const groupMode = args.includes('--group');
const asAnish   = args.includes('--as-anish');
const prompt    = args.filter(a => !a.startsWith('--'))[0] ?? DEFAULT_PROMPT;

// Optional: install global hook so we can trace what hits Gemini.
if (debugSigs) {
  const realFetch = global.fetch;
  global.fetch = (async (...fa: Parameters<typeof fetch>) => {
    const url = String(fa[0]);
    if (url.includes('generativelanguage.googleapis.com')) {
      const init = fa[1] as RequestInit | undefined;
      const body = init?.body ? String(init.body) : '';
      try {
        const parsed = JSON.parse(body);
        const contents = parsed.contents ?? [];
        console.log(`\n[FETCH→Gemini] ${url.split('?')[0]}  contents=${contents.length}`);
        contents.forEach((c: any, i: number) => {
          (c.parts ?? []).forEach((p: any, j: number) => {
            const what = p.functionCall ? `fn(${p.functionCall.name})` : p.functionResponse ? `fnResp(${p.functionResponse.name})` : p.text != null ? `text(${String(p.text).slice(0,30)})` : Object.keys(p).join(',');
            const sig  = p.thoughtSignature ? `SIG(${String(p.thoughtSignature).slice(0,8)}…,${String(p.thoughtSignature).length}b)` : 'NO-SIG';
            console.log(`  ${c.role} content[${i}].part[${j}]: ${what}  ${sig}`);
          });
        });
      } catch { /* not json or non-trivial body */ }
    }
    return realFetch(...fa);
  }) as typeof fetch;
}

async function main() {
  const chatId = groupMode ? GROUP_CHAT_ID : P2P_CHAT_ID;
  const chatType = groupMode ? 'group' : 'p2p';
  const userOpenId = asAnish ? ANISH_OPEN_ID : ABHISHEK_OPEN_ID;

  console.log('\n=== run-engine-harness ===');
  console.log(`mode:   ${chatType}`);
  console.log(`user:   ${asAnish ? 'Anish Suman' : 'Abhishek Verma'} (${userOpenId})`);
  console.log(`chatId: ${chatId}`);
  console.log(`prompt: ${JSON.stringify(prompt)}`);
  console.log(`debug-sigs: ${debugSigs}\n`);

  const env       = loadAndValidateEnv(process.env);
  const container = await buildContainer(env);
  const { engine, larkAdapter, channelIdentityRepo, prisma, approvalGate } = container;

  // ── 1. Resolve identity (mirrors webhook) ─────────────────────────────────
  const identityResult = await channelIdentityRepo.resolveByLarkOpenId(userOpenId);
  if (!identityResult.ok || !identityResult.value) {
    console.error(`Identity not found for openId=${userOpenId}`);
    process.exit(1);
  }
  const identity = identityResult.value;
  console.log(`identity: companyId=${identity.companyId} userId=${identity.userId} role=${identity.aiRole} dept=${identity.activeDepartmentId ?? '∅'}\n`);

  // ── 2. Build IncomingMessage + RunContext exactly like the webhook ────────
  const now = new Date();
  const messageId = `om_harness_${randomUUID()}`;
  const traceId   = asCorrelationId(`${messageId}-${now.getTime()}`);

  const incoming: IncomingMessage = {
    channel:        'lark',
    messageId:      asMessageId(messageId),
    chatId:         asChatId(chatId),
    chatType,
    userExternalId: userOpenId,
    text:           prompt,
    attachments:    [],
    timestamp:      now.toISOString(),
    traceId,
    mentions:       [],
    mentionsSelf:   true,
    raw:            {},
  };

  const runContext: RunContext = {
    companyId:      asCompanyId(identity.companyId),
    userId:         asUserId(identity.userId),
    companyRole:    asCompanyRoleSlug(identity.aiRole),
    channel:        'lark',
    traceId:        String(traceId),
    requestId:      messageId,
    userExternalId: userOpenId,
    chatId,
    ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
  };

  const conversation: ConversationHandle = {
    channel:          'lark',
    chatId:           incoming.chatId,
    replyToMessageId: incoming.messageId,
    replyInThread:    groupMode,
    correlationId:    traceId,
  };

  // ── 2b. Pre-flight: dump group context if group mode ──────────────────────
  if (groupMode && container.chatContextService) {
    const ctxResult = await container.chatContextService.loadContext(
      identity.companyId, chatId,
    );
    if (ctxResult?.ok && ctxResult.value) {
      const win = ctxResult.value;
      console.log(`── GROUP CONTEXT PRE-FLIGHT ──`);
      console.log(`  Total messages:  ${win.totalMessageCount}`);
      console.log(`  Recent messages: ${win.recentMessages.length}`);
      console.log(`  Has summary:     ${!!win.summary}`);
      for (const msg of win.recentMessages) {
        const attInfo = msg.attachments
          ? ` [${msg.attachments.length} att: ${msg.attachments.map(a => `${a.kind}/${a.fileName}${a.cloudinaryUrl ? ' ✓url' : ' ✗url'}${a.inlineContext ? ' ✓ocr' : ' ✗ocr'}`).join(', ')}]`
          : '';
        console.log(`  [${msg.createdAt}] ${msg.senderName} (${msg.role}): ${msg.content.slice(0, 80)}${attInfo}`);
      }
      console.log('');
    } else {
      console.log('── GROUP CONTEXT: empty or error ──\n');
    }
  }

  // ── 3. Store this message in group context (mirrors webhook snapshot) ─────
  if (groupMode && container.chatContextService) {
    await container.chatContextService.appendMessage({
      companyId: identity.companyId,
      chatId,
      chatType: 'group',
      messageId,
      senderOpenId: userOpenId,
      senderName: identity.displayName || identity.email || identity.userId,
      role: 'user',
      content: prompt,
      createdAt: now.toISOString(),
      botMentioned: true,
    });
    console.log('Stored harness message in group context.\n');
  }

  // ── 4. Run the engine — this delivers a real card to Lark ─────────────────
  console.log('engine.run starting…\n');
  const start = Date.now();
  const result = await engine.run({
    incoming,
    runContext,
    conversation,
    channelAdapter: larkAdapter,
    approvalGate,
  });
  const elapsedMs = Date.now() - start;

  console.log(`\n=== engine.run done in ${elapsedMs}ms ===`);
  if (!result.ok) {
    console.error('FAILED:', result.error.message);
    console.error(result.error);
    process.exit(1);
  }
  console.log(`tools called: [${result.value.toolsCalled.join(', ')}]`);
  console.log(`reply length: ${result.value.finalReply.text.length}`);
  console.log(`reply text  : ${result.value.finalReply.text.slice(0, 200)}${result.value.finalReply.text.length > 200 ? '…' : ''}`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(e => { console.error('CRASH:', e); process.exit(2); });
