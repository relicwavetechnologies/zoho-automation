import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { ZohoTokenService } from '../src/infrastructure/zoho/zoho-token.service.js';
import { ZohoConnectionRepository } from '../src/infrastructure/zoho/zoho-connection.repository.js';
import { ZohoBooksPaginatedClient } from '../src/infrastructure/zoho/zoho-books-paginated.client.js';
import { RedisCache } from '../src/infrastructure/cache/redis-cache.js';
import { loadAndValidateEnv } from '../src/config/env.js';
import { getExchangeRates, buildCurrencyUtilities } from '../src/application/zoho/exchange-rate.service.js';
import { getModuleSchema, injectSyntheticFields } from '../src/infrastructure/zoho/zoho-books-schema.cache.js';
import Redis from 'ioredis';

const env = loadAndValidateEnv(process.env);
const prisma = new PrismaClient();
const log: any = { info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, child:()=>log };
const fmt = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const cacheRedis = new Redis(env.REDIS_CACHE_URL || env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  await cacheRedis.connect().catch(() => {});
  const cache = new RedisCache(cacheRedis);
  const connRepo = new ZohoConnectionRepository(prisma, env);
  const tokenService = new ZohoTokenService(connRepo, cache, env, log);
  const client = new ZohoBooksPaginatedClient(tokenService, env.ZOHO_API_BASE_URL);
  const company = await prisma.company.findFirst();
  if (!company) throw new Error('No company');

  const rates = await getExchangeRates();
  const currencyUtils = buildCurrencyUtilities(rates);

  // Fetch ALL invoices (same as what Divo's auto-upgrade does)
  const allInvoices = await client.listAllRecords({ companyId: company.id, moduleName: 'invoices' });
  console.log(`Total invoices fetched: ${allInvoices.items.length}\n`);

  const schema = getModuleSchema('invoices');
  const enriched = injectSyntheticFields(allInvoices.items, schema, currencyUtils);

  // Sum _balance_inr and _amount_inr — this is exactly what Divo's sandbox would compute
  const sumBalanceInr = enriched.reduce((s, d) => s + Number(d._balance_inr ?? 0), 0);
  const sumAmountInr = enriched.reduce((s, d) => s + Number(d._amount_inr ?? 0), 0);
  const sumBalance = enriched.reduce((s, d) => s + Number(d._balance ?? 0), 0);
  const sumAmount = enriched.reduce((s, d) => s + Number(d._amount ?? 0), 0);

  console.log('=== SYNTHETIC FIELD SUMS (what Divo sees) ===');
  console.log(`  _amount_inr sum  : ${fmt(sumAmountInr)}`);
  console.log(`  _balance_inr sum : ${fmt(sumBalanceInr)}`);
  console.log(`  _amount sum      : ${fmt(sumAmount)} (original currency)`);
  console.log(`  _balance sum     : ${fmt(sumBalance)} (original currency)`);

  // Break down by currency to verify conversion
  const byCurrency = new Map<string, { count: number; balanceOrig: number; balanceInr: number; amountOrig: number; amountInr: number }>();
  for (const inv of enriched) {
    const cur = String(inv._currency ?? 'INR');
    const e = byCurrency.get(cur) ?? { count: 0, balanceOrig: 0, balanceInr: 0, amountOrig: 0, amountInr: 0 };
    e.count++;
    e.balanceOrig += Number(inv._balance ?? 0);
    e.balanceInr += Number(inv._balance_inr ?? 0);
    e.amountOrig += Number(inv._amount ?? 0);
    e.amountInr += Number(inv._amount_inr ?? 0);
    byCurrency.set(cur, e);
  }

  console.log('\n=== BREAKDOWN BY CURRENCY ===');
  for (const [cur, d] of [...byCurrency.entries()].sort((a, b) => b[1].amountInr - a[1].amountInr)) {
    console.log(`  ${cur}: ${d.count} invoices`);
    console.log(`    _amount: ${fmt(d.amountOrig)} ${cur} → _amount_inr: ${fmt(d.amountInr)}`);
    console.log(`    _balance: ${fmt(d.balanceOrig)} ${cur} → _balance_inr: ${fmt(d.balanceInr)}`);
  }

  // Show a few foreign currency records to spot-check conversion
  console.log('\n=== SAMPLE FOREIGN CURRENCY INVOICES ===');
  const foreign = enriched.filter(d => d._currency !== 'INR' && Number(d._balance ?? 0) > 0).slice(0, 5);
  for (const inv of foreign) {
    console.log(`  ${inv._id}: ${inv._currency} balance=${inv._balance} → _balance_inr=${inv._balance_inr} (exchange_rate=${inv.exchange_rate ?? 'N/A'})`);
  }

  // Monthly trend verification (same as Q2)
  console.log('\n=== MONTHLY TREND (using _amount_inr) ===');
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const monthly = new Map<string, { count: number; amountInr: number }>();
  for (const inv of enriched) {
    const d = String(inv._date ?? '');
    if (!d || new Date(d) < sixMonthsAgo) continue;
    const key = d.slice(0, 7);
    const e = monthly.get(key) ?? { count: 0, amountInr: 0 };
    e.count++;
    e.amountInr += Number(inv._amount_inr ?? 0);
    monthly.set(key, e);
  }
  for (const [month, d] of [...monthly.entries()].sort()) {
    console.log(`  ${month}: ${d.count} invoices, amount_inr: ${fmt(d.amountInr)}`);
  }

  // Payments verification
  console.log('\n=== CUSTOMER PAYMENTS 2026 BY MONTH ===');
  const payments = await client.listAllRecords({ companyId: company.id, moduleName: 'customerpayments' });
  const paySchema = getModuleSchema('customerpayments');
  const enrichedPayments = injectSyntheticFields(payments.items, paySchema, currencyUtils);
  const payMonthly = new Map<string, { count: number; amountInr: number }>();
  for (const p of enrichedPayments) {
    const d = String(p._date ?? '');
    if (!d.startsWith('2026')) continue;
    const key = d.slice(0, 7);
    const e = payMonthly.get(key) ?? { count: 0, amountInr: 0 };
    e.count++;
    e.amountInr += Number(p._amount_inr ?? 0);
    payMonthly.set(key, e);
  }
  for (const [month, d] of [...payMonthly.entries()].sort()) {
    console.log(`  ${month}: ${d.count} payments, amount_inr: ${fmt(d.amountInr)}`);
  }

  await prisma.$disconnect();
  await cacheRedis.quit();
}

main().catch(e => { console.error(e); process.exit(1); });
