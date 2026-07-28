/**
 * zohoBooks tool — Zoho Books read/write + deep financial reports.
 *
 * Operations:
 *   CRUD:
 *     list_invoices   — paginated invoice list (first page, bounded)
 *     get_invoice     — single invoice by ID
 *     create_invoice  — create a new invoice
 *     list_contacts   — paginated contact list
 *     get_contact     — single contact by ID
 *     list_expenses   — paginated expense list
 *     list_bills      — paginated bill list
 *     list_payments   — paginated customer payment list
 *     get_chart_of_accounts — chart of accounts
 *     get_account_balance   — bank account balances
 *     list_bank_transactions — paginated bank transaction list
 *     search_transactions   — global transaction search
 *     get_tax_summary       — tax summary report
 *     send_invoice          — email an invoice
 *     record_payment        — record a customer payment
 *     create_expense        — create an expense
 *     create_bill           — create a bill
 *     void_invoice          — void an invoice
 *
 *   Reports (exhaustive pagination + token-safe output):
 *     build_overdue_report — scan ALL overdue invoices, compute aging buckets,
 *                            top-10 customers, return summary + CSV link when > threshold
 *
 * Token safety:
 *   - Plain list ops return at most `limit` records (default 25, max 100)
 *     and fetch only one bounded page unless exportAll was explicitly requested
 *   - build_overdue_report always passes only summary + top-N inline to LLM;
 *     full dataset is uploaded as a Cloudinary CSV with a 24 h signed link
 */

import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result }                     from '../../../../shared/result';
import { ok, err }                         from '../../../../shared/result';
import { PermissionError, ToolError }      from '../../../../shared/errors';
import type { ToolActionGroup }            from '../../../../domain/permissions/tool-action-group';
import { asToolId }                        from '../../../../shared/ids';
import type { ZohoFinanceOps }             from '../../../zoho/zoho-finance-ops';
import type { CloudinaryAdapter }          from '../../../../infrastructure/cloudinary/cloudinary.adapter';
import { mapZohoError }                    from '../../../zoho/zoho-error.utils';
import { formatAmount, formatDate }        from '../../../zoho/zoho-format.utils';
import { normalizeStatus, parseDateFilter } from '../../../zoho/zoho-filter.utils';
import { handleZohoList, type ZohoListCsvColumn } from '../../../zoho/zoho-list-handler';
import type { ZohoBooksPaginatedClient, ZohoBooksModule } from '../../../../infrastructure/zoho/zoho-books-paginated.client';
import { getModuleSchema, injectSyntheticFields, toSchemaHint } from '../../../../infrastructure/zoho/zoho-books-schema.cache';
import { runInSandbox, arrayToCsv, SandboxTimeoutError, SandboxScriptError, SandboxInputTooLargeError, SandboxSerializationError } from '../shared/sandbox-runner';
import { filterZohoRecordsByEmail, normalizedEmail, recordMatchesZohoEmail } from '../../../../shared/zoho-personalization';

// ─── Args schema ──────────────────────────────────────────────────────────────

const Schema = z.object({
  connectionId: z.string().uuid(),
  op: z.enum([
    // CRUD
    'list_invoices',
    'get_invoice',
    'create_invoice',
    'list_contacts',
    'get_contact',
    'list_expenses',
    'list_bills',
    'list_payments',
    'get_chart_of_accounts',
    'get_account_balance',
    'list_bank_transactions',
    'search_transactions',
    'get_tax_summary',
    'send_invoice',
    'record_payment',
    'create_expense',
    'create_bill',
    'void_invoice',
    // Reports
    'build_overdue_report',
  ]),

  // CRUD params
  invoiceId:      z.string().optional(),
  contactId:      z.string().optional(),
  accountId:      z.string().optional(),
  searchQuery:    z.string().optional(),
  email:          z.string().email().optional(),
  fields:         z.record(z.unknown()).optional(),
  limit:          z.number().int().min(1).max(100).optional(),
  exportAll:      z.boolean().optional(),
  organizationId: z.string().optional(),
  dateFrom:       z.string().optional(),
  dateTo:         z.string().optional(),
  status:         z.string().optional(),
  taxYear:        z.string().optional(),

  // Report params
  asOfDate:         z.string().optional(),   // ISO date, default = today
  minOverdueDays:   z.number().int().min(0).optional(),
  invoiceDateFrom:  z.string().optional(),
  invoiceDateTo:    z.string().optional(),

  // Script mode — auto-escalates list ops to exhaustive fetch + VM sandbox
  script:     z.string().optional(),
  scriptArgs: z.record(z.unknown()).optional(),
  exportCsv:  z.boolean().optional(),
  csvColumns: z.array(z.string()).optional(),
});

type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success:      z.boolean(),
  data:         z.unknown().optional(),
  id:           z.string().optional(),
  message:      z.string().optional(),
  // Report fields (present only for build_overdue_report)
  report:       z.unknown().optional(),
  csvLink:      z.string().optional(),
  csvPublicId:  z.string().optional(),
  csvExpiresAt: z.string().optional(),
  truncated:    z.boolean().optional(),
  hasMore:      z.boolean().optional(),
  suggestExport: z.boolean().optional(),
  // Script-mode fields
  rowCount:        z.number().optional(),
  totalFetched:    z.number().optional(),
  moduleSchema:    z.unknown().optional(),
  sourceTruncated: z.boolean().optional(),
});

type Res = z.infer<typeof ResultSchema>;

// ─── Simple client port (for CRUD ops) ───────────────────────────────────────

export interface ZohoBooksClientPort {
  listInvoices(limit?: number): Promise<unknown[]>;
  getInvoice(invoiceId: string): Promise<unknown>;
  createInvoice(fields: Record<string, unknown>): Promise<{ invoiceId: string }>;
  listContacts(limit?: number): Promise<unknown[]>;
  getContact(contactId: string): Promise<unknown>;
  listExpenses(limit?: number): Promise<unknown[]>;
  sendInvoice(invoiceId: string, email?: string): Promise<{ invoiceId: string }>;
  recordPayment(fields: Record<string, unknown>): Promise<{ paymentId: string }>;
  createExpense(fields: Record<string, unknown>): Promise<{ expenseId: string }>;
  createBill(fields: Record<string, unknown>): Promise<{ billId: string }>;
  voidInvoice(invoiceId: string): Promise<{ invoiceId: string }>;
}

const readOps = new Set<Args['op']>([
  'list_invoices',
  'get_invoice',
  'list_contacts',
  'get_contact',
  'list_expenses',
  'list_bills',
  'list_payments',
  'get_chart_of_accounts',
  'get_account_balance',
  'list_bank_transactions',
  'search_transactions',
  'get_tax_summary',
  'build_overdue_report',
]);

const createOps = new Set<Args['op']>([
  'create_invoice',
  'send_invoice',
  'record_payment',
  'create_expense',
  'create_bill',
]);

const listOpToModule: Record<string, ZohoBooksModule> = {
  list_invoices:         'invoices',
  list_bills:            'bills',
  list_expenses:         'expenses',
  list_payments:         'customerpayments',
  list_contacts:         'contacts',
  list_bank_transactions: 'banktransactions',
  search_transactions:   'banktransactions',
};

const INLINE_SCRIPT_LIMIT = 10;

const amountFields = new Set([
  'amount',
  'balance',
  'total',
  'sub_total',
  'subtotal',
  'tax_total',
  'discount_total',
  'payment_made',
  'payment_received',
  'amount_due',
  'amount_applied',
  'bcy_total',
  'bcy_balance',
  'fc_total',
  'fc_balance',
  'outstanding',
  'totalOutstanding',
]);

const dateFields = new Set([
  'date',
  'due_date',
  'created_time',
  'last_modified_time',
  'invoice_date',
  'payment_date',
  'transaction_date',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const displayKey = (key: string): string =>
  key.includes('_') ? `${key}_formatted` : `${key}Formatted`;

const currencyFrom = (record: Record<string, unknown>): string => {
  const currency = record['currency_code'] ?? record['currencyCode'] ?? record['currency'];
  return typeof currency === 'string' && currency.trim() ? currency : 'INR';
};

const numericAmount = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value.trim())) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const stringValue = (record: Record<string, unknown>, ...keys: string[]): string =>
  keys.map(key => record[key]).find(value => typeof value === 'string' && value.trim().length > 0) as string | undefined ?? '';

const amountValue = (record: Record<string, unknown>, ...keys: string[]): number => {
  for (const key of keys) {
    const amount = numericAmount(record[key]);
    if (amount !== null) return amount;
  }
  return 0;
};

const summarizeRecords = (
  moduleLabel: string,
  amountKeys: string[],
  items: readonly Record<string, unknown>[],
): string => {
  if (items.length === 0) return `No ${moduleLabel.toLowerCase()} matched the current criteria.`;
  if (amountKeys.length === 0) return `Found ${items.length} ${moduleLabel.toLowerCase()}.`;

  const totals = new Map<string, number>();
  for (const item of items) {
    const currency = currencyFrom(item);
    totals.set(currency, (totals.get(currency) ?? 0) + amountValue(item, ...amountKeys));
  }
  const totalText = [...totals.entries()]
    .filter(([, total]) => total !== 0)
    .map(([currency, total]) => `${formatAmount(total, currency)} (${currency})`)
    .join(', ');
  return totalText
    ? `Found ${items.length} ${moduleLabel.toLowerCase()}: ${totalText}.`
    : `Found ${items.length} ${moduleLabel.toLowerCase()}.`;
};

const commonColumns = {
  id: (header = 'ID'): ZohoListCsvColumn<Record<string, unknown>> => ({
    key: 'id',
    header,
    value: item => stringValue(item, 'invoice_id', 'bill_id', 'payment_id', 'expense_id', 'contact_id', 'transaction_id', 'id'),
  }),
  date: { key: 'date', header: 'Date' } satisfies ZohoListCsvColumn<Record<string, unknown>>,
  status: { key: 'status', header: 'Status' } satisfies ZohoListCsvColumn<Record<string, unknown>>,
  currency: { key: 'currency_code', header: 'Currency' } satisfies ZohoListCsvColumn<Record<string, unknown>>,
};

const projectListItems = (
  items: readonly Record<string, unknown>[],
  columns: readonly ZohoListCsvColumn<Record<string, unknown>>[],
): Record<string, unknown>[] =>
  items.map(item => Object.fromEntries(
    columns.map(column => [column.key, column.value ? column.value(item) : item[column.key]]),
  ));

function formatZohoResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(formatZohoResult);
  if (!isRecord(value)) return value;

  const formatted: Record<string, unknown> = {};
  const currency = currencyFrom(value);

  for (const [key, fieldValue] of Object.entries(value)) {
    formatted[key] = formatZohoResult(fieldValue);

    if (key.endsWith('_formatted') || key.endsWith('Formatted')) continue;

    if (amountFields.has(key)) {
      const amount = numericAmount(fieldValue);
      if (amount !== null) formatted[displayKey(key)] = formatAmount(amount, currency);
    }

    if (dateFields.has(key) && typeof fieldValue === 'string') {
      formatted[displayKey(key)] = formatDate(fieldValue);
    }
  }

  return formatted;
}

const buildDateRangeParams = (from?: string, to?: string): Record<string, string> => {
  if (from && to) {
    return {
      date_start: parseDateFilter(from).from,
      date_end:   parseDateFilter(to).to,
    };
  }

  if (from) {
    const range = parseDateFilter(from);
    return { date_start: range.from, date_end: range.to };
  }

  if (to) {
    const range = parseDateFilter(to);
    return { date_start: range.from, date_end: range.to };
  }

  return {};
};

const dateParams = (args: Args): Record<string, unknown> => ({
  ...buildDateRangeParams(args.dateFrom, args.dateTo),
  ...(args.status ? { status: normalizeStatus(args.status) } : {}),
});

const reportDateParams = (args: Args): Record<string, string> => {
  const range = buildDateRangeParams(args.invoiceDateFrom, args.invoiceDateTo);
  return {
    ...(range['date_start'] ? { invoiceDateFrom: range['date_start'] } : {}),
    ...(range['date_end'] ? { invoiceDateTo: range['date_end'] } : {}),
  };
};

const singleDateValue = (input: string): string => parseDateFilter(input).to;

// ─── Script-mode handler ──────────────────────────────────────────────────────

async function executeScriptMode(
  args: Args,
  ctx: ToolExecutionContext,
  scriptDeps: { booksClient: ZohoBooksPaginatedClient; cloudinary: CloudinaryAdapter; csvLinkTtl?: number | undefined; scopeFilter?: Record<string, unknown>; requesterEmail?: string | undefined },
): Promise<Result<Res, ToolError>> {
  const { companyId } = ctx.runContext;
  const moduleName = listOpToModule[args.op]! as ZohoBooksModule;

  const rawFilters: Record<string, string> = { ...dateParams(args) } as Record<string, string>;
  if (args.searchQuery) rawFilters['search_text'] = args.searchQuery;
  if (scriptDeps.scopeFilter) Object.assign(rawFilters, scriptDeps.scopeFilter);

  ctx.onProgress?.(`Fetching ${moduleName} from Zoho Books…`);

  let fetchResult: Awaited<ReturnType<typeof scriptDeps.booksClient.listAllRecords>>;
  try {
    fetchResult = await scriptDeps.booksClient.listAllRecords({
      companyId,
      connectionId: args.connectionId,
      userId: ctx.runContext.userId,
      moduleName,
      ...(Object.keys(rawFilters).length > 0 ? { filters: rawFilters } : {}),
    });
  } catch (e) {
    return err(new ToolError({
      toolId: 'zohoBooks', reason: 'upstream_failure',
      cause: e,
      message: mapZohoError(e),
    }));
  }

  const { getExchangeRates, buildCurrencyUtilities } = await import('../../../zoho/exchange-rate.service');
  const rates = await getExchangeRates();
  const currencyUtils = buildCurrencyUtilities(rates);

  const schema = getModuleSchema(moduleName);
  const scopedItems = scriptDeps.requesterEmail
    ? filterZohoRecordsByEmail(fetchResult.items, scriptDeps.requesterEmail)
    : fetchResult.items;
  const enriched = injectSyntheticFields(scopedItems, schema, currencyUtils);

  const items = enriched.map(item => {
    const slim: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      if (value === null || value === undefined || typeof value !== 'object') {
        slim[key] = value;
      }
    }
    return slim;
  });

  const schemaHint = toSchemaHint(schema, items[0]);

  ctx.onProgress?.(`Processing ${items.length} ${moduleName}…`);

  ctx.logger.info('zohoBooks.script_mode.run', {
    companyId, module: moduleName,
    recordsFetched: items.length, sourceRecordsFetched: fetchResult.items.length, truncated: fetchResult.truncated,
  });

  let sandboxResult;
  try {
    sandboxResult = runInSandbox({
      script: args.script!,
      data: items,
      args: args.scriptArgs,
      schema: schemaHint,
      currency: currencyUtils,
    });
  } catch (e) {
    if (e instanceof SandboxTimeoutError || e instanceof SandboxScriptError ||
        e instanceof SandboxInputTooLargeError || e instanceof SandboxSerializationError) {
      return err(new ToolError({ toolId: 'zohoBooks', reason: 'upstream_failure', message: e.message }));
    }
    throw e;
  }

  const resultArray = sandboxResult.isArray ? sandboxResult.result as unknown[] : null;

  ctx.onProgress?.(`Analysis complete — ${sandboxResult.rowCount ?? 1} results from ${items.length} records`);

  let csvLink: string | undefined;
  let csvPublicId: string | undefined;
  let csvExpiresAt: string | undefined;

  if (args.exportCsv && resultArray && resultArray.length > 0 && scriptDeps.cloudinary.isAvailable) {
    try {
      const firstRow = resultArray[0] as Record<string, unknown>;
      const availableColumns = Object.keys(firstRow);
      const requestedColumns = args.csvColumns ?? [];
      const invalidColumns = requestedColumns.filter(column => !availableColumns.includes(column));
      const columns = requestedColumns.length > 0 && invalidColumns.length === 0
        ? requestedColumns
        : availableColumns;
      if (invalidColumns.length > 0) {
        ctx.logger.warn('zohoBooks.script_mode.invalid_csv_columns', {
          invalidColumns,
          fallbackColumnCount: availableColumns.length,
        });
      }
      const csvBuffer = arrayToCsv(columns, resultArray);
      const dateStr = new Date().toISOString().slice(0, 10);
      const exported = await scriptDeps.cloudinary.uploadCsvBuffer({
        buffer: csvBuffer,
        fileName: `divo-export-${dateStr}-${companyId.slice(0, 8)}.csv`,
        companyId,
        ttlSeconds: scriptDeps.csvLinkTtl ?? 86_400,
      });
      if (exported) {
        csvLink = exported.signedUrl;
        csvPublicId = exported.publicId;
        csvExpiresAt = exported.expiresAt;
      }
    } catch (e) {
      ctx.logger.warn('zohoBooks.script_mode.csv_failed', { error: String(e) });
    }
  }

  const inlineData = resultArray && resultArray.length > INLINE_SCRIPT_LIMIT
    ? resultArray.slice(0, INLINE_SCRIPT_LIMIT) : sandboxResult.result;

  const parts: string[] = [`Fetched ${items.length} records from Zoho Books.`];
  if (fetchResult.truncated) {
    parts.push('DATA INCOMPLETE - pagination limit (4000 records) reached. Totals may be understated.');
  }
  if (args.script === 'return data' && items.length > 0) {
    const sumAmountInr = items.reduce((s, d) => s + Number(d._amount_inr ?? d._amount ?? 0), 0);
    const sumBalanceInr = items.reduce((s, d) => s + Number(d._balance_inr ?? d._balance ?? 0), 0);
    const aggParts = [`_amount_inr sum = ${formatAmount(sumAmountInr, 'INR')}`];
    if (Math.abs(sumBalanceInr - sumAmountInr) > 0.01) {
      aggParts.push(`_balance_inr sum = ${formatAmount(sumBalanceInr, 'INR')}`);
    }
    parts.push(`Aggregates (all ${items.length} records): ${aggParts.join(', ')}.`);
  }
  if (resultArray) {
    parts.push(`Processed into ${resultArray.length} rows.`);
    if (resultArray.length > INLINE_SCRIPT_LIMIT) parts.push(`Showing first ${INLINE_SCRIPT_LIMIT} inline.`);
  }
  if (csvLink) parts.push('Full CSV available via download link.');

  return ok({
    success: true,
    data: inlineData,
    message: parts.join(' '),
    rowCount: sandboxResult.rowCount,
    totalFetched: items.length,
    moduleSchema: schemaHint,
    sourceTruncated: fetchResult.truncated,
    ...(csvLink ? { csvLink } : {}),
    ...(csvPublicId ? { csvPublicId } : {}),
    ...(csvExpiresAt ? { csvExpiresAt } : {}),
  });
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export const createZohoBooksTool = (deps: {
  /** Factory for simple per-request CRUD client (token resolved per call). */
  getClient:    (
    companyId: string,
    userId: string,
    connectionId?: string,
    minimumAccess?: 'read_only' | 'read_write',
  ) => Promise<ZohoBooksClientPort | null>;
  /** Paginated client for module reads and raw Books report endpoints. */
  booksClient:  ZohoBooksPaginatedClient;
  /** Finance ops service for deep report operations. */
  financeOps:   ZohoFinanceOps;
  /** CSV export storage for generic list operations. */
  cloudinary:    CloudinaryAdapter;
  inlineThreshold?: number;
  csvLinkTtl?:      number;
}): Tool<Args, Res> => ({
  id:           asToolId('zohoBooks'),
  family:       'zoho',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema:   Schema,
  resultSchema: ResultSchema,

  description: [
    'Access Zoho Books: 19 operations for invoices, bills, expenses, payments, contacts, bank transactions, and reports.',
    'Plain list operations fetch one bounded page and return only the requested limit.',
    'For custom analysis (grouping, aggregation, ranking), add a `script` parameter to fetch up to 4000 records with pre-converted INR fields (_amount_inr, _balance_inr, _total_inr).',
    'Use _amount_inr/_balance_inr for all INR calculations — pre-converted using Zoho exchange rates, guaranteed correct.',
    'Set exportCsv=true or exportAll=true for downloadable CSV.',
    'Full CSV example: {"op":"list_invoices","dateFrom":"2026-07-01","dateTo":"2026-07-31","exportAll":true,"connectionId":"<exact UUID>"}. Keep every field top-level.',
  ].join(' '),

  parameterDocs: [
    'connectionId: exact accessible Zoho UUID. In backend-hosted channels, omit it when only one Zoho account is accessible; the backend resolves that account. If multiple are available, retry with the exact ID returned by the error.',
    'op: list_invoices|get_invoice|create_invoice|list_contacts|get_contact|list_expenses|list_bills|list_payments|get_chart_of_accounts|get_account_balance|list_bank_transactions|search_transactions|get_tax_summary|send_invoice|record_payment|create_expense|create_bill|void_invoice|build_overdue_report',
    'read params: accountId, searchQuery, dateFrom, dateTo, status, taxYear, exportAll, limit (1-100)',
    'limit is the requested maximum. Once that many rows are returned, do not fetch more pages or switch to script mode unless the user explicitly asks for all records, an export, or an aggregate requiring the complete dataset.',
    'write params: invoiceId, email, fields',
    'build_overdue_report params: asOfDate (ISO), minOverdueDays, invoiceDateFrom, invoiceDateTo',
    '',
    'SCRIPT MODE (list ops only — for ANALYSIS/GROUPING/AGGREGATION):',
    'script: JS code. Receives data (all records), args (extra params), schema (field hints). Must return a value.',
    '  _amount_inr/_total_inr = full amount in INR (pre-converted). _balance_inr = outstanding in INR.',
    '  _amount/_total = original currency. _balance = original outstanding. _currency = ISO code.',
    '  For INR sums: use _balance_inr or _amount_inr directly. For "show in USD": fromINR(total, "USD").',
    '  formatAmount(value, currency) and formatDate(iso) are available in the sandbox.',
    '  Example: "const g={}; data.forEach(b=>{const v=b.vendor_name||\'Unknown\'; if(!g[v])g[v]={vendor:v,count:0,outstanding:0}; g[v].count++; g[v].outstanding+=b._balance_inr;}); return Object.values(g).sort((a,b)=>b.outstanding-a.outstanding)"',
    'scriptArgs: extra parameters available as `args` in the script',
    'exportCsv: true to upload script result as CSV with download link',
    'csvColumns: column order for CSV (auto-detected if omitted)',
  ].join('\n'),

  permissionCheck(args, perm) {
    const action: ToolActionGroup = readOps.has(args.op) ? 'read' : createOps.has(args.op) ? 'create' : 'delete';
    const allowed = perm.allowedActionsByTool.get(asToolId('zohoBooks'))?.has(action) ?? false;
    return allowed
      ? ok(action)
      : err(new PermissionError({ toolId: 'zohoBooks', action, reason: 'not_allowed' }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    const { companyId, userId } = ctx.runContext;
    const connectionContext = {
      connectionId: args.connectionId,
      userId,
    };

    const zohoReadScope = ctx.perm.department?.zohoReadScope ?? 'show_all';
    const requesterEmail = normalizedEmail(ctx.runContext.requesterEmail);
    const personalizedScope = zohoReadScope === 'personalized';
    if (personalizedScope && !requesterEmail) {
      return err(new ToolError({
        toolId: 'zohoBooks',
        reason: 'permission_denied',
        message: 'Personalized Zoho access requires the signed-in member email.',
      }));
    }
    if (personalizedScope) {
      ctx.logger.info('zoho_books.scope.personalized', { requesterEmail, op: args.op });
      if (!readOps.has(args.op)) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'permission_denied',
          message: 'Zoho write actions are unavailable while this role is restricted to personalized data.',
        }));
      }
    }

    // ── Report operations (use financeOps — deep pagination + CSV) ──────────
    if (args.op === 'build_overdue_report') {
      if (personalizedScope) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'permission_denied',
          message: 'Overdue reports aggregate department-wide invoices and are unavailable for personalized Zoho access.',
        }));
      }
      ctx.onProgress?.('Building overdue invoice report…');
      try {
        const report = await deps.financeOps.buildOverdueReport({
          companyId,
          ...connectionContext,
          ...(args.organizationId  ? { organizationId:  args.organizationId  } : {}),
          ...(args.asOfDate        ? { asOfDate:        singleDateValue(args.asOfDate) } : {}),
          ...(args.minOverdueDays !== undefined ? { minOverdueDays: args.minOverdueDays } : {}),
          ...reportDateParams(args),
        });

        return ok({
          success: true,
          message: report.summary,
          report:  formatZohoResult(report),   // full structured data — synthesis uses this to format the reply
        });
      } catch (e) {
        return err(new ToolError({
          toolId:  'zohoBooks',
          reason:  'upstream_failure',
          cause:   e,
          message: `Overdue report failed: ${mapZohoError(e)}`,
        }));
      }
    }

    const scopeFilter: Record<string, unknown> = personalizedScope ? { email: requesterEmail! } : {};

    // ── Script mode (auto-escalate list ops to exhaustive fetch + sandbox) ──
    if (args.script) {
      const moduleName = listOpToModule[args.op];
      if (moduleName) {
        return executeScriptMode(args, ctx, {
          booksClient: deps.booksClient,
          cloudinary:  deps.cloudinary,
          csvLinkTtl:  deps.csvLinkTtl,
          ...(personalizedScope ? { scopeFilter, requesterEmail: requesterEmail! } : {}),
        });
      }
      return err(new ToolError({
        toolId: 'zohoBooks', reason: 'bad_args',
        message: `script is only supported on list operations (${Object.keys(listOpToModule).join(', ')}), not ${args.op}`,
      }));
    }

    // ── CRUD operations (use simple client) ──────────────────────────────────
    ctx.logger.info('zoho_books.tool.get_client', { companyId, userId, op: args.op });
    const client = await deps.getClient(
      companyId,
      userId,
      args.connectionId,
      readOps.has(args.op) ? 'read_only' : 'read_write',
    );
    ctx.logger.info('zoho_books.tool.client_resolved', { companyId, hasClient: !!client, op: args.op });
    if (!client) {
      ctx.logger.warn('zoho_books.tool.no_client', { companyId, userId, op: args.op });
      return err(new ToolError({
        toolId:  'zohoBooks',
        reason:  'unrecoverable',
        message: 'Zoho Books not connected for this company',
      }));
    }

    const listRecords = async (moduleName: ZohoBooksModule, filters?: Record<string, unknown>, query?: string) =>
      deps.booksClient.listRecords({
        companyId,
        ...connectionContext,
        moduleName,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        filters: { ...scopeFilter, ...filters },
        ...(query ? { query } : {}),
        perPage: args.limit ?? 25,
      });

    const dateFilter = dateParams(args);
    const listWithExport = async (
      moduleName: ZohoBooksModule,
      moduleLabel: string,
      options: {
        filters?: Record<string, unknown>;
        query?: string;
        amountKeys?: string[];
        columns: readonly ZohoListCsvColumn<Record<string, unknown>>[];
        fileNameParts?: readonly string[];
      },
    ) => {
      const result = await handleZohoList({
        companyId,
        ...connectionContext,
        moduleName,
        moduleLabel,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        filters: { ...scopeFilter, ...options.filters },
        ...(options.query ? { query: options.query } : {}),
        exportAll: args.exportAll === true,
        offerExportOnOverflow: args.limit === undefined,
        inlineThreshold: args.limit ?? deps.inlineThreshold ?? 25,
        csvTtlSeconds: deps.csvLinkTtl ?? 86_400,
        fileNameParts: options.fileNameParts ?? [
          ...(args.dateFrom ? [args.dateFrom] : []),
          ...(args.dateTo ? [args.dateTo] : []),
          ...(args.status ? [args.status] : []),
        ],
        csvColumns: options.columns,
        summarize: (items) => summarizeRecords(moduleLabel, options.amountKeys ?? [], items),
        booksClient: deps.booksClient,
        cloudinary: deps.cloudinary,
        logger: ctx.logger,
      });
      const modelItems = projectListItems(result.items, options.columns);

      return {
        success: true,
        message: result.summary,
        data: formatZohoResult({
          items: modelItems,
          totalCount: result.totalCount,
          ...(result.csvLink ? { csvLink: result.csvLink } : {}),
          ...(result.csvPublicId ? { csvPublicId: result.csvPublicId } : {}),
          ...(result.csvExpiresAt ? { csvExpiresAt: result.csvExpiresAt } : {}),
          truncated: result.truncated,
          hasMore: result.hasMore,
          suggestExport: result.suggestExport,
        }),
        report: {
          totalCount: result.totalCount,
          summary: result.summary,
          truncated: result.truncated,
          hasMore: result.hasMore,
          suggestExport: result.suggestExport,
          ...(result.csvLink ? { csvLink: result.csvLink } : {}),
          ...(result.csvPublicId ? { csvPublicId: result.csvPublicId } : {}),
          ...(result.csvExpiresAt ? { csvExpiresAt: result.csvExpiresAt } : {}),
        },
        ...(result.csvLink ? { csvLink: result.csvLink } : {}),
        ...(result.csvPublicId ? { csvPublicId: result.csvPublicId } : {}),
        ...(result.csvExpiresAt ? { csvExpiresAt: result.csvExpiresAt } : {}),
        truncated: result.truncated,
        hasMore: result.hasMore,
        suggestExport: result.suggestExport,
      } satisfies Res;
    };

    try {
      switch (args.op) {
        case 'list_invoices':
          return ok(await listWithExport('invoices', 'invoices', {
            filters: dateFilter,
            amountKeys: ['total', 'balance', 'amount_due'],
            columns: [
              commonColumns.id('Invoice ID'),
              { key: 'invoice_number', header: 'Invoice Number' },
              { key: 'customer_name', header: 'Customer' },
              commonColumns.date,
              { key: 'due_date', header: 'Due Date' },
              commonColumns.status,
              { key: 'total', header: 'Total' },
              { key: 'balance', header: 'Balance' },
              commonColumns.currency,
            ],
          }));

        case 'get_invoice': {
          if (!args.invoiceId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'invoiceId required for get_invoice' }));
          const invoice = await client.getInvoice(args.invoiceId);
          if (personalizedScope && !recordMatchesZohoEmail(invoice, requesterEmail!)) return ok({ success: true, data: null, message: 'Invoice not found' });
          return ok({ success: true, data: formatZohoResult(invoice) });
        }

        case 'create_invoice': {
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for create_invoice' }));
          const r = await client.createInvoice(args.fields as Record<string, unknown>);
          return ok({ success: true, id: r.invoiceId, message: 'Invoice created successfully' });
        }

        case 'send_invoice': {
          if (!args.invoiceId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'invoiceId required for send_invoice' }));
          const r = await client.sendInvoice(args.invoiceId, args.email);
          return ok({ success: true, id: r.invoiceId, message: 'Invoice sent successfully' });
        }

        case 'record_payment': {
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for record_payment' }));
          const r = await client.recordPayment(args.fields as Record<string, unknown>);
          return ok({ success: true, id: r.paymentId, message: 'Payment recorded successfully' });
        }

        case 'create_expense': {
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for create_expense' }));
          const r = await client.createExpense(args.fields as Record<string, unknown>);
          return ok({ success: true, id: r.expenseId, message: 'Expense created successfully' });
        }

        case 'create_bill': {
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for create_bill' }));
          const r = await client.createBill(args.fields as Record<string, unknown>);
          return ok({ success: true, id: r.billId, message: 'Bill created successfully' });
        }

        case 'void_invoice': {
          if (!args.invoiceId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'invoiceId required for void_invoice' }));
          const r = await client.voidInvoice(args.invoiceId);
          return ok({ success: true, id: r.invoiceId, message: 'Invoice voided successfully' });
        }

        case 'list_contacts':
          return ok(await listWithExport('contacts', 'contacts', {
            ...(args.searchQuery ? { query: args.searchQuery } : {}),
            columns: [
              commonColumns.id('Contact ID'),
              { key: 'contact_name', header: 'Contact Name' },
              { key: 'company_name', header: 'Company' },
              { key: 'email', header: 'Email' },
              { key: 'phone', header: 'Phone' },
              { key: 'status', header: 'Status' },
              commonColumns.currency,
            ],
          }));

        case 'get_contact': {
          if (!args.contactId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'contactId required for get_contact' }));
          const contact = await client.getContact(args.contactId);
          if (personalizedScope && !recordMatchesZohoEmail(contact, requesterEmail!)) return ok({ success: true, data: null, message: 'Contact not found' });
          return ok({ success: true, data: formatZohoResult(contact) });
        }

        case 'list_expenses':
          return ok(await listWithExport('expenses', 'expenses', {
            filters: dateFilter,
            amountKeys: ['total', 'amount'],
            columns: [
              commonColumns.id('Expense ID'),
              commonColumns.date,
              { key: 'account_name', header: 'Account' },
              { key: 'vendor_name', header: 'Vendor' },
              { key: 'amount', header: 'Amount' },
              commonColumns.currency,
              commonColumns.status,
            ],
          }));

        case 'list_bills':
          return ok(await listWithExport('bills', 'bills', {
            filters: dateFilter,
            amountKeys: ['total', 'balance', 'amount_due'],
            columns: [
              commonColumns.id('Bill ID'),
              { key: 'bill_number', header: 'Bill Number' },
              { key: 'vendor_name', header: 'Vendor' },
              commonColumns.date,
              { key: 'due_date', header: 'Due Date' },
              commonColumns.status,
              { key: 'total', header: 'Total' },
              { key: 'balance', header: 'Balance' },
              commonColumns.currency,
            ],
          }));

        case 'list_payments':
          return ok(await listWithExport('customerpayments', 'payments', {
            filters: dateFilter,
            amountKeys: ['amount', 'payment_amount'],
            columns: [
              commonColumns.id('Payment ID'),
              { key: 'payment_number', header: 'Payment Number' },
              { key: 'customer_name', header: 'Customer' },
              commonColumns.date,
              { key: 'amount', header: 'Amount' },
              commonColumns.currency,
              commonColumns.status,
            ],
          }));

        case 'get_chart_of_accounts': {
          if (personalizedScope) return err(new ToolError({ toolId: 'zohoBooks', reason: 'permission_denied', message: 'Chart of accounts is unavailable for personalized Zoho access.' }));
          const data = await deps.booksClient.getEndpoint({
            companyId,
            ...connectionContext,
            path: '/chartofaccounts',
            ...(args.organizationId ? { organizationId: args.organizationId } : {}),
          });
          return ok({ success: true, data: formatZohoResult(data['chartofaccounts'] ?? data) });
        }

        case 'get_account_balance': {
          if (personalizedScope) return err(new ToolError({ toolId: 'zohoBooks', reason: 'permission_denied', message: 'Account balances are unavailable for personalized Zoho access.' }));
          const data = args.accountId
            ? await deps.booksClient.getEndpoint({
              companyId,
              ...connectionContext,
              path: `/bankaccounts/${encodeURIComponent(args.accountId)}`,
              ...(args.organizationId ? { organizationId: args.organizationId } : {}),
            })
            : await listRecords('bankaccounts');
          return ok({ success: true, data: formatZohoResult(data) });
        }

        case 'list_bank_transactions':
          return ok(await listWithExport('banktransactions', 'bank transactions', {
            filters: dateFilter,
            amountKeys: ['amount'],
            columns: [
              commonColumns.id('Transaction ID'),
              { key: 'transaction_type', header: 'Type' },
              commonColumns.date,
              { key: 'description', header: 'Description' },
              { key: 'amount', header: 'Amount' },
              commonColumns.currency,
              commonColumns.status,
            ],
          }));

        case 'search_transactions': {
          if (!args.searchQuery) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'searchQuery required for search_transactions' }));
          return ok(await listWithExport('banktransactions', 'transaction search results', {
            filters: dateFilter,
            query: args.searchQuery,
            amountKeys: ['amount'],
            fileNameParts: ['search', args.searchQuery],
            columns: [
              commonColumns.id('Transaction ID'),
              { key: 'transaction_type', header: 'Type' },
              commonColumns.date,
              { key: 'description', header: 'Description' },
              { key: 'amount', header: 'Amount' },
              commonColumns.currency,
              commonColumns.status,
            ],
          }));
        }

        case 'get_tax_summary': {
          if (personalizedScope) return err(new ToolError({ toolId: 'zohoBooks', reason: 'permission_denied', message: 'Tax summaries are unavailable for personalized Zoho access.' }));
          const data = await deps.booksClient.getEndpoint({
            companyId,
            ...connectionContext,
            path: '/reports/taxsummary',
            ...(args.organizationId ? { organizationId: args.organizationId } : {}),
            params: {
              ...(args.taxYear ? { tax_year: args.taxYear } : {}),
              ...dateParams(args),
            },
          });
          return ok({ success: true, data: formatZohoResult(data) });
        }
      }
    } catch (e) {
      return err(new ToolError({
        toolId:  'zohoBooks',
        reason:  'upstream_failure',
        cause:   e,
        message: mapZohoError(e),
      }));
    }
  },
});
