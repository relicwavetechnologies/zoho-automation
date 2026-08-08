/**
 * Does Zoho Books actually honour `invoice_number` as a list filter?
 *
 * The duplicate-number check in zoho-books.tool.ts asks Zoho for invoices
 * carrying a specific number and treats an empty answer as "that number is
 * free". If Zoho ignores an unrecognised query parameter instead of filtering
 * on it, that call returns the most recent invoices regardless, the client-side
 * re-filter throws them all away, and the check reports "no duplicate" every
 * single time — while looking like it ran.
 *
 * So the decisive experiment is a number that cannot exist. A filter that is
 * honoured returns nothing. A filter that is ignored returns the same page the
 * unfiltered call returns.
 *
 * GETs only. Nothing here writes to Zoho or to the database.
 *
 *   npx tsx scripts/probe-zoho-invoice-number-filter.ts
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { ZohoTokenService } from '../src/infrastructure/zoho/zoho-token.service.js';
import { ZohoConnectionRepository } from '../src/infrastructure/zoho/zoho-connection.repository.js';
import { IntegrationConnectionRepository } from '../src/infrastructure/persistence/integration-connection.repository.js';
import { ZohoBooksPaginatedClient } from '../src/infrastructure/zoho/zoho-books-paginated.client.js';
import { loadAndValidateEnv } from '../src/config/env.js';
import type { CachePort } from '../src/shared/cache.js';
import type { Result } from '../src/shared/result.js';

const env    = loadAndValidateEnv(process.env);
const prisma = new PrismaClient();

const log: any = {
  info: () => {}, warn: (...a: unknown[]) => console.log('[warn]', ...a),
  error: (...a: unknown[]) => console.log('[error]', ...a),
  debug: () => {}, child: () => log,
};

const store = new Map<string, { value: unknown; expiresAt: number }>();
const cache: CachePort = {
  async get<T>(key: string): Promise<Result<T | null, any>> {
    const e = store.get(key);
    if (!e || Date.now() > e.expiresAt) return { ok: true, value: null } as any;
    return { ok: true, value: e.value as T } as any;
  },
  async set(key: string, value: unknown, ttl?: number) {
    store.set(key, { value, expiresAt: Date.now() + (ttl ?? 3600) * 1000 });
    return { ok: true, value: undefined } as any;
  },
  async del(key: string) { store.delete(key); return { ok: true, value: undefined } as any; },
  async scanDel() { return { ok: true, value: 0 } as any; },
};

const num = (records: readonly Record<string, unknown>[]) =>
  records.map(r => String(r['invoice_number'] ?? '')).filter(Boolean);

async function main() {
  // The tool authenticates against an IntegrationConnection, not a legacy
  // ZohoConnectionProfile, and only for a member the connection is granted to.
  const connections = await prisma.integrationConnection.findMany({
    where: { provider: 'zoho', status: 'connected' },
    select: { id: true, companyId: true, label: true },
  });
  console.log(`Connected Zoho integration connections: ${connections.length}`);

  const connRepo     = new ZohoConnectionRepository(prisma, env);
  const tokenService = new ZohoTokenService(
    connRepo, cache, env, log,
    new IntegrationConnectionRepository(prisma as never, env),
  );
  const books        = new ZohoBooksPaginatedClient(tokenService, env.ZOHO_API_BASE_URL);

  // Find a (connection, member) pair the grant table actually permits.
  let chosen: { connectionId: string; companyId: string; userId: string } | null = null;
  for (const c of connections) {
    const grants = await prisma.integrationConnectionGrant.findMany({
      where: { connectionId: c.id },
      select: { granteeType: true, granteeId: true, access: true },
    });
    console.log(`  ${c.id}  ${c.label ?? ''} → ${grants.length} grant(s): ${grants.map(g => `${g.granteeType}:${g.access}`).join(', ') || 'none'}`);
    for (const g of grants) {
      const userId = g.granteeType === 'user'
        ? g.granteeId
        : g.granteeType === 'department'
          ? (await prisma.departmentMembership.findFirst({
            where: { departmentId: g.granteeId, status: 'active' }, select: { userId: true },
          }))?.userId
          : (await prisma.departmentMembership.findFirst({
            where: { status: 'active', department: { companyId: c.companyId } }, select: { userId: true },
          }))?.userId;
      if (userId) { chosen = { connectionId: c.id, companyId: c.companyId, userId }; break; }
    }
    if (chosen) break;
  }
  if (!chosen) { console.log('No connection is granted to any member — nothing to probe.'); return; }
  console.log(`\nProbing connection ${chosen.connectionId} as member ${chosen.userId}\n`);

  const auth = {
    companyId:    chosen.companyId,
    userId:       chosen.userId,
    connectionId: chosen.connectionId,
    moduleName:   'invoices' as const,
  };

  // ── Control: no filter at all ───────────────────────────────────────────────
  const unfiltered = await books.listRecords({ ...auth, page: 1, perPage: 10 });
  console.log(`[control ] no filter           → ${unfiltered.items.length} invoices`);
  console.log(`           org=${unfiltered.organizationId}  numbers=${num(unfiltered.items).slice(0, 5).join(', ')}`);

  // ── The decisive test: a number that cannot exist ───────────────────────────
  const impossible = 'DIVO-PROBE-NO-SUCH-INVOICE-9Z9Z9Z';
  const ghost = await books.listRecords({
    ...auth, page: 1, perPage: 10, filters: { invoice_number: impossible },
  });
  console.log(`[ghost   ] invoice_number=${impossible} → ${ghost.items.length} invoices`);
  if (ghost.items.length > 0) console.log(`           numbers=${num(ghost.items).slice(0, 5).join(', ')}`);

  // ── Positive control: a number that does exist ──────────────────────────────
  const real = num(unfiltered.items)[0];
  if (real) {
    const hit = await books.listRecords({
      ...auth, page: 1, perPage: 10, filters: { invoice_number: real },
    });
    const allMatch = hit.items.length > 0 && num(hit.items).every(n => n === real);
    console.log(`[real    ] invoice_number=${real} → ${hit.items.length} invoices, all matching: ${allMatch}`);
    if (!allMatch) console.log(`           numbers=${num(hit.items).slice(0, 5).join(', ')}`);
  }

  // ── Verdict ─────────────────────────────────────────────────────────────────
  console.log('');
  if (ghost.items.length === 0) {
    console.log('VERDICT: Zoho HONOURS invoice_number. The duplicate check is sound.');
  } else if (ghost.items.length === unfiltered.items.length) {
    console.log('VERDICT: Zoho IGNORES invoice_number — it returned the unfiltered page.');
    console.log('         The duplicate check can never fire. It needs a different lookup.');
  } else {
    console.log('VERDICT: inconclusive — Zoho neither filtered exactly nor ignored it. Read the numbers above.');
  }
}

main()
  .catch(e => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
