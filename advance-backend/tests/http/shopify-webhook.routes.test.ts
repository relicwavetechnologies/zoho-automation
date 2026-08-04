import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { createShopifyWebhookRoutes } from '../../src/http/shopify/shopify-webhook.routes.ts';
import { err, ok } from '../../src/shared/result.ts';

const secret = 'webhook-secret';
const logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function () { return this; },
} as any;

describe('Shopify webhook routes', () => {
  it('rejects an invalid HMAC before touching durable state', async () => {
    let calls = 0;
    const repository = { process: async () => { calls += 1; return ok({ duplicate: false, affectedConnections: 0 }); } };
    const result = await callWebhook(repository, { hmac: 'invalid' });
    assert.equal(result.status, 401);
    assert.equal(calls, 0);
  });

  it('atomically requests receipt and store revocation for uninstall events', async () => {
    const calls: unknown[] = [];
    const repository = {
      process: async (input: unknown) => {
        calls.push(input);
        return ok({ duplicate: false, affectedConnections: 2 });
      },
    };
    const result = await callWebhook(repository);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
    assert.deepEqual(calls, [{
      webhookId: 'webhook-1',
      topic: 'app/uninstalled',
      shopDomain: 'demo.myshopify.com',
      action: 'revoke',
    }]);
  });

  it('accepts Shopify uninstall payloads with null domains using the signed shop header', async () => {
    const calls: unknown[] = [];
    const repository = {
      process: async (input: unknown) => {
        calls.push(input);
        return ok({ duplicate: false, affectedConnections: 1 });
      },
    };
    const result = await callWebhook(repository, {
      rawBody: JSON.stringify({ id: 123, domain: null, myshopify_domain: null }),
      shopDomain: 'demo.myshopify.com',
    });
    assert.equal(result.status, 200);
    assert.equal((calls[0] as Record<string, unknown>)['shopDomain'], 'demo.myshopify.com');
    assert.equal((calls[0] as Record<string, unknown>)['action'], 'revoke');
  });

  it('rejects uninstall payloads whose embedded domain conflicts with the signed shop header', async () => {
    let calls = 0;
    const repository = { process: async () => { calls += 1; return ok({ duplicate: false, affectedConnections: 0 }); } };
    const result = await callWebhook(repository, {
      rawBody: JSON.stringify({ id: 123, domain: 'other.myshopify.com', myshopify_domain: null }),
      shopDomain: 'demo.myshopify.com',
    });
    assert.equal(result.status, 400);
    assert.equal(calls, 0);
  });

  it('acknowledges durable duplicates without repeating lifecycle work', async () => {
    const repository = { process: async () => ok({ duplicate: true, affectedConnections: 0 }) };
    const result = await callWebhook(repository);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, duplicate: true });
  });

  it('fails with 503 when the atomic receipt/lifecycle checkpoint is unavailable', async () => {
    const repository = { process: async () => err(new Error('database unavailable') as never) };
    const result = await callWebhook(repository);
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: 'webhook_checkpoint_unavailable' });
  });

  it('acknowledges unknown signed topics without creating a misleading receipt', async () => {
    let calls = 0;
    const repository = { process: async () => { calls += 1; return ok({ duplicate: false, affectedConnections: 0 }); } };
    const result = await callWebhook(repository, { topic: 'orders/create' });
    assert.equal(result.status, 204);
    assert.equal(calls, 0);
  });

  it('requests irreversible store erasure only for the signed shop/redact topic', async () => {
    const calls: unknown[] = [];
    const repository = { process: async (input: unknown) => { calls.push(input); return ok({ duplicate: false, affectedConnections: 1 }); } };
    const result = await callWebhook(repository, {
      topic: 'shop/redact',
      rawBody: JSON.stringify({ shop_id: 1, shop_domain: 'demo.myshopify.com' }),
    });
    assert.equal(result.status, 200);
    assert.equal((calls[0] as Record<string, unknown>)['action'], 'erase');
  });

  it('records data-request receipts without customer data and purges redaction traces', async () => {
    const calls: unknown[] = [];
    const repository = { process: async (input: unknown) => { calls.push(input); return ok({ duplicate: false, affectedConnections: 0 }); } };
    await callWebhook(repository, {
      topic: 'customers/data_request',
      rawBody: JSON.stringify({ shop_domain: 'demo.myshopify.com', data_request: { id: 99 }, customer: { id: 42 }, orders_requested: [7, 8] }),
    });
    await callWebhook(repository, {
      topic: 'customers/redact',
      rawBody: JSON.stringify({ shop_domain: 'demo.myshopify.com', customer: { id: 42 }, orders_to_redact: [7, 8] }),
    });
    assert.deepEqual(calls.map(call => (call as Record<string, unknown>)['action']), [
      'record_data_request', 'purge_customer_traces',
    ]);
    assert.deepEqual((calls[0] as Record<string, unknown>)['privacyRequest'], {
      requestId: '99', customerId: '42', orderIds: ['7', '8'],
    });
    assert.deepEqual((calls[1] as Record<string, unknown>)['privacyRequest'], {
      customerId: '42', orderIds: ['7', '8'],
    });
  });

  it('rejects replay under a substituted topic or target-shop header', async () => {
    let calls = 0;
    const repository = { process: async () => { calls += 1; return ok({ duplicate: false, affectedConnections: 0 }); } };
    const signedDataRequest = JSON.stringify({
      shop_domain: 'demo.myshopify.com',
      data_request: { id: 99 },
      customer: { id: 42 },
      orders_requested: [],
    });
    const wrongTopic = await callWebhook(repository, {
      topic: 'shop/redact',
      rawBody: signedDataRequest,
    });
    const wrongShop = await callWebhook(repository, {
      topic: 'customers/data_request',
      rawBody: signedDataRequest,
      shopDomain: 'other.myshopify.com',
    });
    assert.equal(wrongTopic.status, 400);
    assert.equal(wrongShop.status, 400);
    assert.equal(calls, 0);
  });
});

async function callWebhook(
  repository: { process: (input: any) => Promise<any> },
  overrides: { topic?: string; hmac?: string; rawBody?: string; shopDomain?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const rawBody = overrides.rawBody ?? JSON.stringify({ id: 1, domain: 'demo.myshopify.com' });
  const topic = overrides.topic ?? 'app/uninstalled';
  const hmac = overrides.hmac ?? createHmac('sha256', secret).update(rawBody).digest('base64');
  const router = createShopifyWebhookRoutes({ clientSecret: secret, repository: repository as never, logger });
  const layer = (router as any).stack.find((item: any) => item.route?.path === '/' && item.route?.methods?.post);
  assert.ok(layer);
  const req = {
    method: 'POST',
    path: '/',
    headers: {
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-webhook-id': 'webhook-1',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': overrides.shopDomain ?? 'demo.myshopify.com',
    },
    rawBody,
  } as unknown as Request;
  let status = 200;
  let body: unknown;
  const res = {
    status: (value: number) => { status = value; return res; },
    json: (value: unknown) => { body = value; return res; },
    end: () => res,
  } as unknown as Response;
  await layer.route.stack[0].handle(req, res);
  return { status, body };
}
