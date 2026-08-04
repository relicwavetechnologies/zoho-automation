import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { createHealthRoutes } from '../../src/http/health.routes.ts';

function router(
  callback?: string,
  knowledgeHealth?: () => Promise<{ status: 'ok' | 'degraded' }>,
  callbackProbe?: (url: string) => Promise<boolean>,
) {
  return createHealthRoutes({
    $queryRaw: async () => [{ ok: 1 }],
  } as any, {
    ...(callback ? { larkCardCallbackUrl: callback } : {}),
    ...(callbackProbe ? { larkCardCallbackProbe: callbackProbe } : {}),
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
  it('reports a reachable human-card callback without claiming provider-console verification', async () => {
    const response = await callGet(router(
      'https://example-tunnel.test/webhooks/lark/events',
      undefined,
      async () => true,
    ), '/lark-card-callback');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      status: 'reachable',
      callbackPath: '/webhooks/lark/events',
      providerConfiguration: 'unverified',
    });
    assert.doesNotMatch(JSON.stringify(response.body), /example-tunnel/);
  });

  it('fails readiness when the configured callback URL is unreachable', async () => {
    const response = await callGet(router(
      'https://expired-tunnel.test/webhooks/lark/events',
      undefined,
      async () => false,
    ), '/lark-card-callback');
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      status: 'degraded',
      reason: 'callback_url_unreachable',
      callbackPath: '/webhooks/lark/events',
      providerConfiguration: 'unverified',
    });
    assert.doesNotMatch(JSON.stringify(response.body), /expired-tunnel/);
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
