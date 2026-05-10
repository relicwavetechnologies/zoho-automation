import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { decryptToken } from '../src/infrastructure/shared/token.crypto.js';

const prisma  = new PrismaClient();
const ENC_KEY = process.env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '';
const API_BASE = process.env.ZOHO_API_BASE_URL ?? 'https://www.zohoapis.in';
const ACCT_BASE = process.env.ZOHO_ACCOUNTS_BASE_URL ?? 'https://accounts.zoho.in';

async function getToken(companyId: string): Promise<string> {
  const conn = await prisma.zohoConnection.findFirst({ where: { companyId } });
  if (!conn) throw new Error('No ZohoConnection');

  const expiresAt = conn.accessTokenExpiresAt ? new Date(conn.accessTokenExpiresAt).getTime() : 0;
  const needsRefresh = expiresAt - Date.now() < 120_000;

  if (!needsRefresh && conn.accessTokenEncrypted) {
    return decryptToken(conn.accessTokenEncrypted, ENC_KEY);
  }

  if (!conn.refreshTokenEncrypted) throw new Error('No refresh token');
  const cfg = await prisma.zohoOAuthConfig.findFirst({ where: { companyId } });
  const clientId     = cfg?.clientId ?? process.env.ZOHO_CLIENT_ID!;
  const clientSecret = cfg?.clientSecret
    ? decryptToken(cfg.clientSecret, ENC_KEY)
    : process.env.ZOHO_CLIENT_SECRET!;
  const refreshToken = decryptToken(conn.refreshTokenEncrypted, ENC_KEY);

  const resp = await fetch(`${ACCT_BASE}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
  });
  const data = await resp.json() as Record<string, string>;
  if (!data['access_token']) throw new Error(`Refresh failed: ${JSON.stringify(data)}`);
  console.log('  Token refreshed ✓');
  return data['access_token'];
}

async function getDefaultOrgId(token: string): Promise<string> {
  const resp = await fetch(`${API_BASE}/books/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await resp.json() as Record<string, unknown>;
  const orgs = (Array.isArray(data['organizations']) ? data['organizations'] : []) as Record<string, unknown>[];
  const def  = orgs.find(o => o['is_default_org']) ?? orgs[0];
  if (!def) throw new Error('No org found');
  console.log(`  Org: ${def['name']} (${def['organization_id']})`);
  return String(def['organization_id']);
}

async function fetchPage(token: string, orgId: string, from: string, to: string, page: number) {
  const params = new URLSearchParams({ organization_id: orgId, from_date: from, to_date: to, page: String(page), per_page: '200' });
  const resp = await fetch(`${API_BASE}/books/v3/expenses?${params}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (!resp.ok) { const b = await resp.text(); throw new Error(`Zoho ${resp.status}: ${b.slice(0,200)}`); }
  const data = await resp.json() as Record<string, unknown>;
  const items = (Array.isArray(data['expenses']) ? data['expenses'] : []) as Record<string, unknown>[];
  const ctx  = data['page_context'] as Record<string, unknown> | undefined;
  return { items, hasMore: Boolean(ctx?.['has_more_page']) };
}

async function main() {
  const co = await prisma.company.findFirst();
  if (!co) throw new Error('No company');
  console.log('Company:', co.name);

  const token = await getToken(co.id);
  const orgId = await getDefaultOrgId(token);

  // ── 1. Inspect field names from a real record ────────────────────────────
  console.log('\n══ STEP 1: Raw field inspection (April 2026, page 1) ══');
  const { items: sample } = await fetchPage(token, orgId, '2026-04-01', '2026-04-30', 1);
  console.log(`Sample size: ${sample.length}`);
  if (sample.length > 0) {
    const r = sample[0];
    console.log('All keys:', Object.keys(r).join(', '));
    console.log('\nFinancial + date fields:');
    for (const [k, v] of Object.entries(r)) {
      const s = k.toLowerCase();
      if (s.includes('total') || s.includes('amount') || s.includes('bcy') || s.includes('currency') || s.includes('tax') || s === 'date' || s === 'expense_date')
        console.log(`  ${k} = ${JSON.stringify(v)}`);
    }
  }

  // ── 2. Full 6-month fetch ─────────────────────────────────────────────────
  console.log('\n══ STEP 2: Fetching Nov 2025 – Apr 2026 ══');
  const all: Record<string, unknown>[] = [];
  for (let p = 1; p <= 20; p++) {
    const { items, hasMore } = await fetchPage(token, orgId, '2025-11-01', '2026-04-30', p);
    all.push(...items);
    process.stdout.write(`  Page ${p}: +${items.length} (total ${all.length})  hasMore=${hasMore}\n`);
    if (!hasMore) break;
  }

  // ── 3. Detect correct amount field ───────────────────────────────────────
  const candidates = ['total', 'amount', 'sub_total', 'bcy_total', 'total_with_tax'];
  const sums: Record<string, number> = Object.fromEntries(candidates.map(f => [f, 0]));
  for (const e of all) for (const f of candidates) sums[f] += Number(e[f] ?? 0);

  console.log('\n══ STEP 3: Amount field detection ══');
  for (const [f, s] of Object.entries(sums))
    console.log(`  ${f}: ${s.toFixed(2)}${s > 0 ? ' ← DATA' : ''}`);
  const bestField = candidates.find(f => sums[f] > 0) ?? 'total';
  console.log(`→ Using: "${bestField}"`);

  // ── 4. Month breakdown ────────────────────────────────────────────────────
  const byMonth: Record<string, { count: number; total: number; currency: string }> = {};
  for (const e of all) {
    const date = String(e['date'] ?? e['expense_date'] ?? '');
    const mon  = date.slice(0, 7);
    if (mon.length < 7) continue;
    if (!byMonth[mon]) byMonth[mon] = { count: 0, total: 0, currency: '' };
    byMonth[mon].count++;
    byMonth[mon].total += Number(e[bestField] ?? 0);
    if (!byMonth[mon].currency) byMonth[mon].currency = String(e['currency_code'] ?? '');
  }

  // ── 5. Verdict vs Divo ────────────────────────────────────────────────────
  const divoCount: Record<string, number> = {
    '2025-11': 163, '2025-12': 232, '2026-01': 291,
    '2026-02': 212, '2026-03': 298, '2026-04': 397,
  };

  console.log('\n══ STEP 4: Audit vs Divo Response ══');
  console.log('Month    │ Real Count │ Divo Count │ Δ Count │ Real Total      │ Divo Total │ Verdict');
  console.log('─────────┼───────────┼───────────┼─────────┼─────────────────┼───────────┼─────────');
  for (const [mon, d] of Object.entries(byMonth).sort()) {
    const dc    = divoCount[mon] ?? 0;
    const delta = d.count - dc;
    const cStr  = delta === 0 ? '✓ 0' : `✗ ${delta > 0 ? '+' : ''}${delta}`;
    const aStr  = d.total > 0 ? `BUG — real=${d.total.toFixed(2)}, divo=0.00` : 'both 0 (ok)';
    console.log(`${mon}  │ ${String(d.count).padEnd(10)}│ ${String(dc).padEnd(10)}│ ${cStr.padEnd(8)}│ ${String(d.total.toFixed(2)).padEnd(16)}│ 0.00       │ ${aStr}`);
  }

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
