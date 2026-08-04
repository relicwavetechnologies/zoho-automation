import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SemrushService } from '../../src/application/semrush/semrush.service.ts';
import { SemrushServiceError } from '../../src/application/semrush/semrush.types.ts';

const logger = { info: () => undefined, warn: () => undefined } as any;

describe('SemrushService', () => {
  it('preflights and executes through the web client only', async () => {
    const calls: unknown[] = [];
    const service = new SemrushService({
      assertConfigured: () => undefined,
      fetch: async (args) => {
        calls.push(args);
        return {
          operation: 'domain_overview',
          status: 'complete',
          coverage: { apiVersion: 'web_dpa' },
          rows: [{ Domain: 'example.com' }],
        };
      },
    } as any, logger);

    assert.deepEqual(await service.preflight({ operation: 'domain_overview', domain: 'example.com' }), {
      configured: true,
      operation: 'domain_overview',
      apiVersion: 'web_private',
      providerHost: 'www.semrush.com',
      reportType: 'dpa/rpc ranks.Ranks organic.overview',
      limits: { maxRowsPerRequest: 200 },
    });
    const result = await service.execute({ operation: 'domain_overview', domain: 'example.com' });
    assert.equal(result.status, 'complete');
    assert.deepEqual(calls, [{ operation: 'domain_overview', domain: 'example.com' }]);
  });

  it('blocks when the web session is not configured', async () => {
    const service = new SemrushService({
      assertConfigured: () => {
        throw new SemrushServiceError('not_configured', 'Semrush web session is not configured.');
      },
      fetch: async () => { throw new Error('must not call'); },
    } as any, logger);

    await assert.rejects(
      () => service.execute({ operation: 'domain_overview', domain: 'example.com' }),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'not_configured',
    );
  });

  it('reports backlinks web limits in preflight', async () => {
    const service = new SemrushService({
      assertConfigured: () => undefined,
      fetch: async () => ({
        operation: 'backlinks_comparison',
        status: 'complete',
        coverage: {},
        rows: [],
      }),
    } as any, logger);

    assert.deepEqual(
      await service.preflight({ operation: 'backlinks_comparison', targets: ['a.com', 'b.com'] }),
      {
        configured: true,
        operation: 'backlinks_comparison',
        apiVersion: 'web_private',
        providerHost: 'www.semrush.com',
        reportType: 'backlinks/webapi2 backlinks_comparison',
        limits: { maxTargets: 10, requestsBilled: 1 },
      },
    );
  });
});
