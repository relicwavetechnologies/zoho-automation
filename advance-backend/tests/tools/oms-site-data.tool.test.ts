import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOmsSiteDataTool } from '../../src/application/orchestration/tools/families/oms-site-data.tool.ts';
import { OmsSiteDataServiceError } from '../../src/application/oms/oms-site-data.types.ts';
import { makeAllowedPerm, makeCtx, makeDeniedPerm } from './tool-test.helpers.ts';

describe('OMS Site Data tool', () => {
  it('rejects raw provider requests, URLs, and unbounded searches at the schema boundary', () => {
    const tool = createTool();
    assert.equal(tool.argsSchema.safeParse({ operation: 'search_sites' }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'search_sites', niche: 'Technology', headers: { Cookie: 'nope' } }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'search_sites', niche: 'Technology', filters: [{ field: 'website', op: 'contains', value: 'x' }] }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'get_site_profiles', websites: ['https://example.com'] }).success, false);
    assert.equal(tool.argsSchema.safeParse({ operation: 'run_sql', sql: 'SELECT * FROM Site' }).success, false);
  });

  it('requires explicit OMS read permission', () => {
    const tool = createTool();
    assert.equal(tool.permissionCheck({ operation: 'get_site_profiles', websites: ['example.com'] }, makeDeniedPerm()).ok, false);
    assert.deepEqual(
      tool.permissionCheck({ operation: 'get_site_profiles', websites: ['example.com'] }, makeAllowedPerm('omsSiteData', ['read'])),
      { ok: true, value: 'read' },
    );
  });

  it('bounds chat output at 50 rows and creates a private 24-hour CSV for the provider result', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ website: `site-${index}.com`, domainAuthority: index }));
    const uploads: unknown[] = [];
    const tool = createTool({
      service: { execute: async () => ({ operation: 'search_sites', status: 'partial', coverage: { providerRowCap: 100 }, rows }) },
      cloudinary: {
        isAvailable: true,
        uploadCsvBuffer: async (input: unknown) => { uploads.push(input); return { publicId: 'temp_exports/co/oms', signedUrl: 'https://example.test/oms.csv', expiresAt: '2026-07-21T00:00:00.000Z' }; },
      },
    });
    const result = await tool.execute({ operation: 'search_sites', niche: 'Technology' }, makeCtx('omsSiteData', ['read']));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'partial');
    assert.equal(result.value.rows.length, 50);
    assert.equal(result.value.artifact?.id, 'temp_exports/co/oms');
    assert.equal(uploads.length, 1);
    assert.match(result.value.message, /may be truncated/i);
  });

  it('returns a blocked result for the provider empty-body ambiguity', async () => {
    const tool = createTool({ service: { execute: async () => { throw new OmsSiteDataServiceError('ambiguous_empty_response', 'OMS response is ambiguous.'); } } });
    const result = await tool.execute({ operation: 'get_site_profiles', websites: ['example.com'] }, makeCtx('omsSiteData', ['read']));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'blocked');
    assert.match(result.value.message, /ambiguous/i);
  });
});

function createTool(overrides: { service?: Record<string, unknown>; cloudinary?: Record<string, unknown> } = {}) {
  const service = {
    preflight: async () => ({ configured: true }),
    execute: async () => ({ operation: 'search_sites', status: 'complete' as const, coverage: {}, rows: [{ website: 'example.com' }] }),
    ...overrides.service,
  };
  const cloudinary = { isAvailable: false, uploadCsvBuffer: async () => null, ...overrides.cloudinary };
  return createOmsSiteDataTool({ service: service as never, cloudinary: cloudinary as never });
}
