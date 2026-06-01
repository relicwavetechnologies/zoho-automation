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
  const cacheRedis = new Redis(env.REDIS_CACHE_URL || env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  await cacheRedis.connect().catch(() => {});
  const cache = new RedisCache(cacheRedis);
  const connRepo = new ZohoConnectionRepository(prisma, env);
  const tokenService = new ZohoTokenService(connRepo, cache, env, log);
  const client = new ZohoBooksPaginatedClient(tokenService, env.ZOHO_API_BASE_URL);
  const company = await prisma.company.findFirst();
  if (!company) throw new Error('No company');

  const rates = await getExchangeRates();
  const { toINR } = buildCurrencyUtilities(rates);

  // Fetch all outstanding invoices (any status with balance > 0)
  const statuses = ['unpaid', 'overdue', 'partially_paid', 'sent'];
  const all: Record<string, unknown>[] = [];
  for (const s of statuses) {
    const r = await client.listAllRecords({ companyId: company.id, moduleName: 'invoices', filters: { status: s } });
    all.push(...r.items);
  }
  const seen = new Set<string>();
  const deduped = all.filter(inv => {
    const id = String(inv.invoice_id);
    if (seen.has(id)) return false;
    seen.add(id);
    return Number(inv.balance ?? 0) > 0;
  });

  // Group by currency
  const byCurrency = new Map<string, { count: number; balance: number }>();
  for (const inv of deduped) {
    const cur = String(inv.currency_code || 'INR');
    const e = byCurrency.get(cur) ?? { count: 0, balance: 0 };
    e.count++;
    e.balance += Number(inv.balance ?? 0);
    byCurrency.set(cur, e);
  }

  console.log('=== Q1 VERIFICATION: Outstanding invoices by currency ===\n');
  console.log(`Total outstanding invoices: ${deduped.length}`);
  let grandTotalINR = 0;
  for (const [cur, d] of [...byCurrency.entries()].sort((a, b) => b[1].balance - a[1].balance)) {
    const inr = toINR(d.balance, cur);
    grandTotalINR += inr;
    console.log(`  ${cur}: ${d.count} invoices, balance ${fmt(d.balance)}, in INR: ₹${fmt(inr)}`);
  }
  console.log(`\n  Grand total in INR: ₹${fmt(grandTotalINR)}`);

  // Q2: Monthly invoice trend (last 6 months)
  console.log('\n=== Q2 VERIFICATION: Monthly invoices created (last 6 months) ===\n');
  const allInvoices = await client.listAllRecords({ companyId: company.id, moduleName: 'invoices' });
  const monthly = new Map<string, { count: number; total: number }>();
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  for (const inv of allInvoices.items) {
    const d = String(inv.date ?? '');
    if (!d) continue;
    const dt = new Date(d);
    if (dt < sixMonthsAgo) continue;
    const key = d.slice(0, 7); // YYYY-MM
    const e = monthly.get(key) ?? { count: 0, total: 0 };
    e.count++;
    e.total += Number(inv.total ?? 0);
    monthly.set(key, e);
  }
  for (const [month, d] of [...monthly.entries()].sort()) {
    console.log(`  ${month}: ${d.count} invoices, total ₹${fmt(d.total)}`);
  }

  // Q3: Top 5 expenses by amount this year
  console.log('\n=== Q3 VERIFICATION: Top 10 expenses this year ===\n');
  const expenses = await client.listAllRecords({ companyId: company.id, moduleName: 'expenses' });
  const thisYear = new Date().getFullYear();
  const yearExpenses = expenses.items
    .filter(e => String(e.date ?? '').startsWith(String(thisYear)))
    .map(e => ({
      id: e.expense_id, account: String(e.account_name ?? ''), vendor: String(e.vendor_name ?? ''),
      total: Number(e.total ?? 0), currency: String(e.currency_code ?? 'INR'), date: String(e.date ?? ''),
    }))
    .sort((a, b) => b.total - a.total);
  const totalExpenses = yearExpenses.reduce((s, e) => s + e.total, 0);
  console.log(`  Total expenses this year: ${yearExpenses.length}, sum: ₹${fmt(totalExpenses)}`);
  for (const e of yearExpenses.slice(0, 10)) {
    console.log(`  ${e.date} | ${e.account.slice(0, 30).padEnd(30)} | ${e.vendor.slice(0, 20).padEnd(20)} | ₹${fmt(e.total)} ${e.currency}`);
  }

  // Q4: Top 5 vendors by bill amount
  console.log('\n=== Q4 VERIFICATION: Top 5 vendors by total bill amount ===\n');
  const bills = await client.listAllRecords({ companyId: company.id, moduleName: 'bills' });
  const byVendor = new Map<string, { count: number; total: number; balance: number }>();
  for (const bill of bills.items) {
    const vendor = String(bill.vendor_name ?? 'Unknown');
    const e = byVendor.get(vendor) ?? { count: 0, total: 0, balance: 0 };
    e.count++;
    e.total += Number(bill.total ?? 0);
    e.balance += Number(bill.balance ?? 0);
    byVendor.set(vendor, e);
  }
  const sortedVendors = [...byVendor.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [vendor, d] of sortedVendors.slice(0, 5)) {
    console.log(`  ${vendor.slice(0, 35).padEnd(35)} | ${d.count} bills | total: ₹${fmt(d.total)} | outstanding: ₹${fmt(d.balance)}`);
  }

  // Q5: Paid vs unpaid invoices this month
  console.log('\n=== Q5 VERIFICATION: This month invoice status breakdown ===\n');
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const thisMonthInvoices = allInvoices.items.filter(inv => String(inv.date ?? '').startsWith(thisMonth));
  const statusBreakdown = new Map<string, { count: number; total: number }>();
  for (const inv of thisMonthInvoices) {
    const status = String(inv.status ?? 'unknown');
    const e = statusBreakdown.get(status) ?? { count: 0, total: 0 };
    e.count++;
    e.total += Number(inv.total ?? 0);
    statusBreakdown.set(status, e);
  }
  console.log(`  Total invoices this month (${thisMonth}): ${thisMonthInvoices.length}`);
  for (const [status, d] of [...statusBreakdown.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${status.padEnd(20)} | ${d.count} invoices | ₹${fmt(d.total)}`);
  }

  await prisma.$disconnect();
  await cacheRedis.quit();
}

main().catch(e => { console.error(e); process.exit(1); });
