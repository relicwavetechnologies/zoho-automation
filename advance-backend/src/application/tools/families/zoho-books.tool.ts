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
 *                            top-10 customers, return a bounded summary
 *
 * Token safety:
 *   - Plain list ops return at most `limit` records (default 25, max 100)
 *     and fetch only one bounded page unless exportAll was explicitly requested
 *   - Governed artifacts are delivered only by dataExport and obey its central row ceiling
 */

import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result }                     from '../../../shared/result';
import { ok, err }                         from '../../../shared/result';
import { PermissionError, ToolError }      from '../../../shared/errors';
import type { ToolActionGroup }            from '../../../domain/permissions/tool-action-group';
import { asToolId }                        from '../../../shared/ids';
import {
  ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE,
  ZOHO_BOOKS_OUTSTANDING_RULE,
  ZOHO_BOOKS_ROW_CONTRACT,
} from '../../../shared/zoho-books-row-contract';
import type { ZohoFinanceOps }             from '../../zoho/zoho-finance-ops';
import { mapZohoError }                    from '../../zoho/zoho-error.utils';
import { formatAmount, formatDate }        from '../../zoho/zoho-format.utils';
import { normalizeStatus, parseDateFilter } from '../../zoho/zoho-filter.utils';
import { handleZohoList, type ZohoListCsvColumn } from '../../zoho/zoho-list-handler';
import type { ZohoBooksPaginatedClient, ZohoBooksModule } from '../../../infrastructure/zoho/zoho-books-paginated.client';
import { getModuleSchema, injectSyntheticFields, toSchemaHint } from '../../../infrastructure/zoho/zoho-books-schema.cache';
import { runInSandbox, SandboxTimeoutError, SandboxScriptError, SandboxInputTooLargeError, SandboxSerializationError } from '../shared/sandbox-runner';
import { filterZohoRecordsByEmail, normalizedEmail, recordMatchesZohoEmail } from '../../../shared/zoho-personalization';
import { contributeExportPart, exportWithdrawalMessage } from '../../data-export/tool-export-offer';
import {
  dataExportCallRequestId,
  dataExportRunRequestId,
} from '../../data-export/export-request-identity';
import { DATA_EXPORT_CSV_ROW_LIMIT } from '../../data-export/data-export-limits';
import { datasetSourceSchema } from '../../data-export/data-export.types';
import type { DataExportOfferService } from '../../data-export/data-export-offer.service';
import type { DataExportOfferPayload } from '../../data-export/export-offer';
import {
  createDatasetPreview,
  DATASET_PREVIEW_ROW_LIMIT,
} from '../../data-export/dataset-preview';

// ─── Args schema ──────────────────────────────────────────────────────────────

const Schema = z.object({
  connectionId: z.string().uuid(),
  destinationConnectionId: z.string().uuid().optional(),
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
});

type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success:      z.boolean(),
  data:         z.unknown().optional(),
  id:           z.string().optional(),
  message:      z.string().optional(),
  // Report fields (present only for build_overdue_report)
  report:       z.unknown().optional(),
  truncated:    z.boolean().optional(),
  hasMore:      z.boolean().optional(),
  suggestExport: z.boolean().optional(),
  // Script-mode fields
  rowCount:        z.number().optional(),
  totalFetched:    z.number().optional(),
  moduleSchema:    z.unknown().optional(),
  sourceTruncated: z.boolean().optional(),
  exportQueued: z.boolean().optional(),
  exportJobId: z.string().optional(),
  preview: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.unknown())).max(DATASET_PREVIEW_ROW_LIMIT),
    coverage: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('complete'), totalRows: z.number().int().nonnegative() }),
      z.object({
        kind: z.literal('truncated'),
        returnedRows: z.number().int().nonnegative(),
        knownTotal: z.number().int().nonnegative().optional(),
        reason: z.string(),
      }),
      z.object({
        kind: z.literal('provider_limited'),
        returnedRows: z.number().int().nonnegative(),
        reason: z.string(),
      }),
      z.object({ kind: z.literal('unknown'), returnedRows: z.number().int().nonnegative() }),
    ]),
    exportOfferId: z.string().optional(),
    exportRowCount: z.number().int().nonnegative().optional(),
    exportWithdrawn: z.literal(true).optional(),
  }).optional(),
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
  'outstanding_payable_amount',
  'outstanding_receivable_amount',
  'outstanding_ob_payable_amount',
  'outstanding_ob_receivable_amount',
  'opening_balance_amount',
  'unused_credits_payable_amount',
  'unused_credits_receivable_amount',
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

const currencyFrom = (record: Record<string, unknown>): string | undefined => {
  const currency = record['currency_code'] ?? record['currencyCode'] ?? record['currency'];
  return typeof currency === 'string' && currency.trim() ? currency : undefined;
};

const numericAmount = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value.trim())) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const stringValue = (record: Record<string, unknown>, ...keys: string[]): string =>
  keys.map(key => record[key]).find(value => typeof value === 'string' && value.trim().length > 0) as string | undefined ?? '';

const normalizeRecordNumber = (value: string): string => value.trim().toLowerCase();
const isZohoRecordId = (value: string): boolean => /^\d{10,}$/.test(value.trim());

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
  truncated = false,
): string => {
  if (items.length === 0) return `No ${moduleLabel.toLowerCase()} matched the current criteria.`;
  const countLabel = truncated ? `Showing ${items.length}` : `Found ${items.length}`;
  if (amountKeys.length === 0) return `${countLabel} ${moduleLabel.toLowerCase()}.`;

  const totals = new Map<string, number>();
  for (const item of items) {
    const currency = currencyFrom(item) ?? 'UNKNOWN';
    totals.set(currency, (totals.get(currency) ?? 0) + amountValue(item, ...amountKeys));
  }
  const totalText = [...totals.entries()]
    .filter(([, total]) => total !== 0)
    .map(([currency, total]) => currency === 'UNKNOWN'
      ? `${total.toLocaleString('en-IN')} (currency unavailable)`
      : `${formatAmount(total, currency)} (${currency})`)
    .join(', ');
  return totalText
    ? `${countLabel} ${moduleLabel.toLowerCase()}: ${totalText}.`
    : `${countLabel} ${moduleLabel.toLowerCase()}.`;
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

    if (amountFields.has(key) && currency) {
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

/**
 * Provider filters for one module, derived once so the inline read and the
 * export recipe cannot drift.
 *
 * They have to agree. The recipe is replayed at confirmation time, so a filter
 * the preview applied but the recipe omits turns a scoped answer into an
 * unscoped file — and `accountId` was being accepted and dropped by both,
 * widening a one-account question to every account in the organisation.
 */
const moduleFilters = (
  moduleName: ZohoBooksModule,
  args: Args,
): Record<string, unknown> =>
  // Zoho scopes bank transactions per account: it rejects a status filter that
  // names none, and ignores the account unless it is passed as account_id.
  //
  // Deliberately only the module-specific companion, not the date/status set.
  // Folding those in here would start sending filters to modules that have
  // never received them — `list_contacts` passes none today — and Zoho answers
  // an unsupported filter with a 400 rather than ignoring it.
  (moduleName === 'banktransactions' && args.accountId
    ? { account_id: args.accountId }
    : {});

/**
 * Zoho answers a status filter with no account as `The account does not exist`,
 * which reads as a missing bank account rather than a missing argument. Say
 * what is actually wrong, before the provider gets a chance to mislead.
 */
const bankTransactionFilterError = (args: Args): ToolError | undefined =>
  args.status && !args.accountId
    ? new ToolError({
        toolId: 'zohoBooks',
        reason: 'bad_args',
        message:
          'Add accountId and retry — this is a missing argument, not a permission problem. '
          + 'Zoho Books scopes bank transactions per account and rejects a status filter that '
          + 'names none. Call get_account_balance with no accountId to list the bank accounts '
          + 'and their ids, then retry with accountId. To read every account instead, drop the '
          + 'status filter.',
      })
    : undefined;

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
  scriptDeps: { booksClient: ZohoBooksPaginatedClient; scopeFilter?: Record<string, unknown>; requesterEmail?: string | undefined },
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

  const { getExchangeRates, buildCurrencyUtilities } = await import('../../zoho/exchange-rate.service');
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

  return ok({
    success: true,
    data: inlineData,
    message: parts.join(' '),
    rowCount: sandboxResult.rowCount,
    totalFetched: items.length,
    moduleSchema: schemaHint,
    sourceTruncated: fetchResult.truncated,
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
  offers?: Pick<DataExportOfferService, 'appendAuthorizedPart' | 'submitAuthorized'>;
  inlineThreshold?: number;
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
    'For an exact aggregate that may require more than 4000 records, page through this tool inside a scripted workflow, write the rows to a file, and aggregate over that file.',
    'Use populated _amount_inr/_balance_inr for INR calculations; never infer an original currency when _currency is UNKNOWN.',
    `Set exportAll=true for a governed auto-format export with a ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')}-row pipeline ceiling, subject to provider availability. If the user asks for more or every row, disclose the cap and never call the result complete.`,
    'Export example: {"op":"list_invoices","dateFrom":"2026-07-01","dateTo":"2026-07-31","exportAll":true,"connectionId":"<exact Zoho UUID>"}. If Divo returns eligible Google destination choices, retry with the same arguments plus destinationConnectionId="<chosen Google UUID>". Keep every field top-level.',
  ].join(' '),

  parameterDocs: [
    'connectionId: exact accessible Zoho UUID. In backend-hosted channels, omit it when only one Zoho account is accessible; the backend resolves that account. If multiple are available, retry with the exact ID returned by the error.',
    'op: list_invoices|get_invoice|create_invoice|list_contacts|get_contact|list_expenses|list_bills|list_payments|get_chart_of_accounts|get_account_balance|list_bank_transactions|search_transactions|get_tax_summary|send_invoice|record_payment|create_expense|create_bill|void_invoice|build_overdue_report',
    'read params: invoiceId, accountId, searchQuery, dateFrom, dateTo, status, taxYear, exportAll, limit (1-100)',
    'get_invoice accepts a Zoho numeric invoice ID or an exact human invoice number. list_invoices forwards searchQuery to Zoho and returns newest invoice dates first.',
    'limit is the requested maximum. Once that many rows are returned, do not fetch more pages or switch to script mode unless the user explicitly asks for an export or an aggregate within script mode’s documented 4,000-record ceiling.',
    'write params: invoiceId, email, fields',
    'build_overdue_report params: asOfDate (ISO), minOverdueDays, invoiceDateFrom, invoiceDateTo',
    '',
    'SCRIPT MODE (list ops only — for ANALYSIS/GROUPING/AGGREGATION):',
    'script: JS code. Receives data (all records), args (extra params), schema (field hints). Must return a value.',
    `  ${ZOHO_BOOKS_ROW_CONTRACT}`,
    `  ${ZOHO_BOOKS_OUTSTANDING_RULE}`,
    `  ${ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE}`,
    '  _amount/_total = original currency amount. _balance = original outstanding. _currency = ISO code or UNKNOWN; never label UNKNOWN as INR.',
    '  For INR sums: use _balance_inr or _amount_inr directly. For "show in USD": fromINR(total, "USD").',
    '  formatAmount(value, currency) and formatDate(iso) are available in the sandbox.',
    '  Example (bill-balance ranking only — not contact payable total): "const g={}; data.forEach(b=>{const v=b.vendor_name||\'Unknown\'; if(!g[v])g[v]={vendor:v,count:0,billBalance:0}; g[v].count++; g[v].billBalance+=b._balance_inr;}); return Object.values(g).sort((a,b)=>b.billBalance-a.billBalance)"',
    'scriptArgs: extra parameters available as `args` in the script',
    `Script results stay bounded inline. For a governed auto-format source artifact of up to ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')} rows, subject to provider availability, use exportAll=true or dataExport.`,
  ].join('\n'),

  permissionCheck(args, perm) {
    const action: ToolActionGroup = readOps.has(args.op) ? 'read' : createOps.has(args.op) ? 'create' : 'delete';
    const allowed = perm.allowedActionsByTool.get(asToolId('zohoBooks'))?.has(action) ?? false;
    if (
      allowed
      && args.exportAll
      && !perm.allowedActionsByTool.get(asToolId('dataExport'))?.has('create')
    ) {
      return err(new PermissionError({ toolId: 'dataExport', action: 'create', reason: 'not_allowed' }));
    }
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

    // ── Report operations (server-side aggregation, bounded model result) ───
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

    // `exportAll` queues one artifact per call through `submitAuthorized`, while
    // a bounded list contributes a part to the run's merged offer. Those want
    // opposite identity scopes, so the caller states which it is.
    const exportPayloadFor = (
      moduleName: ZohoBooksModule,
      requestId: string,
    ): DataExportOfferPayload => ({
      companyId,
      userId,
      ...(ctx.runContext.departmentId ? { departmentId: ctx.runContext.departmentId } : {}),
      source: {
        kind: 'zoho_books',
        connectionId: args.connectionId,
        module: moduleName,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        filters: { ...dateParams(args), ...moduleFilters(moduleName, args) },
        ...(args.searchQuery ? { query: args.searchQuery } : {}),
      },
      destination: {
        format: 'auto',
        title: `Zoho Books ${moduleName} export`,
      },
      chatId: ctx.runContext.chatId!,
      ...(ctx.runContext.runtimeThreadId
        ? { conversationKey: ctx.runContext.runtimeThreadId }
        : {}),
      ...(ctx.runContext.replyToMessageId
        ? { replyToMessageId: ctx.runContext.replyToMessageId }
        : {}),
      ...(ctx.runContext.replyInThread !== undefined
        ? { replyInThread: ctx.runContext.replyInThread }
        : {}),
      requestId,
      ...(ctx.runContext.traceId ? { traceId: ctx.runContext.traceId } : {}),
    });

    const exportModule = listOpToModule[args.op];
    if (args.exportAll && exportModule) {
      if (!ctx.perm.allowedActionsByTool.get(asToolId('dataExport'))?.has('create')) {
        return err(new ToolError({
          toolId: 'dataExport',
          reason: 'permission_denied',
          message: `Governed Zoho Books exports of up to ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')} rows are not permitted for this member`,
        }));
      }
      if (personalizedScope) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'permission_denied',
          message: `Governed Zoho exports of up to ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')} rows require full company Zoho read scope`,
        }));
      }
      if (
        !deps.offers
        || ctx.runContext.channel !== 'lark'
        || !ctx.runContext.chatId
        || !args.connectionId
      ) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: `Governed Zoho exports of up to ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')} rows require an exact connection UUID and a Lark chat for delivery`,
        }));
      }
      // exportAll returns before the per-op switch, so the guards on the
      // individual bank-transaction cases never see it. Without this, the one
      // path that queues an export directly is also the only one that could
      // still submit a recipe the provider will reject.
      if (exportModule === 'banktransactions') {
        const filterError = bankTransactionFilterError(args);
        if (filterError) return err(filterError);
      }
      const payload = exportPayloadFor(
        exportModule,
        dataExportCallRequestId(ctx.runContext, ctx.correlationId),
      );
      const recipe = datasetSourceSchema.safeParse(payload.source);
      if (!recipe.success) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: `This export cannot be run as asked — ${recipe.error.errors.map(issue => issue.message).join('; ')}`,
        }));
      }
      try {
        const exportJobId = await deps.offers.submitAuthorized(
          payload,
          args.destinationConnectionId,
        );
        return ok({
          success: true,
          exportQueued: true,
          exportJobId,
          message: `Zoho Books export queued through dataExport with the ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')}-row auto-format pipeline ceiling, subject to provider availability. I will deliver the verified private Google artifact to this Lark chat. If more rows exist, they will be omitted and the result will not be described as complete.`,
        });
      } catch (cause) {
        return err(new ToolError({
          toolId: 'dataExport',
          reason: 'upstream_failure',
          cause,
          message: `Could not queue Zoho Books export: ${cause instanceof Error ? cause.message : String(cause)}`,
        }));
      }
    }

    // ── Script mode (auto-escalate list ops to exhaustive fetch + sandbox) ──
    if (args.script) {
      const moduleName = listOpToModule[args.op];
      if (moduleName) {
        return executeScriptMode(args, ctx, {
          booksClient: deps.booksClient,
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
    const listBounded = async (
      moduleName: ZohoBooksModule,
      moduleLabel: string,
      options: {
        filters?: Record<string, unknown>;
        query?: string;
        amountKeys?: string[];
        columns: readonly ZohoListCsvColumn<Record<string, unknown>>[];
      },
    ) => {
      const canOfferExport = args.limit === undefined
        && !personalizedScope
        && deps.offers !== undefined
        && ctx.runContext.channel === 'lark'
        && Boolean(ctx.runContext.chatId)
        && ctx.perm.allowedActionsByTool.get(asToolId('dataExport'))?.has('create') === true;
      const result = await handleZohoList({
        companyId,
        ...connectionContext,
        moduleName,
        moduleLabel,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        filters: { ...scopeFilter, ...moduleFilters(moduleName, args), ...options.filters },
        ...(options.query ? { query: options.query } : {}),
        offerExportOnOverflow: canOfferExport,
        inlineThreshold: Math.min(
          args.limit ?? deps.inlineThreshold ?? DATASET_PREVIEW_ROW_LIMIT,
          DATASET_PREVIEW_ROW_LIMIT,
        ),
        ...(personalizedScope
          ? { postFilter: (items: readonly Record<string, unknown>[]) =>
              filterZohoRecordsByEmail(items, requesterEmail!) }
          : {}),
        summarize: (items, meta) => summarizeRecords(
          moduleLabel,
          options.amountKeys ?? [],
          items,
          meta.truncated,
        ),
        booksClient: deps.booksClient,
      });
      const modelItems = projectListItems(result.items, options.columns);
      const formattedItems = formatZohoResult(modelItems) as Record<string, unknown>[];
      const offer = await contributeExportPart({
        offers: deps.offers,
        eligible: result.suggestExport && canOfferExport,
        payload: () => exportPayloadFor(
          moduleName,
          dataExportRunRequestId(ctx.runContext, ctx.correlationId),
        ),
        observedRowCount: formattedItems.length,
        collectionTitle: `Zoho Books ${moduleName}`,
        logger: ctx.logger,
        scope: 'zoho_books',
        correlationId: ctx.correlationId,
      });
      const preview = createDatasetPreview({
        rows: formattedItems,
        coverage: result.coverage,
        ...(offer.kind === 'offered' ? { exportOfferId: offer.offerId, exportRowCount: offer.observedRowCount } : {}),
        ...(offer.kind === 'withdrawn' ? { exportWithdrawn: true as const } : {}),
      });

      return {
        success: true,
        message: offer.kind === 'withdrawn'
          ? `${result.summary} ${exportWithdrawalMessage(offer.reason)}`
          : result.summary,
        preview,
        report: {
          returnedCount: result.items.length,
          ...(result.totalCount !== undefined ? { totalCount: result.totalCount } : {}),
          summary: result.summary,
          truncated: result.truncated,
          hasMore: result.hasMore,
          suggestExport: result.suggestExport,
        },
        truncated: result.truncated,
        hasMore: result.hasMore,
        suggestExport: result.suggestExport,
      } satisfies Res;
    };

    try {
      switch (args.op) {
        case 'list_invoices':
          return ok(await listBounded('invoices', 'invoices', {
            filters: {
              ...dateFilter,
              sort_column: 'date',
              sort_order: 'D',
            },
            ...(args.searchQuery ? { query: args.searchQuery } : {}),
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
          let resolvedInvoiceId = args.invoiceId;
          if (!isZohoRecordId(resolvedInvoiceId)) {
            const lookup = await deps.booksClient.listRecords({
              companyId,
              ...connectionContext,
              moduleName: 'invoices',
              ...(args.organizationId ? { organizationId: args.organizationId } : {}),
              filters: scopeFilter,
              query: resolvedInvoiceId,
              page: 1,
              perPage: 200,
            });
            const exact = lookup.items.filter(item =>
              normalizeRecordNumber(stringValue(item, 'invoice_number'))
              === normalizeRecordNumber(resolvedInvoiceId));
            if (exact.length !== 1) {
              return ok({
                success: true,
                data: null,
                message: exact.length === 0
                  ? `Invoice number "${resolvedInvoiceId}" was not found`
                  : `Invoice number "${resolvedInvoiceId}" is ambiguous`,
              });
            }
            resolvedInvoiceId = stringValue(exact[0]!, 'invoice_id');
            if (!resolvedInvoiceId) {
              return err(new ToolError({
                toolId: 'zohoBooks',
                reason: 'upstream_failure',
                message: 'Zoho invoice search returned an exact invoice number without an invoice ID',
              }));
            }
          }
          const invoice = await client.getInvoice(resolvedInvoiceId);
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
          return ok(await listBounded('contacts', 'contacts', {
            ...(args.searchQuery ? { query: args.searchQuery } : {}),
            columns: [
              commonColumns.id('Contact ID'),
              { key: 'contact_name', header: 'Contact Name' },
              { key: 'company_name', header: 'Company' },
              { key: 'email', header: 'Email' },
              { key: 'phone', header: 'Phone' },
              { key: 'status', header: 'Status' },
              commonColumns.currency,
              { key: 'outstanding_payable_amount', header: 'Outstanding Payables' },
              { key: 'outstanding_receivable_amount', header: 'Outstanding Receivables' },
            ],
          }));

        case 'get_contact': {
          if (!args.contactId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'contactId required for get_contact' }));
          const contact = await client.getContact(args.contactId);
          if (personalizedScope && !recordMatchesZohoEmail(contact, requesterEmail!)) return ok({ success: true, data: null, message: 'Contact not found' });
          return ok({ success: true, data: formatZohoResult(contact) });
        }

        case 'list_expenses':
          return ok(await listBounded('expenses', 'expenses', {
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
          return ok(await listBounded('bills', 'bills', {
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
          return ok(await listBounded('customerpayments', 'payments', {
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

        case 'list_bank_transactions': {
          const filterError = bankTransactionFilterError(args);
          if (filterError) return err(filterError);
          return ok(await listBounded('banktransactions', 'bank transactions', {
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
        }

        case 'search_transactions': {
          if (!args.searchQuery) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'searchQuery required for search_transactions' }));
          const filterError = bankTransactionFilterError(args);
          if (filterError) return err(filterError);
          return ok(await listBounded('banktransactions', 'transaction search results', {
            filters: dateFilter,
            query: args.searchQuery,
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
