import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSemrushTool } from '../../src/application/tools/families/semrush.tool.ts';
import { SemrushServiceError } from '../../src/application/semrush/semrush.types.ts';
import { createDataExportTool } from '../../src/application/tools/families/data-export.tool.ts';
import { SemrushSnapshotDataExportSource } from '../../src/application/data-export/data-export.sources.ts';
import { datasetSourceToolId } from '../../src/application/data-export/data-export.types.ts';
import { parseDataExportOfferPayload } from '../../src/application/data-export/export-offer.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { makeAllowedPerm, makeCtx, makeDeniedPerm } from './tool-test.helpers.ts';

const rows = Array.from({ length: 1_000 }, (_, index) => ({ keyword: `keyword-${index}`, position: index + 1 }));

describe('semrush tool', () => {
  it('rejects protocols, paths, raw headers, and arbitrary operation fields at the schema boundary', () => {
    const tool = createTool();
    assert.equal(tool.argsSchema.safeParse({ operation: 'domain_overview', domain: 'https://example.com' }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'domain_overview', domain: 'example.com/path' }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'domain_overview', domain: 'example.com', headers: { Cookie: 'nope' } }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'arbitrary_export', domain: 'example.com' }).success, false);
  });

  it('requires explicit read permission', () => {
    const tool = createTool();
    const denied = tool.permissionCheck({ operation: 'domain_overview', domain: 'example.com' }, makeDeniedPerm());
    assert.equal(denied.ok, false);
    const allowed = tool.permissionCheck({ operation: 'domain_overview', domain: 'example.com' }, makeAllowedPerm('semrush', ['read']));
    assert.deepEqual(allowed, { ok: true, value: 'read' });
  });

  it('keeps large results bounded without creating a temporary artifact', async () => {
    const tool = createTool({
      service: {
        execute: async () => ({ operation: 'organic_positions', status: 'complete', coverage: { database: 'in' }, rows }),
      },
    });
    const result = await tool.execute({ operation: 'organic_positions', domain: 'example.com', database: 'in', limit: 1_000 }, makeCtx('semrush', ['read']));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.preview?.rows.length, 25);
    assert.deepEqual(result.value.preview?.coverage, {
      kind: 'truncated',
      returnedRows: 25,
      knownTotal: 1_000,
      reason: 'model_preview_limit',
    });
    assert.equal('artifact' in result.value, false);
    assert.doesNotMatch(result.value.message, /temporary CSV|download link/i);
  });


  it('folds one lookup per domain into a single offer covering the whole answer', async () => {
    // Reproduces the reported failure: an answer built from many one-row
    // lookups used to carry an export representing only the first one.
    const domains = ['a.com', 'b.com', 'c.com'];
    const appended: unknown[] = [];
    let parts = 0;
    const tool = createTool({
      service: {
        execute: async (args: any) => ({
          operation: 'domain_overview',
          status: 'complete',
          coverage: {},
          rows: [{ domain: args.domain, rank: 1 }],
        }),
      },
      offers: {
        appendAuthorizedPart: async (payload: unknown) => {
          appended.push(payload);
          parts += 1;
          return {
            outcome: 'appended' as const,
            offerId: 'offer-one',
            expiresAt: new Date('2026-08-03T00:00:00.000Z'),
            partCount: parts,
          };
        },
      },
    });

    const offerIds: (string | undefined)[] = [];
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
      offerIds.push(result.value.preview?.exportOfferId);
    }

    assert.equal(appended.length, 3, 'every lookup contributes its rows');
    assert.deepEqual(new Set(offerIds), new Set(['offer-one']), 'all three answer one offer');
    // Each call must contribute its own domain, not re-send the first.
    assert.deepEqual(
      appended.map((p: any) => p.source.args.domain),
      domains,
    );
  });

  it('withdraws the export when a run mixes datasets that cannot share a file', async () => {
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'organic_positions',
          status: 'complete',
          coverage: {},
          rows: [{ keyword: 'x' }],
        }),
      },
      offers: {
        appendAuthorizedPart: async () => ({
          outcome: 'withdrawn' as const,
          reason: 'shape_mismatch' as const,
          revokedOfferId: 'offer-one',
        }),
      },
    });
    const ctx = makeCtx('semrush', ['read'], { chatId: 'oc-chat', requestId: 'request-mixed' });
    ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));

    const result = await tool.execute(
      { operation: 'organic_positions', domain: 'a.com' },
      ctx,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.preview?.exportOfferId, undefined, 'no button may be offered');
    assert.equal(result.value.preview?.exportWithdrawn, true, 'the gateway must revoke the bound offer');
    assert.match(result.value.message, /combines datasets that cannot share one file/i);
  });

  it('creates one opaque export offer without creating a production Cloudinary artifact', async () => {
    const offers: unknown[] = [];
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'organic_positions',
          status: 'partial',
          coverage: { database: 'in' },
          rows,
          nextPage: '1000',
        }),
      },
      offers: {
        appendAuthorizedPart: async (payload: unknown) => {
          offers.push(payload);
          return {
            outcome: 'appended' as const,
            offerId: 'offer-opaque',
            expiresAt: new Date('2026-08-03T00:00:00.000Z'),
            partCount: 1,
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
      { operation: 'organic_positions', domain: 'example.com', database: 'in', limit: 1_000 },
      ctx,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.preview?.rows.length, 25);
    assert.deepEqual(result.value.preview?.coverage, {
      kind: 'truncated',
      returnedRows: 1_000,
      reason: 'semrush_next_page_available',
    });
    assert.equal(result.value.preview?.exportOfferId, 'offer-opaque');
    assert.equal(result.value.nextPage, '1000');
    assert.equal(offers.length, 1);
    const payload = parseDataExportOfferPayload(offers[0]);
    assert.deepEqual(payload.source, {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: { operation: 'organic_positions', domain: 'example.com', database: 'in', limit: 1_000 },
    });
    assert.equal(payload.requestId, 'runtime-run-1');
    assert.equal(payload.destination.title, 'Semrush organic positions — example.com');
    assert.match(result.value.message, /reruns those queries when the user confirms/i);

    const withoutExportPermission = await tool.execute(
      { operation: 'organic_positions', domain: 'example.com', limit: 1_000 },
      makeCtx('semrush', ['read'], { chatId: 'oc-chat', requestId: 'request-2' }),
    );
    assert.equal(withoutExportPermission.ok && withoutExportPermission.value.preview?.exportOfferId, undefined);
    assert.equal(offers.length, 1);

    const dataExport = createDataExportTool({ offers: {} as never });
    assert.equal(dataExport.argsSchema.safeParse({
      source: payload.source,
      destination: payload.destination,
    }).success, false, 'Semrush exports must use the opaque offer, not a model-built recipe');
  });

  it('marks partial provider responses without pagination as provider-limited', async () => {
    const tool = createTool({
      service: {
        execute: async () => ({ operation: 'keyword_gap', status: 'partial', coverage: {}, rows: rows.slice(0, 100) }),
      },
    });
    const result = await tool.execute(
      { operation: 'keyword_gap', targets: ['mine.com', 'competitor.com'], limit: 100 },
      makeCtx('semrush', ['read']),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.preview?.coverage, {
      kind: 'provider_limited',
      returnedRows: 100,
      reason: 'semrush_requested_limit_without_pagination_or_total',
    });
  });

  it('keeps the successful preview when optional offer persistence fails', async () => {
    const tool = createTool({
      service: {
        execute: async () => ({ operation: 'domain_overview', status: 'complete', coverage: {}, rows: [{ domain: 'example.com' }] }),
      },
      offers: {
        appendAuthorizedPart: async () => { throw new Error('database unavailable'); },
      },
    });
    const ctx = makeCtx('semrush', ['read'], { chatId: 'oc-chat', requestId: 'request-3' });
    ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));

    const result = await tool.execute({ operation: 'domain_overview', domain: 'example.com' }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.preview?.rows, [{ domain: 'example.com' }]);
    assert.equal(result.value.preview?.exportOfferId, undefined);
    assert.match(result.value.message, /could not safely prepare one/i);
  });

  it('replays an opaque offer through the central Semrush source adapter', async () => {
    const calls: unknown[] = [];
    const adapter = new SemrushSnapshotDataExportSource({
      execute: async (args) => {
        calls.push(args);
        const offset = args.operation === 'organic_positions' ? args.offset ?? 0 : 0;
        return {
          operation: 'organic_positions',
          status: offset === 0 ? 'partial' : 'complete',
          coverage: {},
          rows: [{ keyword: offset === 0 ? 'payments' : 'settlements' }],
          ...(offset === 0 ? { nextPage: '1000' } : {}),
        };
      },
    } as never);
    const source = {
      kind: 'semrush_snapshot' as const,
      connectionId: 'backend_managed' as const,
      args: { operation: 'organic_positions' as const, domain: 'example.com' },
    };
    const pages = [];
    for await (const page of adapter.read(source, { companyId: 'co-1', userId: 'user-1' })) pages.push(page);

    assert.deepEqual(calls, [
      { operation: 'organic_positions', domain: 'example.com', limit: 1_000, offset: 0 },
      { operation: 'organic_positions', domain: 'example.com', limit: 1_000, offset: 1_000 },
    ]);
    assert.deepEqual(pages, [
      { rows: [{ keyword: 'payments' }], hasMore: true },
      { rows: [{ keyword: 'settlements' }] },
    ]);
    assert.equal(datasetSourceToolId(source), 'semrush');
  });

  it('reads the requested window from the args, not from the adapter page size', async () => {
    const calls: unknown[] = [];
    const adapter = new SemrushSnapshotDataExportSource({
      execute: async (args) => {
        calls.push(args);
        return {
          operation: 'organic_positions', status: 'partial', coverage: {},
          rows: Array.from({ length: args.limit ?? 0 }, (_, index) => ({ keyword: `keyword-${index}` })),
          nextPage: String((args.offset ?? 0) + (args.limit ?? 0)),
        };
      },
    } as never);
    const pages = [];
    for await (const page of adapter.read({
      kind: 'semrush_snapshot', connectionId: 'backend_managed',
      args: { operation: 'organic_positions', domain: 'example.com', limit: 50 },
    }, { companyId: 'co-1', userId: 'user-1' })) pages.push(page);

    // 50 is what was asked for; 1,000 is only the adapter's page size.
    assert.deepEqual(calls, [{ operation: 'organic_positions', domain: 'example.com', limit: 50, offset: 0 }]);
    assert.equal(pages.flatMap(page => page.rows).length, 50);
    // Exactly what was asked for is a complete export, not a truncated one.
    assert.equal(pages[0]?.hasMore, undefined);
    assert.equal(pages[0]?.sourceTruncated, undefined);
  });

  it('keeps each part of a multi-part export on its own window', async () => {
    // Two organic_positions lookups in one run merge into one offer. The window
    // belongs to the part that carries it: capping the merged dataset at the
    // first part's limit would drop the second domain entirely.
    const calls: { domain: string; limit?: number; offset?: number }[] = [];
    const adapter = new SemrushSnapshotDataExportSource({
      execute: async (args: any) => {
        calls.push({ domain: args.domain, limit: args.limit, offset: args.offset });
        return {
          operation: 'organic_positions', status: 'complete', coverage: {},
          rows: Array.from({ length: args.limit ?? 0 }, (_, index) => ({ domain: args.domain, index })),
        };
      },
    } as never);
    const rows: Record<string, unknown>[] = [];
    for (const domain of ['a.com', 'b.com']) {
      for await (const page of adapter.read({
        kind: 'semrush_snapshot', connectionId: 'backend_managed',
        args: { operation: 'organic_positions', domain, limit: 50 },
      }, { companyId: 'co-1', userId: 'user-1' })) rows.push(...page.rows);
    }

    assert.deepEqual(calls, [
      { domain: 'a.com', limit: 50, offset: 0 },
      { domain: 'b.com', limit: 50, offset: 0 },
    ]);
    assert.equal(rows.length, 100);
    assert.deepEqual([...new Set(rows.map(row => row['domain']))], ['a.com', 'b.com']);
  });

  it('returns an honest blocked result when the backend has no Semrush key', async () => {
    const tool = createTool({ service: { execute: async () => { throw new SemrushServiceError('not_configured', 'Semrush is not configured on this backend.'); } } });
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
  offers?: Record<string, unknown>;
} = {}) {
  const service = {
    preflight: async () => ({ configured: true }),
    execute: async () => ({ operation: 'domain_overview', status: 'complete' as const, coverage: {}, rows: [{ domain: 'example.com' }] }),
    ...overrides.service,
  };
  return createSemrushTool({
    service: service as never,
    ...(overrides.offers ? { offers: overrides.offers as never } : {}),
  });
}
