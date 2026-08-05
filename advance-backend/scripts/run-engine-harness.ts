/**
 * run-engine-harness — drive the cloud Pi runtime end-to-end with a
 * configurable prompt, real DB identity, Divo Gateway, and optional Lark
 * delivery.
 *
 * This bypasses webhook admission while preserving the production Pi runtime
 * lease, local controller, backend capability gateway, and Lark status/final
 * renderer.
 * It never invokes the legacy Vercel AI SDK orchestration engine.
 *
 * Usage:
 *   pnpm tsx scripts/run-engine-harness.ts                     # Abhishek → Abhishek DM
 *   pnpm tsx scripts/run-engine-harness.ts "your prompt here"
 *   pnpm tsx scripts/run-engine-harness.ts --model luna "your prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --allow-impersonation --user "Anish Suman" --chat-id oc_anish "your prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --fresh-context --allow-impersonation --user "Shivam Bhateja" --chat-id oc_shivam "your prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --group "your prompt" # seeds a real Lark thread
 *   pnpm tsx scripts/run-engine-harness.ts --group --thread-root om_x "follow-up prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --group --group-mode inline "your prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --backend-url http://127.0.0.1:8000 "your prompt"
 *   pnpm tsx scripts/run-engine-harness.ts --no-final-delivery "your prompt" # suppress status/final cards; tools remain live
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
import type { PrismaClient } from '../src/generated/prisma';
import { asMessageId, asChatId, asCorrelationId, asCompanyId, asUserId, asDepartmentId } from '../src/shared/ids';
import { asCompanyRoleSlug } from '../src/domain/permissions/company-role';
import type { IncomingMessage } from '../src/domain/channel/incoming-message';
import type { RunContext } from '../src/domain/orchestration/run-context';
import type { ConversationHandle } from '../src/application/channels/channel.adapter';
import type { LarkPiRuntimeService } from '../src/application/runtime/lark-pi-runtime.service';
import { conversationKeyForMessage } from '../src/domain/conversation/conversation-key';
import { runPiAndDeliver } from '../src/infrastructure/channels/lark/lark.webhook.routes';
import {
  resolveHarnessOpenId,
  resolveHarnessTenantKey,
} from '../src/application/agent-seat/harness-identity.ts';
import {
  LarkMessagingClient,
  type LarkChatMode,
} from '../src/infrastructure/channels/lark/clients/lark-messaging.client';

export { resolveHarnessOpenId, resolveHarnessTenantKey };

const HARNESS_MODEL_IDS = {
  flash: 'deepseek-v4-flash',
  pro: 'deepseek-v4-pro',
  luna: 'gpt-5.6-luna',
} as const;
const DEFAULT_PROMPT = 'Reply with exactly: Divo Pi harness is working. Do not call any tools.';
const DEFAULT_USER_SELECTOR = 'abhishek@emiactech.com';
const P2P_CHAT_ID      = 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50';
const GROUP_CHAT_ID    = 'oc_b9169aab0765f46b2fe9147068e3c79f';
const TRACE_PATH       = join(tmpdir(), 'divo-harness-latest.jsonl');

export type HarnessModel = keyof typeof HARNESS_MODEL_IDS;

export interface EngineHarnessOptions {
  readonly userSelector: string;
  readonly backendUrl: string;
  readonly chatId: string;
  readonly chatType: 'p2p' | 'group';
  readonly groupReplyMode: 'threaded' | 'inline';
  readonly threadRootMessageId?: string;
  readonly model?: HarnessModel;
  readonly prompt: string;
  readonly debugSigs: boolean;
  readonly trace: boolean;
  readonly fullDebug: boolean;
  readonly freshContext: boolean;
  readonly allowImpersonation: boolean;
  readonly oauthE2e: boolean;
  readonly deliverToLark: boolean;
  readonly help: boolean;
}

/**
 * Keep the provider delivery address separate from the disposable Pi thread.
 * Lark callbacks and review cards must always use the real chat ID; fresh
 * harness isolation belongs only in the agent session key.
 */
export function resolveHarnessRuntimeAddress(
  chatId: string,
  messageId: string,
  freshContext: boolean,
): { chatId: string; freshThreadId?: string } {
  return {
    chatId,
    ...(freshContext ? { freshThreadId: `harness_fresh_${messageId}` } : {}),
  };
}

/**
 * Keep production delivery intact while replacing only the Pi session key.
 * `runPiAndDeliver` correctly derives a DM session from the real chat ID; the
 * harness needs this narrow wrapper because a fresh test must not reopen that
 * user's durable conversation merely to deliver the result to the same DM.
 */
export function isolateHarnessPiThread(
  runtime: Pick<LarkPiRuntimeService, 'run'>,
  freshThreadId?: string,
): Pick<LarkPiRuntimeService, 'run'> {
  if (!freshThreadId) return runtime;
  return {
    run: input => runtime.run({ ...input, threadId: freshThreadId }),
  };
}

/**
 * Bind the selected principal to the provider-authoritative chat before any
 * model or tool execution. A configured label is not proof of either chat
 * type or membership, so both facts fail closed.
 */
export function assertHarnessChatBinding(input: {
  readonly chatId: string;
  readonly expectedChatType: 'p2p' | 'group';
  readonly actualMode: LarkChatMode;
  readonly selectedOpenId: string;
  readonly memberOpenIds: readonly string[];
}): void {
  const actualChatType = input.actualMode === 'p2p' ? 'p2p' : 'group';
  if (actualChatType !== input.expectedChatType) {
    throw new Error(
      `Refusing harness run: chat ${input.chatId} has provider mode ${input.actualMode}, not configured ${input.expectedChatType}.`,
    );
  }
  if (!input.memberOpenIds.includes(input.selectedOpenId)) {
    throw new Error(
      `Refusing harness run: selected Lark principal ${input.selectedOpenId} is not a live member of chat ${input.chatId}.`,
    );
  }
}

export function parseEngineHarnessArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): EngineHarnessOptions {
  let userSelector = DEFAULT_USER_SELECTOR;
  let backendUrl = env.HARNESS_PI_BACKEND_URL?.trim()
    || `http://127.0.0.1:${env.PORT?.trim() || '8000'}`;
  let explicitChatId: string | undefined;
  let chatType: 'p2p' | 'group' = 'p2p';
  let groupReplyMode: 'threaded' | 'inline' = 'threaded';
  let threadRootMessageId: string | undefined;
  let model: HarnessModel | undefined;
  let debugSigs = false;
  let trace = true;
  let fullDebug = false;
  let freshContext = false;
  let allowImpersonation = false;
  let oauthE2e = false;
  let deliverToLark = true;
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
    if (value === '--no-delivery') {
      throw new Error(
        '--no-delivery was removed because it falsely implied a side-effect-free run. '
        + 'Use --no-final-delivery to suppress only status/final cards; tool, review, approval, and provider side effects remain enabled.',
      );
    }
    if (value === '--no-final-delivery') {
      deliverToLark = false;
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
      || value === '--backend-url'
      || value === '--chat-id'
      || value === '--chat-type'
      || value === '--group-mode'
      || value === '--thread-root'
      || value === '--model'
    ) {
      const optionValue = args[++index]?.trim();
      if (!optionValue) throw new Error(`${value} requires a value`);
      if (value === '--user') userSelector = optionValue;
      if (value === '--backend-url') backendUrl = optionValue;
      if (value === '--chat-id') explicitChatId = optionValue;
      if (value === '--thread-root') threadRootMessageId = optionValue;
      if (value === '--model') {
        if (optionValue !== 'flash' && optionValue !== 'pro' && optionValue !== 'luna') {
          throw new Error('--model must be flash, pro, or luna');
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
  if (
    userSelector.toLowerCase() !== DEFAULT_USER_SELECTOR.toLowerCase()
    && !explicitChatId
  ) {
    throw new Error(
      'Selecting a non-default Lark principal requires an explicit --chat-id. '
      + 'This is required even with --no-final-delivery because tools can send review cards.',
    );
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
  if (!deliverToLark && oauthE2e) {
    throw new Error('--no-final-delivery cannot be combined with --oauth-e2e');
  }
  if (!deliverToLark && chatType !== 'p2p') {
    throw new Error('--no-final-delivery currently supports p2p harness runs only');
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
  try {
    const parsedBackendUrl = new URL(backendUrl);
    if (parsedBackendUrl.protocol !== 'http:' && parsedBackendUrl.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error('--backend-url must be an absolute HTTP(S) URL');
  }

  return {
    userSelector,
    backendUrl: backendUrl.replace(/\/+$/, ''),
    chatId: resolvedChatId,
    chatType,
    groupReplyMode,
    ...(threadRootMessageId ? { threadRootMessageId } : {}),
    ...(model ? { model } : {}),
    prompt: promptParts.join(' ').trim() || DEFAULT_PROMPT,
    debugSigs,
    trace,
    fullDebug,
    freshContext,
    allowImpersonation,
    oauthE2e,
    deliverToLark,
    help,
  };
}

export function assertPiHarnessOptions(options: EngineHarnessOptions): void {
  if (options.debugSigs) {
    throw new Error('--debug-sigs applies only to the retired Gemini harness path');
  }
  if (options.fullDebug) {
    throw new Error('--full-debug applies only to the retired AI SDK harness path');
  }
  if (options.oauthE2e) {
    throw new Error('--oauth-e2e is not supported by the direct cloud Pi harness');
  }
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
  expectedModel: HarnessModel | null;
  activeModelId: string;
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
      expectedModel: input.expectedModel,
      activeModelId: input.activeModelId,
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

async function main() {
  const options = parseEngineHarnessArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: pnpm tsx scripts/run-engine-harness.ts [--model flash|pro|luna] [--backend-url <local-backend-url>] [--fresh-context] [--no-final-delivery] [--allow-impersonation --user <email|name|open_id>] [--chat-id <allowed-id>] [--chat-type p2p|group] [--group] [--group-mode threaded|inline] [--thread-root <message-id>] [--no-trace] [prompt]');
    return;
  }
  assertPiHarnessOptions(options);
  console.log('\n=== run-engine-harness ===');
  console.log('runtime: cloud Pi (legacy AI SDK disabled)');
  console.log(`mode:   ${options.chatType}`);
  if (options.chatType === 'group') console.log(`group reply mode: ${options.groupReplyMode}`);
  console.log(`expected model: ${options.model ?? 'member policy'}`);
  console.log(`user selector: ${options.userSelector}`);
  console.log(`final delivery: ${options.deliverToLark ? `Lark chat ${options.chatId}` : 'suppressed; tool/provider side effects remain enabled'}`);
  console.log(`fresh context: ${options.freshContext}`);
  console.log(`oauth e2e: ${options.oauthE2e}`);
  console.log(`prompt: ${JSON.stringify(options.prompt)}`);
  console.log(`persisted trace: ${options.trace}`);
  console.log(`full debug: ${options.fullDebug}\n`);

  const env = loadAndValidateEnv({
    ...process.env,
    ...(options.freshContext
      ? { HINDSIGHT_ENABLED: 'false', KNOWLEDGE_LEARNING_ENABLED: 'false' }
      : {}),
    // Build the same fully composed runtime used by the webhook while still
    // allowing the harness to target an explicitly selected backend.
    PI_LARK_BACKEND_URL: options.backendUrl,
  });
  const container = await buildContainer(env);
  const {
    larkAdapter,
    channelIdentityRepo,
    prisma,
    larkPiRuntime: piRuntime,
  } = container;

  // ── 1. Resolve identity (mirrors webhook) ─────────────────────────────────
  const userOpenId = await resolveHarnessOpenId(prisma, options.userSelector);
  const identityResult = await channelIdentityRepo.resolveByLarkOpenId(userOpenId);
  if (!identityResult.ok || !identityResult.value) {
    console.error(`Identity not found for openId=${userOpenId}`);
    process.exit(1);
  }
  const identity = identityResult.value;
  const tenantKey = await resolveHarnessTenantKey(prisma, identity.companyId, userOpenId);
  const harnessMessagingClient = new LarkMessagingClient({
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    logger: container.logger,
    ...(env.LARK_API_BASE_URL ? { apiBaseUrl: env.LARK_API_BASE_URL } : {}),
  });
  const [actualChatMode, liveChatMembers] = await Promise.all([
    harnessMessagingClient.getChatMode(options.chatId),
    harnessMessagingClient.listChatMemberOpenIds(options.chatId),
  ]);
  assertHarnessChatBinding({
    chatId: options.chatId,
    expectedChatType: options.chatType,
    actualMode: actualChatMode,
    selectedOpenId: userOpenId,
    memberOpenIds: liveChatMembers,
  });
  const activeModelId = await piRuntime.modelFor(identity.userId);
  const expectedModelId = options.model ? HARNESS_MODEL_IDS[options.model] : undefined;
  if (expectedModelId && activeModelId !== expectedModelId) {
    throw new Error(
      `--model ${options.model} expects ${expectedModelId}, but Lark is pinned to ${activeModelId}. `
      + 'Update the channel pin or omit --model.',
    );
  }
  console.log(`identity: ${identity.displayName ?? identity.email ?? userOpenId} (${userOpenId})`);
  console.log(`principal: companyId=${identity.companyId} userId=${identity.userId} role=${identity.aiRole} dept=${identity.activeDepartmentId ?? '∅'} tenant=${tenantKey}\n`);
  console.log(`active model: ${activeModelId}\n`);

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
  const messageId = seededThread
    ? threadRootMessageId!
    : `om_harness_${randomUUID()}`;
  const traceId   = asCorrelationId(`${messageId}-${now.getTime()}`);
  const runtimeAddress = resolveHarnessRuntimeAddress(
    options.chatId,
    messageId,
    options.freshContext,
  );
  const contextChatId = runtimeAddress.chatId;
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
    tenantId:       tenantKey,
    traceId:        String(traceId),
    requestId:      messageId,
    userExternalId: userOpenId,
    chatId:         options.chatId,
    ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
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

  // ── 4. Run cloud Pi through the same lease/controller boundary as Lark ────
  const runtimeThreadId = runtimeAddress.freshThreadId ?? String(conversationKeyForMessage({
    chatId: String(incoming.chatId),
    chatType: incoming.chatType,
    messageId: String(incoming.messageId),
    ...(incoming.threadId ? { threadId: String(incoming.threadId) } : {}),
    ...(incoming.rootMessageId ? { rootMessageId: String(incoming.rootMessageId) } : {}),
    userExternalId: incoming.userExternalId,
    ...(incoming.groupReplyMode ? { groupReplyMode: incoming.groupReplyMode } : {}),
  }));
  console.log(`Pi controller: ${env.PI_LARK_CONTROLLER_URL}`);
  console.log(`Pi backend:    ${options.backendUrl}`);
  console.log(`Pi thread:     ${runtimeThreadId}`);
  console.log('piRuntime.run starting…\n');
  const start = Date.now();
  const delivery = options.deliverToLark
    ? await runPiAndDeliver({
        incoming,
        runContext,
        conversation,
        deps: {
          adapter: larkAdapter,
          piRuntime: isolateHarnessPiThread(piRuntime, runtimeAddress.freshThreadId),
        },
        log: container.logger,
        rethrowRuntimeFailureAfterDelivery: true,
      })
    : null;
  const resultText = options.deliverToLark
    ? delivery?.text ?? null
    : (await piRuntime.run({
        incoming,
        runContext,
        conversation,
        threadId: runtimeThreadId,
      })).text;
  if (!resultText) throw new Error('Cloud Pi completed without a delivered response');
  const elapsedMs = Date.now() - start;

  console.log(`\n=== piRuntime.run done in ${elapsedMs}ms ===`);
  console.log(`reply length: ${resultText.length}`);
  console.log(`reply text  : ${resultText.slice(0, 200)}${resultText.length > 200 ? '…' : ''}`);

  if (options.deliverToLark) {
    console.log('delivered to Lark through the production status/final card flow');
  } else {
    console.log('status/final delivery skipped (--no-final-delivery); tool/provider side effects remained enabled');
  }

  if (options.trace) {
    await printPersistedTrace({
      db: prisma,
      requestId: messageId,
      traceId: String(traceId),
      expectedModel: options.model ?? null,
      activeModelId,
    });
  }

  if (options.chatType === 'group' && container.chatContextService) {
    await container.chatContextService.appendMessage({
      companyId: identity.companyId,
      chatId: contextChatId,
      chatType: 'group',
      messageId: String(options.deliverToLark
        ? `om_harness_reply_${traceId}`
        : `om_harness_local_${traceId}`),
      senderOpenId: 'divo',
      senderName: 'Divo',
      role: 'assistant',
      content: resultText,
      createdAt: new Date().toISOString(),
      botMentioned: false,
    });
  }

  await prisma.$disconnect();
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => { console.error('CRASH:', e); process.exit(2); });
}
