/**
 * Audit script: verify overdue invoice data directly from Zoho Books.
 * Bypasses the LLM entirely — calls the API and prints raw numbers.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { ZohoTokenService } from '../src/infrastructure/zoho/zoho-token.service.js';
import { ZohoConnectionRepository } from '../src/infrastructure/zoho/zoho-connection.repository.js';
import { ZohoBooksPaginatedClient } from '../src/infrastructure/zoho/zoho-books-paginated.client.js';
import { ZohoFinanceOps } from '../src/application/zoho/zoho-finance-ops.js';
import { RedisCache } from '../src/infrastructure/cache/redis-cache.js';
import { loadAndValidateEnv } from '../src/config/env.js';
import Redis from 'ioredis';

const env    = loadAndValidateEnv(process.env);
const prisma = new PrismaClient();
const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log };
const cloudinary: any = { isAvailable: false, uploadCsvBuffer: async () => null };

async function main() {
  const company = await prisma.company.findFirst();
  if (!company) throw new Error('No company');
  console.log(`Company: ${company.name} (${company.id})\n`);

  const cacheRedis = new Redis(env.REDIS_CACHE_URL || env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  await cacheRedis.connect().catch(() => console.log('Redis cache unavailable'));
  const cache = new RedisCache(cacheRedis);

  const connRepo     = new ZohoConnectionRepository(prisma, env);
  const tokenService = new ZohoTokenService(connRepo, cache, env, log);
  const booksClient  = new ZohoBooksPaginatedClient(tokenService, env.ZOHO_API_BASE_URL);
  const financeOps   = new ZohoFinanceOps(booksClient, cloudinary, log);

  console.log('=== STEP 1: Build overdue report (same as Divo) ===\n');
  const report = await financeOps.buildOverdueReport({ companyId: company.id });

  console.log(`Total overdue invoices: ${report.invoiceCount}`);
  console.log(`Total outstanding (balance): ₹${formatINR(report.totalOutstanding)}`);
  console.log(`Truncated: ${report.truncated}\n`);

  console.log('=== STEP 2: Top customers by overdue balance ===\n');
  const topCustomers = (report as any).topCustomers as Array<{
    customerName: string; invoiceCount: number; balance: number; total: number;
  }>;
  if (topCustomers) {
    for (let i = 0; i < Math.min(10, topCustomers.length); i++) {
      const c = topCustomers[i]!;
      console.log(`${i + 1}. ${c.customerName}`);
      console.log(`   Invoices: ${c.invoiceCount}`);
      console.log(`   Balance (outstanding): ₹${formatINR(c.balance)}`);
      console.log(`   Total (full amount):   ₹${formatINR(c.total ?? 0)}`);
      console.log();
    }
  }

  console.log('=== STEP 3: Raw invoice list (first 20 overdue, sorted by balance desc) ===\n');
  const rawResult = await booksClient.listAllRecords({
    companyId: company.id,
    moduleName: 'invoices',
    filters: { status: 'overdue' },
  });

  const invoices = rawResult.items
    .map(inv => ({
      number: inv['invoice_number'] as string,
      customer: inv['customer_name'] as string,
      total: Number(inv['total'] ?? 0),
      balance: Number(inv['balance'] ?? 0),
      currency: inv['currency_code'] as string,
      dueDate: inv['due_date'] as string,
      status: inv['status'] as string,
    }))
    .sort((a, b) => b.balance - a.balance);

  console.log(`Total overdue invoices fetched: ${invoices.length}`);
  console.log(`Sum of balance: ₹${formatINR(invoices.reduce((s, i) => s + i.balance, 0))}`);
  console.log(`Sum of total:   ₹${formatINR(invoices.reduce((s, i) => s + i.total, 0))}\n`);

  console.log('Top 20 by balance:');
  for (const inv of invoices.slice(0, 20)) {
    console.log(`  ${inv.number} | ${inv.customer.slice(0, 30).padEnd(30)} | balance: ₹${formatINR(inv.balance).padStart(15)} | total: ₹${formatINR(inv.total).padStart(15)} | ${inv.currency} | due: ${inv.dueDate}`);
  }

  console.log('\n=== STEP 4: Group by customer (verify Divo\'s top 5) ===\n');
  const byCustomer = new Map<string, { balance: number; total: number; count: number }>();
  for (const inv of invoices) {
    const existing = byCustomer.get(inv.customer) ?? { balance: 0, total: 0, count: 0 };
    existing.balance += inv.balance;
    existing.total += inv.total;
    existing.count++;
    byCustomer.set(inv.customer, existing);
  }

  const sorted = [...byCustomer.entries()]
    .sort((a, b) => b[1].balance - a[1].balance);

  for (let i = 0; i < Math.min(10, sorted.length); i++) {
    const [name, data] = sorted[i]!;
    console.log(`${i + 1}. ${name}`);
    console.log(`   Invoices: ${data.count} | Balance: ₹${formatINR(data.balance)} | Total: ₹${formatINR(data.total)}`);
  }

  console.log(`\nTop 5 balance sum: ₹${formatINR(sorted.slice(0, 5).reduce((s, [, d]) => s + d.balance, 0))}`);

  await prisma.$disconnect();
  await cacheRedis.quit();
}

function formatINR(n: number): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

main().catch(e => { console.error(e); process.exit(1); });
