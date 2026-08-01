import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { createHealthRoutes } from '../../src/http/health.routes.ts';

function router(callback?: string, knowledgeHealth?: () => Promise<{ status: 'ok' | 'degraded' }>) {
  return createHealthRoutes({
    $queryRaw: async () => [{ ok: 1 }],
  } as any, {
    ...(callback ? { larkCardCallbackUrl: callback } : {}),
    ...(knowledgeHealth ? { knowledgeOperations: { health: knowledgeHealth } } : {}),
  });
}

async function callGet(
  target: ReturnType<typeof createHealthRoutes>,
  path: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const req = { method: 'GET', path } as unknown as Request;
    const res = {
      status: (next: number) => { status = next; return res; },
      json: (body: unknown) => { resolve({ status, body }); return res; },
    } as unknown as Response;
    const layer = (target as any).stack.find((candidate: any) =>
      candidate.route?.path === path && candidate.route.methods?.get);
    const handler = layer?.route?.stack?.[0]?.handle;
    if (!handler) return reject(new Error(`GET ${path} route not found`));
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

describe('health routes', () => {
  it('reports the configured human-card callback path without exposing its public host', async () => {
    const response = await callGet(router(
      'https://example-tunnel.test/webhooks/lark/events',
    ), '/lark-card-callback');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      status: 'ok',
      callbackPath: '/webhooks/lark/events',
    });
    assert.doesNotMatch(JSON.stringify(response.body), /example-tunnel/);
  });

  it('fails readiness when interactive cards have no callback configuration', async () => {
    const response = await callGet(router(), '/lark-card-callback');
    assert.equal(response.status, 503);
    assert.equal(response.body.reason, 'callback_not_configured');
  });

  it('reports canonical knowledge degradation as a dedicated readiness failure', async () => {
    const response = await callGet(router(undefined, async () => ({ status: 'degraded' })), '/knowledge');
    assert.equal(response.status, 503);
    assert.equal(response.body.status, 'degraded');
  });

  it('keeps knowledge readiness healthy when no pipeline backlog is degraded', async () => {
    const response = await callGet(router(undefined, async () => ({ status: 'ok' })), '/knowledge');
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
  });
});
