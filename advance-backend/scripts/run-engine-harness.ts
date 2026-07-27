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
 *   pnpm tsx scripts/run-engine-harness.ts                     # Abhishek → Abhishek DM
 *   pnpm tsx scripts/run-engine-harness.ts "your prompt here"
 *   pnpm tsx scripts/run-engine-harness.ts --allow-impersonation --user "Anish Suman" "your prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --chat-id oc_x --chat-type group "your prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --debug-sigs        # dump every transformParams call
 *
 * `--user` selects a DB-linked Lark identity by exact email, exact display
 * name, or open_id. It changes the authenticated principal, never exposes or
 * copies that member's stored credential. Non-default users require
 * `--allow-impersonation`. Custom delivery IDs must be configured in the
 * comma-separated HARNESS_LARK_ALLOWED_CHAT_IDS environment variable.
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
const DEFAULT_USER_SELECTOR = 'abhishek@emiactech.com';
const P2P_CHAT_ID      = 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50';
const GROUP_CHAT_ID    = 'oc_b9169aab0765f46b2fe9147068e3c79f';

export interface EngineHarnessOptions {
  readonly userSelector: string;
  readonly chatId: string;
  readonly chatType: 'p2p' | 'group';
  readonly prompt: string;
  readonly debugSigs: boolean;
  readonly allowImpersonation: boolean;
  readonly help: boolean;
}

export function parseEngineHarnessArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): EngineHarnessOptions {
  let userSelector = DEFAULT_USER_SELECTOR;
  let explicitChatId: string | undefined;
  let chatType: 'p2p' | 'group' = 'p2p';
  let debugSigs = false;
  let allowImpersonation = false;
  let help = false;
  const promptParts: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--') {
      promptParts.push(...args.slice(index + 1));
      break;
    }
    if (value === '--debug-sigs') {
      debugSigs = true;
      continue;
    }
    if (value === '--allow-impersonation') {
      allowImpersonation = true;
      continue;
    }
    if (value === '--group') {
      chatType = 'group';
      continue;
    }
    if (value === '--as-anish') {
      userSelector = 'Anish Suman';
      continue;
    }
    if (value === '--help' || value === '-h') {
      help = true;
      continue;
    }
    if (value === '--user' || value === '--chat-id' || value === '--chat-type') {
      const optionValue = args[++index]?.trim();
      if (!optionValue) throw new Error(`${value} requires a value`);
      if (value === '--user') userSelector = optionValue;
      if (value === '--chat-id') explicitChatId = optionValue;
      if (value === '--chat-type') {
        if (optionValue !== 'p2p' && optionValue !== 'group') {
          throw new Error('--chat-type must be p2p or group');
        }
        chatType = optionValue;
      }
      continue;
    }
    if (value?.startsWith('--')) throw new Error(`Unknown option: ${value}`);
    if (value) promptParts.push(value);
  }

  if (
    userSelector.toLowerCase() !== DEFAULT_USER_SELECTOR.toLowerCase()
    && !allowImpersonation
  ) {
    throw new Error('Selecting a non-default Lark principal requires --allow-impersonation');
  }
  const resolvedChatId = explicitChatId
    ?? (chatType === 'group'
      ? GROUP_CHAT_ID
      : env.HARNESS_LARK_CHAT_ID?.trim() || P2P_CHAT_ID);
  const allowedChatIds = new Set([
    P2P_CHAT_ID,
    GROUP_CHAT_ID,
    ...(env.HARNESS_LARK_ALLOWED_CHAT_IDS ?? '').split(',').map(value => value.trim()),
  ].filter((value): value is string => Boolean(value)));
  if (!allowedChatIds.has(resolvedChatId)) {
    throw new Error(`Chat ${resolvedChatId} is not in HARNESS_LARK_ALLOWED_CHAT_IDS`);
  }

  return {
    userSelector,
    chatId: resolvedChatId,
    chatType,
    prompt: promptParts.join(' ').trim() || DEFAULT_PROMPT,
    debugSigs,
    allowImpersonation,
    help,
  };
}

type HarnessIdentityStore = {
  channelIdentity: {
    findMany(input: unknown): Promise<Array<{
      larkOpenId: string | null;
      displayName: string | null;
      email: string | null;
    }>>;
  };
};

export async function resolveHarnessOpenId(
  db: HarnessIdentityStore,
  selector: string,
): Promise<string> {
  const normalized = selector.trim();
  const selectorFilter = normalized.startsWith('ou_')
    ? [{ larkOpenId: normalized }]
    : [
        { email: { equals: normalized, mode: 'insensitive' } },
        { displayName: { equals: normalized, mode: 'insensitive' } },
      ];
  const matches = await db.channelIdentity.findMany({
    where: {
      channel: 'lark',
      larkOpenId: { not: null },
      OR: selectorFilter,
    },
    select: { larkOpenId: true, displayName: true, email: true },
    orderBy: { updatedAt: 'desc' },
    take: 2,
  });
  if (matches.length === 0) {
    throw new Error(`No DB-linked Lark identity matches ${JSON.stringify(normalized)}`);
  }
  if (matches.length > 1) {
    throw new Error(`Lark identity ${JSON.stringify(normalized)} is ambiguous; pass its exact open_id`);
  }
  return matches[0]!.larkOpenId!;
}

// Optional: install global hook so we can trace what hits Gemini.
function installGeminiSignatureTrace() {
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
  const options = parseEngineHarnessArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: pnpm tsx scripts/run-engine-harness.ts [--allow-impersonation --user <email|name|open_id>] [--chat-id <allowed-id>] [--chat-type p2p|group] [--group] [--debug-sigs] [prompt]');
    return;
  }
  if (options.debugSigs) installGeminiSignatureTrace();

  console.log('\n=== run-engine-harness ===');
  console.log(`mode:   ${options.chatType}`);
  console.log(`user selector: ${options.userSelector}`);
  console.log(`chatId: ${options.chatId}`);
  console.log(`prompt: ${JSON.stringify(options.prompt)}`);
  console.log(`debug-sigs: ${options.debugSigs}\n`);

  const env       = loadAndValidateEnv(process.env);
  const container = await buildContainer(env);
  const { engine, larkAdapter, channelIdentityRepo, prisma, approvalGate } = container;

  // ── 1. Resolve identity (mirrors webhook) ─────────────────────────────────
  const userOpenId = await resolveHarnessOpenId(prisma, options.userSelector);
  const identityResult = await channelIdentityRepo.resolveByLarkOpenId(userOpenId);
  if (!identityResult.ok || !identityResult.value) {
    console.error(`Identity not found for openId=${userOpenId}`);
    process.exit(1);
  }
  const identity = identityResult.value;
  console.log(`identity: ${identity.displayName ?? identity.email ?? userOpenId} (${userOpenId})`);
  console.log(`principal: companyId=${identity.companyId} userId=${identity.userId} role=${identity.aiRole} dept=${identity.activeDepartmentId ?? '∅'}\n`);

  // ── 2. Build IncomingMessage + RunContext exactly like the webhook ────────
  const now = new Date();
  const messageId = `om_harness_${randomUUID()}`;
  const traceId   = asCorrelationId(`${messageId}-${now.getTime()}`);
  console.log(`traceId: ${traceId}`);
  console.log(`requestId: ${messageId}\n`);

  const incoming: IncomingMessage = {
    channel:        'lark',
    messageId:      asMessageId(messageId),
    chatId:         asChatId(options.chatId),
    chatType:       options.chatType,
    userExternalId: userOpenId,
    text:           options.prompt,
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
    chatId:         options.chatId,
    ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
  };

  const conversation: ConversationHandle = {
    channel:          'lark',
    chatId:           incoming.chatId,
    replyToMessageId: incoming.messageId,
    replyInThread:    options.chatType === 'group',
    correlationId:    traceId,
  };

  // ── 2b. Pre-flight: dump group context if group mode ──────────────────────
  if (options.chatType === 'group' && container.chatContextService) {
    const ctxResult = await container.chatContextService.loadContext(
      identity.companyId, options.chatId,
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
  if (options.chatType === 'group' && container.chatContextService) {
    await container.chatContextService.appendMessage({
      companyId: identity.companyId,
      chatId: options.chatId,
      chatType: 'group',
      messageId,
      senderOpenId: userOpenId,
      senderName: identity.displayName || identity.email || identity.userId,
      role: 'user',
      content: options.prompt,
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

if (require.main === module) {
  main().catch(e => { console.error('CRASH:', e); process.exit(2); });
}
