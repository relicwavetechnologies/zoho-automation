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

  it('keeps direct previews bounded while preserving the complete report for a protected local file', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ Database: `c${index}`, Rank: index + 1 }));
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'domain_overview',
          status: 'complete',
          coverage: { databasesReturned: rows.length },
          rows,
        }),
      },
    });
    const args = { operation: 'domain_overview' as const, domain: 'example.com' };

    const direct = await tool.execute(args, makeCtx('semrush', ['read']));
    const local = await tool.execute(args, {
      ...makeCtx('semrush', ['read']),
      resultAudience: 'local_file',
    });

    assert.equal(direct.ok, true);
    assert.equal(local.ok, true);
    if (!direct.ok || !local.ok) return;
    assert.equal(direct.value.preview?.rows.length, 25);
    assert.deepEqual(direct.value.preview?.coverage, {
      kind: 'truncated',
      returnedRows: 25,
      knownTotal: 40,
      reason: 'model_preview_limit',
    });
    assert.equal(local.value.preview?.rows.length, 40);
    assert.deepEqual(local.value.preview?.coverage, { kind: 'complete', totalRows: 40 });
    assert.equal(tool.resultSchema.safeParse(local.value).success, true);
  });

  it('counts the countries itself so the model never has to', async () => {
    // 810 + 3 + 2 + 0 = 815 across four rows, one of them a measured zero.
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'domain_overview',
          status: 'complete',
          coverage: { databasesReturned: 4 },
          rows: [
            { Database: 'in', 'Organic Keywords': 53, 'Organic Traffic': 810, 'Organic Cost': 1000 },
            { Database: 'us', 'Organic Keywords': 105, 'Organic Traffic': 3, 'Organic Cost': 12 },
            { Database: 'ru', 'Organic Keywords': 6, 'Organic Traffic': 2, 'Organic Cost': 0 },
            { Database: 'ca', 'Organic Keywords': 9, 'Organic Traffic': 0, 'Organic Cost': 0 },
          ],
        }),
      },
    });

    const result = await tool.execute({ operation: 'domain_overview', domain: 'example.com' }, makeCtx('semrush', ['read']));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.insights, {
      kind: 'domain_overview',
      countriesReturned: 4,
      totalOrganicTraffic: 815,
      totalOrganicKeywords: 173,
      countriesWithTraffic: 3,
      countriesWithZeroTraffic: 1,
      countriesForEightyPercentOfTraffic: 1,
      tiers: { core: 1, emerging: 2, dormant: 1 },
      topCountries: [
        { database: 'in', organicTraffic: 810, trafficSharePct: 99.39 },
        { database: 'us', organicTraffic: 3, trafficSharePct: 0.37 },
        { database: 'ru', organicTraffic: 2, trafficSharePct: 0.25 },
      ],
    });
    assert.match(result.value.message, /4 countries returned/);
    assert.match(result.value.message, /1 measured at zero/);
    assert.match(result.value.message, /Quote these numbers rather than counting rows yourself/);
  });

  it('counts every returned row, not the 25 the chat preview stops at', async () => {
    // Counting the preview is the failure this replaces: it is capped, so a
    // tally of what is on screen silently undercounts a longer run.
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'domain_overview',
          status: 'complete',
          coverage: { databasesReturned: 30 },
          rows: Array.from({ length: 30 }, (_, i) => ({
            Database: `c${i}`,
            'Organic Keywords': 1,
            'Organic Traffic': i < 10 ? 100 : 0,
            'Organic Cost': 0,
          })),
        }),
      },
    });

    const result = await tool.execute({ operation: 'domain_overview', domain: 'example.com' }, makeCtx('semrush', ['read']));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.preview?.rows.length, 25);
    assert.equal(result.value.insights?.countriesReturned, 30);
    assert.equal(result.value.insights?.countriesWithZeroTraffic, 20);
    assert.equal(result.value.insights?.countriesWithTraffic, 10);
  });

  it('numbers every compared target so an answer cannot quietly drop one', async () => {
    // A real eleven-site comparison was written up as ten, with every printed
    // number correct. A count does not catch that; numbered positions do.
    const targets = Array.from({ length: 11 }, (_, i) => `site${i}.com`);
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'backlinks_comparison',
          status: 'complete',
          coverage: {},
          rows: targets.map((target, i) => ({
            Target: target,
            'Authority Score': 30 - i,
            Backlinks: 1000 * (i + 1),
            'Referring Domains': 100 * (i + 1),
            'Provider Data Status': 'Returned',
          })),
        }),
      },
    });

    const result = await tool.execute({ operation: 'backlinks_comparison', targets }, makeCtx('semrush', ['read']));

    assert.equal(result.ok, true);
    if (!result.ok || result.value.insights?.kind !== 'backlinks_comparison') {
      return assert.fail('expected backlinks insights');
    }
    const { insights } = result.value;
    assert.equal(insights.targetsCompared, 11);
    assert.deepEqual(insights.ranking.map(entry => entry.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(insights.ranking.map(entry => entry.target), targets);
    assert.deepEqual(insights.targetsWithoutProviderData, []);
    assert.match(result.value.message, /Ranked 11 targets as positions 1 to 11/);
    assert.match(result.value.message, /do not drop one/);
    assert.match(result.value.message, /Every target returned a report/);
  });

  it('ranks a target with no Semrush report last, with null metrics rather than a zero score', async () => {
    const tool = createTool({
      service: {
        execute: async () => ({
          operation: 'backlinks_comparison',
          status: 'complete',
          coverage: { missingTargets: ['gone.com'] },
          rows: [
            { Target: 'weak.com', 'Authority Score': 2, Backlinks: 10, 'Referring Domains': 5, 'Provider Data Status': 'Returned' },
            { Target: 'gone.com', 'Provider Data Status': 'No provider data' },
          ],
        }),
      },
    });

    const result = await tool.execute({ operation: 'backlinks_comparison', targets: ['weak.com', 'gone.com'] }, makeCtx('semrush', ['read']));

    assert.equal(result.ok, true);
    if (!result.ok || result.value.insights?.kind !== 'backlinks_comparison') {
      return assert.fail('expected backlinks insights');
    }
    const last = result.value.insights.ranking.at(-1)!;
    assert.equal(last.target, 'gone.com');
    assert.equal(last.authorityScore, null);
    assert.equal(last.hasProviderData, false);
    assert.match(result.value.message, /missing data and not a score of zero/);
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
