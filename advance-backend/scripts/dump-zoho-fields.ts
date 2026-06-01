/**
 * Dump one sample record from each Zoho Books module to see exact field names.
 * Focus: amount fields, currency fields, bcy_ fields, exchange_rate.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { ZohoTokenService } from '../src/infrastructure/zoho/zoho-token.service.js';
import { ZohoConnectionRepository } from '../src/infrastructure/zoho/zoho-connection.repository.js';
import { ZohoBooksPaginatedClient } from '../src/infrastructure/zoho/zoho-books-paginated.client.js';
import { RedisCache } from '../src/infrastructure/cache/redis-cache.js';
import { loadAndValidateEnv } from '../src/config/env.js';
import Redis from 'ioredis';

const env = loadAndValidateEnv(process.env);
const prisma = new PrismaClient();
const log: any = { info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, child:()=>log };

const MODULES = [
  'invoices', 'bills', 'expenses', 'customerpayments', 'vendorpayments',
  'creditnotes', 'salesorders', 'purchaseorders', 'estimates',
  'banktransactions', 'contacts', 'items', 'bankaccounts',
] as const;

async function main() {
  const redis = new Redis(env.REDIS_CACHE_URL || env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  await redis.connect().catch(() => {});
  const cache = new RedisCache(redis);
  const connRepo = new ZohoConnectionRepository(prisma, env);
  const tokenService = new ZohoTokenService(connRepo, cache, env, log);
  const client = new ZohoBooksPaginatedClient(tokenService, env.ZOHO_API_BASE_URL);
  const company = await prisma.company.findFirst();
  if (!company) throw new Error('No company');

  for (const mod of MODULES) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`MODULE: ${mod}`);
    console.log('='.repeat(60));

    try {
      const result = await client.listAllRecords({ companyId: company.id, moduleName: mod, maxPages: 1 });
      if (result.items.length === 0) {
        console.log('  (no records)');
        continue;
      }

      const sample = result.items[0]!;
      const allKeys = Object.keys(sample);

      // Find amount fields (contain numbers that look like money)
      const amountKeys = allKeys.filter(k =>
        /amount|total|balance|rate|price|cost|tax|discount|credit|debit|payment|exchange|bcy|fcy/i.test(k)
      );

      // Find currency fields
      const currencyKeys = allKeys.filter(k =>
        /currency|currency_code|currency_id|currency_symbol/i.test(k)
      );

      console.log(`\n  All fields (${allKeys.length}): ${allKeys.join(', ')}`);
      console.log(`\n  Amount-related fields:`);
      for (const k of amountKeys) {
        console.log(`    ${k}: ${JSON.stringify(sample[k])}`);
      }
      console.log(`\n  Currency-related fields:`);
      for (const k of currencyKeys) {
        console.log(`    ${k}: ${JSON.stringify(sample[k])}`);
      }

      // Check for a USD record if possible
      if (result.items.length > 1) {
        const foreign = result.items.find(r => r.currency_code && r.currency_code !== 'INR');
        if (foreign) {
          console.log(`\n  FOREIGN CURRENCY SAMPLE (${foreign.currency_code}):`);
          for (const k of [...amountKeys, ...currencyKeys]) {
            if (foreign[k] !== undefined) console.log(`    ${k}: ${JSON.stringify(foreign[k])}`);
          }
        }
      }
    } catch (e) {
      console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await prisma.$disconnect();
  await redis.quit();
}

main().catch(e => { console.error(e); process.exit(1); });
