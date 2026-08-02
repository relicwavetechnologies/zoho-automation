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

  it('keeps the legacy Cloudinary rollback path bounded at 25 preview rows', async () => {
    const uploads: unknown[] = [];
    const tool = createTool({
      service: {
        execute: async () => ({ operation: 'organic_positions', status: 'complete', coverage: { database: 'in' }, rows }),
      },
      cloudinary: {
        isAvailable: true,
        uploadCsvBuffer: async (input: unknown) => { uploads.push(input); return { publicId: 'temp_exports/co/rows', signedUrl: 'https://example.test/signed.csv', expiresAt: '2026-07-21T00:00:00.000Z' }; },
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
    assert.equal(result.value.artifact?.id, 'temp_exports/co/rows');
    assert.equal(uploads.length, 1);
    assert.match(result.value.message, /temporary CSV/i);
  });

  it('creates one opaque export offer without creating a production Cloudinary artifact', async () => {
    const offers: unknown[] = [];
    const uploads: unknown[] = [];
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
        createAuthorizedOffer: async (payload: unknown) => {
          offers.push(payload);
          return { offerId: 'offer-opaque', expiresAt: new Date('2026-08-03T00:00:00.000Z') };
        },
      },
      cloudinary: {
        isAvailable: true,
        uploadCsvBuffer: async (input: unknown) => { uploads.push(input); return null; },
      },
    });
    const ctx = makeCtx('semrush', ['read'], { chatId: 'oc-chat', requestId: 'request-1' });
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
    assert.equal(result.value.artifact, undefined);
    assert.equal(uploads.length, 0);
    assert.equal(offers.length, 1);
    const payload = parseDataExportOfferPayload(offers[0]);
    assert.deepEqual(payload.source, {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: { operation: 'organic_positions', domain: 'example.com', database: 'in', limit: 1_000 },
    });
    assert.match(payload.destination.title, /export/i);
    assert.match(result.value.message, /reruns this Semrush query/i);

    const withoutExportPermission = await tool.execute(
      { operation: 'organic_positions', domain: 'example.com', limit: 1_000 },
      makeCtx('semrush', ['read'], { chatId: 'oc-chat', requestId: 'request-2' }),
    );
    assert.equal(withoutExportPermission.ok && withoutExportPermission.value.preview?.exportOfferId, undefined);
    assert.equal(offers.length, 1);
    assert.equal(uploads.length, 0);

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
        createAuthorizedOffer: async () => { throw new Error('database unavailable'); },
      },
    });
    const ctx = makeCtx('semrush', ['read'], { chatId: 'oc-chat', requestId: 'request-3' });
    ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));

    const result = await tool.execute({ operation: 'domain_overview', domain: 'example.com' }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.preview?.rows, [{ domain: 'example.com' }]);
    assert.equal(result.value.preview?.exportOfferId, undefined);
  });

  it('replays an opaque offer through the central Semrush source adapter', async () => {
    const calls: unknown[] = [];
    const adapter = new SemrushSnapshotDataExportSource({
      execute: async (args) => {
        calls.push(args);
        return {
          operation: 'organic_positions',
          status: 'partial',
          coverage: {},
          rows: [{ keyword: 'payments' }],
          nextPage: '100',
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

    assert.deepEqual(calls, [{ operation: 'organic_positions', domain: 'example.com' }]);
    assert.deepEqual(pages, [{ rows: [{ keyword: 'payments' }], sourceTruncated: true }]);
    assert.equal(datasetSourceToolId(source), 'semrush');
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
  cloudinary?: Record<string, unknown>;
} = {}) {
  const service = {
    preflight: async () => ({ configured: true }),
    execute: async () => ({ operation: 'domain_overview', status: 'complete' as const, coverage: {}, rows: [{ domain: 'example.com' }] }),
    ...overrides.service,
  };
  const cloudinary = {
    isAvailable: false,
    uploadCsvBuffer: async () => null,
    ...overrides.cloudinary,
  };
  return createSemrushTool({
    service: service as never,
    ...(overrides.offers ? { offers: overrides.offers as never } : {}),
    cloudinary: cloudinary as never,
  });
}
