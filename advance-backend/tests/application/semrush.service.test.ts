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
