import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createLarkWebhookRoutes,
  processAcceptedLarkReceipt,
  replayLarkMessageAfterLogin,
  quotedImageAttachments,
  runPiAndDeliver,
  runTranscript,
  type LarkWebhookDeps,
} from '../../../src/infrastructure/channels/lark/lark.webhook.routes.ts';
import { LarkPiRuntimeError } from '../../../src/application/runtime/lark-pi-runtime.service.ts';
import { LarkChannelAdapter } from '../../../src/infrastructure/channels/lark/lark.adapter.ts';
import { BusyLaneNotices } from '../../../src/infrastructure/channels/lark/lark-busy-notice.ts';
import { LarkDataExportCardHandler } from '../../../src/infrastructure/channels/lark/lark-data-export-card.handler.ts';
import { ChatMessageSerializer } from '../../../src/application/channels/chat-message-serializer.ts';
import { ElevenLabsTranscriptionClient } from '../../../src/infrastructure/ai/transcription/elevenlabs-transcription.client.ts';
import { err, ok } from '../../../src/shared/result.ts';
import { ChannelError } from '../../../src/shared/errors.ts';
import type { Logger } from '../../../src/shared/logger.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

interface LarkTestIdentity {
  userId: string;
  companyId: string;
  aiRole: string;
  channel: 'lark';
  activeDepartmentId?: string;
  displayName?: string;
  email?: string;
}

function makeEvent(input: {
  chatType: 'p2p' | 'group';
  senderType?: 'user' | 'bot';
  mentionsBot?: boolean;
  mentionsHuman?: boolean;
  /** Attach a file to the message instead of sending plain text. */
  file?: { key: string; name: string };
  /** Attach an image — the one media kind Divo actually reads over Lark. */
  image?: { key: string };
  /** Attach a Lark voice note. Duration is reported by Lark in milliseconds. */
  voice?: { key: string; durationMs?: number };
  /** Override sender and message identity to model several people in one room. */
  senderOpenId?: string;
  messageId?: string;
  rootId?: string | null;
  parentId?: string | null;
  threadId?: string | null;
  text?: string;
}) {
  const mentions = [
    ...(input.mentionsBot
      ? [{ key: '@_user_1', name: 'Renamed Bot', id: { open_id: 'ou_bot' } }]
      : []),
    ...(input.mentionsHuman
      ? [{
          key: '@_user_2',
          name: 'Alice',
          id: { open_id: 'ou_alice', user_id: 'on_alice', union_id: 'un_alice' },
        }]
      : []),
  ];
  const text = [
    ...(input.mentionsBot ? ['@_user_1'] : []),
    ...(input.mentionsHuman ? ['@_user_2'] : []),
    input.text ?? 'help',
  ].join(' ');
  return {
    header: {
      event_type: 'im.message.receive_v1',
      token: 'verify',
      tenant_key: 'tenant-1',
      app_id: 'app-1',
      event_id: 'event-1',
    },
    event: {
      sender: {
        sender_id: { open_id: input.senderOpenId ?? 'ou_sender' },
        sender_type: input.senderType ?? 'user',
      },
      message: {
        message_id: input.messageId ?? 'om_1',
        chat_id: 'oc_1',
        chat_type: input.chatType,
        message_type: input.file ? 'file' : input.image ? 'image' : input.voice ? 'audio' : 'text',
        content: input.file
          ? JSON.stringify({ file_key: input.file.key, file_name: input.file.name })
          : input.image
            ? JSON.stringify({ image_key: input.image.key })
            : input.voice
              ? JSON.stringify({ file_key: input.voice.key, duration: input.voice.durationMs })
              : JSON.stringify({ text }),
        create_time: '1700000000000',
        ...(input.rootId === null ? {} : { root_id: input.rootId ?? 'om_root' }),
        ...(input.parentId === null ? {} : { parent_id: input.parentId ?? 'om_parent' }),
        ...(input.threadId === null ? {} : input.threadId ? { thread_id: input.threadId } : {}),
        mentions,
      },
    },
  };
}

/**
 * Await a condition by yielding the event loop. The budget only exists to turn a
 * genuine hang into a readable failure — it is deliberately far larger than the
 * work being awaited, because `node --test` runs files in parallel and a tight
 * wall-clock deadline fails on CPU contention rather than on real regressions.
 */
async function waitUntil(
  condition: () => boolean,
  label: string,
  budgetMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(condition(), label);
}

async function runWebhook(body: unknown, options: {
  engineRun?: (input: unknown) => Promise<unknown>;
  serializer?: ChatMessageSerializer;
  waitForIdle?: boolean;
  /**
   * A fixed identity, or one resolved per Lark open ID. The per-ID form models
   * a room with several people in it, which is the only way to show that a
   * turn runs with its own sender's authority rather than the room's.
   */
  identity?: LarkTestIdentity | ((openId: string) => LarkTestIdentity);
  /** Model a first-time user: identity resolution finds nobody. */
  unknownUser?: boolean;
  /** What `prepareLarkLogin` reports for that unknown user. */
  pendingLogin?: Record<string, unknown> | null;
  /** Whether first-touch bootstrap succeeded (workspace bound + directory ok). */
  bootstrapped?: boolean;
  /** Company installation resolved independently of a speaker's user identity. */
  tenantCompanyId?: string | null;
  /** Simulate the tenant binding store being unavailable at admission. */
  tenantCompanyLookupFails?: boolean;
  /** Whether Lark OAuth is configured on this deployment. */
  oauthConfigured?: boolean;
  appBaseUrl?: string;
  /** Whether the resolved member already has a live cloud-Pi session. */
  activePiSession?: boolean;
  /** Active memberships after the saved Lark department context changed. */
  changedDepartmentMemberships?: string[];
  /** Number of user-owned Lark connections revoked by an auth command. */
  larkConnectionCount?: number;
  setupAdapter?: (adapter: LarkChannelAdapter) => void;
  /** Background document indexing. Ships 'off'. */
  documentIndexing?: 'on' | 'off';
  /** Observe the transcript write / ingestion enqueue ordering. */
  onRetain?: () => void;
  onEnqueue?: () => void;
  knowledgeReviewService?: {
    isKnowledgeReviewAction(cardEvent: unknown): boolean;
    handle(cardEvent: unknown, actor: unknown): Promise<{ responseBody: Record<string, unknown> }>;
  };
  dataExportCardHandler?: {
    handle(cardEvent: unknown, actor: unknown): Promise<{ handled: boolean; responseBody?: unknown }>;
  };
  acceptReceipt?: () => Promise<{
    ok: boolean;
    value?: { receiptId: string; isNew: boolean };
    error?: Error;
  }>;
  enqueueReceipt?: (receiptId: string) => Promise<string>;
  markQueuedReceipt?: (receiptId: string, queueJobId: string) => Promise<{
    ok: boolean;
    error?: Error;
  }>;
  processQueued?: boolean;
  /**
   * Untagged attachment policy. Group text retention is unconditional.
   */
  untaggedPolicy?: {
    LARK_UNTAGGED_GROUP_ATTACHMENTS: 'ignore' | 'process';
  };
  /** Per-company control rows layered over the deployment policy. */
  companyControls?: Array<{ controlKey: string; value: string }>;
  /** Per-group reply mode loaded before the receipt enters the async lane. */
  groupReplyMode?: 'threaded' | 'inline';
  /** Durable canonical conversation keys already owned by Divo. */
  ownedThreadKeys?: Set<string>;
  ownershipReadFails?: boolean;
  ownershipWriteFails?: boolean;
  /** Parent lookup result for quote context. */
  parentMessage?: Awaited<ReturnType<NonNullable<LarkWebhookDeps['fetchParentMessage']>>>;
  /** Enable and observe group-mode writes. */
  groupModeStore?: boolean;
  /** Delivery outbox, consulted before the agent runs. */
  channelDeliveryRepo?: unknown;
  /** Pending same-lane receipts available for rapid-message batching. */
  batchCandidates?: Array<{
    receiptId: string;
    messageId: string;
    payload: Record<string, unknown>;
    acceptedAt: Date;
  }>;
  /** Optional busy-lane notice state. */
  busyNotices?: BusyLaneNotices;
  /** Voice-note bytes downloaded from Lark. */
  voiceFileClient?: LarkWebhookDeps['voiceFileClient'];
  /** Speech-to-text provider used for voice notes. */
  voiceTranscriber?: LarkWebhookDeps['voiceTranscriber'];
  /** Previously cached transcript for a retried Lark event. */
  cachedVoiceTranscript?: string | null;
  voiceCacheReadFails?: boolean;
  voiceCacheWriteFails?: boolean;
} = {}) {
  const order: string[] = [];
  const retainedMessages: Array<Record<string, unknown>> = [];
  const ingestionJobs: Array<Record<string, unknown>> = [];
  const appendedTurns: Array<Record<string, unknown>> = [];
  const clearedHistoryKeys: string[] = [];
  const clearedRoomChatIds: string[] = [];
  const clearedRoomContexts: string[] = [];
  const acceptedPayloads: unknown[] = [];
  const acceptedLaneKeys: string[] = [];
  const acceptedCompanyIds: string[] = [];
  const engineInputs: unknown[] = [];
  const pendingAttachmentInputs: unknown[] = [];
  const piSessionContexts: unknown[] = [];
  const serializerKeys: string[] = [];
  const identityLookups: Array<{ openId: string; tenantKey: string }> = [];
  const invalidatedIdentities: string[] = [];
  const revokedLarkUsers: Array<{ companyId: string; userId: string }> = [];
  const departmentPreferenceUpdates: unknown[] = [];
  const completedBatchReceipts: string[] = [];
  const groupModeUpdates: unknown[] = [];
  const background: Promise<void>[] = [];
  const logEvents: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const cacheWrites: Array<{ key: string; value: string; ttlSeconds: number }> = [];
  const ownedThreadKeys = options.ownedThreadKeys ?? new Set<string>();
  const runtimeConversation = {
    findUnique: async (input: any) => {
      if (options.ownershipReadFails) throw new Error('ownership read unavailable');
      const key = input.where.companyId_channel_channelConversationKey.channelConversationKey;
      return ownedThreadKeys.has(key)
        ? { refsJson: { divoOwnedThread: true } }
        : null;
    },
    upsert: async (input: any) => {
      const key = input.where.companyId_channel_channelConversationKey.channelConversationKey;
      const refs = input.create?.refsJson ?? input.update?.refsJson;
      if (refs?.divoOwnedThread === true && options.ownershipWriteFails) {
        throw new Error('ownership write unavailable');
      }
      if (refs?.divoOwnedThread === true) ownedThreadKeys.add(key);
      return {};
    },
  };
  let status = 200;
  let responseBody: unknown;
  const createLogger = (bindings: Record<string, unknown> = {}): Logger => ({
    info: (event, fields) => logEvents.push({ event, fields: { ...bindings, ...fields } }),
    warn: (event, fields) => logEvents.push({ event, fields: { ...bindings, ...fields } }),
    error: (event, fields) => logEvents.push({ event, fields: { ...bindings, ...fields } }),
    debug: (event, fields) => logEvents.push({ event, fields: { ...bindings, ...fields } }),
    child: context => createLogger({ ...bindings, ...context }),
  });
  const logger = createLogger();

  const env = {
    LARK_APP_ID: 'app',
    LARK_APP_SECRET: 'secret',
    LARK_BOT_NAME: 'Divo',
    LARK_VERIFICATION_TOKEN: 'verify',
    LARK_UNTAGGED_GROUP_ATTACHMENTS: 'ignore',
    // Matches the shipped default: documents are read for the turn, not indexed.
    LARK_DOCUMENT_INDEXING: options.documentIndexing ?? 'off',
    ...(options.untaggedPolicy ?? {}),
  } as any;
  const adapter = new LarkChannelAdapter({ env, logger: noopLogger, botOpenId: 'ou_bot' });
  captureOutbound(adapter);
  options.setupAdapter?.(adapter);
  let queuedReceiptId: string | undefined;
  const routeDeps = {
    adapter,
    piRuntime: {
      ...(options.activePiSession !== undefined
        ? {
            hasActiveSession: async (context: unknown) => {
              piSessionContexts.push(context);
              return options.activePiSession!;
            },
          }
        : {}),
      run: async (input: unknown) => {
        order.push('engine');
        engineInputs.push(input);
        if (options.engineRun) {
          const result = await options.engineRun(input) as any;
          if (result?.ok === false) throw result.error;
          return {
            text: result?.value?.finalReply?.text ?? result?.text ?? 'done',
            ...(result?.actions ? { actions: result.actions } : {}),
          };
        }
        return { text: 'done' };
      },
      stagePendingAttachments: async (input: unknown) => {
        order.push('stage-pending');
        pendingAttachmentInputs.push(input);
      },
    } as any,
    channelIdentityRepo: {
      resolveByLarkTenantIdentity: async (openId: string, tenantKey: string) => {
        identityLookups.push({ openId, tenantKey });
        const resolved = typeof options.identity === 'function'
          ? options.identity(openId)
          : options.identity;
        if (options.unknownUser) return ok(null);
        return ok(resolved ?? {
          userId: 'user-1',
          companyId: 'company-1',
          aiRole: 'MEMBER',
          channel: 'lark',
        });
      },
      resolveLarkTenantCompanyId: async () => options.tenantCompanyLookupFails
        ? err(new Error('tenant binding store unavailable'))
        : ok(options.tenantCompanyId === undefined ? 'company-1' : options.tenantCompanyId),
      prepareLarkLogin: async () => ok(options.pendingLogin ?? null),
      invalidateIdentityCache: async (openId: string) => { invalidatedIdentities.push(openId); },
    } as any,
    conversationRepo: {
      // Only `appendTurn` is exercised here: it is how an attachment with no
      // question yet is remembered for the message that finally asks one.
      appendTurn: async (key: string, turn: Record<string, unknown>) => {
        appendedTurns.push({ key, ...turn });
        return ok({ id: 't1', ...turn });
      },
      clearHistory: async (key: string) => {
        clearedHistoryKeys.push(key);
        return ok(true);
      },
      clearChatHistories: async (chatId: string) => {
        clearedRoomChatIds.push(chatId);
        return ok(3);
      },
    } as any,
    ingressReceiptRepo: {
      accept: async (input?: {
        payload?: unknown;
        laneKey?: string;
        companyId?: string;
      }) => {
        order.push('receipt');
        acceptedPayloads.push(input?.payload);
        if (input?.laneKey) acceptedLaneKeys.push(input.laneKey);
        if (input?.companyId) acceptedCompanyIds.push(input.companyId);
        return options.acceptReceipt
          ? options.acceptReceipt()
          : { ok: true, value: { receiptId: 'receipt-1', isNew: true } };
      },
      markQueued: async (receiptId: string, queueJobId: string) => {
        order.push('link');
        return options.markQueuedReceipt
          ? options.markQueuedReceipt(receiptId, queueJobId)
          : { ok: true, value: undefined };
      },
      listBatchable: async () => ok(options.batchCandidates ?? []),
      claim: async () => ok({ outcome: 'claimed' as const, receipt: {} as any }),
      markCompleted: async (receiptId: string) => {
        completedBatchReceipts.push(receiptId);
        return ok(undefined);
      },
    } as any,
    ingressQueue: {
      enqueue: async (receiptId: string) => {
        order.push('queue');
        const queueJobId = options.enqueueReceipt
          ? await options.enqueueReceipt(receiptId)
          : `lark_ingress_${receiptId}`;
        queuedReceiptId = receiptId;
        return queueJobId;
      },
    },
    logger,
    env,
    // Two spies for the two side effects the untagged policy governs: whether
    // a message enters the room transcript, and whether its documents are
    // queued for indexing.
    chatContextService: {
      appendMessage: async (message: Record<string, unknown>) => {
        order.push('retain');
        options.onRetain?.();
        retainedMessages.push(message);
        return ok(null);
      },
      clear: async (_companyId: string, chatId: string) => {
        clearedRoomContexts.push(chatId);
        return ok(undefined);
      },
    } as any,
    ingestionQueue: {
      enqueue: async (payload: Record<string, unknown>) => {
        options.onEnqueue?.();
        ingestionJobs.push(payload);
        return 'job-1';
      },
    } as any,
    ...(options.companyControls
      || options.groupReplyMode
      || options.groupModeStore
      || options.ownedThreadKeys
      || options.ownershipReadFails
      || options.ownershipWriteFails
      ? {
          prisma: {
            adminControlState: {
              findMany: async () => options.companyControls ?? [],
              findUnique: async () => options.groupReplyMode
                ? { value: options.groupReplyMode }
                : null,
              upsert: async (input: unknown) => {
                groupModeUpdates.push(input);
                return {};
              },
            },
            runtimeConversation,
          } as any,
        }
      : {}),
    ...(options.parentMessage
      ? { fetchParentMessage: async () => options.parentMessage! }
      : {}),
    ...(options.channelDeliveryRepo
      ? { channelDeliveryRepo: options.channelDeliveryRepo as any }
      : {}),
    batchingEnabled: Boolean(options.batchCandidates),
    ...(options.busyNotices ? { busyNotices: options.busyNotices } : {}),
    ...(options.voiceFileClient ? { voiceFileClient: options.voiceFileClient } : {}),
    ...(options.voiceTranscriber ? { voiceTranscriber: options.voiceTranscriber } : {}),
    cache: {
      get: async () => options.voiceCacheReadFails
        ? err(new Error('cache read failed'))
        : ok(options.cachedVoiceTranscript ?? null),
      setNx: async () => ok(true),
      set: async (key: string, value: string, ttlSeconds: number) => {
        cacheWrites.push({ key, value, ttlSeconds });
        return options.voiceCacheWriteFails
          ? err(new Error('cache write failed'))
          : ok(true);
      },
    } as any,
    ...(options.bootstrapped
      ? {
          // Enough of the real bootstrap for it to succeed: a bound workspace,
          // a directory that agrees about the tenant, and a user it can see.
          prisma: {
            larkTenantBinding: { findFirst: async () => ({ companyId: 'company-1' }) },
            channelIdentity: { upsert: async () => ({}) },
            adminControlState: { findMany: async () => options.companyControls ?? [] },
            runtimeConversation,
          } as any,
          larkContactsClient: {
            getTenantKey: async () => 'tenant-1',
            getUser: async (openId: string) => ({
              openId, displayName: 'Alice', email: 'alice@example.com',
            }),
          } as any,
        }
      : {}),
    ...(options.changedDepartmentMemberships || options.larkConnectionCount !== undefined
      ? {
          ...(options.changedDepartmentMemberships
            ? {
                prisma: {
                  departmentMembership: {
                    findFirst: async ({ where }: any) =>
                      options.changedDepartmentMemberships!.includes(where.departmentId)
                        ? { departmentId: where.departmentId }
                        : null,
                    findMany: async ({ take }: any) =>
                      options.changedDepartmentMemberships!
                        .slice(0, take)
                        .map(departmentId => ({ departmentId })),
                  },
                  userDepartmentPreference: {
                    updateMany: async (input: unknown) => {
                      departmentPreferenceUpdates.push(input);
                      return { count: 1 };
                    },
                  },
                  runtimeConversation,
                } as any,
              }
            : {}),
          connectionRepo: {
            revokeLarkConnectionsForUser: async (companyId: string, userId: string) => {
              revokedLarkUsers.push({ companyId, userId });
              return ok(options.larkConnectionCount ?? 1);
            },
          } as any,
        }
      : {}),
    // The sign-in card points at the web app now, so the link needs no Lark
    // OAuth at all — only somewhere to send people.
    appBaseUrl: options.appBaseUrl ?? 'https://app.example',
    ...(options.oauthConfigured
      ? {
          larkOAuthService: {
            isConfigured: () => true,
            generateNonce: () => 'nonce-1',
            getAuthorizeUrl: (state: string) => `https://lark.example/authorize?state=${state}`,
          } as any,
        }
      : {}),
    serializer: options.serializer ?? {
      run: (key: string, task: (signal: AbortSignal) => Promise<void>) => {
        serializerKeys.push(key);
        order.push('enqueue');
        background.push(Promise.resolve().then(() => task(new AbortController().signal)));
      },
      runAndWait: async (key: string, task: (signal: AbortSignal) => Promise<void>) => {
        serializerKeys.push(key);
        order.push('execute');
        await task(new AbortController().signal);
      },
    } as any,
    ...(options.knowledgeReviewService
      ? { knowledgeReviewService: options.knowledgeReviewService as any }
      : {}),
    ...(options.dataExportCardHandler
      ? { dataExportCardHandler: options.dataExportCardHandler as any }
      : {}),
  } as any;
  const router = createLarkWebhookRoutes(routeDeps);

  const req = {
    method: 'POST',
    path: '/events',
    headers: {},
    body,
  } as unknown as Request;
  const res = {
    status: (value: number) => { status = value; return res; },
    json: (value: unknown) => {
      responseBody = value;
      order.push('ack');
      return res;
    },
  } as unknown as Response;
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === '/events');
  assert.ok(layer, 'events route');
  await Promise.resolve(layer.route.stack[0].handle(req, res, () => {}));
  await waitUntil(() => responseBody !== undefined, 'webhook responded');
  const processQueuedReceipt = async (): Promise<void> => {
    if (!queuedReceiptId) throw new Error('No durable receipt was queued');
    await processAcceptedLarkReceipt({
      receiptId: queuedReceiptId,
      tenantKey: 'tenant-1',
      acceptedAt: new Date('2026-07-26T00:00:00.000Z'),
      // Taken from the event rather than hardcoded: the worker refuses a
      // receipt whose stored identity disagrees with its payload, so a fixed ID
      // here would silently restrict every test to one message.
      messageId: String((body as any)?.event?.message?.message_id ?? 'om_1'),
      payload: body as Record<string, unknown>,
      ...(acceptedCompanyIds.at(-1)
        ? { companyId: acceptedCompanyIds.at(-1)! }
        : {}),
      ...(acceptedLaneKeys.at(-1) ? { laneKey: acceptedLaneKeys.at(-1)! } : {}),
    }, routeDeps);
  };
  if (queuedReceiptId && status === 200 && options.processQueued !== false) {
    await processQueuedReceipt();
  }
  if (options.serializer && options.waitForIdle !== false) {
    const serializer = options.serializer;
    await waitUntil(() => serializer.activeChats === 0, 'serializer settled');
  } else {
    await Promise.all(background);
  }
  return {
    routeDeps,
    status,
    responseBody,
    order,
    engineInputs,
    pendingAttachmentInputs,
    piSessionContexts,
    serializerKeys,
    identityLookups,
    invalidatedIdentities,
    revokedLarkUsers,
    departmentPreferenceUpdates,
    logEvents,
    retainedMessages,
    ingestionJobs,
    appendedTurns,
    clearedHistoryKeys,
    clearedRoomChatIds,
    clearedRoomContexts,
    acceptedPayloads,
    acceptedLaneKeys,
    acceptedCompanyIds,
    completedBatchReceipts,
    groupModeUpdates,
    ownedThreadKeys,
    cacheWrites,
    processQueuedReceipt,
  };
}

describe('Lark webhook admission', () => {
  it('durably accepts before ACKing and runs an exact-ID group mention', async () => {
    const ownedThreadKeys = new Set<string>();
    const result = await runWebhook(
      makeEvent({ chatType: 'group', mentionsBot: true }),
      { ownedThreadKeys },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.responseBody, { ok: true });
    // A mentioned turn is recorded in the room transcript on both sides of the
    // run, so the group keeps a coherent record of what was asked and answered.
    assert.deepEqual(
      result.order,
      ['receipt', 'queue', 'link', 'ack', 'execute', 'retain', 'engine', 'retain'],
    );
    assert.deepEqual(result.serializerKeys, [
      '["lark","runtime-user-lane","company-1","user-1"]',
    ]);
    assert.deepEqual(result.identityLookups, [{ openId: 'ou_sender', tenantKey: 'tenant-1' }]);
    assert.equal(result.engineInputs.length, 1);
    const engineInput = result.engineInputs[0] as {
      abortSignal?: AbortSignal;
      conversation: {
        replyToMessageId?: string;
        replyInThread?: boolean;
      };
      incoming: {
        replyToMessageId?: string;
        rootMessageId?: string;
      };
    };
    assert.ok(engineInput.abortSignal instanceof AbortSignal);
    assert.equal(engineInput.incoming.replyToMessageId, 'om_parent');
    assert.equal(engineInput.incoming.rootMessageId, 'om_root');
    assert.equal(engineInput.conversation.replyToMessageId, 'om_1');
    assert.equal(engineInput.conversation.replyInThread, true);
    assert.deepEqual([...ownedThreadKeys], ['oc_1:thread:om_root']);
    const correlated = result.logEvents.find(entry => entry.event === 'webhook.execution.correlated');
    assert.deepEqual(correlated?.fields, {
      route: 'lark-webhook',
      tenantKey: 'tenant-1',
      appId: 'app-1',
      larkEventId: 'event-1',
      correlationId: 'om_1-1700000000000',
      runId: 'om_1-1700000000000',
      jobId: null,
      attempt: 1,
      chatId: 'oc_1',
      messageId: 'om_1',
      threadId: null,
      rootMessageId: 'om_root',
      parentMessageId: 'om_parent',
      requesterOpenId: 'ou_sender',
      legacyLaneKey: 'lark:oc_1',
      receiptId: 'receipt-1',
      companyId: 'company-1',
      requesterUserId: 'user-1',
      departmentId: null,
      roomKey: '["lark","room","company-1","tenant-1","app-1","oc_1"]',
      // The reported lane must be the one the serializer actually ordered on,
      // otherwise lane telemetry cannot be used to diagnose ordering.
      laneKey: '["lark","runtime-user-lane","company-1","user-1"]',
      deliveryTargetKey: '["lark","delivery","company-1","tenant-1","app-1","oc_1","om_1","om_root"]',
      routingMode: 'active',
    });
    assert.equal(
      result.serializerKeys[0],
      (result.logEvents.find(entry => entry.event === 'webhook.execution.correlated')
        ?.fields['laneKey']),
      'reported lane key matches the serialized lane key',
    );
    for (const event of ['webhook.accepted', 'webhook.background.started', 'webhook.background.completed']) {
      assert.ok(result.logEvents.some(entry => entry.event === event), `${event} log`);
    }
    const accepted = result.logEvents.find(entry => entry.event === 'webhook.accepted');
    const started = result.logEvents.find(entry => entry.event === 'webhook.background.started');
    const completed = result.logEvents.find(entry => entry.event === 'webhook.background.completed');
    assert.equal(accepted?.fields['queueJobId'], 'lark_ingress_receipt-1');
    assert.equal(typeof accepted?.fields['verificationMs'], 'number');
    assert.equal(typeof accepted?.fields['ackMs'], 'number');
    assert.ok(started);
    assert.equal(typeof completed?.fields['runMs'], 'number');
  });

  it('delivers verified runtime actions on the final Lark card', async () => {
    const actions = [{
      label: 'Export all rows',
      value: JSON.stringify({
        kind: 'data_export_confirm',
        offerId: '11111111-1111-4111-8111-111111111111',
      }),
      style: 'primary',
    }];
    const result = await runWebhook(makeEvent({ chatType: 'p2p' }), {
      engineRun: async () => ({ text: 'I found more rows.', actions }),
    });

    assert.deepEqual((result.routeDeps.adapter as any).__finalActions, [actions]);
  });

  it('ACKs and passively queues an unmentioned group message without running the engine', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'group' }));
    // Retained as ambient room context under the default policy, but never run.
    assert.deepEqual(result.order, ['receipt', 'queue', 'link', 'ack', 'execute', 'retain']);
    assert.equal(result.engineInputs.length, 0);
  });

  it('continues a Divo-owned thread without mentioning it again', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      text: 'compare the margins too',
    }), {
      ownedThreadKeys: new Set(['oc_1:thread:om_root']),
    });

    assert.equal(result.engineInputs.length, 1);
    const input = result.engineInputs[0] as {
      incoming: { text: string };
      conversation: { replyInThread?: boolean };
    };
    assert.match(input.incoming.text, /compare the margins too/);
    assert.equal(input.conversation.replyInThread, true);
  });

  it('continues a Divo-owned thread when replying to another person', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      text: 'I agree with this',
    }), {
      ownedThreadKeys: new Set(['oc_1:thread:om_root']),
      parentMessage: {
        messageId: 'om_parent',
        status: 'available',
        messageType: 'text',
        text: 'Human discussion',
        senderExternalId: 'ou_alice',
        imageUrls: [],
      },
    });

    assert.equal(result.engineInputs.length, 1);
    assert.equal(result.retainedMessages.length, 2);
  });

  it('keeps an unmentioned reply in an unowned human thread ambient', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      text: 'I agree with this',
    }), {
      ownedThreadKeys: new Set(),
    });

    assert.equal(result.engineInputs.length, 0);
    assert.equal(result.retainedMessages.length, 1);
  });

  it('retries instead of silently dropping a thread when ownership cannot be read', async () => {
    let ran = false;
    await assert.rejects(
      runWebhook(makeEvent({
        chatType: 'group',
        text: 'continue the owned thread',
      }), {
        ownedThreadKeys: new Set(['oc_1:thread:om_root']),
        ownershipReadFails: true,
        engineRun: async () => {
          ran = true;
          return { text: 'must not run' };
        },
      }),
      /ownership read unavailable/,
    );
    assert.equal(ran, false);
  });

  it('persists ownership before answering and succeeds on retry', async () => {
    const ownedThreadKeys = new Set<string>();
    let runs = 0;
    const event = makeEvent({ chatType: 'group', mentionsBot: true });

    await assert.rejects(
      runWebhook(event, {
        ownedThreadKeys,
        ownershipWriteFails: true,
        engineRun: async () => {
          runs += 1;
          return { text: 'must not run' };
        },
      }),
      /ownership write unavailable/,
    );
    assert.equal(runs, 0);
    assert.deepEqual([...ownedThreadKeys], []);

    await runWebhook(event, {
      ownedThreadKeys,
      engineRun: async () => {
        runs += 1;
        return { text: 'started' };
      },
    });
    const followUp = await runWebhook(makeEvent({
      chatType: 'group',
      text: 'continue without another mention',
    }), {
      ownedThreadKeys,
      engineRun: async () => {
        runs += 1;
        return { text: 'continued' };
      },
    });

    assert.deepEqual([...ownedThreadKeys], ['oc_1:thread:om_root']);
    assert.equal(followUp.engineInputs.length, 1);
    assert.equal(runs, 2);
  });

  it('does not put an unmentioned top-level room message into thread history', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      rootId: null,
      parentId: null,
      text: 'Ambient room discussion',
    }));

    assert.equal(result.engineInputs.length, 0);
    assert.equal(result.retainedMessages.length, 1);
    assert.equal(result.appendedTurns.length, 0);
  });

  it('hydrates a bare mention from only the current native thread', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      rootId: 'om_root',
      parentId: null,
      threadId: 'omt_current',
      text: '',
    }), {
      setupAdapter: adapter => {
        adapter.listThreadMessages = async () => [{
          messageId: 'om_1',
          text: '@Divo',
          senderId: 'ou_sender',
          senderName: 'Abhishek',
          timestamp: '1700000000000',
        }, {
          messageId: 'om_prior',
          text: 'use semrush',
          senderId: 'ou_sender',
          senderName: 'Abhishek',
          timestamp: '1699999999000',
        }, {
          messageId: 'om_answer',
          text: 'Earlier HDFC answer',
          senderId: 'ou_bot',
          timestamp: '1699999998000',
        }];
      },
    });

    assert.equal(result.engineInputs.length, 1);
    const incoming = (result.engineInputs[0] as any).incoming;
    assert.equal(incoming.requiresAdjacentContext, true);
    assert.match(String(incoming.referenceContext), /Earlier HDFC answer/);
    assert.match(String(incoming.referenceContext), /use semrush/);
    assert.doesNotMatch(String(incoming.referenceContext), /@Divo/);
    assert.equal(result.appendedTurns.length, 0);
  });

  it('marks a bare mention as context-dependent when adjacent context cannot be fetched', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      rootId: 'om_root',
      parentId: null,
      text: '',
    }));

    assert.equal(result.engineInputs.length, 1);
    const incoming = (result.engineInputs[0] as any).incoming;
    assert.equal(incoming.requiresAdjacentContext, true);
    assert.equal(incoming.referenceContext, undefined);
  });

  it('ignores a stored inline override and keeps an owned group threaded', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      text: 'continue',
    }), {
      groupReplyMode: 'inline',
      ownedThreadKeys: new Set(['oc_1:thread:om_root']),
    });

    assert.equal(result.engineInputs.length, 1);
    assert.equal((result.engineInputs[0] as any).conversation.replyInThread, true);
  });

  it('fails closed when a message event has no authenticated tenant key', async () => {
    const event = makeEvent({ chatType: 'p2p' });
    delete (event.header as Record<string, unknown>)['tenant_key'];

    const result = await runWebhook(event);

    assert.deepEqual(result.order, ['ack']);
    assert.deepEqual(result.identityLookups, []);
    assert.equal(result.engineInputs.length, 0);
    assert.ok(result.logEvents.some(entry => entry.event === 'webhook.identity.tenant_missing'));
  });

  it('does not admit when the tenant binding cannot be verified', async () => {
    const result = await runWebhook(
      makeEvent({ chatType: 'group', mentionsBot: true }),
      { tenantCompanyLookupFails: true },
    );

    assert.equal(result.status, 503);
    assert.deepEqual(result.order, ['ack']);
    assert.equal(result.acceptedPayloads.length, 0);
    assert.ok(result.logEvents.some(
      entry => entry.event === 'webhook.identity.tenant_binding_lookup_failed',
    ));
  });

  it('does not execute a pending receipt after its tenant is rebound', async () => {
    const event = makeEvent({ chatType: 'group', mentionsBot: true });
    const result = await runWebhook(event, {
      processQueued: false,
      tenantCompanyId: 'company-new',
    });

    await assert.rejects(
      () => processAcceptedLarkReceipt({
        receiptId: 'receipt-old',
        tenantKey: 'tenant-1',
        companyId: 'company-old',
        messageId: 'om_1',
        payload: event,
        attempts: 1,
        acceptedAt: new Date('2026-07-26T00:00:00.000Z'),
      }, result.routeDeps),
      /company binding changed/i,
    );
    assert.equal(result.engineInputs.length, 0);
  });

  it('re-enqueues a duplicate durable receipt with the same stable identity', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'p2p' }), {
      acceptReceipt: async () => ({
        ok: true,
        value: { receiptId: 'receipt-existing', isNew: false },
      }),
      processQueued: false,
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.responseBody, { ok: true });
    assert.deepEqual(result.order, ['receipt', 'queue', 'link', 'ack']);
    assert.equal(result.engineInputs.length, 0);
    assert.ok(result.logEvents.some(entry => entry.event === 'webhook.receipt.duplicate'));
  });

  it('returns 503 before ACK when durable admission fails', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'p2p' }), {
      acceptReceipt: async () => ({
        ok: false,
        error: new Error('database unavailable'),
      }),
    });

    assert.equal(result.status, 503);
    assert.deepEqual(result.responseBody, { error: 'ingress_unavailable' });
    assert.deepEqual(result.order, ['receipt', 'ack']);
    assert.equal(result.engineInputs.length, 0);
    assert.ok(result.logEvents.some(entry => entry.event === 'webhook.receipt.failed'));
  });

  it('returns 503 when stable queue admission fails', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'p2p' }), {
      enqueueReceipt: async () => {
        throw new Error('queue unavailable');
      },
    });

    assert.equal(result.status, 503);
    assert.deepEqual(result.responseBody, { error: 'ingress_unavailable' });
    assert.deepEqual(result.order, ['receipt', 'queue', 'ack']);
    assert.equal(result.engineInputs.length, 0);
    assert.ok(result.logEvents.some(entry => entry.event === 'webhook.queue.failed'));
  });

  it('returns 503 when the durable receipt cannot record its stable queue job', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'p2p' }), {
      markQueuedReceipt: async () => ({
        ok: false,
        error: new Error('database unavailable'),
      }),
    });

    assert.equal(result.status, 503);
    assert.deepEqual(result.responseBody, { error: 'ingress_unavailable' });
    assert.deepEqual(result.order, ['receipt', 'queue', 'link', 'ack']);
    assert.equal(result.engineInputs.length, 0);
    assert.ok(
      result.logEvents.some(entry => entry.event === 'webhook.receipt.queue_link_failed'),
    );
  });

  it('passes exact human mention identities without changing requester authority', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      mentionsHuman: true,
    }));
    assert.equal(result.engineInputs.length, 1);
    const engineInput = result.engineInputs[0] as {
      incoming: { text: string };
      runContext: {
        userId: string;
        userExternalId: string;
        mentionedLarkOpenIds: string[];
      };
    };
    assert.equal(engineInput.runContext.userId, 'user-1');
    assert.equal(engineInput.runContext.userExternalId, 'ou_sender');
    assert.deepEqual(engineInput.runContext.mentionedLarkOpenIds, ['ou_alice']);
    assert.match(engineInput.incoming.text, /"openId":"ou_alice"/);
    assert.match(engineInput.incoming.text, /"userId":"on_alice"/);
    assert.match(engineInput.incoming.text, /"unionId":"un_alice"/);
    assert.match(
      engineInput.incoming.text,
      /do not change requester identity, permissions, or approval authority/,
    );
  });

  it('ignores a bot echo before ACKed work enters the serializer', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'p2p', senderType: 'bot' }));
    assert.deepEqual(result.order, ['ack']);
    assert.equal(result.engineInputs.length, 0);
  });

  it('streams cloud Pi progress through the status card before final delivery', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'p2p',
      rootId: null,
      parentId: null,
      text: 'token=must-not-render Create a report from Drive',
    }), {
      engineRun: async (input: unknown) => {
        const onProgress = (input as any).onProgress;
        await onProgress({ type: 'starting', stage: 'workspace', label: 'Checking your workspace…' });
        await onProgress({ type: 'starting', stage: 'container', label: 'Resuming your work…' });
        await onProgress({ type: 'ready' });
        await onProgress({
          type: 'tool_start',
          callId: 'call-1',
          toolName: 'divo_gateway',
          toolId: 'googleDrive',
        });
        await onProgress({
          type: 'tool_end',
          callId: 'call-1',
          toolName: 'divo_gateway',
          isError: false,
        });
        await onProgress({ type: 'writing' });
        return { text: 'Report complete' };
      },
    });

    const adapter = result.routeDeps.adapter as any;
    assert.ok(adapter.__statusUpdates.length >= 3);
    assert.equal(adapter.__outboundOrder[0], 'status');
    assert.equal(adapter.__outboundOrder.at(-1), 'final');
    assert.deepEqual(adapter.__finalReplies, ['Report complete']);

    // Status cards are published without blocking the run, so a transition that
    // is superseded before its card goes out is dropped rather than replayed.
    // What the card owes the user is therefore not every frame, but an order it
    // never walks back: it opens on "thinking" and ends on "writing".
    const RANK: Record<string, number> = { thinking: 0, working: 1, writing: 2 };
    const states = adapter.__statusUpdates.map((update: any) => update.timeline.state);
    assert.equal(states[0], 'thinking');
    assert.equal(states.at(-1), 'writing');
    for (let i = 1; i < states.length; i += 1) {
      assert.ok(
        RANK[states[i]] >= RANK[states[i - 1]],
        `status card went backwards: ${states[i - 1]} → ${states[i]}`,
      );
    }

    // The opening frame is awaited before the run starts, so it is exact.
    assert.equal(adapter.__statusUpdates[0].timeline.liveLabel, 'Getting things ready…');
    assert.doesNotMatch(
      adapter.__statusUpdates.map((update: any) => update.timeline.liveLabel).join(' '),
      /\bPi\b/,
    );

    // The ledger accumulates, so the settled last frame carries the finished
    // tool whether or not its "running" frame ever made it out.
    assert.deepEqual(adapter.__statusUpdates.at(-1).timeline.ledger, [{
      kind: 'tool',
      // The tool table's name, not a vendor guessed from the id's prefix: the
      // run used Drive, and "Google" was as close as the old regex could get.
      label: 'Google Drive',
      count: 1,
      status: 'done',
    }]);
    // A call whose arguments named nothing worth showing stays bare. The row's
    // marker already carries running/done/failed, so an invented placeholder
    // would render as "● Google — In progress" and say nothing.
    for (const update of adapter.__statusUpdates) {
      for (const row of update.timeline.ledger ?? []) {
        assert.ok(!('outcome' in row), `ledger row carried placeholder outcome: ${JSON.stringify(row)}`);
      }
    }
    assert.doesNotMatch(
      JSON.stringify(adapter.__statusUpdates),
      /token|secret|must-not-render|args|result/i,
    );
  });

  it('nests subagents under the step that spawned them, and keeps the checklist after it', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'p2p',
      rootId: null,
      parentId: null,
      text: 'Build the Monday report',
    }), {
      engineRun: async (input: unknown) => {
        const onProgress = (input as any).onProgress;
        await onProgress({ type: 'tool_start', callId: 'call-todo', toolName: 'divo_todos' });
        await onProgress({
          type: 'tool_end',
          callId: 'call-todo',
          toolName: 'divo_todos',
          isError: false,
          todos: [
            { title: 'Pull the deals', status: 'done' },
            { title: 'Draft the summary', status: 'running' },
            { title: 'Post it', status: 'pending' },
          ],
        });
        await onProgress({ type: 'tool_start', callId: 'call-sub', toolName: 'divo_subagents' });
        await onProgress({
          type: 'tool_progress',
          callId: 'call-sub',
          toolName: 'divo_subagents',
          children: [
            { label: 'scout', status: 'running', detail: 'reading the export' },
            { label: 'reviewer', status: 'done', detail: 'checked totals' },
          ],
        });
        return { text: 'Report complete' };
      },
    });

    const adapter = result.routeDeps.adapter as any;
    const last = adapter.__statusUpdates.at(-1).timeline;

    const subagentRow = last.ledger.find((row: any) => row.label === 'Subagents');
    assert.deepEqual(subagentRow.children, [
      { label: 'scout', count: 1, status: 'running', outcome: 'reading the export' },
      { label: 'reviewer', count: 1, status: 'done', outcome: 'checked totals' },
    ]);

    // The checklist belongs to the run, not to the call that declared it, so it
    // must outlive that tool call — which ended two events ago.
    assert.equal(last.declared.done, 1);
    assert.equal(last.declared.total, 3);
    assert.equal(last.declared.current, 'Draft the summary');
    assert.equal(last.declared.items.length, 3);
  });

  it('names an unmapped tool instead of collapsing it to "Tool"', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'p2p',
      rootId: null,
      parentId: null,
      text: 'Check something',
    }), {
      engineRun: async (input: unknown) => {
        await (input as any).onProgress({
          type: 'tool_start', callId: 'call-x', toolName: 'divo_skill_view',
        });
        return { text: 'done' };
      },
    });

    const adapter = result.routeDeps.adapter as any;
    const row = adapter.__statusUpdates.at(-1).timeline.ledger[0];
    // Not "Skill view" — that was the humanizer spelling out an internal tool
    // id, with the space in it, on a card a customer reads.
    assert.equal(row.label, 'Skill');
  });

  // A thirteen-minute run whose card only ever shows tool names reads as broken,
  // however well it is going. What the model says between its calls is the only
  // part of that card written for a person.
  it('interleaves the model talking with the steps it took, and says what each was about', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'p2p',
      rootId: null,
      parentId: null,
      text: 'Audit the Airtable bases',
    }), {
      engineRun: async (input: unknown) => {
        const onProgress = (input as any).onProgress;
        await onProgress({ type: 'say', index: 0, text: 'Let me see which bases you can reach.' });
        await onProgress({
          type: 'tool_start', callId: 'c1', toolName: 'bash', detail: 'airtable list-bases',
        });
        await onProgress({ type: 'tool_end', callId: 'c1', toolName: 'bash', isError: false });
        await onProgress({ type: 'say', index: 0, text: 'Found 3. Profiling the largest.' });
        await onProgress({
          type: 'tool_start', callId: 'c2', toolName: 'read', detail: 'bases.json',
        });
        return { text: 'Audit complete' };
      },
    });

    const adapter = result.routeDeps.adapter as any;
    assert.deepEqual(
      adapter.__statusUpdates.at(-1).timeline.ledger.map((row: any) =>
        [row.kind, row.label, row.outcome ?? ''].join('|')),
      [
        'say|Let me see which bases you can reach.|',
        'tool|Terminal|airtable list-bases',
        'say|Found 3. Profiling the largest.|',
        'tool|Files|bases.json',
      ],
    );

    // The final card edits the status card in place, so without this the whole
    // log is destroyed at the moment the answer lands.
    const trace = adapter.__finalTraces[0] as string;
    assert.match(trace, /airtable list-bases/);
    assert.match(trace, /Let me see which bases you can reach\./);
  });

  // A block index restarts at zero in every new assistant message, so keying on
  // it alone makes the second thing the model says overwrite the first.
  it('keeps a second sentence after a tool call instead of overwriting the first', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'p2p', rootId: null, parentId: null, text: 'Do the thing',
    }), {
      engineRun: async (input: unknown) => {
        const onProgress = (input as any).onProgress;
        await onProgress({ type: 'say', index: 0, text: 'First I will look.' });
        await onProgress({ type: 'tool_start', callId: 'c1', toolName: 'bash' });
        await onProgress({ type: 'say', index: 0, text: 'Now I will write it up.' });
        return { text: 'done' };
      },
    });

    const adapter = result.routeDeps.adapter as any;
    assert.deepEqual(
      adapter.__statusUpdates.at(-1).timeline.ledger
        .filter((row: any) => row.kind === 'say')
        .map((row: any) => row.label),
      ['First I will look.', 'Now I will write it up.'],
    );
  });

  it('delivers a harness-visible Pi failure before rethrowing it', async () => {
    const finalReplies: string[] = [];
    const persisted: unknown[] = [];
    const failure = new LarkPiRuntimeError(
      'capacity_full',
      'PI is busy. Please retry.',
    );
    const adapter = {
      registerAbortController() {},
      cleanupAbortController() {},
      sendStatus: async (conversation: any) => ok({
        channel: 'lark',
        messageId: 'om_status',
        correlationId: conversation.correlationId,
      }),
      editStatus: async (handle: any) => ok(handle),
      sendFinalReply: async (_conversation: unknown, reply: { text: string }) => {
        finalReplies.push(reply.text);
        return ok({ channel: 'lark', messageId: 'om_status' });
      },
    };

    await assert.rejects(
      runPiAndDeliver({
        incoming: {
          channel: 'lark',
          messageId: 'om_1',
          chatId: 'oc_1',
          chatType: 'p2p',
          userExternalId: 'ou_sender',
          text: 'Do the work',
          attachments: [],
          timestamp: new Date().toISOString(),
          traceId: 'trace-1',
          mentions: [],
          mentionsSelf: true,
          raw: {},
        } as any,
        runContext: {
          companyId: 'company-1',
          userId: 'user-1',
          companyRole: 'MEMBER',
          channel: 'lark',
        } as any,
        conversation: {
          channel: 'lark',
          chatId: 'oc_1',
          correlationId: 'trace-1',
        } as any,
        deps: {
          adapter: adapter as any,
          piRuntime: {
            run: async () => { throw failure; },
          },
          conversationRepo: {
            appendTurn: async (...args: unknown[]) => {
              persisted.push(args);
              return ok({});
            },
          } as any,
        },
        log: noopLogger,
        rethrowRuntimeFailureAfterDelivery: true,
      }),
      error => error === failure,
    );
    assert.deepEqual(finalReplies, ['Divo is busy. Please retry.']);
    assert.equal(persisted.length, 2);
    assert.equal((persisted[0] as any[])[1].role, 'user');
    assert.equal((persisted[1] as any[])[1].role, 'assistant');
    assert.equal((persisted[0] as any[])[3].dedupeKey, 'lark:om_1:user');
    assert.equal((persisted[1] as any[])[3].dedupeKey, 'lark:om_1:assistant');
  });

  it('delivers an explicit Pi failure and lets the next same-chat message run', async () => {
    const serializer = new ChatMessageSerializer({ timeoutMs: 1_000 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let calls = 0;
    let rejectFirst: ((reason: Error) => void) | undefined;
    const engineRun = async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise<never>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return ok({ finalReply: { kind: 'final', text: 'done', format: 'text' } });
    };

    try {
      const first = await runWebhook(makeEvent({ chatType: 'p2p' }), {
        serializer,
        engineRun,
        waitForIdle: false,
        processQueued: false,
      });
      const firstProcessing = first.processQueuedReceipt().catch(error => error);
      await waitUntil(() => !!rejectFirst, 'first engine run started');
      const second = await runWebhook(makeEvent({ chatType: 'p2p' }), {
        serializer,
        engineRun,
        waitForIdle: false,
        processQueued: false,
      });
      const secondProcessing = second.processQueuedReceipt();
      assert.equal(serializer.activeChats, 1, 'successor is queued behind the failed run');
      rejectFirst(new Error('engine unavailable'));
      const firstError = await firstProcessing;
      await secondProcessing;

      await waitUntil(() => serializer.activeChats === 0, 'queued successor settled');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(
        first.logEvents.filter(entry => entry.event === 'webhook.pi.failed').length,
        1,
      );
      assert.equal(first.logEvents.some(entry => entry.event === 'webhook.background.failed'), false);
      assert.equal(second.logEvents.some(entry => entry.event === 'webhook.background.completed'), true);
      assert.equal(firstError, undefined);
      assert.match(
        String((first.routeDeps.adapter as any).__finalReplies[0]),
        /No fallback agent was run/i,
      );
      assert.equal(calls, 2);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
describe('Lark webhook card authorization', () => {
  it('passes the authenticated tenant-scoped actor to memory review', async () => {
    let receivedActor: any;
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_admin', name: 'Admin' },
        action: { value: { action: 'memory_review_approve', memoryId: 'mem-1' } },
      },
    }, {
      identity: {
        userId: 'admin-1',
        companyId: 'company-1',
        aiRole: 'COMPANY_ADMIN',
        channel: 'lark',
      },
      knowledgeReviewService: {
        isKnowledgeReviewAction: () => true,
        handle: async (_event, actor) => {
          receivedActor = actor;
          return { responseBody: { ok: true } };
        },
      },
    });

    assert.deepEqual(result.responseBody, { ok: true });
    assert.deepEqual(receivedActor, {
      tenantKey: 'tenant-1',
      openId: 'ou_admin',
      userId: 'admin-1',
      companyId: 'company-1',
      aiRole: 'COMPANY_ADMIN',
      displayName: 'Admin',
    });
  });

  it('confirms an opaque export offer and format with the signed actor and signed chat context', async () => {
    const confirmations: unknown[] = [];
    const handler = new LarkDataExportCardHandler({
      confirmForActor: async input => {
        confirmations.push(input);
        return { exportJobId: 'job-1', disposition: 'queued' };
      },
    } as any, noopLogger);
    const offerId = '11111111-1111-4111-8111-111111111111';
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_admin', name: 'Admin' },
        context: { open_chat_id: 'oc_export', open_message_id: 'om_export_card' },
        action: {
          value: {
            action: JSON.stringify({ kind: 'data_export_confirm', offerId, format: 'csv' }),
          },
        },
      },
    }, {
      identity: {
        userId: 'admin-1',
        companyId: 'company-1',
        aiRole: 'COMPANY_ADMIN',
        channel: 'lark',
      },
      dataExportCardHandler: handler,
    });

    assert.deepEqual(confirmations, [{
      offerId,
      companyId: 'company-1',
      userId: 'admin-1',
      chatId: 'oc_export',
      progressMessageId: 'om_export_card',
      destinationFormat: 'csv',
    }]);
    assert.equal((result.responseBody as any).toast.type, 'success');
    assert.equal('card' in (result.responseBody as any), false);
  });

  it('replaces the export card with eligible Google account choices before queueing', async () => {
    const handler = new LarkDataExportCardHandler({
      confirmForActor: async () => ({
        disposition: 'choose_destination',
        connections: [
          {
            connectionId: '33333333-3333-4333-8333-333333333333',
            label: 'Work Google',
            accountEmail: 'member@company.test',
          },
          {
            connectionId: '44444444-4444-4444-8444-444444444444',
            label: 'Personal Google',
            accountEmail: 'member@gmail.com',
          },
        ],
      }),
    } as any, noopLogger);
    const offerId = '11111111-1111-4111-8111-111111111111';
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_admin' },
        context: { open_chat_id: 'oc_export', open_message_id: 'om_export_card' },
        action: {
          value: {
            action: JSON.stringify({ kind: 'data_export_confirm', offerId, format: 'csv' }),
          },
        },
      },
    }, { dataExportCardHandler: handler });

    const card = (result.responseBody as any).card.data;
    assert.equal(card.header.title.content, 'Choose a Google account');
    assert.equal(card.body.elements[1].columns.length, 2);
    const callback = JSON.parse(card.body.elements[1].columns[1].elements[0].behaviors[0].value.action);
    assert.deepEqual(callback, {
      kind: 'data_export_confirm',
      offerId,
      format: 'csv',
      connectionId: '44444444-4444-4444-8444-444444444444',
    });
  });

  it('replaces the same export card with Google OAuth and a typed direct continuation', async () => {
    let authorizationInput: unknown;
    const handler = new LarkDataExportCardHandler({
      confirmForActor: async () => ({
        disposition: 'connect_required',
        replyInThread: true,
        replyToMessageId: 'om_thread_root',
      }),
    } as any, noopLogger, {
      issue: async input => {
        authorizationInput = input;
        return {
          outcome: 'issued',
          intentId: 'intent-1',
          authorizeUrl: 'https://accounts.google.test/auth?state=opaque',
          expiresAt: new Date('2026-08-02T06:00:00.000Z'),
          correlationId: 'correlation-1',
        };
      },
    } as any);
    const offerId = '11111111-1111-4111-8111-111111111111';
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_admin' },
        context: { open_chat_id: 'oc_export', open_message_id: 'om_export_card' },
        action: {
          value: {
            action: JSON.stringify({ kind: 'data_export_confirm', offerId, format: 'csv' }),
          },
        },
      },
    }, {
      identity: {
        userId: 'admin-1',
        companyId: 'company-1',
        aiRole: 'COMPANY_ADMIN',
        channel: 'lark',
      },
      dataExportCardHandler: handler,
    });

    assert.deepEqual(authorizationInput, {
      companyId: 'company-1',
      userId: 'admin-1',
      larkOpenId: 'ou_admin',
      larkTenantKey: 'tenant-1',
      chatId: 'oc_export',
      chatType: 'group',
      originalMessageId: 'om_export_card',
      rootMessageId: 'om_thread_root',
      replyInThread: true,
      groupReplyMode: 'threaded',
      originalRequest: 'Resume the confirmed data export after Google is connected.',
      requestedToolIds: ['dataExport'],
      continuationPayload: {
        kind: 'data_export_confirmation',
        offerId,
        progressMessageId: 'om_export_card',
        format: 'csv',
      },
    });
    const card = (result.responseBody as any).card.data;
    assert.equal(card.header.title.content, 'Connect Google Workspace');
    assert.equal(
      card.body.elements[1].behaviors[0].default_url,
      'https://accounts.google.test/auth?state=opaque',
    );
  });

  it('passes only the signed actor context and selected Google connection to confirmation', async () => {
    let confirmation: unknown;
    const handler = new LarkDataExportCardHandler({
      confirmForActor: async input => {
        confirmation = input;
        return { exportJobId: 'job-1', disposition: 'queued' };
      },
    } as any, noopLogger);
    const offerId = '11111111-1111-4111-8111-111111111111';
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_admin' },
        context: { open_chat_id: 'oc_export', open_message_id: 'om_export_card' },
        action: {
          value: {
            action: JSON.stringify({
              kind: 'data_export_confirm',
              offerId,
              format: 'google_sheet',
              connectionId: '33333333-3333-4333-8333-333333333333',
            }),
          },
        },
      },
    }, {
      identity: {
        userId: 'admin-1',
        companyId: 'company-1',
        aiRole: 'COMPANY_ADMIN',
        channel: 'lark',
      },
      dataExportCardHandler: handler,
    });

    assert.deepEqual(confirmation, {
      offerId,
      companyId: 'company-1',
      userId: 'admin-1',
      chatId: 'oc_export',
      progressMessageId: 'om_export_card',
      destinationFormat: 'google_sheet',
      destinationConnectionId: '33333333-3333-4333-8333-333333333333',
    });
    assert.equal((result.responseBody as any).toast.type, 'success');
  });

  it('keeps the export button when confirmation is still in progress', async () => {
    const handler = new LarkDataExportCardHandler({
      confirmForActor: async () => ({ exportJobId: 'job-1', disposition: 'in_progress' }),
    } as any, noopLogger);
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_admin' },
        context: { open_chat_id: 'oc_export', open_message_id: 'om_export_card' },
        action: {
          value: {
            action: JSON.stringify({
              kind: 'data_export_confirm',
              offerId: '11111111-1111-4111-8111-111111111111',
            }),
          },
        },
      },
    }, { dataExportCardHandler: handler });

    assert.equal((result.responseBody as any).toast.type, 'info');
    assert.equal('card' in (result.responseBody as any), false);
  });

  it('does not claim an already-confirmed export is tracking on this card', async () => {
    const handler = new LarkDataExportCardHandler({
      confirmForActor: async () => ({
        exportJobId: 'job-existing',
        disposition: 'already_confirmed',
      }),
    } as any, noopLogger);
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_admin' },
        context: { open_chat_id: 'oc_export', open_message_id: 'om_export_card' },
        action: {
          value: {
            action: JSON.stringify({
              kind: 'data_export_confirm',
              offerId: '11111111-1111-4111-8111-111111111111',
            }),
          },
        },
      },
    }, { dataExportCardHandler: handler });

    assert.match((result.responseBody as any).toast.content, /existing job/i);
    assert.match((result.responseBody as any).toast.content, /original Divo conversation/i);
    assert.doesNotMatch((result.responseBody as any).toast.content, /this card/i);
    assert.equal('card' in (result.responseBody as any), false);
  });

  it('does not confirm when Lark omits the signed source-card message ID', async () => {
    let confirmations = 0;
    const handler = new LarkDataExportCardHandler({
      confirmForActor: async () => {
        confirmations++;
        return { exportJobId: 'job-1', disposition: 'queued' };
      },
    } as any, noopLogger);
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_admin' },
        context: { open_chat_id: 'oc_export' },
        action: {
          value: {
            action: JSON.stringify({
              kind: 'data_export_confirm',
              offerId: '11111111-1111-4111-8111-111111111111',
            }),
          },
        },
      },
    }, { dataExportCardHandler: handler });

    assert.equal(confirmations, 0);
    assert.equal((result.responseBody as any).toast.type, 'error');
    assert.match((result.responseBody as any).toast.content, /which card/i);
  });

  it('rejects a tampered export action without calling confirmation', async () => {
    let confirmations = 0;
    const handler = new LarkDataExportCardHandler({
      confirmForActor: async () => {
        confirmations++;
        return { exportJobId: 'job-1', disposition: 'queued' };
      },
    } as any, noopLogger);
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_admin' },
        context: { open_chat_id: 'oc_export' },
        action: {
          value: {
            action: JSON.stringify({
              kind: 'data_export_confirm',
              offerId: '11111111-1111-4111-8111-111111111111',
              companyId: 'company-attacker',
            }),
          },
        },
      },
    }, { dataExportCardHandler: handler });

    assert.equal(confirmations, 0);
    assert.equal((result.responseBody as any).toast.type, 'error');
  });

  it('rejects an unsupported export format without calling confirmation', async () => {
    let confirmations = 0;
    const handler = new LarkDataExportCardHandler({
      confirmForActor: async () => {
        confirmations += 1;
        return { exportJobId: 'job-1', disposition: 'queued' };
      },
    } as any, noopLogger);
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_admin' },
        context: { open_chat_id: 'oc_export', open_message_id: 'om_export_card' },
        action: {
          value: {
            action: JSON.stringify({
              kind: 'data_export_confirm',
              offerId: '11111111-1111-4111-8111-111111111111',
              format: 'xlsx',
            }),
          },
        },
      },
    }, { dataExportCardHandler: handler });

    assert.equal(confirmations, 0);
    assert.equal((result.responseBody as any).toast.type, 'error');
  });


  it('treats old group-mode card actions as informational', async () => {
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
        app_id: 'app-1',
      },
      event: {
        operator: { open_id: 'ou_admin', name: 'Admin' },
        context: { open_chat_id: 'oc_1' },
        action: { value: { action: 'set_group_mode', mode: 'inline' } },
      },
    }, {
      identity: {
        userId: 'admin-1',
        companyId: 'company-1',
        aiRole: 'COMPANY_ADMIN',
        channel: 'lark',
      },
      groupModeStore: true,
    });

    assert.equal(result.groupModeUpdates.length, 0);
    assert.deepEqual(result.responseBody, {
      toast: { type: 'info', content: 'Divo always replies in threads inside groups.' },
    });
  });

  it('does not let a stale group-mode card action change settings', async () => {
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
        app_id: 'app-1',
      },
      event: {
        operator: { open_id: 'ou_member' },
        context: { open_chat_id: 'oc_1' },
        action: { value: { action: 'set_group_mode', mode: 'inline' } },
      },
    }, { groupModeStore: true });

    assert.deepEqual(result.groupModeUpdates, []);
    assert.deepEqual(result.responseBody, {
      toast: { type: 'info', content: 'Divo always replies in threads inside groups.' },
    });
  });
});

/**
 * Run `body` with every outbound HTTP call refused.
 *
 * Attachment preparation reaches Lark for a tenant token and the image bytes.
 * These tests are about whether preparation is *entered*, not whether the
 * download succeeds, and a unit test must not depend on the network. Refusing
 * the fetch exercises the same path: a failed download is non-fatal, so the
 * attachment still gets a prepared context — with an error recorded on it.
 */
async function withStubbedFetch<T>(
  body: (calls: string[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return new Response('{}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** Attachment contexts as they were handed to the room transcript. */
function attachmentsOf(message: unknown): Record<string, unknown>[] {
  const attachments = (message as Record<string, unknown> | undefined)?.['attachments'];
  return Array.isArray(attachments) ? attachments as Record<string, unknown>[] : [];
}

/**
 * Filenames Divo tried to pull out of Lark.
 *
 * Observed through the download log rather than through `globalThis.fetch`:
 * the Lark SDK is built on axios, so a stubbed `fetch` never sees these calls
 * and asserting on it would pass no matter what the code did. Every attempt
 * that does not succeed logs here, and in a unit test none of them succeed.
 */
function attemptedDownloads(
  logEvents: Array<{ event: string; fields: Record<string, unknown> }>,
): string[] {
  return logEvents
    .filter(entry => entry.event.startsWith('webhook.attachment.download.'))
    .map(entry => String(entry.fields['fileName']));
}

/** Plain-text notices Divo sent to the chat, in order. */
function noticesSent(adapter: any): string[] {
  return adapter.__sentTexts ?? [];
}

/** Record every unreserved send and card so a first-touch branch is observable. */
function captureOutbound(adapter: any): void {
  adapter.__sentTexts = [];
  adapter.__sentTextDeliveries = [];
  adapter.__sentCards = [];
  adapter.__sentCardDeliveries = [];
  adapter.__finalReplies = [];
  adapter.__finalActions = [];
  adapter.__finalTraces = [];
  adapter.__statusUpdates = [];
  adapter.__outboundOrder = [];
  adapter.sendStatus = async (_conversation: unknown, update: unknown) => {
    adapter.__statusUpdates.push(update);
    adapter.__outboundOrder.push('status');
    return ok({
      channel: 'lark',
      messageId: 'om_status',
      correlationId: 'om_1-1700000000000',
    });
  };
  adapter.editStatus = async (handle: unknown, update: unknown) => {
    adapter.__statusUpdates.push(update);
    adapter.__outboundOrder.push('status');
    return ok(handle);
  };
  adapter.sendToChatId = async (
    _chatId: string,
    text: string,
    replyToMessageId?: string,
    _idempotencyKey?: string,
    replyInThread?: boolean,
  ) => {
    adapter.__sentTexts.push(text);
    adapter.__sentTextDeliveries.push({ replyToMessageId, replyInThread });
    return ok('om_notice');
  };
  adapter.sendCardToChat = async (
    _chatId: string,
    card: string,
    replyToMessageId?: string,
    replyInThread?: boolean,
  ) => {
    adapter.__sentCards.push(card);
    adapter.__sentCardDeliveries.push({ replyToMessageId, replyInThread });
    return ok({ messageId: 'om_card' });
  };
  adapter.sendFinalReply = async (
    _conversation: unknown,
    reply: { text: string; executionTrace?: string; actions?: unknown },
  ) => {
    adapter.__finalReplies.push(reply.text);
    adapter.__finalTraces.push(reply.executionTrace);
    adapter.__finalActions.push(reply.actions);
    adapter.__outboundOrder.push('final');
    return ok({ messageId: 'om_reply' });
  };
}

describe('Lark conversation commands', () => {
  it('rejects the retired inline group mode', async () => {
    let adapter: any;
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: '/group-mode inline',
    }), {
      identity: {
        userId: 'admin-1',
        companyId: 'company-1',
        aiRole: 'COMPANY_ADMIN',
        channel: 'lark',
      },
      groupModeStore: true,
      setupAdapter: value => { adapter = value; captureOutbound(value); },
    });

    assert.equal(result.groupModeUpdates.length, 0);
    assert.match(adapter.__finalReplies[0], /always replies in threads/i);
    assert.match(adapter.__finalReplies[0], /no longer available/i);
  });

  it('shows the permanent threaded group behavior', async () => {
    let adapter: any;
    await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: '/group-settings',
    }), {
      identity: {
        userId: 'admin-1',
        companyId: 'company-1',
        aiRole: 'COMPANY_ADMIN',
        channel: 'lark',
      },
      groupReplyMode: 'threaded',
      setupAdapter: value => { adapter = value; captureOutbound(value); },
    });

    const envelope = JSON.parse(adapter.__sentCards[0]);
    const card = JSON.parse(envelope.card);
    assert.doesNotMatch(JSON.stringify(card), /set_group_mode/);
    assert.match(JSON.stringify(card), /Threaded replies are always on/);
    assert.doesNotMatch(JSON.stringify(card), /Inline/);
    assert.doesNotMatch(JSON.stringify(card), /admin.*change/i);
  });

  it('clears only the active thread', async () => {
    let adapter: any;
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: '/clear',
      rootId: 'om_thread_root',
    }), {
      setupAdapter: value => { adapter = value; captureOutbound(value); },
    });

    assert.deepEqual(result.clearedHistoryKeys, ['oc_1:thread:om_thread_root']);
    assert.deepEqual(result.clearedRoomChatIds, []);
    assert.match(adapter.__finalReplies[0], /This conversation is cleared/i);
  });

  it('ignores a legacy inline override when clearing a group thread', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: '/clear',
    }), {
      groupReplyMode: 'inline',
      setupAdapter: captureOutbound,
    });

    assert.deepEqual(result.clearedHistoryKeys, ['oc_1:thread:om_root']);
    assert.deepEqual(result.clearedRoomChatIds, []);
  });

  it('requires an admin confirmation before clearing the whole room', async () => {
    let firstAdapter: any;
    const first = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: '/clear room',
    }), {
      identity: {
        userId: 'admin-1',
        companyId: 'company-1',
        aiRole: 'COMPANY_ADMIN',
        channel: 'lark',
      },
      setupAdapter: value => { firstAdapter = value; captureOutbound(value); },
    });
    assert.deepEqual(first.clearedRoomChatIds, []);
    assert.match(firstAdapter.__finalReplies[0], /clear room confirm/i);

    const confirmed = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: '/clear room confirm',
    }), {
      identity: {
        userId: 'admin-1',
        companyId: 'company-1',
        aiRole: 'COMPANY_ADMIN',
        channel: 'lark',
      },
      setupAdapter: captureOutbound,
    });
    assert.deepEqual(confirmed.clearedRoomChatIds, ['oc_1']);
    assert.deepEqual(confirmed.clearedRoomContexts, ['oc_1']);
    assert.deepEqual(confirmed.clearedHistoryKeys, []);
  });

  it('keeps a top-level threaded clear from silently clearing the room', async () => {
    let adapter: any;
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: '/clear',
      rootId: null,
    }), {
      setupAdapter: value => { adapter = value; captureOutbound(value); },
    });

    assert.deepEqual(result.clearedHistoryKeys, []);
    assert.deepEqual(result.clearedRoomChatIds, []);
    assert.match(adapter.__finalReplies[0], /inside the thread/i);
  });

  // Both spellings enter the same handler; `/q` is the one the card and /help
  // advertise, `/stop` is kept for the people who already learned it.
  for (const command of ['/q', '/stop']) {
    it(`handles ${command} before entering the busy conversation lane`, async () => {
      let adapter: any;
      let interrupted: unknown;
      const result = await runWebhook(makeEvent({
        chatType: 'group',
        mentionsBot: true,
        text: command,
        rootId: 'om_thread_root',
      }), {
        setupAdapter: value => {
          adapter = value;
          captureOutbound(value);
          value.interruptConversation = (key: string, actor: unknown) => {
            interrupted = { key, actor };
            return 'aborted';
          };
        },
      });

      assert.deepEqual(interrupted, {
        key: 'oc_1:thread:om_thread_root',
        actor: {
          userId: 'user-1',
          companyId: 'company-1',
          aiRole: 'MEMBER',
        },
      });
      // The whole point of intercepting here: a stop that queued behind the run
      // it is stopping would arrive after that run had already finished.
      assert.deepEqual(result.serializerKeys, []);
      assert.equal(result.engineInputs.length, 0);
      assert.match(noticesSent(adapter)[0], /Stop requested/i);
      assert.deepEqual(adapter.__sentTextDeliveries, [{
        replyToMessageId: 'om_1',
        replyInThread: true,
      }]);
    });
  }
});

describe('Lark first contact', () => {
  const firstTimer = () => makeEvent({ chatType: 'p2p', text: 'hello' });

  it('says the workspace is not connected instead of going quiet', async () => {
    let adapter: any;
    const result = await runWebhook(firstTimer(), {
      unknownUser: true,
      pendingLogin: null,
      setupAdapter: a => { adapter = a; captureOutbound(a); },
    });

    // The state every new customer starts in. Silence here is indistinguishable
    // from Divo being down, which is the worst possible first impression.
    assert.equal(result.status, 200);
    assert.equal(noticesSent(adapter).length, 1, 'exactly one notice');
    assert.match(noticesSent(adapter)[0]!, /not connected to this Lark workspace/i);
    assert.ok(!result.order.includes('engine'), 'and no agent run');
  });

  it('distinguishes a directory failure from an unconnected workspace', async () => {
    let adapter: any;
    await runWebhook(firstTimer(), {
      unknownUser: true,
      bootstrapped: true,
      pendingLogin: null,
      setupAdapter: a => { adapter = a; captureOutbound(a); },
    });

    // Bootstrap succeeded, so the workspace *is* connected — telling them to go
    // connect it would send an admin chasing something that is already done.
    assert.match(noticesSent(adapter)[0]!, /couldn't verify your account/i);
  });

  it('signs people in on a deployment with no Lark OAuth at all', async () => {
    let adapter: any;
    await runWebhook(firstTimer(), {
      unknownUser: true,
      pendingLogin: {
        status: 'ready', companyId: 'company-1', userId: 'user-1',
        larkOpenId: 'ou_sender', displayName: 'Alice', email: 'alice@example.com',
      },
      // oauthConfigured deliberately omitted. Sign-in happens in the web app,
      // so a deployment that has never configured Lark OAuth must still be
      // able to let people in — it just cannot act as them afterwards.
      setupAdapter: a => { adapter = a; captureOutbound(a); },
    });

    assert.equal(adapter.__sentCards.length, 1, 'a sign-in card, not an apology');
    assert.deepEqual(noticesSent(adapter), []);
  });

  it('explains a profile with no email', async () => {
    let adapter: any;
    await runWebhook(firstTimer(), {
      unknownUser: true,
      pendingLogin: { status: 'missing_email', companyId: 'company-1', larkOpenId: 'ou_sender' },
      setupAdapter: a => { adapter = a; captureOutbound(a); },
    });

    assert.match(noticesSent(adapter)[0]!, /no email address/i);
  });

  it('sends a card with a Connect button when sign-in is possible', async () => {
    let adapter: any;
    await runWebhook(firstTimer(), {
      unknownUser: true,
      oauthConfigured: true,
      pendingLogin: {
        status: 'ready', companyId: 'company-1', userId: 'user-1',
        larkOpenId: 'ou_sender', displayName: 'Alice', email: 'alice@example.com',
      },
      setupAdapter: a => { adapter = a; captureOutbound(a); },
    });

    assert.equal(adapter.__sentCards.length, 1, 'a card, not a raw link');
    const card = JSON.parse(JSON.parse(adapter.__sentCards[0]).card);
    const button = card.body.elements.find((e: any) => e.tag === 'button');
    assert.equal(button.behaviors[0].type, 'open_url');
    assert.deepEqual(noticesSent(adapter), [], 'no duplicate plain-text prompt');
  });

  it('offers the Connect button before Pi when a known member cloud session expired', async () => {
    let adapter: any;
    const result = await runWebhook(firstTimer(), {
      oauthConfigured: true,
      activePiSession: false,
      setupAdapter: a => { adapter = a; captureOutbound(a); },
    });

    assert.equal(adapter.__sentCards.length, 1);
    const card = JSON.parse(JSON.parse(adapter.__sentCards[0]).card);
    const button = card.body.elements.find((element: any) => element.tag === 'button');
    assert.equal(button.behaviors[0].type, 'open_url');
    assert.match(card.body.elements[0].content, /cloud session expired/i);
    assert.ok(!result.order.includes('engine'), 'Pi must not start before session recovery');
    assert.equal(result.cacheWrites.length, 1, 'the original request is retained for replay');
    assert.deepEqual(result.piSessionContexts, [{
      companyId: 'company-1',
      userId: 'user-1',
      companyRole: 'MEMBER',
      channel: 'lark',
      tenantId: 'tenant-1',
      userExternalId: 'ou_sender',
    }]);
  });

  it('stays silent for an unmentioned group message when the cloud session expired', async () => {
    let adapter: any;
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      rootId: null,
      parentId: null,
      text: 'ordinary room discussion',
    }), {
      oauthConfigured: true,
      activePiSession: false,
      setupAdapter: value => { adapter = value; captureOutbound(value); },
    });

    assert.deepEqual(adapter.__sentCards, []);
    assert.deepEqual(noticesSent(adapter), []);
    assert.deepEqual(result.piSessionContexts, []);
    assert.equal(result.engineInputs.length, 0);
  });

  it('offers sign-in to an unknown person continuing a Divo-owned thread', async () => {
    let adapter: any;
    await runWebhook(makeEvent({
      chatType: 'group',
      text: 'continue this for me too',
    }), {
      unknownUser: true,
      oauthConfigured: true,
      ownedThreadKeys: new Set(['oc_1:thread:om_root']),
      pendingLogin: {
        status: 'ready',
        companyId: 'company-1',
        userId: 'user-2',
        larkOpenId: 'ou_sender',
        displayName: 'Bob',
        email: 'bob@example.com',
      },
      setupAdapter: value => { adapter = value; captureOutbound(value); },
    });

    assert.equal(adapter.__sentCards.length, 1);
    assert.deepEqual(adapter.__sentCardDeliveries, [{
      replyToMessageId: 'om_1',
      replyInThread: true,
    }]);
  });

  it('keeps the Connect card inside a default-threaded group', async () => {
    let adapter: any;
    await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: 'hello',
    }), {
      unknownUser: true,
      oauthConfigured: true,
      pendingLogin: {
        status: 'ready', companyId: 'company-1', userId: 'user-1',
        larkOpenId: 'ou_sender', displayName: 'Alice', email: 'alice@example.com',
      },
      setupAdapter: a => { adapter = a; captureOutbound(a); },
    });

    assert.deepEqual(adapter.__sentCardDeliveries, [{
      replyToMessageId: 'om_1',
      replyInThread: true,
    }]);
  });

  it('keeps the Connect card threaded despite a legacy inline override', async () => {
    let adapter: any;
    await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: 'hello',
    }), {
      unknownUser: true,
      oauthConfigured: true,
      groupReplyMode: 'inline',
      pendingLogin: {
        status: 'ready', companyId: 'company-1', userId: 'user-1',
        larkOpenId: 'ou_sender', displayName: 'Alice', email: 'alice@example.com',
      },
      setupAdapter: a => { adapter = a; captureOutbound(a); },
    });

    assert.deepEqual(adapter.__sentCardDeliveries, [{
      replyToMessageId: 'om_1',
      replyInThread: true,
    }]);
  });

  it('signs out and offers the Connect button when the saved department is stale', async () => {
    let adapter: any;
    const result = await runWebhook(firstTimer(), {
      identity: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MANAGER',
        channel: 'lark',
        activeDepartmentId: 'dept-finance',
      },
      changedDepartmentMemberships: ['dept-tech'],
      oauthConfigured: true,
      pendingLogin: {
        status: 'ready', companyId: 'company-1', userId: 'user-1',
        larkOpenId: 'ou_sender', displayName: 'Alice', email: 'alice@example.com',
      },
      setupAdapter: a => { adapter = a; captureOutbound(a); },
    });

    assert.ok(!result.order.includes('engine'), 'stale authority never reaches the agent');
    assert.deepEqual(result.revokedLarkUsers, [{ companyId: 'company-1', userId: 'user-1' }]);
    assert.deepEqual(result.invalidatedIdentities, ['ou_sender']);
    assert.deepEqual(result.departmentPreferenceUpdates, [{
      where: {
        userId: 'user-1',
        companyId: 'company-1',
        activeDepartmentId: 'dept-finance',
      },
      data: { activeDepartmentId: 'dept-tech' },
    }]);
    const card = JSON.parse(JSON.parse(adapter.__sentCards[0]).card);
    assert.match(card.body.elements[0].content, /department access changed/i);
  });

  it('keeps a selected department that is valid beyond the first two memberships', async () => {
    const result = await runWebhook(firstTimer(), {
      identity: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MANAGER',
        channel: 'lark',
        activeDepartmentId: 'dept-finance',
      },
      changedDepartmentMemberships: ['dept-tech', 'dept-ops', 'dept-finance'],
      setupAdapter: captureOutbound,
    });

    assert.ok(result.order.includes('engine'), 'valid authority reaches the agent');
    assert.deepEqual(result.revokedLarkUsers, []);
    assert.deepEqual(result.invalidatedIdentities, []);
    assert.deepEqual(result.departmentPreferenceUpdates, []);
  });

  it('falls back to a plain link when the card cannot be sent', async () => {
    let adapter: any;
    await runWebhook(firstTimer(), {
      unknownUser: true,
      oauthConfigured: true,
      pendingLogin: {
        status: 'ready', companyId: 'company-1', userId: 'user-1',
        larkOpenId: 'ou_sender', displayName: 'Alice', email: 'alice@example.com',
      },
      setupAdapter: a => {
        adapter = a;
        captureOutbound(a);
        a.sendCardToChat = async () => ({
          ok: false, error: { message: 'card rejected' },
        });
      },
    });

    // A working link in an ugly message beats a button nobody received.
    assert.equal(noticesSent(adapter).length, 1);
    assert.match(noticesSent(adapter)[0]!, /https:\/\/app\.example\/link\/lark\?state=/);
  });
});

describe('Lark auth commands', () => {
  it('renders /login as the same Connect button used for first contact', async () => {
    let adapter: any;
    const result = await runWebhook(makeEvent({ chatType: 'p2p', text: '/login' }), {
      identity: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MEMBER',
        channel: 'lark',
        displayName: 'Alice',
      },
      oauthConfigured: true,
      setupAdapter: value => { adapter = value; captureOutbound(value); },
    });

    assert.ok(!result.order.includes('engine'), 'auth command never reaches the agent');
    assert.equal(adapter.__sentCards.length, 1, 'the URL is protected behind a button');
    assert.deepEqual(adapter.__finalReplies, [], 'no raw authorization URL is posted');
    const card = JSON.parse(JSON.parse(adapter.__sentCards[0]).card);
    const button = card.body.elements.find((element: any) => element.tag === 'button');
    assert.equal(button.behaviors[0].type, 'open_url');
    assert.match(button.behaviors[0].default_url, /^https:\/\/app\.example\/link\/lark\?state=/);
  });

  it('keeps the /login card inside a group thread', async () => {
    let adapter: any;
    await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: '/login',
    }), {
      oauthConfigured: true,
      setupAdapter: value => { adapter = value; captureOutbound(value); },
    });

    assert.deepEqual(adapter.__sentCardDeliveries, [{
      replyToMessageId: 'om_1',
      replyInThread: true,
    }]);
  });

  it('revokes /logout and clears the cached identity before offering reconnect', async () => {
    let adapter: any;
    const result = await runWebhook(makeEvent({ chatType: 'p2p', text: '/logout' }), {
      larkConnectionCount: 1,
      setupAdapter: value => { adapter = value; captureOutbound(value); },
    });

    assert.ok(!result.order.includes('engine'), 'auth command never reaches the agent');
    assert.deepEqual(result.revokedLarkUsers, [{ companyId: 'company-1', userId: 'user-1' }]);
    assert.deepEqual(result.invalidatedIdentities, ['ou_sender']);
    assert.deepEqual(adapter.__finalReplies, [
      'Disconnected. Your personal Lark sign-in has been removed. Send me another message whenever you want to reconnect.',
    ]);
  });
});

describe('Post-login replay', () => {
  it('answers the message the user sent before signing in', async () => {
    const base = await runWebhook(makeEvent({ chatType: 'p2p', text: 'what is my quota' }));
    const event = makeEvent({ chatType: 'p2p', text: 'what is my quota' });

    await replayLarkMessageAfterLogin(event as any, base.routeDeps as any);

    // The whole reason the sign-in card can promise "no need to send it again".
    const replayed = base.engineInputs.at(-1) as Record<string, any>;
    assert.match(String(replayed?.['incoming']?.text ?? ''), /what is my quota/);
  });

  it('runs under a distinct trace ID so the sign-in prompt has not spent its reservation', async () => {
    const base = await runWebhook(makeEvent({ chatType: 'p2p', text: 'hello' }));
    const before = base.engineInputs.length;
    const event = makeEvent({ chatType: 'p2p', text: 'hello' });

    await replayLarkMessageAfterLogin(event as any, base.routeDeps as any);

    const original = (base.engineInputs[0] as any)?.incoming?.traceId;
    const replay = (base.engineInputs[before] as any)?.incoming?.traceId;

    // Wave 5 keys a delivery on the trace ID. The sign-in prompt was delivered
    // under the original one, so replaying with it would find the reservation
    // already `delivered` and swallow the answer — the user would connect and
    // then get silence.
    assert.notEqual(String(replay), String(original));
    assert.match(String(replay), /:replay$/);
  });

  it('is stable across repeats, so a retried replay still deduplicates', async () => {
    const base = await runWebhook(makeEvent({ chatType: 'p2p', text: 'hello' }));
    const event = makeEvent({ chatType: 'p2p', text: 'hello' });

    await replayLarkMessageAfterLogin(event as any, base.routeDeps as any);
    const first = (base.engineInputs.at(-1) as any)?.incoming?.traceId;
    await replayLarkMessageAfterLogin(event as any, base.routeDeps as any);
    const second = (base.engineInputs.at(-1) as any)?.incoming?.traceId;

    assert.equal(String(first), String(second));
  });

  it('ignores a payload it cannot parse rather than throwing into the callback', async () => {
    const base = await runWebhook(makeEvent({ chatType: 'p2p', text: 'hello' }));
    const before = base.engineInputs.length;

    // The OAuth callback is best-effort and the browser is waiting on it.
    await replayLarkMessageAfterLogin({ nonsense: true } as any, base.routeDeps as any);

    assert.equal(base.engineInputs.length, before, 'no run started');
  });
});

describe('Lark voice notes', () => {
  it('transcribes a private voice note with Scribe v2 and reuses the cached transcript', async () => {
    const downloads: unknown[][] = [];
    let request: { url: string; apiKey: string | null; modelId: FormDataEntryValue | null } | undefined;
    const transcriber = new ElevenLabsTranscriptionClient({
      apiKey: 'eleven-secret',
      fetchImpl: (async (url, init) => {
        const form = init?.body as FormData;
        request = {
          url: String(url),
          apiKey: new Headers(init?.headers).get('xi-api-key'),
          modelId: form.get('model_id'),
        };
        assert.ok(form.get('file') instanceof Blob);
        return new Response(JSON.stringify({
          text: '  Send the report.  ',
          language_code: 'en',
          language_probability: 0.99,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });

    const first = await runWebhook(makeEvent({
      chatType: 'p2p',
      messageId: 'om_voice_1',
      voice: { key: 'file_voice_1', durationMs: 12_000 },
    }), {
      voiceFileClient: {
        downloadFile: async (...args: unknown[]) => {
          downloads.push(args);
          return Buffer.from('fake-ogg');
        },
      },
      voiceTranscriber: transcriber,
    });

    assert.deepEqual(downloads, [['om_voice_1', 'file_voice_1', 25 * 1_024 * 1_024]]);
    assert.deepEqual(request, {
      url: 'https://api.elevenlabs.io/v1/speech-to-text',
      apiKey: 'eleven-secret',
      modelId: 'scribe_v2',
    });
    assert.equal((first.engineInputs[0] as any).incoming.text, 'Send the report.');
    assert.deepEqual((first.engineInputs[0] as any).incoming.attachments, [{
      type: 'audio',
      fileKey: 'file_voice_1',
      mimeType: 'audio/ogg',
      name: 'voice-note.ogg',
    }]);
    assert.deepEqual(first.cacheWrites, [{
      key: 'lark:voice-transcript:tenant-1:om_voice_1',
      value: 'Send the report.',
      ttlSeconds: 7 * 60 * 60,
    }]);

    const retry = await runWebhook(makeEvent({
      chatType: 'p2p',
      messageId: 'om_voice_1',
      voice: { key: 'file_voice_1', durationMs: 12_000 },
    }), {
      cachedVoiceTranscript: 'Send the report.',
    });
    assert.equal((retry.engineInputs[0] as any).incoming.text, 'Send the report.');
    assert.ok(retry.logEvents.some(entry => entry.event === 'webhook.voice.cache_hit'));
  });

  it('ignores voice notes in group chats without downloading them', async () => {
    let downloads = 0;
    let transcriptions = 0;
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      voice: { key: 'file_voice_group', durationMs: 5_000 },
    }), {
      voiceFileClient: {
        downloadFile: async () => {
          downloads += 1;
          return Buffer.from('not expected');
        },
      },
      voiceTranscriber: {
        transcribe: async () => {
          transcriptions += 1;
          return { text: 'not expected' };
        },
      },
    });

    assert.equal(downloads, 0);
    assert.equal(transcriptions, 0);
    assert.equal(result.engineInputs.length, 0);
    assert.ok(result.logEvents.some(entry => entry.event === 'webhook.voice.group_ignored'));
  });

  it('transcribes an uploaded audio file in a private chat without requiring duration metadata', async () => {
    let transcription: { audio: Buffer; fileName: string; mimeType: string } | undefined;
    const result = await runWebhook(makeEvent({
      chatType: 'p2p',
      messageId: 'om_audio_file',
      file: { key: 'file_audio_upload', name: 'standup.mp3' },
    }), {
      voiceFileClient: {
        downloadFile: async () => Buffer.from('fake-mp3'),
      },
      voiceTranscriber: {
        transcribe: async input => {
          transcription = {
            audio: input.audio,
            fileName: input.fileName,
            mimeType: input.mimeType,
          };
          return { text: 'Here is the project update.' };
        },
      },
    });

    assert.deepEqual(transcription, {
      audio: Buffer.from('fake-mp3'),
      fileName: 'standup.mp3',
      mimeType: 'audio/mpeg',
    });
    assert.equal((result.engineInputs[0] as any).incoming.text, 'Here is the project update.');
    assert.deepEqual((result.engineInputs[0] as any).incoming.attachments, [{
      type: 'audio',
      fileKey: 'file_audio_upload',
      mimeType: 'audio/mpeg',
      name: 'standup.mp3',
    }]);
  });

  it('transcribes referenced audio when a group reply explicitly mentions Divo', async () => {
    const downloads: unknown[][] = [];
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: 'summarize this',
      parentId: 'om_voice_parent',
    }), {
      parentMessage: {
        messageId: 'om_voice_parent',
        status: 'available',
        messageType: 'audio',
        text: '',
        senderExternalId: 'ou_alice',
        imageUrls: [],
        audioAttachment: {
          fileKey: 'file_voice_parent', fileName: 'voice-note.ogg', mimeType: 'audio/ogg',
          durationMs: 8_000, source: 'voice-note',
        },
      },
      voiceFileClient: {
        downloadFile: async (...args: unknown[]) => {
          downloads.push(args);
          return Buffer.from('fake-ogg');
        },
      },
      voiceTranscriber: {
        transcribe: async () => ({ text: 'Revenue grew by twelve percent.' }),
      },
    });

    assert.deepEqual(
      downloads,
      [['om_voice_parent', 'file_voice_parent', 25 * 1_024 * 1_024]],
    );
    const engineInput = result.engineInputs[0] as any;
    assert.match(engineInput.incoming.text, /Voice note transcript: Revenue grew by twelve percent/);
    assert.match(engineInput.incoming.text, /summarize this/);
    assert.equal(engineInput.incoming.attachments[0]?.type, 'audio');
    assert.equal(engineInput.runContext.userId, 'user-1', 'the replying user remains the authority');
    assert.deepEqual(result.cacheWrites, [{
      key: 'lark:voice-transcript:tenant-1:om_voice_parent',
      value: 'Revenue grew by twelve percent.',
      ttlSeconds: 7 * 60 * 60,
    }]);
  });

  it('transcribes a referenced audio file and preserves its format metadata', async () => {
    const transcriptions: Array<{ fileName: string; mimeType: string }> = [];
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: 'summarize this',
      parentId: 'om_audio_file_parent',
    }), {
      parentMessage: {
        messageId: 'om_audio_file_parent',
        status: 'available',
        messageType: 'file',
        text: '',
        senderExternalId: 'ou_alice',
        imageUrls: [],
        audioAttachment: {
          fileKey: 'file_audio_parent', fileName: 'meeting.wav', mimeType: 'audio/wav',
          durationMs: null, source: 'file',
        },
      },
      voiceFileClient: {
        downloadFile: async () => Buffer.from('fake-wav'),
      },
      voiceTranscriber: {
        transcribe: async input => {
          transcriptions.push({ fileName: input.fileName, mimeType: input.mimeType });
          return { text: 'The team approved the launch.' };
        },
      },
    });

    assert.deepEqual(transcriptions, [{ fileName: 'meeting.wav', mimeType: 'audio/wav' }]);
    const incoming = (result.engineInputs[0] as any).incoming;
    assert.match(incoming.text, /Voice note transcript: The team approved the launch/);
    assert.deepEqual(incoming.attachments[0], {
      type: 'audio',
      fileKey: 'file_audio_parent',
      mimeType: 'audio/wav',
      name: 'meeting.wav',
    });
  });

  it('uses referenced audio as the context for a later bare group mention', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: '',
      parentId: 'om_voice_parent',
      threadId: null,
    }), {
      parentMessage: {
        messageId: 'om_voice_parent',
        status: 'available',
        messageType: 'audio',
        text: '',
        senderExternalId: 'ou_sender',
        imageUrls: [],
        audioAttachment: {
          fileKey: 'file_voice_parent', fileName: 'voice-note.ogg', mimeType: 'audio/ogg',
          durationMs: 4_000, source: 'voice-note',
        },
      },
      voiceFileClient: {
        downloadFile: async () => Buffer.from('fake-ogg'),
      },
      voiceTranscriber: {
        transcribe: async () => ({ text: 'Compare both companies.' }),
      },
    });

    const engineInput = result.engineInputs[0] as any;
    assert.match(engineInput.incoming.text, /Voice note transcript: Compare both companies/);
    assert.equal(engineInput.incoming.requiresAdjacentContext, undefined);
    assert.equal(engineInput.incoming.attachments[0]?.type, 'audio');
  });

  it('fails closed for over-limit and failed private transcriptions', async () => {
    const unknownDuration = await runWebhook(makeEvent({
      chatType: 'p2p',
      voice: { key: 'file_voice_unknown' },
    }), {
      setupAdapter: captureOutbound,
    });
    assert.equal(unknownDuration.engineInputs.length, 0);
    assert.match(noticesSent(unknownDuration.routeDeps.adapter)[0]!, /verify the length/i);

    const tooLong = await runWebhook(makeEvent({
      chatType: 'p2p',
      voice: { key: 'file_voice_long', durationMs: 10 * 60_000 + 1 },
    }), {
      setupAdapter: captureOutbound,
    });
    assert.equal(tooLong.engineInputs.length, 0);
    assert.match(noticesSent(tooLong.routeDeps.adapter)[0]!, /10-minute limit/i);

    const failed = await runWebhook(makeEvent({
      chatType: 'p2p',
      voice: { key: 'file_voice_failed', durationMs: 2_000 },
    }), {
      setupAdapter: captureOutbound,
      voiceFileClient: {
        downloadFile: async () => Buffer.from('fake-ogg'),
      },
      voiceTranscriber: {
        transcribe: async () => { throw new Error('provider unavailable'); },
      },
    });
    assert.equal(failed.engineInputs.length, 0);
    assert.match(noticesSent(failed.routeDeps.adapter)[0]!, /could not transcribe/i);

    let cacheReadProviderCalls = 0;
    const cacheReadFailed = await runWebhook(makeEvent({
      chatType: 'p2p',
      voice: { key: 'file_voice_cache_read', durationMs: 2_000 },
    }), {
      setupAdapter: captureOutbound,
      voiceCacheReadFails: true,
      voiceFileClient: {
        downloadFile: async () => Buffer.from('fake-ogg'),
      },
      voiceTranscriber: {
        transcribe: async () => {
          cacheReadProviderCalls += 1;
          return { text: 'must not run' };
        },
      },
    });
    assert.equal(cacheReadProviderCalls, 0);
    assert.equal(cacheReadFailed.engineInputs.length, 0);
    assert.match(noticesSent(cacheReadFailed.routeDeps.adapter)[0]!, /temporarily unavailable/i);

    const oversized = await runWebhook(makeEvent({
      chatType: 'p2p',
      voice: { key: 'file_voice_oversized', durationMs: 2_000 },
    }), {
      setupAdapter: captureOutbound,
      voiceFileClient: {
        downloadFile: async () => Buffer.from('fake-ogg'),
      },
      voiceTranscriber: {
        transcribe: async () => ({ text: 'x'.repeat(50_001) }),
      },
    });
    assert.equal(oversized.engineInputs.length, 0);
    assert.deepEqual(oversized.cacheWrites, []);
    assert.match(noticesSent(oversized.routeDeps.adapter)[0]!, /too much text/i);

    const cacheWriteFailed = await runWebhook(makeEvent({
      chatType: 'p2p',
      voice: { key: 'file_voice_cache_write', durationMs: 2_000 },
    }), {
      setupAdapter: captureOutbound,
      voiceCacheWriteFails: true,
      voiceFileClient: {
        downloadFile: async () => Buffer.from('fake-ogg'),
      },
      voiceTranscriber: {
        transcribe: async () => ({ text: 'Do not run the engine.' }),
      },
    });
    assert.equal(cacheWriteFailed.engineInputs.length, 0);
    assert.match(noticesSent(cacheWriteFailed.routeDeps.adapter)[0]!, /temporarily unavailable/i);
  });
});

describe('Lark document attachments', () => {
  it('does not pull a readable document out of Lark at all', async () => {
    // The bytes travel once, from Lark into the sender's container workspace,
    // and the webhook is not on that path. A download here would be a second
    // copy the backend has no use for.
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      file: { key: 'file_v3_budget', name: 'budget.xlsx' },
    }), {
      identity: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MEMBER',
        channel: 'lark',
        displayName: 'Alice',
      },
    }));

    assert.deepEqual(attemptedDownloads(result.logEvents), [], 'nothing is fetched here');
    assert.ok(
      !result.logEvents.some(entry => entry.event === 'webhook.attachment.unsupported'),
      'and the document is not recorded as a refusal',
    );
    assert.equal(result.status, 200);
    assert.ok(result.order.includes('engine'), 'Divo answers the message');
    assert.equal(
      (result.engineInputs[0] as any).incoming.senderName,
      'Alice',
      'the attachment engine path keeps shared-thread speaker attribution',
    );
  });

  it('records the document as bound for the workspace, with the key needed to stage it', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      file: { key: 'file_v3_spec', name: 'spec.docx' },
    })));

    const attachments = attachmentsOf(result.retainedMessages[0]);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]?.['ingestionStatus'], 'workspace');
    assert.equal(attachments[0]?.['fileName'], 'spec.docx');
    // Without the file key the run has no way to fetch the bytes it is
    // supposed to stage, and the path in [ATTACHED_FILES] would point at
    // nothing.
    assert.equal(attachments[0]?.['larkFileKey'], 'file_v3_spec');
  });

  it('keeps no trace of the document contents in the transcript', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      file: { key: 'file_v3_q3', name: 'Q3-revenue.pdf' },
    })));

    const attachment = attachmentsOf(result.retainedMessages[0])[0]!;
    // A readable file gets no `inlineContext` at all — that field now carries
    // only the reason a file was refused.
    assert.equal(attachment['inlineContext'], undefined);
    assert.equal(attachment['error'], undefined);
  });

  it('waits for the question when a DM carries only a document', async () => {
    // The upload-then-ask pattern, which is how people send a PDF they want
    // read. An unreadable format still gets its refusal immediately, because
    // no follow-up question would change the answer.
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'p2p',
      file: { key: 'file_v3_budget', name: 'budget.xlsx' },
      text: '',
    })));

    assert.ok(!result.order.includes('engine'), 'no agent run');
    assert.ok(result.order.includes('stage-pending'), 'bytes are retained in the signed private workspace');
    assert.equal(result.pendingAttachmentInputs.length, 1);
    assert.ok(
      result.logEvents.some(e => e.event === 'webhook.attachment.awaiting_question'),
      'and the wait is recorded',
    );
    assert.doesNotMatch(
      String(result.appendedTurns[0]?.['content'] ?? ''),
      /\[Lark sender:/,
      'DM history remains unlabelled while the attachment waits for its question',
    );
  });

  it('refuses a format no skill can open, without downloading it', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'p2p',
      file: { key: 'file_v3_clip', name: 'standup.mp4' },
    })));

    // The refusal has to happen before any fetch. Moving bytes we then decline
    // to use is the worst of both: they left Lark and the user got nothing.
    assert.deepEqual(attemptedDownloads(result.logEvents), [], 'the video never left Lark');
    assert.ok(
      result.logEvents.some(entry => entry.event === 'webhook.attachment.unsupported'),
      'and the refusal is recorded',
    );

    const incoming = (result.engineInputs[0] as Record<string, any>)?.['incoming'];
    const text = String(incoming?.text ?? '');
    assert.match(text, /NOT SAVED/, 'the refusal reaches the prompt');
    assert.match(text, /standup\.mp4/);
    assert.match(text, /Do not guess or infer/i);
  });

  it('acknowledges a document it is going to sit on quietly', async () => {
    const reactions: string[] = [];
    await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'p2p',
      file: { key: 'file_v3_only', name: 'notes.txt' },
      text: '',
    }), {
      setupAdapter: adapter => {
        (adapter as any).reactToIncoming = async (_id: string, emoji: string) => {
          reactions.push(emoji);
        };
      },
    }));

    // Divo is deliberately silent until the question arrives, so a 📥 is the
    // only thing telling the user the upload was not ignored.
    assert.deepEqual(reactions, ['\u{1F4E5}']);
  });

  it('does not acknowledge a document it is going to refuse', async () => {
    const reactions: string[] = [];
    await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'p2p',
      file: { key: 'file_v3_clip', name: 'standup.mp4' },
      text: '',
    }), {
      setupAdapter: adapter => {
        (adapter as any).reactToIncoming = async (_id: string, emoji: string) => {
          reactions.push(emoji);
        };
      },
    }));

    // A 📥 here says "received, working on it" and is then contradicted by the
    // refusal that follows.
    assert.deepEqual(reactions, []);
  });
});

describe('Lark image attachments', () => {
  it('does not answer a DM image that has not been asked about yet', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'p2p',
      image: { key: 'img_v3_silent' },
      text: '',
    })));

    // People send the picture first and the question second. Replying to the
    // picture alone spends a turn to say nothing useful.
    assert.ok(!result.order.includes('engine'), 'no agent run');
    assert.ok(
      result.logEvents.some(e => e.event === 'webhook.attachment.awaiting_question'),
      'and the wait is recorded',
    );
    // Silence is only acceptable if the image is remembered. A Lark image
    // message carries no text — a caption is always a separate message — so
    // conversation history is the only place the follow-up can read it back
    // from, and it is what makes "check this img" answerable a moment later.
    assert.equal(result.appendedTurns.length, 1, 'the image is kept for the next turn');
    // Only the filename — the bytes are not read here. The follow-up question
    // is what sends the image into the workspace.
    assert.match(String(result.appendedTurns[0]?.['content'] ?? ''), /\[Attached: /);
  });

  it('routes an image to the workspace like any other file', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      image: { key: 'img_v3_chart' },
    })));

    const attachments = attachmentsOf(result.retainedMessages[0]);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]?.['ingestionStatus'], 'workspace');
    // No copy of the image survives the webhook — not as bytes, not as OCR
    // text. The agent opens it from the workspace when it needs to.
    assert.equal(attachments[0]?.['base64DataUrl'], undefined);
    assert.equal(attachments[0]?.['cloudinaryUrl'], undefined);
    assert.equal(attachments[0]?.['inlineContext'], undefined);
    assert.deepEqual(attemptedDownloads(result.logEvents), []);
  });
});

describe('Lark untagged group policy', () => {
  it('does not download or OCR an image shared without mentioning Divo', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      image: { key: 'img_v3_secret' },
    })));

    // Asserted on the attempt itself rather than inferred from a missing side
    // effect: "was not read" and "did not leave Lark" are different claims, and
    // only this one fails if the download ever moves out of the gated helper.
    assert.deepEqual(attemptedDownloads(result.logEvents), [], 'nothing was fetched from Lark');
    assert.equal(result.status, 200);
    assert.ok(!result.order.includes('engine'), 'engine did not run');
    // Nothing is retained either: an image message carries no text to keep.
    assert.deepEqual(result.retainedMessages, [], 'nothing entered the transcript');
  });

  it('retains untagged group text in the room transcript by default', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'group' }));

    assert.equal(result.retainedMessages.length, 1, 'ambient text is kept');
    const message = result.retainedMessages[0]!;
    assert.equal(message['botMentioned'], false);
    assert.equal(message['chatId'], 'oc_1');
    assert.ok(!result.order.includes('engine'), 'retention is not invocation');
  });

  it('retains an unknown speaker in a tenant-bound room without invoking Divo', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'group', text: 'ship it Monday' }), {
      unknownUser: true,
      tenantCompanyId: 'company-1',
    });

    assert.equal(result.retainedMessages.length, 1);
    assert.equal(result.retainedMessages[0]?.['companyId'], 'company-1');
    assert.equal(result.retainedMessages[0]?.['senderOpenId'], 'ou_sender');
    assert.equal(result.retainedMessages[0]?.['content'], 'ship it Monday');
    assert.ok(!result.order.includes('engine'), 'ambient history grants no authority');
  });

  it('retains a tagged unknown speaker before offering sign-in', async () => {
    let adapter: any;
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: 'summarize the plan',
    }), {
      unknownUser: true,
      tenantCompanyId: 'company-1',
      setupAdapter: value => { adapter = value; captureOutbound(value); },
    });

    assert.equal(result.retainedMessages.length, 1);
    assert.equal(result.retainedMessages[0]?.['companyId'], 'company-1');
    assert.match(String(result.retainedMessages[0]?.['content']), /summarize the plan/);
    assert.ok(!result.order.includes('engine'), 'an unknown speaker receives no tool authority');
    assert.equal(noticesSent(adapter).length, 1, 'a tagged speaker may receive sign-in guidance');
  });

  it('does not retain an unknown speaker from an unbound workspace', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'group', text: 'private note' }), {
      unknownUser: true,
      tenantCompanyId: null,
    });

    assert.deepEqual(result.retainedMessages, []);
    assert.ok(!result.order.includes('engine'));
  });

  it('does not send a busy notice for an untagged group message', async () => {
    let adapter: any;
    const result = await runWebhook(makeEvent({ chatType: 'group', text: 'ambient update' }), {
      busyNotices: new BusyLaneNotices(),
      setupAdapter: value => { adapter = value; captureOutbound(value); },
      waitForIdle: false,
      serializer: {
        isActive: () => true,
        runAndWait: async (_key: string, task: (signal: AbortSignal) => Promise<void>) =>
          task(new AbortController().signal),
      } as any,
    });

    assert.deepEqual(noticesSent(adapter), []);
    assert.equal(result.retainedMessages.length, 1);
    assert.ok(!result.order.includes('engine'));
  });

  it('ignores a stale text-retention opt-out and keeps listening', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'group' }), {
      companyControls: [{ controlKey: 'lark.untagged.textRetention', value: 'off' }],
    });

    assert.equal(result.retainedMessages.length, 1, 'ambient text is always kept');
    assert.ok(!result.order.includes('engine'), 'listening is not invocation');
  });

  it('reaches attachment preparation when a deployment opts in', async () => {
    // Guards the over-blocking failure mode: with only untagged-and-ignored
    // cases, hard-wiring the gate to false would leave every test green while
    // attachment handling was silently dead.
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      image: { key: 'img_v3_shared' },
    }), {
      untaggedPolicy: {
        LARK_UNTAGGED_GROUP_ATTACHMENTS: 'process',
      },
    }));

    const attachments = attachmentsOf(result.retainedMessages[0]);
    assert.equal(attachments.length, 1, 'opt-in reaches attachment preparation');
    // `workspace` is the status preparation produces; a skipped attachment
    // would never have been given one.
    assert.equal(attachments[0]?.['ingestionStatus'], 'workspace');
    assert.ok(!result.order.includes('engine'), 'opting in does not make Divo reply');
  });

  it('still prepares an image on a message that does address Divo', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      image: { key: 'img_v3_asked' },
    })));

    // The policy governs what Divo takes uninvited; being asked is the
    // invitation, so the default 'ignore' setting must not gate this.
    const attachments = attachmentsOf(result.retainedMessages[0]);
    assert.equal(attachments.length, 1, 'an addressed image is prepared');
    assert.equal(attachments[0]?.['ingestionStatus'], 'workspace');
    assert.ok(result.order.includes('engine'), 'and the turn still runs');
  });

  it('reports the policy it actually applied, not the policy configured', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      image: { key: 'img_v3_x' },
    }));

    const skipped = result.logEvents.find(
      entry => entry.event === 'webhook.group_message.not_mentioned',
    );
    assert.ok(skipped, 'skip is logged');
    assert.equal(skipped.fields['attachmentCount'], 1, 'the attachment is still counted');
    assert.equal(skipped.fields['attachmentsProcessed'], false);
    assert.equal(skipped.fields['textRetained'], true);
  });

  // ── Documents are exempt from this gate ──────────────────────────────────
  // Lark gives a file message no text field, so a document upload can never
  // carry an @mention — it is *structurally* untagged. Gating documents on
  // the mention would mean Divo could never read one posted in a group, which
  // is the entire feature.

  it('records the untagged document in the transcript so a later question finds it', async () => {
    // The upload-then-ask flow lives or dies here. A file message carries no
    // text, so without the attachment the transcript keeps no trace that a
    // document ever arrived — and the follow-up "@Divo what does it say" has
    // nothing to resolve "it" to.
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      file: { key: 'file_v3_untagged', name: 'notes.pdf' },
    })));

    const attachments = attachmentsOf(result.retainedMessages[0]);
    assert.equal(attachments.length, 1, 'the upload is in the transcript');
    assert.equal(attachments[0]?.['fileName'], 'notes.pdf');
  });

  it('still refuses an untagged image while accepting an untagged document', async () => {
    // The exemption is for documents only. An image posted uninvited is still
    // never sent to a third-party vision provider.
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      image: { key: 'img_v3_secret' },
    })));

    assert.deepEqual(attemptedDownloads(result.logEvents), [], 'the image never left Lark');
    assert.deepEqual(result.ingestionJobs, [], 'and nothing was indexed');
  });
});

describe('Lark per-turn authority in a shared thread', () => {
  const PEOPLE: Record<string, LarkTestIdentity> = {
    ou_alice: {
      userId: 'user-alice',
      companyId: 'company-1',
      aiRole: 'COMPANY_ADMIN',
      channel: 'lark',
      activeDepartmentId: 'dept-finance',
      email: 'alice@example.com',
    },
    ou_bob: {
      userId: 'user-bob',
      companyId: 'company-1',
      aiRole: 'MEMBER',
      channel: 'lark',
      activeDepartmentId: 'dept-support',
      email: 'bob@example.com',
    },
  };

  const runAs = (openId: string, messageId: string) => runWebhook(makeEvent({
    chatType: 'group',
    mentionsBot: true,
    senderOpenId: openId,
    messageId,
    rootId: 'om_alice_thread',
    text: 'what can I see',
  }), { identity: (id: string) => PEOPLE[id]! });

  it("runs Bob's follow-up in Alice's thread with Bob's own authority", async () => {
    const alice = await runAs('ou_alice', 'om_a1');
    const bob = await runAs('ou_bob', 'om_b1');

    const aliceRun = (alice.engineInputs[0] as any).runContext;
    const bobRun = (bob.engineInputs[0] as any).runContext;

    // Same room, same thread, different people. Sharing the conversation must
    // not share the authority: Bob inheriting Alice's admin role here is the
    // whole failure mode this wave exists to prevent.
    assert.equal(String(aliceRun.userId), 'user-alice');
    assert.equal(String(bobRun.userId), 'user-bob');
    assert.equal(String(aliceRun.companyRole), 'COMPANY_ADMIN');
    assert.equal(String(bobRun.companyRole), 'MEMBER');
    assert.equal(String(aliceRun.departmentId), 'dept-finance');
    assert.equal(String(bobRun.departmentId), 'dept-support');
    assert.equal(String(bobRun.requesterEmail), 'bob@example.com');
    assert.equal((bob.engineInputs[0] as any).incoming.senderName, 'bob@example.com');
  });

  it('resolves identity per turn rather than reusing the thread"s first resolution', async () => {
    const alice = await runAs('ou_alice', 'om_a1');
    const bob = await runAs('ou_bob', 'om_b1');

    // A cached "who owns this thread" would show up as a lookup that never
    // happened for the second speaker.
    assert.deepEqual(alice.identityLookups, [{ openId: 'ou_alice', tenantKey: 'tenant-1' }]);
    assert.deepEqual(bob.identityLookups, [{ openId: 'ou_bob', tenantKey: 'tenant-1' }]);
  });

  it('binds the run to the sender, not to whoever is mentioned in the text', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      mentionsHuman: true,
      senderOpenId: 'ou_bob',
      messageId: 'om_b2',
      rootId: 'om_alice_thread',
    }), { identity: (id: string) => PEOPLE[id]! });

    const runContext = (result.engineInputs[0] as any).runContext;
    // Alice is mentioned in the message; Bob sent it. Authority follows the
    // sender, and the mention travels as data the tools may read.
    assert.equal(String(runContext.userId), 'user-bob');
    assert.equal(String(runContext.companyRole), 'MEMBER');
    assert.deepEqual(runContext.mentionedLarkOpenIds, ['ou_alice']);
    assert.equal(runContext.userExternalId, 'ou_bob');
  });
});

describe('Lark group rapid-message batching', () => {
  it('ignores a legacy inline override and absorbs messages on the thread lane', async () => {
    const second = makeEvent({
      chatType: 'group',
      mentionsBot: true,
      messageId: 'om_2',
      text: 'and include overdue totals',
    });
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      messageId: 'om_1',
      text: 'compare the companies',
    }), {
      groupReplyMode: 'inline',
      batchCandidates: [{
        receiptId: 'receipt-2',
        messageId: 'om_2',
        payload: second,
        acceptedAt: new Date('2026-07-26T00:00:00.100Z'),
      }],
    });

    assert.deepEqual(result.acceptedLaneKeys, [
      '["lark","ingress-receipt-lane","company-1","tenant-1","app-1","oc_1","thread","om_root"]',
    ]);
    assert.equal(result.engineInputs.length, 1);
    assert.match(String((result.engineInputs[0] as any).incoming.text), /compare the companies/);
    assert.match(String((result.engineInputs[0] as any).incoming.text), /include overdue totals/);
    assert.deepEqual(result.completedBatchReceipts, ['receipt-2']);
  });

  it('keeps the admitted mode when the group setting changes before execution', async () => {
    const cases = [{
      admittedMode: 'inline' as const,
      currentMode: 'threaded' as const,
      laneKey: '["lark","ingress-receipt-lane","company-1","tenant-1","app-1","oc_1","requester","ou_sender"]',
      replyInThread: false,
      runtimeLane: '["lark","runtime-user-lane","company-1","user-1"]',
    }, {
      admittedMode: 'threaded' as const,
      currentMode: 'inline' as const,
      laneKey: '["lark","ingress-receipt-lane","company-1","tenant-1","app-1","oc_1","thread","om_root"]',
      replyInThread: true,
      runtimeLane: '["lark","runtime-user-lane","company-1","user-1"]',
    }, {
      admittedMode: 'threaded' as const,
      currentMode: 'inline' as const,
      // Before group modes existed, top-level turns used requester lanes.
      laneKey: '["lark","ingress-lane","tenant-1","app-1","oc_1","requester","ou_sender"]',
      replyInThread: true,
      runtimeLane: '["lark","runtime-user-lane","company-1","user-1"]',
    }];

    for (const testCase of cases) {
      const event = makeEvent({ chatType: 'group', mentionsBot: true });
      const result = await runWebhook(event, {
        processQueued: false,
        groupReplyMode: testCase.currentMode,
      });

      await processAcceptedLarkReceipt({
        receiptId: `receipt-${testCase.admittedMode}`,
        tenantKey: 'tenant-1',
        companyId: 'company-1',
        messageId: 'om_1',
        payload: event,
        laneKey: testCase.laneKey,
        attempts: 1,
        acceptedAt: new Date('2026-07-26T00:00:00.000Z'),
      }, result.routeDeps);

      const engineInput = result.engineInputs[0] as any;
      assert.equal(engineInput.incoming.groupReplyMode, testCase.admittedMode);
      assert.equal(engineInput.conversation.replyInThread, testCase.replyInThread);
      assert.equal(result.serializerKeys[0], testCase.runtimeLane);
    }
  });
});

describe('Lark untagged policy per company', () => {
  // An image, because that is the only attachment kind the policy can still
  // decide anything about — a document is refused whatever the policy says.
  const untaggedImage = () => makeEvent({
    chatType: 'group',
    image: { key: 'img_v3_co' },
    text: 'take a look',
  });

  it("honours a company's opt-in over the deployment default", async () => {
    const result = await withStubbedFetch(() => runWebhook(untaggedImage(), {
      companyControls: [
        { controlKey: 'lark.untagged.attachments', value: 'process' },
      ],
    }));

    const attachments = attachmentsOf(result.retainedMessages[0]);
    assert.equal(attachments.length, 1, 'the company that asked gets processing');
    assert.equal(attachments[0]?.['ingestionStatus'], 'workspace');
  });

  it("honours a company's opt-out even when the deployment enables processing", async () => {
    const result = await withStubbedFetch(() => runWebhook(untaggedImage(), {
      untaggedPolicy: {
        LARK_UNTAGGED_GROUP_ATTACHMENTS: 'process',
      },
      companyControls: [{ controlKey: 'lark.untagged.attachments', value: 'ignore' }],
    }));

    // The direction that matters: a company must be able to refuse regardless
    // of what the shared deployment has turned on. The text is still retained,
    // so this asserts the attachment was skipped rather than the whole message.
    assert.deepEqual(attemptedDownloads(result.logEvents), [], 'nothing was fetched from Lark');
    assert.deepEqual(attachmentsOf(result.retainedMessages[0]), []);
  });

  it('leaves other companies on the deployment default', async () => {
    const result = await withStubbedFetch(() => runWebhook(untaggedImage(), {
      companyControls: [],
    }));

    assert.deepEqual(
      attemptedDownloads(result.logEvents), [], 'no override means the safe default',
    );
    assert.deepEqual(attachmentsOf(result.retainedMessages[0]), []);
  });
});

describe('Lark room transcript boundaries', () => {
  it('does not write hydrated quote content into the room-wide transcript', async () => {
    // Stubbed: this path quote-hydrates through Lark, and the assertion is
    // about which object is recorded, not about the fetch succeeding.
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: 'can you action this',
    })));

    const userEntries = result.retainedMessages.filter(m => m['role'] === 'user');
    assert.equal(userEntries.length, 1, 'one transcript entry for the sender');
    const stored = String(userEntries[0]!['content']);
    // The transcript is chat-scoped and every thread reads it back, so a
    // message quoted inside one thread must not arrive as ambient context in
    // an unrelated one. What the sender actually typed is what gets recorded.
    assert.match(stored, /can you action this/);
    assert.doesNotMatch(stored, /Referenced message/);
  });

  it('sends the engine the hydrated prompt even though the transcript keeps the raw text', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      text: 'can you action this',
    })));

    // Narrowing the transcript must not narrow what the model sees. Asserting
    // only the raw text would stay green if someone "fixed" the sibling case by
    // narrowing the engine input too — which is the regression this guards.
    const engineText = String((result.engineInputs[0] as any).incoming.text);
    assert.match(engineText, /can you action this/);
    assert.match(engineText, /Referenced message/, 'the engine still receives the quote hydration');
  });
});

describe('Lark delivery resume', () => {
  /** A delivery repo holding one finished-but-undelivered reply for this run. */
  const repoWithResumable = (payload: Record<string, unknown> | null) => {
    const resends: unknown[] = [];
    return {
      resends,
      repo: {
        findResumable: async (channel: string, runKey: string) => {
          resends.push({ channel, runKey });
          return ok(payload
            ? {
                deliveryId: 'd-1',
                purpose: 'final' as const,
                segmentIndex: 0,
                attempts: 2,
                firstAttemptAt: new Date('2026-07-26T00:00:00.000Z'),
                payload,
              }
            : null);
        },
        reserve: async () => ok({
          outcome: 'reserved' as const,
          record: { deliveryId: 'd-1', attempts: 1, firstAttemptAt: new Date() },
        }),
        markDelivered: async () => ok(undefined),
        markFailed: async () => ok(undefined),
        listRetryable: async () => ok([]),
      },
    };
  };

  it('resends a finished answer instead of re-running the agent', async () => {
    const { repo } = repoWithResumable({ kind: 'final', text: 'already computed', format: 'text' });
    const finalReplies: unknown[] = [];

    const result = await runWebhook(makeEvent({ chatType: 'p2p' }), {
      channelDeliveryRepo: repo,
      setupAdapter: adapter => {
        (adapter as any).sendFinalReply = async (_c: unknown, reply: unknown) => {
          finalReplies.push(reply);
          return ok({ channel: 'lark', messageId: 'om_resent' });
        };
      },
    });

    // The whole point of the wave: every tool this run called has already had
    // its effect. Re-running them to repeat a sentence is the failure mode.
    assert.ok(!result.order.includes('engine'), 'the agent did not run again');
    assert.equal(finalReplies.length, 1, 'the stored answer was resent');
    assert.equal((finalReplies[0] as any).text, 'already computed');
  });

  it('keeps the original inline target when group mode changes before retry', async () => {
    const { repo } = repoWithResumable({
      version: 1,
      reply: { kind: 'final', text: 'already computed', format: 'text' },
      target: {
        chatId: 'oc_1',
        replyToMessageId: 'om_original',
        replyInThread: false,
      },
    });
    const conversations: unknown[] = [];

    await runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
    }), {
      // The retry sees threaded, but the answer was originally produced inline.
      groupReplyMode: 'threaded',
      channelDeliveryRepo: repo,
      setupAdapter: adapter => {
        (adapter as any).sendFinalReply = async (conversation: unknown) => {
          conversations.push(conversation);
          return ok({ channel: 'lark', messageId: 'om_resent' });
        };
      },
    });

    assert.deepEqual(conversations.map(conversation => ({
      chatId: String((conversation as any).chatId),
      replyToMessageId: String((conversation as any).replyToMessageId),
      replyInThread: (conversation as any).replyInThread,
    })), [{
      chatId: 'oc_1',
      replyToMessageId: 'om_original',
      replyInThread: false,
    }]);
  });

  it('runs the agent normally when there is nothing to resume', async () => {
    const { repo } = repoWithResumable(null);

    const result = await runWebhook(makeEvent({ chatType: 'p2p' }), {
      channelDeliveryRepo: repo,
    });

    assert.ok(result.order.includes('engine'), 'a first attempt still runs');
  });

  it('looks the resume up by the run key the delivery was written under', async () => {
    const { repo, resends } = repoWithResumable(null);

    await runWebhook(makeEvent({ chatType: 'p2p' }), { channelDeliveryRepo: repo });

    // `traceId` is derived from the Lark message, so it is the same string on
    // every retry of that message. A random per-run key would make the whole
    // guard a no-op across restarts.
    assert.equal(resends.length, 1);
    assert.equal((resends[0] as any).channel, 'lark');
    assert.equal((resends[0] as any).runKey, 'om_1-1700000000000');
  });

  it('keeps the receipt retryable when the resend itself fails', async () => {
    const { repo } = repoWithResumable({ kind: 'final', text: 'answer', format: 'text' });

    const result = await runWebhook(makeEvent({ chatType: 'p2p' }), {
      channelDeliveryRepo: repo,
      processQueued: false,
      setupAdapter: adapter => {
        (adapter as any).sendFinalReply = async () => ({
          ok: false,
          error: { payload: { reason: 'upstream_5xx' } },
        });
      },
    });

    // The answer exists and the user still has not seen it, so this must not be
    // reported as done.
    await assert.rejects(() => result.processQueuedReceipt(), /resume failed/i);
  });

  it('retries a stored first-delivery failure without re-running the agent', async () => {
    const finalReply = { kind: 'final', text: 'already computed', format: 'text' };
    let resumablePayload: Record<string, unknown> | null = null;
    let engineRuns = 0;
    const delivered: unknown[] = [];
    const { repo } = repoWithResumable(null);
    const batchedEvent = makeEvent({
      chatType: 'p2p',
      messageId: 'om_2',
      text: 'and include the second item',
    });
    repo.findResumable = async () => ok(resumablePayload
      ? {
          deliveryId: 'd-1',
          purpose: 'final' as const,
          segmentIndex: 0,
          attempts: 1,
          firstAttemptAt: new Date('2026-07-26T00:00:00.000Z'),
          payload: resumablePayload,
        }
      : null);

    const result = await runWebhook(makeEvent({ chatType: 'p2p' }), {
      channelDeliveryRepo: repo,
      processQueued: false,
      batchCandidates: [{
        receiptId: 'receipt-2',
        messageId: 'om_2',
        payload: batchedEvent,
        acceptedAt: new Date('2026-07-26T00:00:00.100Z'),
      }],
      engineRun: async () => {
        engineRuns += 1;
        return ok({ finalReply });
      },
      setupAdapter: adapter => {
        (adapter as any).sendFinalReply = async (_conversation: unknown, reply: unknown) => {
          if (!resumablePayload) {
            resumablePayload = finalReply;
            return err(new ChannelError({
              channel: 'lark',
              stage: 'send_final',
              reason: 'upstream_5xx',
            }));
          }
          delivered.push(reply);
          resumablePayload = null;
          return ok({ channel: 'lark', messageId: 'om_resent' });
        };
      },
    });

    await assert.rejects(() => result.processQueuedReceipt(), /channel lark error/i);
    await result.processQueuedReceipt();

    assert.equal(engineRuns, 1, 'tools were not re-run to resend the answer');
    assert.equal(delivered.length, 1);
    assert.equal((delivered[0] as any).text, 'already computed');
    assert.deepEqual(result.completedBatchReceipts, ['receipt-2']);
  });

  it('runs the agent when the resume lookup is unavailable', async () => {
    const repo = {
      findResumable: async () => ({ ok: false as const, error: new Error('db down') }),
      reserve: async () => ok({
        outcome: 'reserved' as const,
        record: { deliveryId: 'd-1', attempts: 1, firstAttemptAt: new Date() },
      }),
      markDelivered: async () => ok(undefined),
      markFailed: async () => ok(undefined),
      listRetryable: async () => ok([]),
    };

    const result = await runWebhook(makeEvent({ chatType: 'p2p' }), {
      channelDeliveryRepo: repo,
    });

    // Failing closed here would strand the message: no resume and no run.
    assert.ok(result.order.includes('engine'));
  });
});

// A quoted picture used to be downloaded, base64-encoded onto the incoming
// message, and then dropped: nothing downstream read `imageUrls`. Divo answered
// quote-replies about an image from the surrounding text alone.
it('a quoted image becomes a file the run can open', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const attachments = quotedImageAttachments(
    [`data:image/png;base64,${png.toString('base64')}`],
    noopLogger,
  );

  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]!.kind, 'image');
  assert.equal(attachments[0]!.mimeType, 'image/png');
  assert.match(attachments[0]!.name, /\.png$/);

  const chunks: Uint8Array[] = [];
  for await (const chunk of await attachments[0]!.openStream()) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), png);
});

// A half-written file in the inbox reads to the agent as a picture it ought to
// be able to open, so a URL that will not decode is dropped instead of staged.
it('an undecodable quoted image is dropped rather than staged empty', () => {
  assert.deepEqual(
    quotedImageAttachments(['https://example.com/not-a-data-url', 'data:image/png;base64,'], noopLogger),
    [],
  );
});

// Delivering the answer edits the status card in place, so on a thirteen-minute
// run the entire record of the work is destroyed at the moment it succeeds.
describe('run transcript kept past the final card', () => {
  const say = (label: string) => ({ kind: 'say' as const, label, count: 1, status: 'done' as const });
  const ran = (label: string, outcome: string) =>
    ({ kind: 'tool' as const, label, count: 1, outcome, status: 'done' as const });

  it('keeps what was said and what was done, in order', () => {
    assert.equal(
      runTranscript([say('Checking the bases.'), ran('Terminal', 'airtable list-bases')]),
      'Checking the bases.\n**Terminal**  airtable list-bases',
    );
  });

  // Its log would just be the model talking, which is what the answer already is.
  it('gives a run that called no tool no trace at all', () => {
    assert.equal(runTranscript([say('Sure — here you go.')]), undefined);
    assert.equal(runTranscript([]), undefined);
  });

  // The trace shares the card's byte budget with the answer, and the answer is
  // the thing the user asked for. Steps nearest it are the ones that explain it.
  it('drops the oldest steps by name rather than silently truncating', () => {
    const rows = Array.from({ length: 400 }, (_, i) => ran('Terminal', `step number ${i}`));
    const trace = runTranscript(rows)!;

    assert.ok(trace.length < 3_400, `trace was ${trace.length} chars`);
    assert.match(trace, /^_\+\d+ earlier steps\._/);
    assert.match(trace, /step number 399/);
    assert.doesNotMatch(trace, /step number 0\b/);
  });

  it('will not let a command close the card markup it is rendered into', () => {
    assert.equal(
      runTranscript([ran('Terminal', 'cat <secret> `whoami`')]),
      '**Terminal**  cat secret whoami',
    );
  });
});
