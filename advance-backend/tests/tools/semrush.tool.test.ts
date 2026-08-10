import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSemrushTool } from '../../src/application/tools/families/semrush.tool.ts';
import { SemrushServiceError } from '../../src/application/semrush/semrush.types.ts';
import { makeAllowedPerm, makeCtx, makeDeniedPerm } from './tool-test.helpers.ts';

describe('semrush tool', () => {
  it('rejects protocols, paths, raw headers, and arbitrary operation fields at the schema boundary', () => {
    const tool = createTool();
    assert.equal(tool.argsSchema.safeParse({ operation: 'domain_overview', domain: 'https://example.com' }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'domain_overview', domain: 'example.com/path' }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'domain_overview', domain: 'example.com', headers: { Cookie: 'nope' } }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'domain_overview', domain: 'example.com', exportCsv: true }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'organic_positions', domain: 'example.com' }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'arbitrary_export', domain: 'example.com' }).success, false);
  });

  it('requires explicit read permission', () => {
    const tool = createTool();
    const denied = tool.permissionCheck({ operation: 'domain_overview', domain: 'example.com' }, makeDeniedPerm());
    assert.equal(denied.ok, false);
    const allowed = tool.permissionCheck({ operation: 'domain_overview', domain: 'example.com' }, makeAllowedPerm('semrush', ['read']));
    assert.deepEqual(allowed, { ok: true, value: 'read' });
  });

  it('names every requested backlinks target when Semrush has no provider report', async () => {
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'backlinks_comparison',
          status: 'complete',
          coverage: { missingTargets: ['missing-one.example', 'missing-two.example'] },
          rows: [
            { Target: 'missing-one.example', 'Provider Data Status': 'No provider data' },
            { Target: 'missing-two.example', 'Provider Data Status': 'No provider data' },
          ],
        }),
      },
    });

    const result = await tool.execute(
      { operation: 'backlinks_comparison', targets: ['missing-one.example', 'missing-two.example'] },
      makeCtx('semrush', ['read']),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.value.message, /no backlink overview for: missing-one\.example, missing-two\.example/i);
  });

  it('states, next to the rows, that no other country was reported', async () => {
    // Skill text alone did not hold: asked which markets a domain was invisible
    // in, the model twice answered with Germany, Japan and Brazil — countries
    // Semrush never mentioned — and called them unindexed. This sentence
    // travels with the rows, which is where the claim gets made.
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'domain_overview',
          status: 'complete',
          coverage: { databasesReturned: 26 },
          rows: Array.from({ length: 26 }, (_, i) => ({ Database: `c${i}`, 'Organic Traffic': 0 })),
        }),
      },
    });

    const result = await tool.execute({ operation: 'domain_overview', domain: 'example.com' }, makeCtx('semrush', ['read']));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.value.message, /26 countries are every country Semrush returned/);
    assert.match(result.value.message, /do not name one/);
    assert.match(result.value.message, /do not count how many are missing/);
    // A returned 0 is measured and must stay reportable.
    assert.match(result.value.message, /real measurement/);
  });

  it('does not add the country caveat to operations that have no countries', async () => {
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'backlinks_comparison',
          status: 'complete',
          coverage: {},
          rows: [{ Target: 'a.com' }],
        }),
      },
    });
    const result = await tool.execute({ operation: 'backlinks_comparison', targets: ['a.com'] }, makeCtx('semrush', ['read']));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.doesNotMatch(result.value.message, /every country Semrush returned/);
  });

  it('alerts a company admin when Semrush rejects the backend credential', async () => {
    const notifier = recordingExhaustionNotifier();
    const tool = createTool({
      service: {
        execute: async () => {
          throw new SemrushServiceError('provider_auth_failed', 'Semrush web session was rejected.');
        },
      },
      apiKeyExhaustion: notifier.port,
    });

    const result = await tool.execute({ operation: 'domain_overview', domain: 'example.com' }, makeCtx('semrush', ['read']));

    assert.equal(result.ok, false);
    assert.equal(notifier.notified.length, 1);
    assert.equal(notifier.notified[0]!.provider, 'semrush');
    assert.equal(notifier.notified[0]!.code, 'provider_auth_failed');
    assert.match(String(notifier.notified[0]!.message), /rejected/i);
  });

  it('does not alert for provider failures that are not credential rejections', async () => {
    for (const code of ['timeout', 'provider_failure', 'rate_limited'] as const) {
      const notifier = recordingExhaustionNotifier();
      const tool = createTool({
        service: { execute: async () => { throw new SemrushServiceError(code, `Semrush ${code}.`); } },
        apiKeyExhaustion: notifier.port,
      });
      await tool.execute({ operation: 'domain_overview', domain: 'example.com' }, makeCtx('semrush', ['read']));
      assert.equal(notifier.notified.length, 0, `${code} must not raise a credential alert`);
    }
  });

  it('clears any standing alert once Semrush answers again', async () => {
    const notifier = recordingExhaustionNotifier();
    const tool = createTool({ apiKeyExhaustion: notifier.port });

    const result = await tool.execute({ operation: 'domain_overview', domain: 'example.com' }, makeCtx('semrush', ['read']));

    assert.equal(result.ok, true);
    assert.equal(notifier.notified.length, 0);
    assert.equal(notifier.cleared.length, 1);
  });

  it('returns an honest blocked result when the web session is not configured', async () => {
    const tool = createTool({
      service: {
        execute: async () => {
          throw new SemrushServiceError('not_configured', 'Semrush web session is not configured.');
        },
      },
    });
    const result = await tool.execute({ operation: 'domain_overview', domain: 'example.com' }, makeCtx('semrush', ['read']));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'blocked');
    assert.equal(result.value.preview, undefined);
    assert.match(result.value.message, /not configured/i);
  });
});

function createTool(overrides: {
  service?: Record<string, unknown>;
  apiKeyExhaustion?: Record<string, unknown>;
} = {}) {
  const service = {
    preflight: async () => ({ configured: true }),
    execute: async () => ({ operation: 'domain_overview', status: 'complete' as const, coverage: {}, rows: [{ domain: 'example.com' }] }),
    ...overrides.service,
  };
  return createSemrushTool({
    service: service as never,
    ...(overrides.apiKeyExhaustion ? { apiKeyExhaustion: overrides.apiKeyExhaustion as never } : {}),
  });
}

function recordingExhaustionNotifier() {
  const notified: Array<Record<string, unknown>> = [];
  const cleared: Array<unknown> = [];
  return {
    notified,
    cleared,
    port: {
      notifyIfExhausted: async (input: Record<string, unknown>) => {
        notified.push(input);
        return { notified: true };
      },
      clear: async (companyId: string, provider: string) => {
        cleared.push({ companyId, provider });
      },
    },
  };
}
