/**
 * Direct zohoBooks tool test harness — calls execute() with different args,
 * bypassing the LLM entirely.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { decryptToken } from '../src/infrastructure/shared/token.crypto.js';
import { ZohoTokenService } from '../src/infrastructure/zoho/zoho-token.service.js';
import { ZohoConnectionRepository } from '../src/infrastructure/zoho/zoho-connection.repository.js';
import { ZohoBooksPaginatedClient } from '../src/infrastructure/zoho/zoho-books-paginated.client.js';
import { ZohoFinanceOps } from '../src/application/zoho/zoho-finance-ops.js';
import { createZohoBooksTool } from '../src/application/orchestration/tools/families/zoho-books.tool.js';
import { RedisCache } from '../src/infrastructure/cache/redis-cache.js';
import { loadAndValidateEnv } from '../src/config/env.js';
import Redis from 'ioredis';

const env    = loadAndValidateEnv(process.env);
const prisma = new PrismaClient();
const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log };

async function main() {
  const company = await prisma.company.findFirst();
  if (!company) throw new Error('No company');
  const companyId = company.id;
  console.log(`Company: ${company.name} (${companyId})\n`);

  const cacheRedis = new Redis(env.REDIS_CACHE_URL || env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  await cacheRedis.connect().catch(() => console.log('Redis cache unavailable — continuing without cache'));
  const cache = new RedisCache(cacheRedis);

  const connRepo     = new ZohoConnectionRepository(prisma, env);
  const tokenService = new ZohoTokenService(connRepo, cache, env, log);
  const booksClient  = new ZohoBooksPaginatedClient(tokenService, env.ZOHO_API_BASE_URL);
  const financeOps   = new ZohoFinanceOps(booksClient, log);

  const tool = createZohoBooksTool({
    getClient:   async () => null,
    booksClient, financeOps,
  });

  const ctx: any = {
    runContext: { companyId, userId: 'test', channel: 'lark', companyRole: 'SUPER_ADMIN', traceId: 'test', requestId: 'test' },
    logger: log,
    clock: { now: () => new Date(), nowMs: () => Date.now() },
    correlationId: 'test',
    perm: {
      allowedToolIds: new Set(['zohoBooks']),
      allowedActionsByTool: new Map([['zohoBooks', new Set(['read', 'create', 'update', 'delete'])]]),
    },
  };

  const tests: Array<{ name: string; args: Record<string, unknown> }> = [
    {
      name: '1. Simple list — list_bills (no script, 5 records)',
      args: { op: 'list_bills', dateFrom: 'this month', limit: 5 },
    },
    {
      name: '2. Script — overdue bills by vendor, top 10 outstanding',
      args: {
        op: 'list_bills', status: 'overdue', dateFrom: 'this year',
        script: `const g = {};
for (const b of data) {
  const v = b.vendor_name || 'Unknown';
  if (!g[v]) g[v] = { vendor: v, count: 0, outstanding: 0 };
  g[v].count++;
  g[v].outstanding += b._balance || 0;
}
return Object.values(g).sort((a, b) => b.outstanding - a.outstanding).slice(0, 10);`,
      },
    },
    {
      name: '3. Script — Q1 2026 expense breakdown by month',
      args: {
        op: 'list_expenses', dateFrom: '2026-01-01', dateTo: '2026-03-31',
        script: `const m = {};
for (const e of data) {
  const mon = (e._date || '').slice(0, 7);
  if (!mon) continue;
  if (!m[mon]) m[mon] = { month: mon, count: 0, total: 0 };
  m[mon].count++;
  m[mon].total += e._amount || 0;
}
return Object.values(m).sort((a, b) => a.month.localeCompare(b.month));`,
      },
    },
    {
      name: '4. Script — multi-currency bill grouping',
      args: {
        op: 'list_bills', dateFrom: 'this year',
        script: `const g = {};
for (const b of data) {
  const cur = b.currency_code || 'INR';
  if (!g[cur]) g[cur] = { currency: cur, count: 0, total: 0, outstanding: 0 };
  g[cur].count++;
  g[cur].total += b._total || 0;
  g[cur].outstanding += b._balance || 0;
}
return Object.values(g).sort((a, b) => b.total - a.total);`,
      },
    },
    {
      name: '5. Script — invoice billed vs outstanding per customer (April 2026)',
      args: {
        op: 'list_invoices', dateFrom: '2026-04-01', dateTo: '2026-04-30',
        script: `const g = {};
for (const inv of data) {
  const c = inv.customer_name || 'Unknown';
  if (!g[c]) g[c] = { customer: c, billed: 0, outstanding: 0, count: 0 };
  g[c].billed += inv._total || 0;
  g[c].outstanding += inv._balance || 0;
  g[c].count++;
}
return Object.values(g).filter(c => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding);`,
      },
    },
    {
      name: '6. Overdue report (zoho-finance-ops, deterministic)',
      args: { op: 'build_overdue_report' },
    },
    {
      name: '7. Script on non-list op (should error)',
      args: { op: 'get_invoice', invoiceId: 'test', script: 'return data' },
    },
  ];

  for (const test of tests) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`TEST: ${test.name}`);
    console.log('='.repeat(70));

    const start = Date.now();
    try {
      const result = await tool.execute(test.args as any, ctx);
      const ms = Date.now() - start;

      if (result.ok) {
        const v = result.value;
        console.log(`  Status:        SUCCESS (${ms}ms)`);
        console.log(`  Message:       ${(v.message ?? '').slice(0, 200)}`);
        if ((v as any).totalFetched !== undefined) console.log(`  Total fetched: ${(v as any).totalFetched}`);
        if ((v as any).rowCount !== undefined)     console.log(`  Row count:     ${(v as any).rowCount}`);
        if ((v as any).sourceTruncated)            console.log(`  TRUNCATED:     YES`);
        if (v.csvLink) console.log(`  CSV:           ${v.csvLink.slice(0, 80)}...`);

        const data = v.data;
        if (Array.isArray(data)) {
          console.log(`  Inline rows:   ${data.length}`);
          if (data.length > 0) console.log(`  First row:     ${JSON.stringify(data[0]).slice(0, 250)}`);
          if (data.length > 1) console.log(`  Last row:      ${JSON.stringify(data[data.length - 1]).slice(0, 250)}`);
        } else if (v.report) {
          const report = v.report as Record<string, unknown>;
          console.log(`  Report keys:   ${Object.keys(report).join(', ')}`);
        }

        if ((v as any).moduleSchema) {
          const s = (v as any).moduleSchema as Record<string, unknown>;
          console.log(`  Schema module: ${s['module']}`);
          if (s['sampleFieldNames']) console.log(`  Sample fields: ${JSON.stringify(s['sampleFieldNames'])}`);
        }
      } else {
        console.log(`  Status:  ERROR (${ms}ms)`);
        console.log(`  Error:   ${result.error.message}`);
      }
    } catch (e) {
      console.log(`  EXCEPTION: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('ALL TESTS COMPLETE');
  console.log('='.repeat(70));

  await cacheRedis.quit().catch(() => {});
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
