import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOmsSiteDataTool } from '../../src/application/tools/families/oms-site-data.tool.ts';
import { createDataExportTool } from '../../src/application/tools/families/data-export.tool.ts';
import { OmsSiteDataServiceError } from '../../src/application/oms/oms-site-data.types.ts';
import { OmsSnapshotDataExportSource } from '../../src/application/data-export/data-export.sources.ts';
import { datasetSourceToolId } from '../../src/application/data-export/data-export.types.ts';
import { parseDataExportOfferPayload } from '../../src/application/data-export/export-offer.ts';
import { asToolId } from '../../src/shared/ids.ts';
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

  /**
   * Exactly what ToolExecutor puts in front of the model on invalid args
   * (tool-executor.ts:579). Nested `unionErrors` are not part of it, so a test
   * that inspects the raw issue tree can pass while the caller is still told
   * nothing — which is how the original defect survived having tests at all.
   */
  const modelFacing = (result: ReturnType<typeof createTool>['argsSchema']['safeParse'] extends
    (...args: never[]) => infer R ? R : never): string =>
    result.success ? '' : result.error.errors
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

  it('names the field a caller got wrong instead of saying "Invalid input"', () => {
    // The live failure. A model read "1–20 exact bare website hostnames" from
    // the docs and sent `hostnames`. Under a plain z.union every branch failed,
    // so the only issue raised was `invalid_union` at the root — rendered as
    // "(root): Invalid input". Told nothing, the model assumed its hostname
    // *format* was wrong and burned its retry reformatting them.
    const tool = createTool();
    const rendered = modelFacing(tool.argsSchema.safeParse({
      operation: 'get_site_profiles',
      hostnames: ['example.com', 'test.com'],
    }));

    assert.match(rendered, /hostnames/, 'must name the key it did not recognise');
    assert.match(rendered, /websites/, 'must name the key it expected');
    assert.doesNotMatch(rendered, /^\(root\): Invalid input$/);
  });

  it('reports the real problem for a chosen branch rather than trying them all', () => {
    // Same defect, different branch: a criterion-less search used to fail every
    // union arm and surface as "Invalid input" too.
    const tool = createTool();
    const rendered = modelFacing(tool.argsSchema.safeParse({ operation: 'search_sites' }));

    assert.match(rendered, /at least one search criterion/);
  });

  it('names the valid operations when the discriminator itself is wrong', () => {
    const tool = createTool();
    const rendered = modelFacing(tool.argsSchema.safeParse({ operation: 'run_sql', sql: 'SELECT 1' }));

    assert.match(rendered, /get_site_profiles/, 'should list the operations it does accept');
  });

  it('still accepts a correctly shaped request for every operation', () => {
    // The restructure moved search's cross-field checks out of the object, so
    // the happy path needs pinning too.
    const tool = createTool();
    assert.equal(tool.argsSchema.safeParse({ operation: 'get_site_profiles', websites: ['example.com'] }).success, true);
    assert.equal(tool.argsSchema.safeParse({ operation: 'list_catalog_values', field: 'niche' }).success, true);
    assert.equal(tool.argsSchema.safeParse({ operation: 'search_sites', niche: 'Technology' }).success, true);
    assert.equal(tool.argsSchema.safeParse({ operation: 'search_sites', minDomainRating: 50, maxDomainRating: 10 }).success, false);
  });

  it('requires explicit OMS read permission', () => {
    const tool = createTool();
    assert.equal(tool.permissionCheck({ operation: 'get_site_profiles', websites: ['example.com'] }, makeDeniedPerm()).ok, false);
    assert.deepEqual(
      tool.permissionCheck({ operation: 'get_site_profiles', websites: ['example.com'] }, makeAllowedPerm('omsSiteData', ['read'])),
      { ok: true, value: 'read' },
    );
  });

  it('keeps large provider snapshots bounded without creating a temporary artifact', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ website: `site-${index}.com`, domainAuthority: index }));
    const tool = createTool({
      service: { execute: async () => ({ operation: 'search_sites', status: 'partial', coverage: { providerRowCap: 100 }, rows }) },
    });
    const result = await tool.execute({ operation: 'search_sites', niche: 'Technology' }, makeCtx('omsSiteData', ['read']));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'partial');
    assert.equal(result.value.preview?.rows.length, 25);
    assert.equal(result.value.preview?.coverage.kind, 'provider_limited');
    assert.equal('artifact' in result.value, false);
    assert.doesNotMatch(result.value.message, /temporary CSV|download link/i);
    assert.match(result.value.message, /arbitrary subset/i);
  });

  it('creates one central provider-limited export candidate without using Cloudinary', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ website: `site-${index}.com` }));
    const candidates: unknown[] = [];
    const tool = createTool({
      service: { execute: async () => ({ operation: 'search_sites', status: 'partial', coverage: {}, rows }) },
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
    const ctx = makeCtx('omsSiteData', ['read'], { chatId: 'oc-chat', requestId: 'request-1' });
    ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));

    const result = await tool.execute({ operation: 'search_sites', niche: 'Technology' }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.preview?.rows.length, 25);
    assert.deepEqual(result.value.preview?.coverage, {
      kind: 'provider_limited',
      returnedRows: 100,
      reason: 'oms_100_row_cap_without_pagination_or_total',
    });
    assert.equal(result.value.exportCandidate?.candidateId, '11111111-1111-4111-8111-111111111111');
    assert.equal(candidates.length, 1);
    const payload = parseDataExportOfferPayload(candidates[0]);
    assert.deepEqual(payload.source, {
      kind: 'oms_snapshot',
      connectionId: 'backend_managed',
      args: { operation: 'search_sites', niche: 'Technology' },
    });
    assert.match(payload.destination.title, /snapshot/i);

    const withoutExportPermission = await tool.execute(
      { operation: 'search_sites', niche: 'Technology' },
      makeCtx('omsSiteData', ['read'], { chatId: 'oc-chat', requestId: 'request-2' }),
    );
    assert.equal(withoutExportPermission.ok && withoutExportPermission.value.exportCandidate, undefined);
    assert.equal(candidates.length, 1);

    const dataExport = createDataExportTool({ offers: {} as never });
    assert.equal(dataExport.argsSchema.safeParse({
      source: payload.source,
      destination: payload.destination,
    }).success, false, 'OMS exports must use the opaque candidate, not a model-built recipe');
  });

  it('keeps the successful preview when optional candidate persistence fails', async () => {
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'get_site_profiles',
          status: 'complete',
          coverage: {},
          rows: [{ website: 'example.com' }],
        }),
      },
      exportCandidates: {
        publishCandidate: async () => { throw new Error('database unavailable'); },
      },
    });
    const ctx = makeCtx('omsSiteData', ['read'], { chatId: 'oc-chat', requestId: 'request-3' });
    ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));

    const result = await tool.execute(
      { operation: 'get_site_profiles', websites: ['example.com'] },
      ctx,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.preview?.rows, [{ website: 'example.com' }]);
    assert.equal(result.value.exportCandidate, undefined);
  });

  it('replays an OMS snapshot through the central source adapter', async () => {
    const calls: unknown[] = [];
    const adapter = new OmsSnapshotDataExportSource({
      execute: async (input) => {
        calls.push(input);
        return {
          operation: 'get_site_profiles',
          status: 'partial',
          coverage: {},
          rows: [{ website: 'example.com' }],
        };
      },
    } as never);
    const pages = [];
    for await (const page of adapter.read({
      kind: 'oms_snapshot',
      connectionId: 'backend_managed',
      args: { operation: 'get_site_profiles', websites: ['example.com'] },
    }, { companyId: 'co-1', userId: 'user-1' })) pages.push(page);

    assert.deepEqual(calls, [{
      companyId: 'co-1',
      args: { operation: 'get_site_profiles', websites: ['example.com'] },
    }]);
    assert.deepEqual(pages, [{
      rows: [{ website: 'example.com' }],
      coverage: { outcome: 'partial', cause: 'provider_limit' },
    }]);
    assert.equal(datasetSourceToolId({
      kind: 'oms_snapshot',
      connectionId: 'backend_managed',
      args: { operation: 'get_site_profiles', websites: ['example.com'] },
    }), 'omsSiteData');
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
    // A small result must not read as an exhaustive filtered dataset.
    assert.match(result.value.message, /100-row cap/i);
    assert.match(result.value.message, /never paginates and never reports a total count/i);
    assert.match(result.value.message, /provider-limited snapshot/i);
    assert.doesNotMatch(result.value.message, /complete set of matches/i);
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

function createTool(overrides: {
  service?: Record<string, unknown>;
  exportCandidates?: Record<string, unknown>;
} = {}) {
  const service = {
    preflight: async () => ({ configured: true }),
    execute: async () => ({ operation: 'search_sites', status: 'complete' as const, coverage: {}, rows: [{ website: 'example.com' }] }),
    ...overrides.service,
  };
  return createOmsSiteDataTool({
    service: service as never,
    ...(overrides.exportCandidates ? { exportCandidates: overrides.exportCandidates as never } : {}),
  });
}
