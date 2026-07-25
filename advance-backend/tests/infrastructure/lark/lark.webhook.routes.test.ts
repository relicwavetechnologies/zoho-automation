import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createLarkWebhookRoutes,
  processAcceptedLarkReceipt,
} from '../../../src/infrastructure/channels/lark/lark.webhook.routes.ts';
import { LarkChannelAdapter } from '../../../src/infrastructure/channels/lark/lark.adapter.ts';
import { ChatMessageSerializer } from '../../../src/application/orchestration/chat-message-serializer.ts';
import { ok } from '../../../src/shared/result.ts';
import type { Logger } from '../../../src/shared/logger.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

function makeEvent(input: {
  chatType: 'p2p' | 'group';
  senderType?: 'user' | 'bot';
  mentionsBot?: boolean;
  mentionsHuman?: boolean;
  /** Attach a file to the message instead of sending plain text. */
  file?: { key: string; name: string };
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
    'help',
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
        sender_id: { open_id: 'ou_sender' },
        sender_type: input.senderType ?? 'user',
      },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        chat_type: input.chatType,
        message_type: input.file ? 'file' : 'text',
        content: input.file
          ? JSON.stringify({ file_key: input.file.key, file_name: input.file.name })
          : JSON.stringify({ text }),
        create_time: '1700000000000',
        root_id: 'om_root',
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
  identity?: {
    userId: string;
    companyId: string;
    aiRole: string;
    channel: 'lark';
  };
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
   * Untagged-group policy. Production resolves these from validated env with
   * defaults; tests must state them, because an unset value is not the default
   * and a silently-off policy would make a gate look like it works when the
   * message simply never reached it.
   */
  untaggedPolicy?: {
    LARK_UNTAGGED_GROUP_TEXT_RETENTION: 'retain' | 'off';
    LARK_UNTAGGED_GROUP_ATTACHMENTS: 'ignore' | 'process';
  };
} = {}) {
  const order: string[] = [];
  const ingestionJobs: unknown[] = [];
  const retainedMessages: Array<Record<string, unknown>> = [];
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
    LARK_UNTAGGED_GROUP_TEXT_RETENTION: 'retain',
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
        return ok(options.identity ?? {
          userId: 'user-1',
          companyId: 'company-1',
          aiRole: 'MEMBER',
          channel: 'lark',
        });
      },
      prepareLarkLogin: async () => ok(null),
    } as any,
    conversationRepo: {} as any,
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
    // Both spies stand in for the side effects the untagged policy governs:
    // `ingestionQueue` is where an attachment becomes indexed company knowledge,
    // and `chatContextService` is where a message enters the room transcript.
    ingestionQueue: {
      enqueue: async (job: unknown) => {
        order.push('ingest');
        ingestionJobs.push(job);
      },
    } as any,
    chatContextService: {
      appendMessage: async (message: Record<string, unknown>) => {
        order.push('retain');
        retainedMessages.push(message);
        return ok(null);
      },
    } as any,
    cache: { setNx: async () => ok(true) } as any,
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
      messageId: 'om_1',
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
    status,
    responseBody,
    order,
    engineInputs,
    serializerKeys,
    identityLookups,
    logEvents,
    ingestionJobs,
    retainedMessages,
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
 * Attachment preparation reaches Lark for a tenant token and the file bytes.
 * These tests are about whether preparation is *entered*, not whether the
 * download succeeds, and a unit test must not depend on the network. Refusing
 * the fetch exercises the same path: the download failure is non-fatal, so the
 * attachment still reaches the ingestion queue as a key-only job.
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

describe('Lark untagged group policy', () => {
  it('does not download, OCR, or index a file shared without mentioning Divo', async () => {
    const outbound: string[] = [];
    const result = await withStubbedFetch(async calls => {
      const value = await runWebhook(makeEvent({
        chatType: 'group',
        file: { key: 'file_v3_secret', name: 'salaries.xlsx' },
      }));
      outbound.push(...calls);
      return value;
    });

    // Asserted directly rather than inferred from the absence of an ingestion
    // job: "did not index" and "did not leave Lark" are different claims, and
    // only this one fails if the download ever moves out of the gated helper.
    assert.deepEqual(outbound, [], 'nothing was fetched from Lark');
    assert.equal(result.status, 200);
    // Preparing this attachment would have pulled the file out of Lark, OCR'd
    // it, pushed it to a CDN, and indexed it as shared company knowledge — all
    // for a message nobody addressed to Divo.
    assert.deepEqual(result.ingestionJobs, [], 'no attachment was indexed');
    assert.ok(!result.order.includes('ingest'), 'ingestion queue never touched');
    assert.ok(!result.order.includes('engine'), 'engine did not run');
    // Nothing is retained either: the filename is all that survived parsing, and
    // a file message carries no text to keep.
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

  it('adds no transcript entry for an untagged group message when retention is off', async () => {
    const result = await runWebhook(makeEvent({ chatType: 'group' }), {
      untaggedPolicy: {
        LARK_UNTAGGED_GROUP_TEXT_RETENTION: 'off',
        LARK_UNTAGGED_GROUP_ATTACHMENTS: 'ignore',
      },
    });

    assert.deepEqual(result.retainedMessages, [], 'no transcript entry');
    assert.ok(!result.order.includes('retain'), 'context service never called');

    // Retention 'off' governs the room transcript, and nothing more. The raw
    // event was already written to the durable ingress receipt before any
    // policy was consulted, and no code path ever deletes it. Pinned here so
    // the setting is not mistaken for a promise that Divo stored nothing.
    const payload = result.acceptedPayloads[0] as Record<string, any>;
    assert.ok(payload, 'the message was still accepted durably');
    assert.match(
      payload['event']['message']['content'],
      /help/,
      'the untagged text survives verbatim in the ingress receipt',
    );
  });

  it('reaches attachment preparation when a deployment opts in', async () => {
    // Guards the over-blocking failure mode: with only untagged-and-ignored
    // cases, hard-wiring the gate to false would leave every test green while
    // attachment ingestion was silently dead.
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      file: { key: 'file_v3_shared', name: 'roadmap.pdf' },
    }), {
      untaggedPolicy: {
        LARK_UNTAGGED_GROUP_TEXT_RETENTION: 'retain',
        LARK_UNTAGGED_GROUP_ATTACHMENTS: 'process',
      },
    }));

    assert.equal(result.ingestionJobs.length, 1, 'opt-in reaches the ingestion queue');
    const job = result.ingestionJobs[0] as Record<string, unknown>;
    assert.equal(job['fileName'], 'roadmap.pdf');
    assert.equal(job['visibility'], 'shared');
    assert.ok(!result.order.includes('engine'), 'opting in does not make Divo reply');
  });

  it('still ingests a file on a message that does address Divo', async () => {
    const result = await withStubbedFetch(() => runWebhook(makeEvent({
      chatType: 'group',
      mentionsBot: true,
      file: { key: 'file_v3_asked', name: 'contract.pdf' },
    })));

    // The policy governs what Divo takes uninvited; being asked is the
    // invitation, so the default 'ignore' setting must not gate this.
    assert.equal(result.ingestionJobs.length, 1, 'an addressed file is ingested');
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
