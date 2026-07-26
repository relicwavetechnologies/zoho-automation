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
    assert.match(result.value.message, /arbitrary subset/i);
  });

  it('warns that an unsorted capped result is not the best sites, and names the ranking when sorted', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ website: `site-${index}.com`, domainAuthority: index }));
    const tool = createTool({
      service: { execute: async () => ({ operation: 'search_sites', status: 'partial', coverage: {}, rows }) },
    });

    const unsorted = await tool.execute({ operation: 'search_sites', niche: 'Technology' }, makeCtx('omsSiteData', ['read']));
    assert.equal(unsorted.ok, true);
    if (!unsorted.ok) return;
    assert.match(unsorted.value.message, /arbitrary subset/i);
    assert.doesNotMatch(unsorted.value.message, /top 100 by/i);

    const sorted = await tool.execute(
      { operation: 'search_sites', niche: 'Technology', sortBy: 'domainAuthority', sortDirection: 'DESC' },
      makeCtx('omsSiteData', ['read']),
    );
    assert.equal(sorted.ok, true);
    if (!sorted.ok) return;
    assert.match(sorted.value.message, /top 100 by domainAuthority DESC/i);
    assert.doesNotMatch(sorted.value.message, /arbitrary subset/i);
  });

  it('gives capped-result advice the operation can actually act on', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ niche: `niche-${index}` }));
    const tool = createTool({
      service: { execute: async () => ({ operation: 'list_catalog_values', status: 'partial', coverage: {}, rows }) },
    });

    // sortBy and filters are rejected by the schema for both non-search
    // operations, so advising them would send the agent into a dead end.
    const catalog = await tool.execute({ operation: 'list_catalog_values', field: 'niche' }, makeCtx('omsSiteData', ['read']));
    assert.equal(catalog.ok, true);
    if (!catalog.ok) return;
    assert.doesNotMatch(catalog.value.message, /sortBy|narrow the filters/i);
    assert.match(catalog.value.message, /distinct values/i);
    // Exactly 100 rows may also be a complete result, so the message must not
    // assert that values are missing.
    assert.match(catalog.value.message, /completeness cannot be confirmed/i);

    const profiles = await tool.execute({ operation: 'get_site_profiles', websites: ['example.com'] }, makeCtx('omsSiteData', ['read']));
    assert.equal(profiles.ok, true);
    if (!profiles.ok) return;
    assert.doesNotMatch(profiles.value.message, /sortBy|narrow the filters/i);
    assert.match(profiles.value.message, /fewer hostnames/i);
    assert.match(profiles.value.message, /completeness cannot be confirmed/i);
  });

  it('discloses the unmeasured-spam-score exclusion, including when nothing matched', async () => {
    // Divo narrows the request itself, so "complete" and "no matches" would
    // otherwise overstate what was actually searched.
    const complete = createTool({
      service: { execute: async () => ({ operation: 'search_sites', status: 'complete', coverage: {}, rows: [{ website: 'a.com' }] }) },
    });
    const constrained = await complete.execute({ operation: 'search_sites', niche: 'Casino', maxSpamScore: 2 }, makeCtx('omsSiteData', ['read']));
    assert.equal(constrained.ok, true);
    if (!constrained.ok) return;
    assert.match(constrained.value.message, /no measured spam score were excluded/i);

    const unconstrained = await complete.execute({ operation: 'search_sites', niche: 'Casino' }, makeCtx('omsSiteData', ['read']));
    assert.equal(unconstrained.ok, true);
    if (!unconstrained.ok) return;
    assert.doesNotMatch(unconstrained.value.message, /measured spam score/i);

    const none = createTool({
      service: { execute: async () => ({ operation: 'search_sites', status: 'empty', coverage: {}, rows: [] }) },
    });
    const empty = await none.execute({ operation: 'search_sites', niche: 'Casino', maxSpamScore: 2 }, makeCtx('omsSiteData', ['read']));
    assert.equal(empty.ok, true);
    if (!empty.ok) return;
    assert.match(empty.value.message, /no measured spam score were excluded/i);
  });

  it('states the row cap and the absence of totals even when the result is under the cap', async () => {
    const tool = createTool({
      service: { execute: async () => ({ operation: 'search_sites', status: 'complete', coverage: {}, rows: [{ website: 'example.com' }] }) },
    });
    const result = await tool.execute({ operation: 'search_sites', niche: 'Technology' }, makeCtx('omsSiteData', ['read']));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // A small result must not read as "these are all the sites that exist".
    assert.match(result.value.message, /100-row cap/i);
    assert.match(result.value.message, /never paginates and never reports a total count/i);
    assert.match(result.value.message, /complete set of matches for this request/i);
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
