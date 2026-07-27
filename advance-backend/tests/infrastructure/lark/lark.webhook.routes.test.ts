import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createLarkWebhookRoutes,
  processAcceptedLarkReceipt,
  replayLarkMessageAfterLogin,
} from '../../../src/infrastructure/channels/lark/lark.webhook.routes.ts';
import { LarkChannelAdapter } from '../../../src/infrastructure/channels/lark/lark.adapter.ts';
import { BusyLaneNotices } from '../../../src/infrastructure/channels/lark/lark-busy-notice.ts';
import { ChatMessageSerializer } from '../../../src/application/orchestration/chat-message-serializer.ts';
import { ok } from '../../../src/shared/result.ts';
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
  /** Override sender and message identity to model several people in one room. */
  senderOpenId?: string;
  messageId?: string;
  rootId?: string;
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
        message_type: input.file ? 'file' : input.image ? 'image' : 'text',
        content: input.file
          ? JSON.stringify({ file_key: input.file.key, file_name: input.file.name })
          : input.image
            ? JSON.stringify({ image_key: input.image.key })
            : JSON.stringify({ text }),
        create_time: '1700000000000',
        root_id: input.rootId ?? 'om_root',
        parent_id: 'om_parent',
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
  /** Whether Lark OAuth is configured on this deployment. */
  oauthConfigured?: boolean;
  setupAdapter?: (adapter: LarkChannelAdapter) => void;
  shareResolverService?: {
    isShareAction(cardEvent: unknown): boolean;
    handle(cardEvent: unknown, actor: unknown): Promise<{ responseBody: Record<string, unknown> }>;
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
  /** Delivery outbox, consulted before the agent runs. */
  channelDeliveryRepo?: unknown;
  /** Optional busy-lane notice state. */
  busyNotices?: BusyLaneNotices;
} = {}) {
  const order: string[] = [];
  const retainedMessages: Array<Record<string, unknown>> = [];
  const appendedTurns: Array<Record<string, unknown>> = [];
  const acceptedPayloads: unknown[] = [];
  const engineInputs: unknown[] = [];
  const serializerKeys: string[] = [];
  const identityLookups: Array<{ openId: string; tenantKey: string }> = [];
  const background: Promise<void>[] = [];
  const logEvents: Array<{ event: string; fields: Record<string, unknown> }> = [];
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
    ...(options.untaggedPolicy ?? {}),
  } as any;
  const adapter = new LarkChannelAdapter({ env, logger: noopLogger, botOpenId: 'ou_bot' });
  options.setupAdapter?.(adapter);
  let queuedReceiptId: string | undefined;
  const routeDeps = {
    adapter,
    engine: {
      run: async (input: unknown) => {
        order.push('engine');
        engineInputs.push(input);
        if (options.engineRun) return options.engineRun(input);
        return ok({ finalReply: { kind: 'final', text: 'done', format: 'text' } });
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
      resolveLarkTenantCompanyId: async () =>
        ok(options.tenantCompanyId === undefined ? 'company-1' : options.tenantCompanyId),
      prepareLarkLogin: async () => ok(options.pendingLogin ?? null),
    } as any,
    conversationRepo: {
      // Only `appendTurn` is exercised here: it is how an attachment with no
      // question yet is remembered for the message that finally asks one.
      appendTurn: async (key: string, turn: Record<string, unknown>) => {
        appendedTurns.push({ key, ...turn });
        return ok({ id: 't1', ...turn });
      },
    } as any,
    ingressReceiptRepo: {
      accept: async (input?: { payload?: unknown }) => {
        order.push('receipt');
        acceptedPayloads.push(input?.payload);
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
    // Divo no longer indexes Lark attachments, so the side effect the untagged
    // policy governs is the download itself — observed through the stubbed
    // fetch, not here. `chatContextService` remains the spy for the other half:
    // whether a message enters the room transcript.
    chatContextService: {
      appendMessage: async (message: Record<string, unknown>) => {
        order.push('retain');
        retainedMessages.push(message);
        return ok(null);
      },
    } as any,
    ...(options.companyControls
      ? {
          prisma: {
            adminControlState: {
              findMany: async () => options.companyControls,
            },
            runtimeConversation: { upsert: async () => ({}) },
          } as any,
        }
      : {}),
    ...(options.channelDeliveryRepo
      ? { channelDeliveryRepo: options.channelDeliveryRepo as any }
      : {}),
    ...(options.busyNotices ? { busyNotices: options.busyNotices } : {}),
    cache: { setNx: async () => ok(true), set: async () => ok(true) } as any,
    ...(options.bootstrapped
      ? {
          // Enough of the real bootstrap for it to succeed: a bound workspace,
          // a directory that agrees about the tenant, and a user it can see.
          prisma: {
            larkTenantBinding: { findFirst: async () => ({ companyId: 'company-1' }) },
            channelIdentity: { upsert: async () => ({}) },
            adminControlState: { findMany: async () => options.companyControls ?? [] },
            runtimeConversation: { upsert: async () => ({}) },
          } as any,
          larkContactsClient: {
            getTenantKey: async () => 'tenant-1',
            getUser: async (openId: string) => ({
              openId, displayName: 'Alice', email: 'alice@example.com',
            }),
          } as any,
        }
      : {}),
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
    ...(options.shareResolverService
      ? { shareResolverService: options.shareResolverService as any }
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
      // Taken from the event rather than hardcoded: the worker refuses a
      // receipt whose stored identity disagrees with its payload, so a fixed ID
      // here would silently restrict every test to one message.
      messageId: String((body as any)?.event?.message?.message_id ?? 'om_1'),
      payload: body as Record<string, unknown>,
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
    serializerKeys,
    identityLookups,
    logEvents,
    retainedMessages,
    appendedTurns,
    acceptedPayloads,
    processQueuedReceipt,
  };
}

describe('Lark webhook admission', () => {
  it('durably accepts before ACKing and runs an exact-ID group mention', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'group', mentionsBot: true }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.responseBody, { ok: true });
    // A mentioned turn is recorded in the room transcript on both sides of the
    // run, so the group keeps a coherent record of what was asked and answered.
    assert.deepEqual(
      result.order,
      ['receipt', 'queue', 'link', 'ack', 'execute', 'retain', 'engine', 'retain'],
    );
    assert.deepEqual(result.serializerKeys, [
      '["lark","ingress-lane","tenant-1","app-1","oc_1","thread","om_root"]',
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
      laneKey: '["lark","ingress-lane","tenant-1","app-1","oc_1","thread","om_root"]',
      companyLaneKey: '["lark","lane","company-1","tenant-1","app-1","oc_1","thread","om_root"]',
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

  it('ACKs and passively queues an unmentioned group message without running the engine', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'group' }));
    // Retained as ambient room context under the default policy, but never run.
    assert.deepEqual(result.order, ['receipt', 'queue', 'link', 'ack', 'execute', 'retain']);
    assert.equal(result.engineInputs.length, 0);
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

  it('logs a background failure once and lets the next same-chat message run', async () => {
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
        first.logEvents.filter(entry => entry.event === 'webhook.background.failed').length,
        1,
      );
      assert.equal(second.logEvents.some(entry => entry.event === 'webhook.background.completed'), true);
      assert.match(String(firstError), /engine unavailable/);
      assert.equal(calls, 2);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('Lark webhook card authorization', () => {
  it('passes the authenticated tenant-scoped actor to share resolution', async () => {
    let receivedActor: any;
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_admin', name: 'Admin' },
        action: { value: { action: 'share_approve', shareId: 'share-1' } },
      },
    }, {
      identity: {
        userId: 'admin-1',
        companyId: 'company-1',
        aiRole: 'COMPANY_ADMIN',
        channel: 'lark',
      },
      shareResolverService: {
        isShareAction: () => true,
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

  it('passes the authenticated actor to interrupt authorization and returns its result', async () => {
    let actor: any;
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_member' },
        context: { open_message_id: 'om_status' },
        action: { value: { action: 'interrupt_run' } },
      },
    }, {
      setupAdapter: adapter => {
        (adapter as any).findCorrelationByStatusMessage = () => 'corr-1';
        (adapter as any).interruptRun = (_correlationId: string, value: unknown) => {
          actor = value;
          return 'forbidden';
        };
      },
    });

    assert.deepEqual(actor, {
      tenantKey: 'tenant-1',
      openId: 'ou_member',
      userId: 'user-1',
      companyId: 'company-1',
      aiRole: 'MEMBER',
    });
    assert.deepEqual(result.responseBody, {
      toast: { type: 'warning', content: 'You are not authorized to interrupt this run.' },
    });
  });

  it('reports an interrupt request without claiming the run already stopped', async () => {
    const result = await runWebhook({
      header: {
        event_type: 'card.action.trigger',
        token: 'verify',
        tenant_key: 'tenant-1',
      },
      event: {
        operator: { open_id: 'ou_member' },
        context: { open_message_id: 'om_status' },
        action: { value: { action: 'interrupt_run' } },
      },
    }, {
      setupAdapter: adapter => {
        (adapter as any).findCorrelationByStatusMessage = () => 'corr-1';
        (adapter as any).interruptRun = () => 'aborted';
      },
    });

    assert.deepEqual(result.responseBody, {
      toast: { type: 'success', content: 'Interrupt requested.' },
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
  adapter.__sentCards = [];
  adapter.sendToChatId = async (_chatId: string, text: string) => {
    adapter.__sentTexts.push(text);
    return ok('om_notice');
  };
  adapter.sendCardToChat = async (_chatId: string, card: string) => {
    adapter.__sentCards.push(card);
    return ok({ messageId: 'om_card' });
  };
}

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

  it('admits when sign-in is not configured on this deployment', async () => {
    let adapter: any;
    await runWebhook(firstTimer(), {
      unknownUser: true,
      pendingLogin: {
        status: 'ready', companyId: 'company-1', userId: 'user-1',
        larkOpenId: 'ou_sender', displayName: 'Alice', email: 'alice@example.com',
      },
      // oauthConfigured omitted: createLarkLoginUrl returns null.
      setupAdapter: a => { adapter = a; captureOutbound(a); },
    });

    // This used to fall through to a silent return, so a deployment missing its
    // OAuth credentials ignored every new user and looked identical to a bug.
    assert.match(noticesSent(adapter)[0]!, /sign-in isn't configured/i);
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
    assert.match(noticesSent(adapter)[0]!, /https:\/\/lark\.example\/authorize/);
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

describe('Lark document attachments', () => {
  it('never fetches a document out of Lark, even when Divo is addressed', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'p2p',
      file: { key: 'file_v3_budget', name: 'budget.xlsx' },
    })));

    // The refusal has to happen before the download, not after it. Fetching a
    // file we then decline to read is the worst of both: the bytes left Lark
    // and the user got nothing for it.
    assert.deepEqual(attemptedDownloads(result.logEvents), [], 'the document never left Lark');
    assert.ok(
      result.logEvents.some(entry => entry.event === 'webhook.attachment.unsupported'),
      'and the refusal is recorded',
    );
    assert.equal(result.status, 200);
    assert.ok(result.order.includes('engine'), 'Divo still answers the message');
  });

  it('tells the model it did not read the document, and not to pretend it did', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'p2p',
      file: { key: 'file_v3_q3', name: 'Q3-revenue.pdf' },
    })));

    const incoming = (result.engineInputs[0] as Record<string, any>)?.['incoming'];
    const text = String(incoming?.text ?? '');

    // Without this the model receives a bare filename and answers from it.
    assert.match(text, /NOT READ/, 'the refusal reaches the prompt');
    assert.match(text, /Q3-revenue\.pdf/);
    assert.match(text, /Do not guess or infer/i);
  });

  it('records the document as unsupported rather than as failed or pending', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      file: { key: 'file_v3_spec', name: 'spec.docx' },
    })));

    const attachments = attachmentsOf(result.retainedMessages[0]);
    assert.equal(attachments.length, 1);
    // 'failed' would imply something went wrong and a retry might help;
    // 'processing' would imply an answer is coming. Neither is true.
    assert.equal(attachments[0]?.['ingestionStatus'], 'unsupported');
    assert.equal(attachments[0]?.['error'], undefined, 'a refusal is not an error');
  });

  it('does not acknowledge a document-only message with a received reaction', async () => {
    const reactions: string[] = [];
    await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'p2p',
      file: { key: 'file_v3_only', name: 'notes.txt' },
    }), {
      setupAdapter: adapter => {
        (adapter as any).reactToIncoming = async (_id: string, emoji: string) => {
          reactions.push(emoji);
        };
      },
    }));

    // A 📥 says "received, working on it" and is then contradicted by the
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
    assert.match(String(result.appendedTurns[0]?.['content'] ?? ''), /Image:/);
  });

  it('tells the model it could not open an image rather than denying one exists', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'p2p',
      image: { key: 'img_v3_broken' },
    })));

    // The user is looking at the picture they just sent. "I don't see any
    // image" is both wrong and useless; "I could not open it, resend it" is
    // actionable. The download always fails here, so this is that path.
    const recorded = String(result.appendedTurns[0]?.['content'] ?? '');
    assert.match(recorded, /could not be read/);
    assert.match(recorded, /Do not tell them no image was attached/);
  });


  it('keeps the OCR text in the transcript but not the image bytes', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      image: { key: 'img_v3_chart' },
    })));

    const attachments = attachmentsOf(result.retainedMessages[0]);
    assert.equal(attachments.length, 1);
    // The whole point of dropping the CDN upload is that no copy of the image
    // survives the turn. Persisting the data URL would reintroduce one.
    assert.equal(attachments[0]?.['base64DataUrl'], undefined);
    assert.equal(attachments[0]?.['cloudinaryUrl'], undefined);
    assert.equal(attachments[0]?.['ingestionStatus'], 'inline_only');
  });

  it('records a download failure on the attachment instead of dropping it', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      image: { key: 'img_v3_broken' },
    })));

    const attachments = attachmentsOf(result.retainedMessages[0]);
    assert.equal(attachments.length, 1, 'the attachment is still reported');
    // Distinguishes "we tried and could not" from "we declined to try", which
    // is the difference between a retry being worth suggesting and not.
    assert.ok(attachments[0]?.['error'], 'the failure is recorded');
    assert.notEqual(attachments[0]?.['ingestionStatus'], 'unsupported');
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
    // `inline_only` is the status preparation produces; a skipped attachment
    // would never have been given one.
    assert.equal(attachments[0]?.['ingestionStatus'], 'inline_only');
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
    assert.equal(attachments[0]?.['ingestionStatus'], 'inline_only');
    assert.ok(result.order.includes('engine'), 'and the turn still runs');
  });

  it('reports the policy it actually applied, not the policy configured', async () => {
    const result = await runWebhook(makeEvent({
      chatType: 'group',
      file: { key: 'file_v3_x', name: 'notes.txt' },
    }));

    const skipped = result.logEvents.find(
      entry => entry.event === 'webhook.group_message.not_mentioned',
    );
    assert.ok(skipped, 'skip is logged');
    assert.equal(skipped.fields['attachmentCount'], 1, 'the attachment is still counted');
    assert.equal(skipped.fields['attachmentsProcessed'], false);
    assert.equal(skipped.fields['textRetained'], true);
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
    assert.equal(attachments[0]?.['ingestionStatus'], 'inline_only');
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
