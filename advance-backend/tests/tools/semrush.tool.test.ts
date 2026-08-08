import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSemrushTool } from '../../src/application/tools/families/semrush.tool.ts';
import { SemrushServiceError } from '../../src/application/semrush/semrush.types.ts';
import { createDataExportTool } from '../../src/application/tools/families/data-export.tool.ts';
import { PermanentDataExportError } from '../../src/application/data-export/data-export.errors.ts';
import { SemrushSnapshotDataExportSource } from '../../src/application/data-export/data-export.sources.ts';
import { datasetSourceToolId } from '../../src/application/data-export/data-export.types.ts';
import { parseDataExportOfferPayload } from '../../src/application/data-export/export-offer.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { makeAllowedPerm, makeCtx, makeDeniedPerm } from './tool-test.helpers.ts';

describe('semrush tool', () => {
  it('rejects protocols, paths, raw headers, and arbitrary operation fields at the schema boundary', () => {
    const tool = createTool();
    assert.equal(tool.argsSchema.safeParse({ operation: 'domain_overview', domain: 'https://example.com' }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'domain_overview', domain: 'example.com/path' }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'domain_overview', domain: 'example.com', headers: { Cookie: 'nope' } }).success, false);
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

  it('publishes an independent export candidate for each source lookup', async () => {
    const domains = ['a.com', 'b.com', 'c.com'];
    const published: unknown[] = [];
    const tool = createTool({
      service: {
        execute: async (args: any) => ({
          operation: 'domain_overview',
          status: 'complete',
          coverage: {},
          rows: [{ domain: args.domain, rank: 1 }],
        }),
      },
      exportCandidates: {
        publishCandidate: async (payload: unknown) => {
          published.push(payload);
          return {
            candidateId: `11111111-1111-4111-8111-11111111111${published.length}`,
            expiresAt: new Date('2026-08-03T00:00:00.000Z'),
          };
        },
      },
    });

    const candidateIds: (string | undefined)[] = [];
    for (const domain of domains) {
      const ctx = makeCtx('semrush', ['read'], {
        chatId: 'oc-chat',
        requestId: 'request-multi',
        runtimeRunId: 'runtime-run-multi',
      });
      ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));
      const result = await tool.execute({ operation: 'domain_overview', domain }, ctx);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      candidateIds.push(result.value.exportCandidate?.candidateId);
    }

    assert.equal(published.length, 3);
    assert.equal(new Set(candidateIds).size, 3);
  });

  it('creates one opaque export candidate for backlinks comparison', async () => {
    const candidates: unknown[] = [];
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'backlinks_comparison',
          status: 'complete',
          coverage: {},
          rows: [{ Target: 'example.com', 'Authority Score': 50 }],
        }),
      },
      exportCandidates: {
        publishCandidate: async (payload: unknown) => {
          candidates.push(payload);
          return {
            candidateId: '11111111-1111-4111-8111-111111111111',
            expiresAt: new Date('2026-08-03T00:00:00.000Z'),
          };
        },
      },
    });
    const ctx = makeCtx('semrush', ['read'], {
      chatId: 'oc-chat',
      requestId: 'request-1',
      runtimeRunId: 'runtime-run-1',
    });
    ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));

    const result = await tool.execute(
      { operation: 'backlinks_comparison', targets: ['example.com', 'other.com'] },
      ctx,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.exportCandidate?.candidateId, '11111111-1111-4111-8111-111111111111');
    const payload = parseDataExportOfferPayload(candidates[0]);
    assert.deepEqual(payload.source, {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: { operation: 'backlinks_comparison', targets: ['example.com', 'other.com'] },
    });

    const dataExport = createDataExportTool({ offers: {} as never });
    assert.equal(dataExport.argsSchema.safeParse({
      source: payload.source,
      destination: payload.destination,
    }).success, false);
  });

  it('keeps export payload titles within the 120-character destination limit for large target lists', async () => {
    const targets = [
      'whatmycarworth.com',
      'giztrendzone.com',
      'iphone-s.com',
      'technewsera.com',
      'theedgesearch.com',
      'fiz-x.com',
      'gamengadgets.com',
      'tierraandlava.com',
      'travelexperta.com',
      'manvsclock.com',
    ];
    const candidates: unknown[] = [];
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'backlinks_comparison',
          status: 'complete',
          coverage: {},
          rows: targets.map(target => ({ Target: target })),
        }),
      },
      exportCandidates: {
        publishCandidate: async (payload: unknown) => {
          candidates.push(payload);
          return {
            candidateId: '11111111-1111-4111-8111-111111111111',
            expiresAt: new Date('2026-08-03T00:00:00.000Z'),
          };
        },
      },
    });
    const ctx = makeCtx('semrush', ['read'], {
      chatId: 'oc-chat',
      requestId: 'request-ten',
      runtimeRunId: 'runtime-run-ten',
    });
    ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));

    const result = await tool.execute({ operation: 'backlinks_comparison', targets }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.exportCandidate?.candidateId);
    const payload = parseDataExportOfferPayload(candidates[0]);
    assert.ok(payload.destination.title.length <= 120);
    assert.match(payload.destination.title, /\+8 more/);
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

  it('replays an opaque Semrush snapshot through the central source adapter in one fetch', async () => {
    const calls: unknown[] = [];
    const adapter = new SemrushSnapshotDataExportSource({
      execute: async (args) => {
        calls.push(args);
        return {
          operation: 'backlinks_comparison',
          status: 'complete',
          coverage: {},
          rows: [{ Target: 'example.com' }],
        };
      },
    } as never);
    const source = {
      kind: 'semrush_snapshot' as const,
      connectionId: 'backend_managed' as const,
      args: { operation: 'backlinks_comparison' as const, targets: ['example.com', 'other.com'] },
    };
    const pages = [];
    for await (const page of adapter.read(source, { companyId: 'co-1', userId: 'user-1' })) pages.push(page);

    assert.deepEqual(calls, [source.args]);
    assert.deepEqual(pages, [{ rows: [{ Target: 'example.com' }] }]);
    assert.equal(datasetSourceToolId(source), 'semrush');
  });

  it('turns rejected web sessions into a permanent export failure', async () => {
    const adapter = new SemrushSnapshotDataExportSource({
      execute: async () => {
        throw new SemrushServiceError('provider_auth_failed', 'Semrush web session was rejected.');
      },
    } as never);

    await assert.rejects(
      async () => {
        for await (const _page of adapter.read({
          kind: 'semrush_snapshot',
          connectionId: 'backend_managed',
          args: { operation: 'domain_overview', domain: 'example.com' },
        }, { companyId: 'co-1', userId: 'user-1' })) {
          // consume
        }
      },
      (error: unknown) => error instanceof PermanentDataExportError
        && /web session was rejected/i.test(error.memberMessage),
    );
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
  exportCandidates?: Record<string, unknown>;
  apiKeyExhaustion?: Record<string, unknown>;
} = {}) {
  const service = {
    preflight: async () => ({ configured: true }),
    execute: async () => ({ operation: 'domain_overview', status: 'complete' as const, coverage: {}, rows: [{ domain: 'example.com' }] }),
    ...overrides.service,
  };
  return createSemrushTool({
    service: service as never,
    ...(overrides.exportCandidates ? { exportCandidates: overrides.exportCandidates as never } : {}),
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
