#!/usr/bin/env tsx
/**
 * Probe senior-validated Semrush web recipes against live www.semrush.com.
 *
 * Requires in advance-backend/.env:
 *   SEMRUSH_WEB_API_KEY
 *   SEMRUSH_WEB_COOKIE
 *
 * Usage:
 *   pnpm tsx scripts/validate-semrush-web.ts
 *   pnpm tsx scripts/validate-semrush-web.ts --probe organic_growth_export
 */
import 'dotenv/config';

const PROBES = {
  domain_overview: 'domain_overview',
  backlinks_comparison: 'backlinks_comparison',
  keyword_position_trend: 'keyword_position_trend',
} as const;

type Probe = keyof typeof PROBES;

async function main() {
  const key = (process.env.SEMRUSH_WEB_API_KEY ?? '').trim();
  const cookie = (process.env.SEMRUSH_WEB_COOKIE ?? '').trim();
  if (!key) throw new Error('Set SEMRUSH_WEB_API_KEY in advance-backend/.env');
  if (!cookie) throw new Error('Set SEMRUSH_WEB_COOKIE in advance-backend/.env');

  const requested = process.argv.includes('--probe')
    ? process.argv[process.argv.indexOf('--probe') + 1] as Probe
    : undefined;
  const probes = requested ? [requested] : Object.keys(PROBES) as Probe[];

  const { SemrushWebClient } = await import('../src/infrastructure/semrush/semrush-web.client.ts');
  const client = new SemrushWebClient({ apiKey: key, cookie, timeoutMs: 30_000 });

  for (const probe of probes) {
    console.log(`\n=== ${probe} ===`);
    const result = await client.fetch(probeArgs(probe));
    console.log(JSON.stringify({ status: result.status, rowCount: result.rows.length, coverage: result.coverage }, null, 2));
    if (result.rows[0]) console.log('first row:', result.rows[0]);
  }
}

function probeArgs(probe: Probe) {
  switch (probe) {
    case 'domain_overview':
      return { operation: 'domain_overview' as const, domain: 'emiactech.com', database: 'in' as const };
    case 'backlinks_comparison':
      return { operation: 'backlinks_comparison' as const, targets: ['emiactech.com', 'decentro.tech'] };
    case 'keyword_position_trend':
      return {
        operation: 'keyword_position_trend' as const,
        domain: 'emiactech.com',
        keyword: 'emiactech',
        date: '20250701',
        database: 'in' as const,
      };
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
