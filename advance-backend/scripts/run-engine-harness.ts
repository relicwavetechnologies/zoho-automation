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
 *   pnpm tsx scripts/run-engine-harness.ts --model pro "your prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --allow-impersonation --user "Anish Suman" "your prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --fresh-context --allow-impersonation --user "Shivam Bhateja" "your prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --group "your prompt" # seeds a real Lark thread
 *   pnpm tsx scripts/run-engine-harness.ts --group --thread-root om_x "follow-up prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --group --group-mode inline "your prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --full-debug        # detailed latest-agent-run.log
 *   pnpm tsx scripts/run-engine-harness.ts --oauth-e2e "read my latest Gmail"
 *
 * `--user` selects a DB-linked Lark identity by exact email, exact display
 * name, or open_id. It changes the authenticated principal, never exposes or
 * copies that member's stored credential. Non-default users require
 * `--allow-impersonation`. Custom delivery IDs must be configured in the
 * comma-separated HARNESS_LARK_ALLOWED_CHAT_IDS environment variable.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildContainer } from '../src/composition';
import { loadAndValidateEnv } from '../src/config/env';
import {
  LARK_MODEL_IDS,
  type LarkModelId,
} from '../src/application/proxy/lark-inference.service';
import type { PrismaClient } from '../src/generated/prisma';
import { asMessageId, asChatId, asCorrelationId, asCompanyId, asUserId, asDepartmentId } from '../src/shared/ids';
import { asCompanyRoleSlug } from '../src/domain/permissions/company-role';
import type { IncomingMessage } from '../src/domain/channel/incoming-message';
import type { RunContext } from '../src/domain/orchestration/run-context';
import type { ConversationHandle } from '../src/application/channels/channel.adapter';
import { DataExportWorker } from '../src/application/data-export/data-export.worker';

const DEFAULT_PROMPT = 'Reply with exactly: Divo Flash harness is working. Do not call any tools.';
const DEFAULT_USER_SELECTOR = 'abhishek@emiactech.com';
const P2P_CHAT_ID      = 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50';
const GROUP_CHAT_ID    = 'oc_b9169aab0765f46b2fe9147068e3c79f';
const TRACE_PATH       = join(tmpdir(), 'divo-harness-latest.jsonl');

export type HarnessModel = keyof typeof LARK_MODEL_IDS;

export interface EngineHarnessOptions {
  readonly userSelector: string;
  readonly chatId: string;
  readonly chatType: 'p2p' | 'group';
  readonly groupReplyMode: 'threaded' | 'inline';
  readonly threadRootMessageId?: string;
  readonly model: HarnessModel;
  readonly prompt: string;
  readonly debugSigs: boolean;
  readonly trace: boolean;
  readonly fullDebug: boolean;
  readonly freshContext: boolean;
  readonly allowImpersonation: boolean;
  readonly oauthE2e: boolean;
  readonly help: boolean;
}

export function parseEngineHarnessArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): EngineHarnessOptions {
  let userSelector = DEFAULT_USER_SELECTOR;
  let explicitChatId: string | undefined;
  let chatType: 'p2p' | 'group' = 'p2p';
  let groupReplyMode: 'threaded' | 'inline' = 'threaded';
  let threadRootMessageId: string | undefined;
  let model: HarnessModel = 'flash';
  let debugSigs = false;
  let trace = true;
  let fullDebug = false;
  let freshContext = false;
  let allowImpersonation = false;
  let oauthE2e = false;
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
    if (value === '--no-trace') {
      trace = false;
      continue;
    }
    if (value === '--full-debug') {
      fullDebug = true;
      continue;
    }
    if (value === '--fresh-context') {
      freshContext = true;
      continue;
    }
    if (value === '--allow-impersonation') {
      allowImpersonation = true;
      continue;
    }
    if (value === '--oauth-e2e') {
      oauthE2e = true;
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
    if (
      value === '--user'
      || value === '--chat-id'
      || value === '--chat-type'
      || value === '--group-mode'
      || value === '--thread-root'
      || value === '--model'
    ) {
      const optionValue = args[++index]?.trim();
      if (!optionValue) throw new Error(`${value} requires a value`);
      if (value === '--user') userSelector = optionValue;
      if (value === '--chat-id') explicitChatId = optionValue;
      if (value === '--thread-root') threadRootMessageId = optionValue;
      if (value === '--model') {
        if (optionValue !== 'flash' && optionValue !== 'pro') {
          throw new Error('--model must be flash or pro');
        }
        model = optionValue;
      }
      if (value === '--chat-type') {
        if (optionValue !== 'p2p' && optionValue !== 'group') {
          throw new Error('--chat-type must be p2p or group');
        }
        chatType = optionValue;
      }
      if (value === '--group-mode') {
        if (optionValue !== 'threaded' && optionValue !== 'inline') {
          throw new Error('--group-mode must be threaded or inline');
        }
        groupReplyMode = optionValue;
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
  if (threadRootMessageId && chatType !== 'group') {
    throw new Error('--thread-root requires a group chat');
  }
  if (threadRootMessageId && groupReplyMode !== 'threaded') {
    throw new Error('--thread-root requires --group-mode threaded');
  }
  if (threadRootMessageId && freshContext) {
    throw new Error('--thread-root cannot be combined with --fresh-context');
  }
  if (oauthE2e && chatType !== 'p2p') {
    throw new Error('--oauth-e2e currently requires a p2p Lark chat');
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
    groupReplyMode,
    ...(threadRootMessageId ? { threadRootMessageId } : {}),
    model,
    prompt: promptParts.join(' ').trim() || DEFAULT_PROMPT,
    debugSigs,
    trace,
    fullDebug,
    freshContext,
    allowImpersonation,
    oauthE2e,
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

export function buildHarnessTextMessage(text: string): string {
  return JSON.stringify({
    msg_type: 'text',
    content: JSON.stringify({ text }),
  });
}

type HarnessTrace = {
  id: string;
  status: string;
  latestSummary: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  events: Array<{
    sequence: number;
    phase: string;
    eventType: string;
    actorType: string;
    actorKey: string | null;
    title: string;
    status: string | null;
    payload: unknown;
    createdAt: Date;
  }>;
  stepResults: Array<{
    sequence: number;
    toolName: string;
    success: boolean;
    status: string | null;
    summary: string | null;
    createdAt: Date;
  }>;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function waitForGoogleOAuthContinuation(
  db: {
    connectionAuthorizationIntent: {
      findFirst(input: unknown): Promise<{
        id: string;
        status: string;
        continuationStatus: string;
        continuationRunId: string | null;
        failureCode: string | null;
      } | null>;
    };
  },
  input: {
    companyId: string;
    userId: string;
    originalMessageId: string;
  },
  options: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onProgress?: (message: string) => void;
  } = {},
): Promise<{ intentId: string; continuationRunId: string }> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const onProgress = options.onProgress ?? console.log;
  const deadline = now() + timeoutMs;
  let lastState = '';

  while (now() < deadline) {
    const intent = await db.connectionAuthorizationIntent.findFirst({
      where: {
        companyId: input.companyId,
        userId: input.userId,
        originalMessageId: input.originalMessageId,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        continuationStatus: true,
        continuationRunId: true,
        failureCode: true,
      },
    });
    if (intent) {
      const state = `${intent.status}:${intent.continuationStatus}:${intent.failureCode ?? ''}`;
      if (state !== lastState) {
        lastState = state;
        onProgress(
          `google oauth lifecycle: intent=${intent.id} authorization=${intent.status} continuation=${intent.continuationStatus}`,
        );
      }
      if (
        intent.status === 'connected'
        && intent.continuationStatus === 'completed'
        && intent.continuationRunId
      ) {
        return {
          intentId: intent.id,
          continuationRunId: intent.continuationRunId,
        };
      }
      if (
        intent.status === 'failed'
        || intent.status === 'expired'
        || intent.continuationStatus === 'failed'
      ) {
        throw new Error(
          `Google OAuth E2E failed: ${intent.failureCode ?? `${intent.status}/${intent.continuationStatus}`}`,
        );
      }
    }
    await sleep(pollMs);
  }
  throw new Error('Google OAuth E2E timed out waiting for the fresh continuation run.');
}

export async function waitForDataExports(
  queue: {
    getJobCounts(
      ...types: Array<'waiting' | 'active' | 'delayed'>
    ): Promise<Record<'waiting' | 'active' | 'delayed', number>>;
    getJobs(
      types: Array<'active'>,
      start?: number,
      end?: number,
      asc?: boolean,
    ): Promise<Array<{ id?: string; progress: unknown }>>;
  },
  options: {
    inactivityMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onProgress?: (message: string) => void;
  } = {},
): Promise<void> {
  const inactivityMs = options.inactivityMs ?? 10 * 60 * 1_000;
  const pollMs = options.pollMs ?? 1_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const onProgress = options.onProgress ?? console.log;
  let deadline = now() + inactivityMs;
  let lastActivity = '';

  while (true) {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
    if (counts.waiting === 0 && counts.active === 0 && counts.delayed === 0) return;
    const activeJobs = counts.active > 0
      ? await queue.getJobs(['active'], 0, -1, true)
      : [];
    const activity = JSON.stringify({
      counts,
      jobs: activeJobs.map(job => ({ id: job.id, progress: job.progress })),
    });
    if (activity !== lastActivity) {
      lastActivity = activity;
      deadline = now() + inactivityMs;
      for (const job of activeJobs) {
        onProgress(`data export progress: job=${job.id ?? 'unknown'} ${formatExportProgress(job.progress)}`);
      }
    }
    if (now() >= deadline) {
      throw new Error('Data export made no queue or row progress for 10 minutes');
    }
    await sleep(pollMs);
  }
}

function formatExportProgress(progress: unknown): string {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return 'stage=starting';
  const value = progress as Record<string, unknown>;
  return [
    typeof value['stage'] === 'string' ? `stage=${value['stage']}` : undefined,
    typeof value['rowsRead'] === 'number' ? `rows=${value['rowsRead']}` : undefined,
    typeof value['pagesRead'] === 'number' ? `pages=${value['pagesRead']}` : undefined,
  ].filter(Boolean).join(' ');
}

function compactTracePayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const source = payload as Record<string, unknown>;
  const compact = Object.fromEntries(
    ['provider', 'model', 'agentTarget', 'toolName', 'operation', 'reason', 'durationMs', 'stepCount', 'replyLength', 'toolsCalled']
      .filter(key => source[key] !== undefined)
      .map(key => [key, source[key]]),
  );
  return Object.keys(compact).length > 0 ? ` ${JSON.stringify(compact)}` : '';
}

async function printPersistedTrace(input: {
  db: Pick<PrismaClient, 'executionRun'>;
  requestId: string;
  traceId: string;
  requestedModelId: LarkModelId;
}): Promise<void> {
  let run: HarnessTrace | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    run = await input.db.executionRun.findUnique({
      where: { requestId: input.requestId },
      select: {
        id: true,
        status: true,
        latestSummary: true,
        errorCode: true,
        errorMessage: true,
        startedAt: true,
        finishedAt: true,
        events: {
          orderBy: { sequence: 'asc' },
          select: {
            sequence: true,
            phase: true,
            eventType: true,
            actorType: true,
            actorKey: true,
            title: true,
            status: true,
            payload: true,
            createdAt: true,
          },
        },
        stepResults: {
          orderBy: { sequence: 'asc' },
          select: {
            sequence: true,
            toolName: true,
            success: true,
            status: true,
            summary: true,
            createdAt: true,
          },
        },
      },
    });
    if (run && run.status !== 'running' && run.events.length > 0) break;
    await delay(100);
  }

  console.log('\n=== persisted agent lifecycle ===');
  if (!run) {
    console.log(`trace unavailable for requestId=${input.requestId}`);
    return;
  }

  const records = [
    {
      kind: 'run',
      traceId: input.traceId,
      requestId: input.requestId,
      requestedModelId: input.requestedModelId,
      executionRunId: run.id,
      status: run.status,
      latestSummary: run.latestSummary,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    ...run.events.map(event => ({ kind: 'event', traceId: input.traceId, ...event })),
    ...run.stepResults.map(step => ({ kind: 'step', traceId: input.traceId, ...step })),
  ];
  writeFileSync(TRACE_PATH, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');

  console.log(`run: ${run.id} status=${run.status} events=${run.events.length} steps=${run.stepResults.length}`);
  for (const event of run.events) {
    const actor = event.actorKey ?? event.actorType;
    console.log(
      `[trace ${String(event.sequence).padStart(3, '0')}] ${event.phase}/${event.eventType}`
      + ` actor=${actor} status=${event.status ?? 'info'}`
      + compactTracePayload(event.payload),
    );
  }
  for (const step of run.stepResults) {
    console.log(
      `[step  ${String(step.sequence).padStart(3, '0')}] ${step.toolName}`
      + ` status=${step.status ?? (step.success ? 'success' : 'failed')}`,
    );
  }
  console.log(`trace jsonl: ${TRACE_PATH}`);
  console.log(`grep: rg -n 'model_call|tool_call|specialist|run_complete|run_failed' ${TRACE_PATH}`);
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
    console.log('Usage: pnpm tsx scripts/run-engine-harness.ts [--model flash|pro] [--fresh-context] [--oauth-e2e] [--allow-impersonation --user <email|name|open_id>] [--chat-id <allowed-id>] [--chat-type p2p|group] [--group] [--group-mode threaded|inline] [--thread-root <message-id>] [--no-trace] [--full-debug] [prompt]');
    return;
  }
  if (options.debugSigs) installGeminiSignatureTrace();
  if (options.fullDebug) process.env.DEBUG_AGENT_RUN = 'true';
  const requestedModelId = LARK_MODEL_IDS[options.model];

  console.log('\n=== run-engine-harness ===');
  console.log(`mode:   ${options.chatType}`);
  if (options.chatType === 'group') console.log(`group reply mode: ${options.groupReplyMode}`);
  console.log(`model:  ${options.model} (${requestedModelId})`);
  console.log(`user selector: ${options.userSelector}`);
  console.log(`delivery chatId: ${options.chatId}`);
  console.log(`fresh context: ${options.freshContext}`);
  console.log(`oauth e2e: ${options.oauthE2e}`);
  console.log(`prompt: ${JSON.stringify(options.prompt)}`);
  console.log(`persisted trace: ${options.trace}`);
  console.log(`full debug: ${options.fullDebug}\n`);

  const env = loadAndValidateEnv(options.freshContext
    ? { ...process.env, MEM0_ENABLED: 'false' }
    : process.env);
  const container = await buildContainer(env);
  const { engine, larkAdapter, channelIdentityRepo, prisma, approvalGate } = container;
  const dataExportWorker = new DataExportWorker({
    redisUrl: container.queueRedisUrl,
    sources: container.dataExportSources,
    sink: container.googleWorkspaceExportSink,
    identityRepo: container.channelIdentityRepo,
    permissions: container.permissions,
    resolveGoogleAuth: container.resolveGoogleExportAuth,
    larkAdapter: container.larkAdapter,
    logger: container.logger,
  });
  dataExportWorker.start();

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

  const oauthBinding = options.oauthE2e
    ? await prisma.larkTenantBinding.findFirst({
        where: { companyId: identity.companyId, isActive: true },
        select: { larkTenantKey: true },
      })
    : null;
  if (options.oauthE2e && !oauthBinding) {
    throw new Error('No active Lark tenant binding exists for the OAuth E2E target.');
  }
  const oauthSeed = options.oauthE2e
    ? await larkAdapter.sendToChatId(
        options.chatId,
        buildHarnessTextMessage(`🧪 Google OAuth E2E\n${options.prompt}`),
      )
    : null;
  if (oauthSeed && !oauthSeed.ok) throw oauthSeed.error;
  if (oauthSeed?.ok) {
    console.log(`seeded OAuth E2E request message: ${oauthSeed.value}`);
  }

  // ── 2. Build IncomingMessage + RunContext exactly like the webhook ────────
  let threadRootMessageId = options.threadRootMessageId;
  let seededThread = false;
  if (
    options.chatType === 'group'
    && options.groupReplyMode === 'threaded'
    && !threadRootMessageId
  ) {
    const seed = await larkAdapter.sendToChatId(
      options.chatId,
      buildHarnessTextMessage(`🧪 Divo engine harness\n${options.prompt}`),
    );
    if (!seed.ok) throw seed.error;
    threadRootMessageId = seed.value;
    seededThread = true;
    console.log(`seeded Lark thread root: ${threadRootMessageId}`);
  }

  const now = new Date();
  const messageId = oauthSeed?.ok
    ? oauthSeed.value
    : seededThread
    ? threadRootMessageId!
    : `om_harness_${randomUUID()}`;
  const traceId   = asCorrelationId(`${messageId}-${now.getTime()}`);
  const contextChatId = options.chatType === 'group' && options.groupReplyMode === 'threaded'
    ? options.chatId
    : options.freshContext
    ? `harness_fresh_${messageId}`
    : options.chatId;
  console.log(`traceId: ${traceId}`);
  console.log(`requestId: ${messageId}\n`);
  console.log(`context chatId: ${contextChatId}\n`);

  const incoming: IncomingMessage = {
    channel:        'lark',
    messageId:      asMessageId(messageId),
    chatId:         asChatId(contextChatId),
    chatType:       options.chatType,
    userExternalId: userOpenId,
    text:           options.prompt,
    attachments:    [],
    timestamp:      now.toISOString(),
    traceId,
    mentions:       [],
    mentionsSelf:   true,
    ...(options.chatType === 'group' ? { groupReplyMode: options.groupReplyMode } : {}),
    ...(!seededThread && threadRootMessageId
      ? { rootMessageId: asMessageId(threadRootMessageId) }
      : {}),
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
    ...(options.oauthE2e && oauthBinding
      ? {
          connectionAuthorization: {
            larkOpenId: userOpenId,
            larkTenantKey: oauthBinding.larkTenantKey,
            chatId: options.chatId,
            chatType: options.chatType,
            originalMessageId: messageId,
            replyInThread: false,
            originalRequest: options.prompt,
          },
        }
      : {}),
  };

  const conversation: ConversationHandle = {
    channel:          'lark',
    chatId:           asChatId(options.chatId),
    ...(threadRootMessageId
      ? { replyToMessageId: asMessageId(threadRootMessageId) }
      : {}),
    ...(options.chatType === 'group'
      ? { replyInThread: options.groupReplyMode === 'threaded' }
      : {}),
    correlationId:    traceId,
  };

  // ── 2b. Pre-flight: dump group context if group mode ──────────────────────
  if (options.chatType === 'group' && container.chatContextService) {
    const ctxResult = await container.chatContextService.loadContext(
      identity.companyId, contextChatId,
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
      chatId: contextChatId,
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
    larkModelId: requestedModelId,
  });
  const elapsedMs = Date.now() - start;

  console.log(`\n=== engine.run done in ${elapsedMs}ms ===`);
  if (!result.ok) {
    console.error('FAILED:', result.error.message);
    console.error(result.error);
    if (options.trace) {
      await printPersistedTrace({
        db: prisma,
        requestId: messageId,
        traceId: String(traceId),
        requestedModelId,
      });
    }
    await dataExportWorker.stop();
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(`tools called: [${result.value.toolsCalled.join(', ')}]`);
  console.log(`reply length: ${result.value.finalReply.text.length}`);
  console.log(`reply text  : ${result.value.finalReply.text.slice(0, 200)}${result.value.finalReply.text.length > 200 ? '…' : ''}`);

  if (options.trace) {
    await printPersistedTrace({
      db: prisma,
      requestId: messageId,
      traceId: String(traceId),
      requestedModelId,
    });
  }
  if (options.oauthE2e) {
    console.log('\nComplete the Connect Google card in Lark; this harness is now monitoring durable backend state.');
    const continuation = await waitForGoogleOAuthContinuation(prisma, {
      companyId: identity.companyId,
      userId: identity.userId,
      originalMessageId: messageId,
    });
    console.log(
      `fresh continuation completed: intent=${continuation.intentId} requestId=${continuation.continuationRunId}`,
    );
    if (options.trace) {
      await printPersistedTrace({
        db: prisma,
        requestId: continuation.continuationRunId,
        traceId: continuation.continuationRunId,
        requestedModelId: LARK_MODEL_IDS.flash,
      });
    }
  }
  if (options.fullDebug) {
    console.log(`full debug log: ${join(process.cwd(), 'latest-agent-run.log')}`);
  }
  await waitForDataExports(container.dataExportQueue.getQueue());
  await dataExportWorker.stop();
  await prisma.$disconnect();
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => { console.error('CRASH:', e); process.exit(2); });
}
