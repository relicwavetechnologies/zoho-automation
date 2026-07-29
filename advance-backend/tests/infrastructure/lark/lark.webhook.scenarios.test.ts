import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { ChatMessageSerializer } from '../../../src/application/orchestration/chat-message-serializer.ts';
import { LarkIngressWorker } from '../../../src/application/lark-ingress/lark-ingress.worker.ts';
import { LarkChannelAdapter } from '../../../src/infrastructure/channels/lark/lark.adapter.ts';
import {
  createLarkWebhookRoutes,
  processAcceptedLarkReceipt,
} from '../../../src/infrastructure/channels/lark/lark.webhook.routes.ts';
import type { Logger } from '../../../src/shared/logger.ts';
import { ok } from '../../../src/shared/result.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

function makeEvent(input: {
  eventId: string;
  messageId: string;
  chatId: string;
  senderOpenId: string;
  rootMessageId?: string;
  threadId?: string;
}) {
  return {
    header: {
      event_type: 'im.message.receive_v1',
      token: 'verify',
      event_id: input.eventId,
      tenant_key: 'tenant-1',
      app_id: 'app-1',
    },
    event: {
      sender: {
        sender_id: { open_id: input.senderOpenId },
        sender_type: 'user',
      },
      message: {
        message_id: input.messageId,
        chat_id: input.chatId,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 help' }),
        create_time: '1700000000000',
        mentions: [{ key: '@_user_1', name: 'Renamed Bot', id: { open_id: 'ou_bot' } }],
        ...(input.rootMessageId ? { root_id: input.rootMessageId } : {}),
        ...(input.threadId ? { thread_id: input.threadId } : {}),
      },
    },
  };
}

function createHarness(
  runEngine: (messageId: string, userId: string) => Promise<void>,
) {
  const receipts = new Map<string, {
    tenantKey: string;
    messageId: string;
    payload: Record<string, unknown>;
    status: 'accepted' | 'processing' | 'completed' | 'failed';
  }>();
  const activeJobs = new Set<Promise<void>>();
  const serializer = new ChatMessageSerializer();
  const adapter = new LarkChannelAdapter({
    env: {
      LARK_APP_ID: 'app',
      LARK_APP_SECRET: 'secret',
      LARK_BOT_NAME: 'Divo',
      LARK_VERIFICATION_TOKEN: 'verify',
    } as any,
    logger: noopLogger,
    botOpenId: 'ou_bot',
  });
  adapter.sendFinalReply = async () => ok({ messageId: 'om_reply' });
  const receiptRepo = {
    accept: async (input: {
      tenantKey: string;
      messageId: string;
      payload: Record<string, unknown>;
    }) => {
      const receiptId = `${input.tenantKey}:${input.messageId}`;
      if (receipts.has(receiptId)) {
        return ok({ receiptId, isNew: false });
      }
      receipts.set(receiptId, { ...input, status: 'accepted' });
      return ok({ receiptId, isNew: true });
    },
    markQueued: async () => ok(undefined),
    claim: async (receiptId: string) => {
      const receipt = receipts.get(receiptId);
      if (!receipt || receipt.status === 'completed' || receipt.status === 'dead') {
        return ok({ outcome: 'terminal' });
      }
      receipt.status = 'processing';
      return ok({
        outcome: 'claimed',
        receipt: { receiptId, acceptedAt: new Date(), attempts: 1, ...receipt },
      });
    },
    markCompleted: async (receiptId: string) => {
      const receipt = receipts.get(receiptId);
      if (receipt) receipt.status = 'completed';
      return ok(undefined);
    },
    markFailed: async (receiptId: string) => {
      const receipt = receipts.get(receiptId);
      if (receipt && receipt.status !== 'completed') receipt.status = 'failed';
      return ok(undefined);
    },
    listRecoverable: async () => ok([]),
    listExhausted: async () => ok([]),
  };
  let worker: LarkIngressWorker;
  const ingressQueue = {
    enqueue: async (receiptId: string) => {
      const job = Promise.resolve()
        .then(() => worker.process({ data: { receiptId } } as any));
      activeJobs.add(job);
      void job.finally(() => activeJobs.delete(job));
      return `lark_ingress_${receiptId}`;
    },
  };
  const routeDeps = {
    adapter,
    piRuntime: {
      run: async (input: any) => {
        await runEngine(String(input.incoming.messageId), String(input.runContext.userId));
        return { text: 'done' };
      },
    } as any,
    channelIdentityRepo: {
      resolveLarkTenantCompanyId: async () => ok('company-1'),
      resolveByLarkTenantIdentity: async (openId: string) => ok({
        userId: `user:${openId}`,
        companyId: 'company-1',
        aiRole: 'MEMBER',
        channel: 'lark',
      }),
    } as any,
    conversationRepo: {} as any,
    ingressReceiptRepo: receiptRepo as any,
    ingressQueue,
    logger: noopLogger,
    env: {
      LARK_APP_ID: 'app',
      LARK_APP_SECRET: 'secret',
      LARK_BOT_NAME: 'Divo',
      LARK_VERIFICATION_TOKEN: 'verify',
    } as any,
    cache: {} as any,
    serializer,
  } as any;
  worker = new LarkIngressWorker({
    redisUrl: 'redis://unused',
    queue: ingressQueue as any,
    receiptRepo: receiptRepo as any,
    processReceipt: receipt => processAcceptedLarkReceipt(receipt, routeDeps),
    logger: noopLogger,
  });
  const router = createLarkWebhookRoutes(routeDeps);
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === '/events');
  assert.ok(layer, 'events route');

  return {
    serializer,
    async waitForIdle(): Promise<void> {
      await waitFor(() => activeJobs.size === 0 && serializer.activeChats === 0);
    },
    async deliver(body: unknown): Promise<void> {
      let status = 200;
      let responseBody: unknown;
      const req = {
        method: 'POST',
        path: '/events',
        headers: {},
        body,
      } as unknown as Request;
      const res = {
        status: (value: number) => { status = value; return res; },
        json: (value: unknown) => { responseBody = value; return res; },
      } as unknown as Response;
      await Promise.resolve(layer.route.stack[0].handle(req, res, () => {}));
      assert.equal(status, 200);
      assert.deepEqual(responseBody, { ok: true });
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Lark scenario');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

describe('Lark webhook scenarios', () => {
  it('processes a retried delivery only once', async () => {
    const calls: string[] = [];
    const harness = createHarness(async messageId => { calls.push(messageId); });
    const event = makeEvent({
      eventId: 'event-retry',
      messageId: 'message-retry',
      chatId: 'group-1',
      senderOpenId: 'sender-1',
    });

    await harness.deliver(event);
    await harness.waitForIdle();
    await harness.deliver(event);
    await harness.waitForIdle();

    assert.deepEqual(calls, ['message-retry']);
  });

  it('runs independent top-level group requesters concurrently', async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const harness = createHarness(async (messageId, userId) => {
      events.push(`start:${messageId}:${userId}`);
      if (messageId === 'message-1') {
        await new Promise<void>(resolve => { releaseFirst = resolve; });
      }
      events.push(`end:${messageId}`);
    });

    await harness.deliver(makeEvent({
      eventId: 'event-1',
      messageId: 'message-1',
      chatId: 'group-1',
      senderOpenId: 'sender-1',
    }));
    await harness.deliver(makeEvent({
      eventId: 'event-2',
      messageId: 'message-2',
      chatId: 'group-1',
      senderOpenId: 'sender-2',
    }));
    await harness.deliver(makeEvent({
      eventId: 'event-3',
      messageId: 'message-3',
      chatId: 'group-2',
      senderOpenId: 'sender-3',
    }));

    await waitFor(() => events.includes('end:message-2') && events.includes('end:message-3'));
    assert.ok(events.includes('start:message-1:user:sender-1'));
    assert.ok(events.includes('start:message-2:user:sender-2'));
    assert.ok(events.includes('start:message-3:user:sender-3'));
    assert.ok(!events.includes('end:message-1'));

    releaseFirst?.();
    await harness.waitForIdle();
    assert.ok(events.includes('end:message-1'));
  });

  it('keeps top-level requests from the same group requester FIFO', async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const harness = createHarness(async messageId => {
      events.push(`start:${messageId}`);
      if (messageId === 'message-1') {
        await new Promise<void>(resolve => { releaseFirst = resolve; });
      }
      events.push(`end:${messageId}`);
    });

    await harness.deliver(makeEvent({
      eventId: 'event-1',
      messageId: 'message-1',
      chatId: 'group-1',
      senderOpenId: 'sender-1',
    }));
    await harness.deliver(makeEvent({
      eventId: 'event-2',
      messageId: 'message-2',
      chatId: 'group-1',
      senderOpenId: 'sender-1',
    }));

    await waitFor(() => events.includes('start:message-1'));
    assert.deepEqual(events, ['start:message-1']);

    releaseFirst?.();
    await harness.waitForIdle();
    assert.deepEqual(events, [
      'start:message-1',
      'end:message-1',
      'start:message-2',
      'end:message-2',
    ]);
  });

  it('keeps different requesters in the same group thread FIFO', async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const harness = createHarness(async messageId => {
      events.push(`start:${messageId}`);
      if (messageId === 'message-1') {
        await new Promise<void>(resolve => { releaseFirst = resolve; });
      }
      events.push(`end:${messageId}`);
    });

    await harness.deliver(makeEvent({
      eventId: 'event-1',
      messageId: 'message-1',
      chatId: 'group-1',
      senderOpenId: 'sender-1',
      threadId: 'thread-1',
    }));
    await harness.deliver(makeEvent({
      eventId: 'event-2',
      messageId: 'message-2',
      chatId: 'group-1',
      senderOpenId: 'sender-2',
      threadId: 'thread-1',
    }));

    await waitFor(() => events.includes('start:message-1'));
    assert.deepEqual(events, ['start:message-1']);

    releaseFirst?.();
    await harness.waitForIdle();
    assert.deepEqual(events, [
      'start:message-1',
      'end:message-1',
      'start:message-2',
      'end:message-2',
    ]);
  });
});
