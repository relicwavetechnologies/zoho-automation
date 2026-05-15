/**
 * Test harness for Zoho Books RBAC email-based filtering.
 *
 * Calls the zohoBooks tool directly with two contexts:
 *   1. Anish Suman  — role "Nothing", zohoReadScope = "personalized"
 *   2. Abhishek     — role "Manager", zohoReadScope = "show_all"
 *
 * Compares results and posts a summary to the Lark test group.
 * No running server or Redis needed — uses in-memory cache.
 *
 * Usage:  npx tsx scripts/test-zoho-scope-filter.ts
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { ZohoTokenService } from '../src/infrastructure/zoho/zoho-token.service.js';
import { ZohoConnectionRepository } from '../src/infrastructure/zoho/zoho-connection.repository.js';
import { ZohoBooksPaginatedClient } from '../src/infrastructure/zoho/zoho-books-paginated.client.js';
import { ZohoFinanceOps } from '../src/application/zoho/zoho-finance-ops.js';
import { createZohoBooksTool } from '../src/application/orchestration/tools/families/zoho-books.tool.js';
import { ZohoBooksClient } from '../src/infrastructure/zoho/zoho-books.client.js';
import { loadAndValidateEnv } from '../src/config/env.js';
import type { Result } from '../src/shared/result.js';
import type { CachePort } from '../src/shared/cache.js';

const LARK_GROUP = 'oc_b9169aab0765f46b2fe9147068e3c79f';

const env    = loadAndValidateEnv(process.env);
const prisma = new PrismaClient();
const log: any = {
  info: (...a: unknown[]) => console.log('[info]', ...a),
  warn: (...a: unknown[]) => console.log('[warn]', ...a),
  error: (...a: unknown[]) => console.log('[error]', ...a),
  debug: () => {},
  child: () => log,
};

const memStore = new Map<string, { value: unknown; expiresAt: number }>();
const memCache: CachePort = {
  async get<T>(key: string): Promise<Result<T | null, any>> {
    const entry = memStore.get(key);
    if (!entry || Date.now() > entry.expiresAt) return { ok: true, value: null } as any;
    return { ok: true, value: entry.value as T } as any;
  },
  async set(key: string, value: unknown, ttl?: number): Promise<Result<void, any>> {
    memStore.set(key, { value, expiresAt: Date.now() + (ttl ?? 3600) * 1000 });
    return { ok: true, value: undefined } as any;
  },
  async del(key: string): Promise<Result<void, any>> {
    memStore.delete(key);
    return { ok: true, value: undefined } as any;
  },
  async scanDel(): Promise<Result<number, any>> {
    return { ok: true, value: 0 } as any;
  },
};

const cloudinary: any = { isAvailable: false, uploadCsvBuffer: async () => null };

function buildCtx(opts: {
  companyId: string;
  userId: string;
  requesterEmail?: string;
  zohoReadScope: 'personalized' | 'show_all';
  departmentId?: string;
}) {
  return {
    runContext: {
      companyId: opts.companyId,
      userId: opts.userId,
      channel: 'lark' as const,
      companyRole: 'MEMBER',
      traceId: 'scope-test',
      requestId: 'scope-test',
      requesterEmail: opts.requesterEmail,
      ...(opts.departmentId ? { departmentId: opts.departmentId } : {}),
    },
    logger: log,
    clock: { now: () => new Date(), nowMs: () => Date.now() },
    correlationId: 'scope-test',
    perm: {
      allowedToolIds: new Set(['zohoBooks']),
      allowedActionsByTool: new Map([['zohoBooks', new Set(['read', 'create', 'update', 'delete'])]]),
      decisions: [],
      department: {
        id: opts.departmentId ?? 'test-dept',
        name: 'Finance',
        roleSlug: opts.zohoReadScope === 'personalized' ? 'NOTHING' : 'MANAGER',
        zohoReadScope: opts.zohoReadScope,
      },
    },
  } as any;
}

async function sendToLark(text: string) {
  const appId = env.LARK_APP_ID;
  const appSecret = env.LARK_APP_SECRET;

  const tokenRes = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const tokenBody = await tokenRes.json() as any;
  const token = tokenBody.tenant_access_token;

  await fetch('https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: LARK_GROUP,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
}

async function main() {
  const company = await prisma.company.findFirst();
  if (!company) throw new Error('No company found');
  const companyId = company.id;

  const anish = await prisma.channelIdentity.findFirst({
    where: { email: 'anishsuman2305@gmail.com', companyId },
  });
  if (!anish) throw new Error('Anish identity not found');

  const anishMembership = await prisma.departmentMembership.findFirst({
    where: { userId: 'b30c783c-015a-41e0-8c18-0475071e8ac3' },
    include: { role: true, department: true },
  });

  console.log('=== Zoho Books Scope Filter Test ===');
  console.log(`Company: ${company.name} (${companyId})`);
  console.log(`Anish email: ${anish.email}`);
  console.log(`Anish role: ${anishMembership?.role.name} (zohoReadScope: ${anishMembership?.role.zohoReadScope})`);
  console.log('');

  const connRepo     = new ZohoConnectionRepository(prisma, env);
  const tokenService = new ZohoTokenService(connRepo, memCache, env, log);
  const booksClient  = new ZohoBooksPaginatedClient(tokenService, env.ZOHO_API_BASE_URL);
  const financeOps   = new ZohoFinanceOps(booksClient, cloudinary, log);

  const resolveOrgId = async (cId: string, token: string): Promise<string | null> => {
    try {
      const res = await fetch(`${env.ZOHO_API_BASE_URL}/books/v3/organizations`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      const body = await res.json() as any;
      return body.organizations?.[0]?.organization_id ?? null;
    } catch { return null; }
  };

  const getClient = async (cId: string) => {
    try {
      const token = await tokenService.getValidToken(cId);
      const orgId = await resolveOrgId(cId, token);
      if (!orgId) return null;
      return new ZohoBooksClient(token, orgId, env.ZOHO_API_BASE_URL);
    } catch { return null; }
  };

  const tool = createZohoBooksTool({
    getClient: async (cId) => getClient(cId),
    booksClient, financeOps, cloudinary,
  });

  const deptId = anishMembership?.departmentId ?? '';

  // ── Test 1: Anish (personalized) — should only see HIS invoices ──
  console.log('── Test 1: Anish (personalized) — list_invoices ──');
  const anishCtx = buildCtx({
    companyId,
    userId: 'b30c783c-015a-41e0-8c18-0475071e8ac3',
    requesterEmail: 'anishsuman2305@gmail.com',
    zohoReadScope: 'personalized',
    departmentId: deptId,
  });

  const anishResult = await tool.execute({ op: 'list_invoices', limit: 50 } as any, anishCtx);
  const anishItems = anishResult.ok ? extractItems(anishResult.value) : [];
  console.log(`  → ${anishItems.length} invoices returned`);
  for (const inv of anishItems.slice(0, 5)) {
    console.log(`    ${inv.invoice_number ?? inv.invoice_id} | ${inv.customer_name ?? ''} | ${inv.email ?? ''} | ${inv.total ?? ''}`);
  }

  // ── Test 2: Admin (show_all) — should see ALL invoices ──
  console.log('\n── Test 2: Admin (show_all) — list_invoices ──');
  const adminCtx = buildCtx({
    companyId,
    userId: 'f6312e2b-d0d3-49fa-acba-786be69949e4',
    requesterEmail: 'vabhi.verma2678@gmail.com',
    zohoReadScope: 'show_all',
    departmentId: deptId,
  });

  const adminResult = await tool.execute({ op: 'list_invoices', limit: 50 } as any, adminCtx);
  const adminItems = adminResult.ok ? extractItems(adminResult.value) : [];
  console.log(`  → ${adminItems.length} invoices returned`);
  for (const inv of adminItems.slice(0, 5)) {
    console.log(`    ${inv.invoice_number ?? inv.invoice_id} | ${inv.customer_name ?? ''} | ${inv.email ?? ''} | ${inv.total ?? ''}`);
  }

  // ── Test 3: Anish (personalized) — list_contacts ──
  console.log('\n── Test 3: Anish (personalized) — list_contacts ──');
  const anishContactResult = await tool.execute({ op: 'list_contacts', limit: 50 } as any, anishCtx);
  const anishContacts = anishContactResult.ok ? extractItems(anishContactResult.value) : [];
  console.log(`  → ${anishContacts.length} contacts returned`);
  for (const c of anishContacts.slice(0, 5)) {
    console.log(`    ${c.contact_name ?? ''} | ${c.email ?? ''}`);
  }

  // ── Test 4: Admin — list_contacts ──
  console.log('\n── Test 4: Admin (show_all) — list_contacts ──');
  const adminContactResult = await tool.execute({ op: 'list_contacts', limit: 50 } as any, adminCtx);
  const adminContacts = adminContactResult.ok ? extractItems(adminContactResult.value) : [];
  console.log(`  → ${adminContacts.length} contacts returned`);

  // ── Summary ──
  const filtering = anishItems.length < adminItems.length;
  const summary = [
    '🔒 Zoho Books RBAC Scope Filter Test Results',
    '',
    `Anish Suman (personalized, email: anishsuman2305@gmail.com):`,
    `  Invoices: ${anishItems.length}`,
    `  Contacts: ${anishContacts.length}`,
    '',
    `Admin (show_all):`,
    `  Invoices: ${adminItems.length}`,
    `  Contacts: ${adminContacts.length}`,
    '',
    filtering
      ? `✅ FILTERING WORKS — Anish sees ${anishItems.length} vs admin's ${adminItems.length} invoices`
      : `❌ FILTERING NOT WORKING — both see ${anishItems.length} invoices`,
  ].join('\n');

  console.log('\n' + summary);

  // Post to Lark group
  try {
    await sendToLark(summary);
    console.log('\n✓ Results posted to Lark group');
  } catch (e) {
    console.log('\n✗ Failed to post to Lark:', e);
  }

  await prisma.$disconnect();
}

function extractItems(value: any): any[] {
  if (!value) return [];
  if (value.data?.items) return value.data.items;
  if (value.report?.items) return value.report.items;
  if (Array.isArray(value.data)) return value.data;
  return [];
}

main().catch(e => { console.error(e); process.exit(1); });
