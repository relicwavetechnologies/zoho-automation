/**
 * The duplicate guard around `sendFinalReply`.
 *
 * The unit pieces are covered elsewhere — the key in tests/domain, the outcomes
 * in the repository test, the classification in the policy test. What only this
 * file can show is that the adapter actually consults the guard before sending,
 * records the result afterwards, and degrades the way it claims to when the
 * guard is unavailable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LarkChannelAdapter } from '../../../src/infrastructure/channels/lark/lark.adapter.ts';
import { LarkApiError } from '../../../src/infrastructure/channels/lark/clients/lark-http.client.ts';
import type { ConversationHandle } from '../../../src/application/channels/channel.adapter.ts';
import type { FinalReply } from '../../../src/domain/channel/outbound.ts';
import { asChatId, asCorrelationId } from '../../../src/shared/ids.ts';
import type { Logger } from '../../../src/shared/logger.ts';
import { ok } from '../../../src/shared/result.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

const fakeEnv = {
  LARK_APP_ID: 'app_001',
  LARK_APP_SECRET: 'secret',
  LARK_BOT_NAME: 'Divo',
} as any;

const conversation: ConversationHandle = {
  channel: 'lark',
  chatId: asChatId('oc_1'),
  correlationId: asCorrelationId('corr-1'),
};

const reply: FinalReply = { kind: 'final', text: 'the answer', format: 'text' };

interface Sent {
  content: string;
  idempotencyKey?: string;
}

/**
 * Build an adapter whose messaging client is replaced with a recorder.
 *
 * The client is private, so it is swapped after construction. That is a smaller
 * lie than reaching for the network: what is under test is the ordering of
 * reserve → send → record, not the HTTP call.
 */
function makeAdapter(options: {
  deliveryRepo?: unknown;
  onSend?: () => void;
}) {
  const sent: Sent[] = [];
  const adapter = new LarkChannelAdapter({
    env: fakeEnv,
    logger: noopLogger,
    botOpenId: 'ou_bot',
    ...(options.deliveryRepo ? { deliveryRepo: options.deliveryRepo as any } : {}),
  });

  (adapter as any).messagingClient = {
    sendMessage: async (
      _chatId: string,
      content: string,
      _replyTo?: string,
      _inThread?: boolean,
      idempotencyKey?: string,
    ) => {
      options.onSend?.();
      sent.push({ content, ...(idempotencyKey ? { idempotencyKey } : {}) });
      return { messageId: 'om_new' };
    },
    updateMessage: async () => {},
  };

  return { adapter, sent };
}

/** A repository stub that records what the adapter asked it. */
function makeRepo(reservation: unknown) {
  const calls: { reserved: any[]; delivered: any[]; failed: any[] } = {
    reserved: [], delivered: [], failed: [],
  };
  return {
    calls,
    repo: {
      reserve: async (input: unknown) => {
        calls.reserved.push(input);
        return ok(reservation);
      },
      markDelivered: async (id: string, providerMessageId?: string) => {
        calls.delivered.push({ id, providerMessageId });
        return ok(undefined);
      },
      markFailed: async (id: string, error: unknown, opts?: unknown) => {
        calls.failed.push({ id, error, opts });
        return ok(undefined);
      },
      listRetryable: async () => ok([]),
    },
  };
}

const RESERVED = {
  outcome: 'reserved',
  record: { deliveryId: 'd-1', attempts: 1, firstAttemptAt: new Date() },
};

describe('final reply duplicate guard', () => {
  it('reserves before sending, keyed on the run', async () => {
    const { repo, calls } = makeRepo(RESERVED);
    const { adapter, sent } = makeAdapter({ deliveryRepo: repo });

    const result = await adapter.sendFinalReply(conversation, reply);

    assert.equal(result.ok, true);
    assert.equal(calls.reserved.length, 1);
    assert.equal(calls.reserved[0].idempotencyKey, 'corr-1:final:0');
    assert.equal(calls.reserved[0].runKey, 'corr-1');
    assert.equal(calls.reserved[0].purpose, 'final');
    assert.equal(sent.length, 1, 'the reply was sent once');
  });

  it('does not send again when the segment was already delivered', async () => {
    const { repo } = makeRepo({
      outcome: 'delivered',
      record: { deliveryId: 'd-1', attempts: 1, firstAttemptAt: new Date(), providerMessageId: 'om_first' },
    });
    const { adapter, sent } = makeAdapter({ deliveryRepo: repo });

    const result = await adapter.sendFinalReply(conversation, reply);

    // The scenario this exists for: the run is retried after its HTTP response
    // was lost, and the user must not receive the answer twice.
    assert.deepEqual(sent, [], 'nothing was sent');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(String(result.value.messageId), 'om_first');
  });

  it('refuses to send while another attempt holds the reservation', async () => {
    const { repo } = makeRepo({ outcome: 'inFlight' });
    const { adapter, sent } = makeAdapter({ deliveryRepo: repo });

    const result = await adapter.sendFinalReply(conversation, reply);

    assert.deepEqual(sent, []);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.payload.reason, 'ambiguous_delivery');
  });

  it('does not revive a delivery that was abandoned', async () => {
    const { repo } = makeRepo({ outcome: 'abandoned' });
    const { adapter, sent } = makeAdapter({ deliveryRepo: repo });

    const result = await adapter.sendFinalReply(conversation, reply);

    assert.deepEqual(sent, []);
    assert.equal(result.ok, false);
  });

  it('records the provider message once the send lands', async () => {
    const { repo, calls } = makeRepo(RESERVED);
    const { adapter } = makeAdapter({ deliveryRepo: repo });

    await adapter.sendFinalReply(conversation, reply);

    assert.deepEqual(calls.delivered, [{ id: 'd-1', providerMessageId: 'om_new' }]);
    assert.deepEqual(calls.failed, []);
  });

  it('carries an idempotency key Lark can deduplicate on', async () => {
    const { repo } = makeRepo(RESERVED);
    const { adapter, sent } = makeAdapter({ deliveryRepo: repo });

    await adapter.sendFinalReply(conversation, reply);

    // The database guard cannot see a send that succeeded at Lark but whose
    // response was lost. This is the half that closes that window.
    assert.equal(sent[0]?.idempotencyKey, 'corr-1:final:0');
    assert.ok((sent[0]?.idempotencyKey?.length ?? 0) <= 50);
  });

  it('sends unguarded rather than staying silent when the guard is unavailable', async () => {
    const repo = {
      reserve: async () => ({ ok: false as const, error: new Error('db down') }),
      markDelivered: async () => ok(undefined),
      markFailed: async () => ok(undefined),
      listRetryable: async () => ok([]),
    };
    const { adapter, sent } = makeAdapter({ deliveryRepo: repo });

    const result = await adapter.sendFinalReply(conversation, reply);

    // A duplicate is recoverable; silence, where the user asked and got
    // nothing, is not.
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
  });

  it('keeps working with no delivery repository at all', async () => {
    const { adapter, sent } = makeAdapter({});

    const result = await adapter.sendFinalReply(conversation, reply);

    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.idempotencyKey, undefined);
  });
});

describe('final reply failure recording', () => {
  it('marks a refused request terminal so it is not retried forever', async () => {
    const { repo, calls } = makeRepo(RESERVED);
    const { adapter } = makeAdapter({
      deliveryRepo: repo,
      onSend: () => { throw new LarkApiError('bad card', 400); },
    });

    const result = await adapter.sendFinalReply(conversation, reply);

    assert.equal(result.ok, false);
    assert.equal(calls.failed.length, 1);
    assert.equal(calls.failed[0].opts.terminal, true);
    assert.equal(calls.failed[0].opts.ambiguous, false);
    assert.deepEqual(calls.delivered, []);
  });

  it('keeps a provider outage retryable and flags it ambiguous', async () => {
    const { repo, calls } = makeRepo(RESERVED);
    const { adapter } = makeAdapter({
      deliveryRepo: repo,
      onSend: () => { throw new LarkApiError('boom', 503); },
    });

    await adapter.sendFinalReply(conversation, reply);

    assert.equal(calls.failed[0].opts.terminal, false);
    assert.equal(calls.failed[0].opts.ambiguous, true);
  });
});
