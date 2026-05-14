import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { decryptToken } from '../src/infrastructure/shared/token.crypto.js';

const prisma   = new PrismaClient();
const ENC_KEY  = process.env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '';
const API_BASE = process.env.ZOHO_API_BASE_URL ?? 'https://www.zohoapis.in';
const ACCT_BASE = process.env.ZOHO_ACCOUNTS_BASE_URL ?? 'https://accounts.zoho.in';

async function getToken(companyId: string): Promise<string> {
  const conn = await prisma.zohoConnection.findFirst({ where: { companyId } });
  if (!conn) throw new Error('No ZohoConnection');
  const expiresAt = conn.accessTokenExpiresAt ? new Date(conn.accessTokenExpiresAt).getTime() : 0;
  if (expiresAt - Date.now() > 120_000 && conn.accessTokenEncrypted) {
    return decryptToken(conn.accessTokenEncrypted, ENC_KEY);
  }
  if (!conn.refreshTokenEncrypted) throw new Error('No refresh token');
  const cfg = await prisma.zohoOAuthConfig.findFirst({ where: { companyId } });
  const clientId     = cfg?.clientId ?? process.env.ZOHO_CLIENT_ID!;
  const clientSecret = cfg?.clientSecret ? decryptToken(cfg.clientSecret, ENC_KEY) : process.env.ZOHO_CLIENT_SECRET!;
  const refreshToken = decryptToken(conn.refreshTokenEncrypted, ENC_KEY);
  const resp = await fetch(`${ACCT_BASE}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
  });
  const data = await resp.json() as Record<string, string>;
  if (!data['access_token']) throw new Error(`Refresh failed: ${JSON.stringify(data)}`);
  return data['access_token'];
}

async function getDefaultOrgId(token: string): Promise<string> {
  const resp = await fetch(`${API_BASE}/books/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await resp.json() as Record<string, unknown>;
  const orgs = (Array.isArray(data['organizations']) ? data['organizations'] : []) as Record<string, unknown>[];
  const def = orgs.find(o => o['is_default_org']) ?? orgs[0];
  if (!def) throw new Error('No org found');
  console.log(`Org: ${def['name']} (${def['organization_id']})`);
  return String(def['organization_id']);
}

async function fetchAll(token: string, orgId: string, module: string, filters: Record<string, string>): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const moduleKey = module === 'customerpayments' ? 'payments' : module;
  for (let page = 1; page <= 20; page++) {
    const params = new URLSearchParams({ organization_id: orgId, page: String(page), per_page: '200', ...filters });
    const resp = await fetch(`${API_BASE}/books/v3/${module}?${params}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!resp.ok) { const b = await resp.text(); throw new Error(`Zoho ${resp.status}: ${b.slice(0, 300)}`); }
    const data = await resp.json() as Record<string, unknown>;
    const items = (Array.isArray(data[moduleKey]) ? data[moduleKey] : []) as Record<string, unknown>[];
    for (const item of items) {
      const id = String(item[`${module.replace(/s$/, '')}_id`] ?? item['expense_id'] ?? item['payment_id'] ?? item['invoice_id'] ?? JSON.stringify(item));
      if (!seen.has(id)) { seen.add(id); all.push(item); }
    }
    const ctx = data['page_context'] as Record<string, unknown> | undefined;
    const hasMore = ctx?.['has_more_page'] === true;
    if (!hasMore) break;
    console.log(`  Page ${page}: ${items.length} records (total: ${all.length})`);
  }
  return all;
}

async function main() {
  const companies = await prisma.company.findMany({ take: 5 });
  const companyId = companies[0]?.id;
  if (!companyId) { console.error('No company found'); return; }
  console.log(`Company: ${companyId}\n`);

  const token = await getToken(companyId);
  const orgId = await getDefaultOrgId(token);

  // ══════════════════════════════════════════════════════════════════════════
  // PROMPT 2: March vs April 2026 EXPENSES
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n═══ PROMPT 2: March vs April 2026 Expenses ═══');

  const marchExpenses = await fetchAll(token, orgId, 'expenses', { date_start: '2026-03-01', date_end: '2026-03-31' });
  const aprilExpenses = await fetchAll(token, orgId, 'expenses', { date_start: '2026-04-01', date_end: '2026-04-30' });

  const sumExpenses = (items: Record<string, unknown>[]) => items.reduce((s, e) => s + Number(e['total'] ?? 0), 0);

  const marchTotal = sumExpenses(marchExpenses);
  const aprilTotal = sumExpenses(aprilExpenses);
  const pctChange = ((aprilTotal - marchTotal) / marchTotal * 100).toFixed(2);

  console.log(`March 2026:  ${marchExpenses.length} expenses, ₹${marchTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
  console.log(`April 2026:  ${aprilExpenses.length} expenses, ₹${aprilTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
  console.log(`% Change:    ${pctChange}%`);
  console.log(`\nDivo said: March=298/₹3,213,391.92, April=395/₹5,757,490.51, +79.17%`);

  // ══════════════════════════════════════════════════════════════════════════
  // PROMPT 5: Unpaid invoices, top 5 by outstanding balance
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n═══ PROMPT 5: Unpaid Invoices ═══');

  const unpaidInvoices = await fetchAll(token, orgId, 'invoices', { status: 'sent,overdue,partially_paid' });
  console.log(`Total unpaid invoices: ${unpaidInvoices.length}`);

  const byCustomer = new Map<string, { name: string; balance: number; count: number }>();
  for (const inv of unpaidInvoices) {
    const name = String(inv['customer_name'] ?? 'Unknown');
    const balance = Number(inv['balance'] ?? 0);
    const existing = byCustomer.get(name) ?? { name, balance: 0, count: 0 };
    existing.balance += balance;
    existing.count++;
    byCustomer.set(name, existing);
  }

  const top5 = [...byCustomer.values()].sort((a, b) => b.balance - a.balance).slice(0, 5);
  console.log('\nTop 5 by outstanding balance:');
  for (const c of top5) {
    console.log(`  ${c.name}: ₹${c.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })} (${c.count} invoices)`);
  }

  console.log(`\nDivo said: 170 unpaid invoices`);
  console.log(`  Convonix Systems: ₹1,98,24,407.00`);
  console.log(`  Interactive Avenues: ₹44,55,577.00`);
  console.log(`  Zenith Optimedia: ₹32,10,849.00`);
  console.log(`  TATVARTHA HEALTH: ₹23,12,252.58`);
  console.log(`  Bajaj General Insurance: ₹22,50,490.45`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
