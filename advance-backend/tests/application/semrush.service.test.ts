import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SemrushService } from '../../src/application/semrush/semrush.service.ts';
import { SemrushServiceError } from '../../src/application/semrush/semrush.types.ts';

const logger = { info: () => undefined } as any;
const args = { operation: 'domain_overview', domain: 'example.com' } as const;

describe('SemrushService', () => {
  it('uses the backend key and fixed official client contract', async () => {
    const calls: unknown[] = [];
    const service = new SemrushService({
      fetch: async (input: unknown) => {
        calls.push(input);
        return { operation: 'domain_overview', status: 'complete', coverage: {}, rows: [{ Dn: 'example.com' }] };
      },
    } as any, 'server-key', logger);

    assert.deepEqual(await service.preflight(args), { configured: true, operation: 'domain_overview', apiVersion: 'v3', limits: { maxRowsPerRequest: 1_000 } });
    const result = await service.execute(args);
    assert.equal(result.status, 'complete');
    assert.deepEqual(calls, [{ apiKey: 'server-key', args }]);
  });

  it('blocks calls when no backend key is configured', async () => {
    const service = new SemrushService({ fetch: async () => { throw new Error('must not call'); } } as any, undefined, logger);
    await assert.rejects(
      () => service.execute(args),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'not_configured',
    );
  });

  it('caches the active webhook key across operations', async () => {
    const providerCalls: unknown[] = [];
    let webhookCalls = 0;
    const service = new SemrushService(
      {
        fetch: async (input: unknown) => {
          providerCalls.push(input);
          return { operation: 'domain_overview', status: 'complete', coverage: {}, rows: [{ Dn: 'example.com' }] };
        },
      } as any,
      'stale-static-key',
      logger,
      'https://keys.example.test/semrush',
      async () => {
        webhookCalls += 1;
        return Response.json({ api_key: 'active-key', status: 'active' });
      },
    );

    await service.execute(args);
    await service.execute(args);

    assert.equal(webhookCalls, 1);
    assert.deepEqual(providerCalls, [
      { apiKey: 'active-key', args },
      { apiKey: 'active-key', args },
    ]);
  });

  it('invalidates a rejected key, retries once with a different webhook key, and caches it', async () => {
    const providerKeys: string[] = [];
    const webhookKeys = ['expired-key', 'replacement-key'];
    let webhookCalls = 0;
    const service = new SemrushService(
      {
        fetch: async ({ apiKey }: { apiKey: string }) => {
          providerKeys.push(apiKey);
          if (apiKey === 'expired-key') {
            throw new SemrushServiceError('provider_auth_failed', 'Semrush rejected the configured API key.');
          }
          return { operation: 'domain_overview', status: 'complete', coverage: {}, rows: [{ Dn: 'example.com' }] };
        },
      } as any,
      undefined,
      logger,
      'https://keys.example.test/semrush',
      async () => Response.json({ api_key: webhookKeys[webhookCalls++], status: 'active' }),
    );

    await service.execute(args);
    await service.execute(args);

    assert.equal(webhookCalls, 2);
    assert.deepEqual(providerKeys, ['expired-key', 'replacement-key', 'replacement-key']);
  });

  it('does not retry a billed request when the webhook returns the same rejected key', async () => {
    let providerCalls = 0;
    let webhookCalls = 0;
    const service = new SemrushService(
      {
        fetch: async () => {
          providerCalls += 1;
          throw new SemrushServiceError('provider_auth_failed', 'Semrush rejected the configured API key.');
        },
      } as any,
      undefined,
      logger,
      'https://keys.example.test/semrush',
      async () => {
        webhookCalls += 1;
        return Response.json({ api_key: 'same-expired-key', status: 'active' });
      },
    );

    await assert.rejects(
      () => service.execute(args),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'provider_auth_failed',
    );

    assert.equal(webhookCalls, 2);
    assert.equal(providerCalls, 1);
  });

  it('invalidates a failed replacement so the next operation can fetch a newer key', async () => {
    const webhookKeys = ['expired-key', 'also-expired-key', 'working-key'];
    let webhookCalls = 0;
    const service = new SemrushService(
      {
        fetch: async ({ apiKey }: { apiKey: string }) => {
          if (apiKey !== 'working-key') {
            throw new SemrushServiceError('provider_insufficient_units', 'Semrush reports insufficient API units.');
          }
          return { operation: 'domain_overview', status: 'complete', coverage: {}, rows: [{ Dn: 'example.com' }] };
        },
      } as any,
      undefined,
      logger,
      'https://keys.example.test/semrush',
      async () => Response.json({ api_key: webhookKeys[webhookCalls++], status: 'active' }),
    );

    await assert.rejects(
      () => service.execute(args),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'provider_insufficient_units',
    );
    const result = await service.execute(args);

    assert.equal(result.status, 'complete');
    assert.equal(webhookCalls, 3);
  });

  it('does not fall back to a stale static key when the webhook has no active key', async () => {
    const service = new SemrushService(
      { fetch: async () => { throw new Error('must not call'); } } as any,
      'stale-static-key',
      logger,
      'https://keys.example.test/semrush',
      async () => Response.json({ status: 'error' }),
    );

    await assert.rejects(
      () => service.execute(args),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'not_configured',
    );
  });

  it('does not tunnel an operation with no mapped API surface to the provider', async () => {
    // All seven operations now have a verified contract, but the guard is what
    // keeps the next one from reaching Semrush before its contract is proven.
    const service = new SemrushService({ fetch: async () => { throw new Error('must not call'); } } as any, 'server-key', logger);
    await assert.rejects(
      () => service.execute({ operation: 'not_a_real_operation' } as never),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'capability_unavailable',
    );
  });

  it('executes every operation that now has a verified contract', async () => {
    const service = new SemrushService(
      { fetch: async () => ({ operation: 'keyword_gap', status: 'complete', coverage: {}, rows: [{ Ph: 'seo' }] }) } as any,
      'server-key',
      logger,
    );
    for (const args of [
      { operation: 'organic_position_trend', domain: 'a.com' },
      { operation: 'keyword_research', keywords: ['seo'] },
      { operation: 'domain_comparison', targets: ['a.com', 'b.com'] },
      { operation: 'keyword_gap', targets: ['a.com', 'b.com'] },
      { operation: 'backlinks_comparison', targets: ['a.com', 'b.com'] },
    ] as const) {
      const result = await service.execute(args as never);
      assert.equal(result.status, 'complete', `${args.operation} must reach the provider`);
    }
  });
});
