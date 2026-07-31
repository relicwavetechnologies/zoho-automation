/**
 * Read-only Zoho Books oracle for agent E2E tests.
 *
 * Usage:
 *   pnpm tsx scripts/validate-zoho-books.ts latest-invoices
 *   pnpm tsx scripts/validate-zoho-books.ts latest-invoices --account Emiac --limit 5
 *   pnpm tsx scripts/validate-zoho-books.ts overdue-invoices --account Emiac --as-of 2026-07-31
 *   pnpm tsx scripts/validate-zoho-books.ts expense-vendors --account Emiac --from 2026-03-01 --to 2026-04-30
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildContainer } from '../src/composition';
import { loadAndValidateEnv } from '../src/config/env';
import { resolveHarnessOpenId } from './run-engine-harness';

const DEFAULT_USER = 'abhishek@emiactech.com';
const DEFAULT_OUTPUT = join(tmpdir(), 'divo-zoho-books-validation.json');

interface Options {
  readonly account?: string;
  readonly asOfDate?: string;
  readonly caseName: 'expense-vendors' | 'latest-invoices' | 'overdue-invoices';
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly limit: number;
  readonly output: string;
  readonly user: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asRecords = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.flatMap(item => asRecord(item) ?? []) : [];

const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();

function parseArgs(args: readonly string[]): Options {
  const caseName = args[0];
  if (
    caseName !== 'expense-vendors'
    && caseName !== 'latest-invoices'
    && caseName !== 'overdue-invoices'
  ) {
    throw new Error(
      'Usage: pnpm tsx scripts/validate-zoho-books.ts '
      + '<expense-vendors|latest-invoices|overdue-invoices> '
      + '[--account <label>] [--as-of YYYY-MM-DD] [--from YYYY-MM-DD] [--to YYYY-MM-DD] '
      + '[--user <email|name|open_id>] '
      + '[--limit 1-200] [--output <path>]',
    );
  }

  let account: string | undefined;
  let asOfDate: string | undefined;
  let dateFrom: string | undefined;
  let dateTo: string | undefined;
  let limit = 5;
  let output = DEFAULT_OUTPUT;
  let user = DEFAULT_USER;

  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    const value = args[++index]?.trim();
    if (!value) throw new Error(`${option} requires a value`);
    if (option === '--account') account = value;
    else if (option === '--as-of') asOfDate = value;
    else if (option === '--from') dateFrom = value;
    else if (option === '--to') dateTo = value;
    else if (option === '--limit') limit = Number(value);
    else if (option === '--output') output = value;
    else if (option === '--user') user = value;
    else throw new Error(`Unknown option: ${option}`);
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('--limit must be an integer from 1 to 200');
  }
  for (const [name, value] of [['--as-of', asOfDate], ['--from', dateFrom], ['--to', dateTo]]) {
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${name} must use YYYY-MM-DD`);
    }
  }
  if (caseName === 'expense-vendors' && (!dateFrom || !dateTo)) {
    throw new Error('expense-vendors requires --from and --to');
  }
  return {
    ...(account ? { account } : {}),
    ...(asOfDate ? { asOfDate } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    caseName,
    limit,
    output,
    user,
  };
}

async function zohoGet(
  auth: { readonly accessToken: string; readonly apiBaseUrl: string },
  path: string,
  params: Readonly<Record<string, string | number>>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${auth.apiBaseUrl.replace(/\/$/, '')}/books/v3${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Zoho-oauthtoken ${auth.accessToken}` },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || (typeof body['code'] === 'number' && body['code'] !== 0)) {
    throw new Error(
      `Zoho GET ${path} failed (${response.status}): ${String(body['message'] ?? 'unknown error')}`,
    );
  }
  return body;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const env = loadAndValidateEnv({ ...process.env, MEM0_ENABLED: 'false' });
  const container = await buildContainer(env);

  try {
    const openId = await resolveHarnessOpenId(container.prisma, options.user);
    const identityResult = await container.channelIdentityRepo.resolveByLarkOpenId(openId);
    if (!identityResult.ok || !identityResult.value) {
      throw new Error(`No DB-linked identity found for ${options.user}`);
    }
    const identity = identityResult.value;
    const accessible = await container.integrationConnectionRepo.listAccessibleZohoConnections({
      companyId: identity.companyId,
      userId: identity.userId,
    });
    if (!accessible.ok) throw accessible.error;

    const matches = options.account
      ? accessible.value.filter(connection =>
        [connection.label, connection.accountName, connection.accountEmail]
          .some(value => normalize(value).includes(normalize(options.account))))
      : accessible.value;
    if (matches.length !== 1) {
      const available = accessible.value.map(connection => connection.label).join(', ') || '(none)';
      throw new Error(
        matches.length === 0
          ? `No accessible Zoho account matched "${options.account ?? ''}". Available: ${available}`
          : `Select one account with --account. Accessible: ${available}`,
      );
    }

    const connection = matches[0]!;
    const auth = await container.zohoTokenService.getValidConnectionAuth({
      companyId: identity.companyId,
      userId: identity.userId,
      connectionId: connection.connectionId,
      minimumAccess: 'read_only',
    });
    const organizationBody = await zohoGet(auth, '/organizations', {});
    const organizations = asRecords(organizationBody['organizations']);
    const organization = organizations.find(item =>
      item['is_default_org'] === true || item['is_default'] === true,
    ) ?? organizations[0];
    const organizationId = String(organization?.['organization_id'] ?? '');
    if (!organizationId) throw new Error(`${connection.label} returned no Zoho Books organization`);

    const baseEvidence = {
      generatedAt: new Date().toISOString(),
      principal: identity.email ?? identity.displayName ?? options.user,
      connection: connection.label,
      organization: String(organization?.['name'] ?? connection.accountName ?? connection.label),
    };
    let evidence: Record<string, unknown>;

    if (options.caseName === 'latest-invoices') {
      const invoiceBody = await zohoGet(auth, '/invoices', {
        organization_id: organizationId,
        page: 1,
        per_page: options.limit,
        sort_column: 'date',
        sort_order: 'D',
      });
      const invoices = asRecords(invoiceBody['invoices']).map(invoice => ({
        invoiceNumber: String(invoice['invoice_number'] ?? ''),
        customer: String(invoice['customer_name'] ?? ''),
        invoiceDate: String(invoice['date'] ?? ''),
        dueDate: String(invoice['due_date'] ?? ''),
        status: String(invoice['status'] ?? ''),
        currency: String(invoice['currency_code'] ?? ''),
        total: invoice['total'] ?? null,
        outstandingBalance: invoice['balance'] ?? null,
      }));
      evidence = {
        ...baseEvidence,
        case: options.caseName,
        requestedLimit: options.limit,
        returnedCount: invoices.length,
        invoices,
      };
    } else if (options.caseName === 'overdue-invoices') {
      const asOf = new Date(`${options.asOfDate ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);
      const rawInvoices: Array<Record<string, unknown>> = [];
      for (let page = 1; page <= 20; page++) {
        const body = await zohoGet(auth, '/invoices', {
          organization_id: organizationId,
          page,
          per_page: 200,
          status: 'overdue',
        });
        rawInvoices.push(...asRecords(body['invoices']));
        const pageContext = asRecord(body['page_context']);
        if (pageContext?.['has_more_page'] !== true) break;
      }
      const seen = new Set<string>();
      const overdue = rawInvoices
        .filter(invoice => {
          const id = String(invoice['invoice_id'] ?? '');
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .map(invoice => {
          const dueDate = String(invoice['due_date'] ?? '');
          const overdueDays = dueDate
            ? Math.floor((asOf.getTime() - new Date(dueDate).getTime()) / 86_400_000)
            : 0;
          return {
            invoiceNumber: String(invoice['invoice_number'] ?? ''),
            customer: String(invoice['customer_name'] ?? ''),
            invoiceDate: String(invoice['date'] ?? ''),
            dueDate,
            overdueDays,
            status: String(invoice['status'] ?? ''),
            currency: String(invoice['currency_code'] ?? 'INR'),
            total: Number(invoice['total'] ?? 0),
            outstandingBalance: Number(invoice['balance'] ?? 0),
          };
        })
        .filter(invoice => invoice.outstandingBalance > 0 && invoice.overdueDays >= 1)
        .sort((left, right) => right.overdueDays - left.overdueDays);
      const currencyTotals = overdue.reduce<Record<string, number>>((totals, invoice) => {
        totals[invoice.currency] = (totals[invoice.currency] ?? 0) + invoice.outstandingBalance;
        return totals;
      }, {});
      const agingBuckets = overdue.reduce<Record<string, Record<string, number>>>((buckets, invoice) => {
        const bucket = invoice.overdueDays <= 30
          ? '1-30'
          : invoice.overdueDays <= 60
            ? '31-60'
            : invoice.overdueDays <= 90
              ? '61-90'
              : '91+';
        const currencyBucket = buckets[bucket] ??= {};
        currencyBucket[invoice.currency] =
          (currencyBucket[invoice.currency] ?? 0) + invoice.outstandingBalance;
        return buckets;
      }, {});
      evidence = {
        ...baseEvidence,
        case: options.caseName,
        asOfDate: asOf.toISOString(),
        invoiceCount: overdue.length,
        currencyTotals,
        agingBuckets,
        requestedLimit: options.limit,
        returnedCount: Math.min(overdue.length, options.limit),
        invoices: overdue.slice(0, options.limit),
      };
    } else {
      const expenses: Array<Record<string, unknown>> = [];
      for (let page = 1; page <= 500; page++) {
        const body = await zohoGet(auth, '/expenses', {
          organization_id: organizationId,
          date_start: options.dateFrom!,
          date_end: options.dateTo!,
          page,
          per_page: 200,
        });
        expenses.push(...asRecords(body['expenses']));
        if (asRecord(body['page_context'])?.['has_more_page'] !== true) break;
        if (page === 500) throw new Error('Expense pagination exceeded 500 pages');
      }
      const unique = new Map<string, Record<string, unknown>>();
      for (const expense of expenses) {
        const id = String(expense['expense_id'] ?? '');
        if (id) unique.set(id, expense);
      }
      const baseTotal = (expense: Record<string, unknown>): number =>
        expense['bcy_total'] === undefined
          ? Number(expense['total'] ?? 0) * (Number(expense['exchange_rate']) || 1)
          : Number(expense['bcy_total'] ?? 0);
      const byVendor = new Map<string, { count: number; total: number }>();
      for (const expense of unique.values()) {
        const vendor = String(expense['vendor_name'] ?? '').trim() || '(No vendor)';
        const current = byVendor.get(vendor) ?? { count: 0, total: 0 };
        current.count++;
        current.total += baseTotal(expense);
        byVendor.set(vendor, current);
      }
      evidence = {
        ...baseEvidence,
        case: options.caseName,
        dateFrom: options.dateFrom,
        dateTo: options.dateTo,
        recordCount: unique.size,
        baseCurrency: String(organization?.['currency_code'] ?? ''),
        total: [...unique.values()].reduce((sum, expense) => sum + baseTotal(expense), 0),
        topVendors: [...byVendor.entries()]
          .map(([vendor, values]) => ({ vendor, ...values }))
          .sort((left, right) => right.total - left.total || left.vendor.localeCompare(right.vendor))
          .slice(0, options.limit),
      };
    }

    writeFileSync(options.output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(evidence, null, 2));
    console.log(`Evidence saved to ${options.output}`);
  } finally {
    await container.prisma.$disconnect();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
