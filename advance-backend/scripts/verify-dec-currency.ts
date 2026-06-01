import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { ZohoTokenService } from '../src/infrastructure/zoho/zoho-token.service.js';
import { ZohoConnectionRepository } from '../src/infrastructure/zoho/zoho-connection.repository.js';
import { ZohoBooksPaginatedClient } from '../src/infrastructure/zoho/zoho-books-paginated.client.js';
import { RedisCache } from '../src/infrastructure/cache/redis-cache.js';
import { loadAndValidateEnv } from '../src/config/env.js';
import { getExchangeRates, buildCurrencyUtilities } from '../src/application/zoho/exchange-rate.service.js';
import Redis from 'ioredis';

const env = loadAndValidateEnv(process.env);
const prisma = new PrismaClient();
const log: any = { info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, child:()=>log };
const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const redis = new Redis(env.REDIS_CACHE_URL || env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  await redis.connect().catch(() => {});
  const cache = new RedisCache(redis);
  const connRepo = new ZohoConnectionRepository(prisma, env);
  const tokenService = new ZohoTokenService(connRepo, cache, env, log);
  const client = new ZohoBooksPaginatedClient(tokenService, env.ZOHO_API_BASE_URL);
  const company = await prisma.company.findFirst();
  if (!company) throw new Error('No company');

  const rates = await getExchangeRates();
  const { toINR } = buildCurrencyUtilities(rates);

  const result = await client.listAllRecords({ companyId: company.id, moduleName: 'invoices' });
  console.log(`Total invoices fetched: ${result.items.length}\n`);

  // Check Dec 2025 to explain the difference
  for (const month of ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) {
    const items = result.items.filter(i => String(i.date ?? '').startsWith(month));
    const byCur: Record<string, { count: number; rawTotal: number; inrTotal: number }> = {};
    for (const inv of items) {
      const cur = String(inv.currency_code || 'INR');
      if (!byCur[cur]) byCur[cur] = { count: 0, rawTotal: 0, inrTotal: 0 };
      byCur[cur].count++;
      const total = Number(inv.total ?? 0);
      byCur[cur].rawTotal += total;
      byCur[cur].inrTotal += toINR(total, cur);
    }

    let rawSum = 0;
    let inrSum = 0;
    const parts: string[] = [];
    for (const [cur, d] of Object.entries(byCur)) {
      rawSum += d.rawTotal;
      inrSum += d.inrTotal;
      if (cur !== 'INR') {
        parts.push(`${cur}: ${d.count} inv, raw ${fmt(d.rawTotal)}, INR ${fmt(d.inrTotal)}`);
      }
    }

    const foreignNote = parts.length > 0 ? ` [foreign: ${parts.join('; ')}]` : '';
    console.log(`${month}: ${items.length} inv | raw sum: ₹${fmt(rawSum)} | correct INR: ₹${fmt(inrSum)}${foreignNote}`);
  }

  await prisma.$disconnect();
  await redis.quit();
}

main().catch(e => { console.error(e); process.exit(1); });
