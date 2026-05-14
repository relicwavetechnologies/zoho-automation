import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { decryptToken } from '../src/infrastructure/shared/token.crypto.js';

const prisma   = new PrismaClient();
const ENC_KEY  = process.env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '';
const API_BASE = process.env.ZOHO_API_BASE_URL ?? 'https://www.zohoapis.in';
const ACCT_BASE = process.env.ZOHO_ACCOUNTS_BASE_URL ?? 'https://accounts.zoho.in';

async function getToken(cid: string) {
  const conn = await prisma.zohoConnection.findFirst({ where: { companyId: cid } });
  if (!conn?.refreshTokenEncrypted) throw new Error('No conn');
  const cfg = await prisma.zohoOAuthConfig.findFirst({ where: { companyId: cid } });
  const clientId = cfg?.clientId ?? process.env.ZOHO_CLIENT_ID!;
  const clientSecret = cfg?.clientSecret ? decryptToken(cfg.clientSecret, ENC_KEY) : process.env.ZOHO_CLIENT_SECRET!;
  const rt = decryptToken(conn.refreshTokenEncrypted, ENC_KEY);
  const r = await fetch(`${ACCT_BASE}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: rt }),
  });
  const d = await r.json() as Record<string, string>;
  if (!d['access_token']) throw new Error(`Refresh failed: ${JSON.stringify(d)}`);
  return d['access_token'];
}

async function main() {
  const co = await prisma.company.findFirst();
  if (!co) throw new Error('No company');
  const token = await getToken(co.id);

  const orgResp = await fetch(`${API_BASE}/books/v3/organizations`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  const orgData = await orgResp.json() as Record<string, unknown>;
  const orgs = (orgData['organizations'] as Record<string, unknown>[]) ?? [];
  const orgId = String((orgs.find(o => o['is_default_org']) ?? orgs[0])?.['organization_id']);
  console.log(`Org: ${orgId}\n`);

  const statuses = ['sent', 'overdue', 'partially_paid'];
  const allInvoices: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const status of statuses) {
    for (let page = 1; page <= 20; page++) {
      const params = new URLSearchParams({ organization_id: orgId, status, page: String(page), per_page: '200' });
      const resp = await fetch(`${API_BASE}/books/v3/invoices?${params}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
      if (!resp.ok) { console.error(`Zoho ${resp.status} for status=${status}`); break; }
      const data = await resp.json() as Record<string, unknown>;
      const items = (data['invoices'] as Record<string, unknown>[]) ?? [];
      for (const inv of items) {
        const id = String(inv['invoice_id']);
        if (!seen.has(id)) { seen.add(id); allInvoices.push(inv); }
      }
      const ctx = data['page_context'] as Record<string, unknown> | undefined;
      if (ctx?.['has_more_page'] !== true) break;
    }
  }

  console.log(`Total unpaid invoices: ${allInvoices.length}`);

  const byCustomer = new Map<string, { name: string; balance: number; total: number; count: number }>();
  for (const inv of allInvoices) {
    const name = String(inv['customer_name'] ?? 'Unknown');
    const balance = Number(inv['balance'] ?? 0);
    const total = Number(inv['total'] ?? 0);
    const e = byCustomer.get(name) ?? { name, balance: 0, total: 0, count: 0 };
    e.balance += balance;
    e.total += total;
    e.count++;
    byCustomer.set(name, e);
  }

  const top5 = [...byCustomer.values()].sort((a, b) => b.balance - a.balance).slice(0, 5);
  console.log('\nTop 5 by outstanding balance (ACTUAL from Zoho API):');
  for (const c of top5) {
    console.log(`  ${c.name}: ₹${c.balance.toFixed(2)} (${c.count} invoices, total=₹${c.total.toFixed(2)})`);
  }

  console.log('\nDivo said (top 5):');
  console.log('  Convonix Systems Pvt. Ltd: ₹19,824,407.00');
  console.log('  Interactive Avenues Pvt. Ltd.: ₹4,455,577.00');
  console.log('  Zenith Optimedia: ₹3,210,849.00');
  console.log('  TATVARTHA HEALTH: ₹2,312,252.58');
  console.log('  Bajaj General Insurance: ₹2,250,490.45');

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
