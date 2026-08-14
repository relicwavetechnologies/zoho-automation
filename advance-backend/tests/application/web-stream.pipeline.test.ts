import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import express from 'express';
import { LarkPiRuntimeService } from '../../src/application/runtime/lark-pi-runtime.service.ts';
import { WebRunRegistry } from '../../src/application/runtime/web-run-registry.ts';
import { WebRunService } from '../../src/application/runtime/web-run.service.ts';
import { createWebChatRoutes } from '../../src/http/desktop/web-chat.routes.ts';

// The controller is intentionally JavaScript: this test crosses the real
// process boundary protocol without inventing a TypeScript-only facsimile.
// @ts-expect-error no declarations are published for the local controller
import { createControllerServer } from '../../../divo-pi/divo/local-rpc-server.mjs';

const logger = {
  child() { return this; }, info() {}, warn() {}, error() {}, debug() {},
} as any;

const listen = async (server: Server): Promise<number> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind TCP');
  return address.port;
};

const close = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
};

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  current: string,
  needle: string,
): Promise<string> {
  let text = current;
  while (!text.includes(needle)) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`stream did not produce ${needle}`)), 1_000);
      }),
    ]);
    if (chunk.done) throw new Error(`stream ended before ${needle}`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

test('a provider delta crosses controller NDJSON, backend parsing, and web SSE before completion', async t => {
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const controller = createControllerServer({
    resolveLease: async () => ({
      profile: 'pipeline-user',
      thread: 'pipeline-thread',
      backendUrl: 'https://backend.example',
      token: 'signed-lease',
      userId: 'user-1',
      companyId: 'company-1',
      instanceId: 'pi-local-1',
    }),
    executeRuntime: async (_runtime: unknown, _message: string, options: any) => {
      options.onProgress({ type: 'answer_delta', index: 0, delta: 'Hello' });
      await finished;
      options.onProgress({ type: 'answer_delta', index: 0, delta: ' world' });
      return { text: 'Hello world' };
    },
  });
  const controllerPort = await listen(controller.server);
  t.after(() => close(controller.server));

  const piRuntime = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: `http://127.0.0.1:${controllerPort}`,
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 60,
    runTimeoutMs: 2_000,
  });
  const webRuns = new WebRunService({ piRuntime, logger });
  const registry = new WebRunRegistry({ logger });
  t.after(() => registry.clear());

  const app = express();
  app.use((_req, res, next) => {
    res.locals['companyId'] = 'company-1';
    res.locals['userId'] = 'user-1';
    res.locals['aiRole'] = 'MEMBER';
    res.locals['sessionId'] = 'session-1';
    next();
  });
  app.use('/api/web-chat', createWebChatRoutes({
    webRuns,
    registry,
    threads: {} as any,
    logger,
    maxUploadBytes: 1_024,
  }));
  const backend = createServer(app);
  const backendPort = await listen(backend);
  t.after(() => close(backend));

  const body = new FormData();
  body.set('threadId', 'web_pipeline1');
  body.set('text', 'Stream this answer');
  const response = await fetch(`http://127.0.0.1:${backendPort}/api/web-chat/runs`, {
    method: 'POST',
    body,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.ok(response.body);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let stream = await readUntil(reader, decoder, '', 'event: answer_delta');
  assert.match(stream, /"delta":"Hello"/);
  assert.doesNotMatch(stream, /event: final/);

  finish();
  stream = await readUntil(reader, decoder, stream, 'event: final');
  assert.match(stream, /"text":"Hello world"/);
  await reader.cancel();
});
