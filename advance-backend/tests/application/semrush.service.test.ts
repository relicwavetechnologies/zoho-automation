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

  it('does not tunnel unsupported operations to the provider', async () => {
    const service = new SemrushService({ fetch: async () => { throw new Error('must not call'); } } as any, 'server-key', logger);
    await assert.rejects(
      () => service.execute({ operation: 'backlinks_comparison', targets: ['a.com', 'b.com'] }),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'capability_unavailable',
    );
  });
});
