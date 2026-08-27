import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { createWhatsappWebhookRoutes } from '../../src/http/whatsapp/whatsapp.webhook.routes.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child() { return this; },
} as any;

const envelope = {
  event: 'message.received',
  sessionId: 'gateway-session-1',
  data: {
    id: 'wa-1',
    from: '919876543210@c.us',
    body: 'Can you send the quote?',
    timestamp: 1_700_000_000,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function withServer(
  ingest: { admit: (...args: any[]) => Promise<any>; process: (...args: any[]) => Promise<any> },
  run: (url: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json({
    verify(req, _res, bytes) {
      (req as unknown as Record<string, unknown>)['rawBody'] = bytes.toString('utf8');
    },
  }));
  app.use('/api/whatsapp', createWhatsappWebhookRoutes({
    ingest: ingest as any,
    logger: noopLogger,
  }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  try {
    await run(`http://127.0.0.1:${address.port}/api/whatsapp/webhook`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const post = (url: string) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(envelope),
});

describe('WhatsApp webhook durability', () => {
  it('does not acknowledge before durable admission completes', async () => {
    const admission = deferred<any>();
    const processing = deferred<any>();
    let processStarted = false;
    await withServer({
      admit: async () => admission.promise,
      process: async () => { processStarted = true; return processing.promise; },
    }, async url => {
      let settled = false;
      const responsePromise = post(url).then(response => { settled = true; return response; });
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(settled, false, '200 would close OpenWA retry before the receipt exists');

      admission.resolve({ status: 'accepted', receiptId: 'receipt-1' });
      const response = await responsePromise;
      assert.equal(response.status, 200);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(processStarted, true);
      processing.resolve({ status: 'stored', chatId: 'chat-1' });
    });
  });

  it('returns a retryable 503 when receipt persistence fails', async () => {
    let processCalls = 0;
    await withServer({
      admit: async () => ({ status: 'failed', error: 'database unavailable' }),
      process: async () => { processCalls += 1; },
    }, async url => {
      const response = await post(url);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'whatsapp_ingress_unavailable' });
      assert.equal(processCalls, 0);
    });
  });

  it('acknowledges a duplicate without processing it again', async () => {
    let processCalls = 0;
    await withServer({
      admit: async () => ({ status: 'duplicate' }),
      process: async () => { processCalls += 1; },
    }, async url => {
      const response = await post(url);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, duplicate: true });
      assert.equal(processCalls, 0);
    });
  });
});
