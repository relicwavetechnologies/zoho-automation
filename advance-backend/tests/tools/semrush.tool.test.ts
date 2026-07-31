import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSemrushTool } from '../../src/application/tools/families/semrush.tool.ts';
import { SemrushServiceError } from '../../src/application/semrush/semrush.types.ts';
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

  it('returns at most 200 rows to the model and spills the full normalized result to a temporary CSV', async () => {
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
    assert.equal(result.value.rows.length, 200);
    assert.equal(result.value.artifact?.id, 'temp_exports/co/rows');
    assert.equal(uploads.length, 1);
    assert.match(result.value.message, /temporary CSV/i);
  });

  it('returns an honest blocked result when the backend has no Semrush key', async () => {
    const tool = createTool({ service: { execute: async () => { throw new SemrushServiceError('not_configured', 'Semrush is not configured on this backend.'); } } });
    const result = await tool.execute({ operation: 'domain_overview', domain: 'example.com' }, makeCtx('semrush', ['read']));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'blocked');
    assert.equal(result.value.rows.length, 0);
    assert.match(result.value.message, /not configured/i);
  });
});

function createTool(overrides: { service?: Record<string, unknown>; cloudinary?: Record<string, unknown> } = {}) {
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
  return createSemrushTool({ service: service as never, cloudinary: cloudinary as never });
}
