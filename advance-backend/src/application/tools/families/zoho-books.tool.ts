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
 *     list_items            — paginated item/product list
 *     list_taxes            — configured tax rates (GST etc.)
 *     send_invoice          — email an invoice
 *     record_payment        — record a customer payment
 *     create_expense        — create an expense
 *     create_bill           — create a bill
 *     create_contact        — create a customer or vendor
 *     update_invoice        — correct an existing invoice
 *     mark_invoice_sent     — move a draft invoice to sent without emailing it
 *     attach_document       — attach a file from this conversation to an invoice or bill
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
import {
  attachedDocumentNames,
  summarizeZohoWrite,
  unwrapZohoRecord,
  type ZohoWriteModule,
} from '../../zoho/zoho-books-write-result';
import { validateAttachmentPolicy }        from '../../email/attachment-policy';
import { mapZohoError }                    from '../../zoho/zoho-error.utils';
import { formatAmount, formatDate }        from '../../zoho/zoho-format.utils';
import { normalizeStatus, parseDateFilter } from '../../zoho/zoho-filter.utils';
import { handleZohoList, type ZohoListCsvColumn } from '../../zoho/zoho-list-handler';
import type { ZohoBooksPaginatedClient, ZohoBooksModule } from '../../../infrastructure/zoho/zoho-books-paginated.client';
import { getModuleSchema, injectSyntheticFields, toSchemaHint } from '../../../infrastructure/zoho/zoho-books-schema.cache';
import { runInSandbox, SandboxTimeoutError, SandboxScriptError, SandboxInputTooLargeError, SandboxSerializationError } from '../shared/sandbox-runner';
import { filterZohoRecordsByEmail, normalizedEmail, recordMatchesZohoEmail } from '../../../shared/zoho-personalization';
import {
  exportCandidateMetadata,
  publishExportCandidate,
} from '../../data-export/tool-export-candidate';
import {
  dataExportRunRequestId,
} from '../../data-export/export-request-identity';
import { DATA_EXPORT_CSV_ROW_LIMIT } from '../../data-export/data-export-limits';
import { datasetSourceSchema } from '../../data-export/data-export.types';
import type { DataExportOrchestrationService } from '../../data-export/data-export-orchestration.service';
import type { DataExportOfferPayload } from '../../data-export/export-offer';
import {
  createDatasetPreview,
  DATASET_PREVIEW_ROW_LIMIT,
} from '../../data-export/dataset-preview';

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
    'list_items',
    'list_taxes',
    'send_invoice',
    'record_payment',
    'create_expense',
    'create_bill',
    'create_contact',
    'update_invoice',
    'mark_invoice_sent',
    'attach_document',
    'void_invoice',
    // Reports
    'build_overdue_report',
  ]),

  // CRUD params
  invoiceId:      z.string().optional(),
  contactId:      z.string().optional(),
  accountId:      z.string().optional(),
  // attach_document — which record the file belongs on, and which file it is.
  recordType:     z.enum(['invoice', 'bill']).optional(),
  recordId:       z.string().optional(),
  fileName:       z.string().optional(),
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
}).strict();

type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success:      z.boolean(),
  data:         z.unknown().optional(),
  id:           z.string().optional(),
  message:      z.string().optional(),
  /** Zoho web link for a record a write just created or changed. */
  recordUrl:    z.string().optional(),
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
  }).optional(),
  exportCandidate: z.object({
    candidateId: z.string().uuid(),
    sourceKind: z.literal('zoho_books'),
    previewRowCount: z.number().int().nonnegative(),
    estimatedRows: z.number().int().nonnegative().optional(),
    expiresAt: z.string(),
  }).strict().optional(),
});

type Res = z.infer<typeof ResultSchema>;

// ─── Attachment source ────────────────────────────────────────────────────────

/**
 * Resolves a member-named file from the current conversation to its bytes.
 *
 * The model names a file; it never handles the provider key. Resolution is the
 * backend's job precisely so a wrong or invented identifier cannot put someone
 * else's document on a financial record.
 */
export interface ZohoAttachmentSourcePort {
  resolve(input: {
    companyId:       string;
    userId:          string;
    channel:         string;
    conversationKey: string;
    fileName:        string;
  }): Promise<
    | { readonly kind: 'resolved'; readonly fileName: string; readonly mimeType: string; readonly content: Buffer }
    | { readonly kind: 'unavailable'; readonly message: string }
  >;
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
  'list_items',
  'list_taxes',
  'build_overdue_report',
]);

const createOps = new Set<Args['op']>([
  'create_invoice',
  'send_invoice',
  'record_payment',
  'create_expense',
  'create_bill',
  'create_contact',
  'attach_document',
]);

/**
 * Ops that change a record that already exists.
 *
 * Without this set the action ternary below sends everything that is neither a
 * read nor a create to `delete` — so correcting an invoice would demand delete
 * permission, and the tool's declared `update` action group would stay unused.
 */
const updateOps = new Set<Args['op']>([
  'update_invoice',
  'mark_invoice_sent',
]);

const listOpToModule: Record<string, ZohoBooksModule> = {
  list_invoices:         'invoices',
  list_bills:            'bills',
  list_expenses:         'expenses',
  list_payments:         'customerpayments',
  list_contacts:         'contacts',
  list_items:            'items',
  list_bank_transactions: 'banktransactions',
  search_transactions:   'banktransactions',
};

/** Zoho's own module path for a record the member can attach a file to. */
const attachModule = { invoice: 'invoices', bill: 'bills' } as const;

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
  /** Paginated client — every read and every write goes through this one. */
  booksClient:  ZohoBooksPaginatedClient;
  /** Finance ops service for deep report operations. */
  financeOps:   ZohoFinanceOps;
  exportCandidates?: Pick<DataExportOrchestrationService, 'publishCandidate'>;
  inlineThreshold?: number;
  /** Resolves a file the member sent in this conversation. Absent = attachments unavailable. */
  attachmentSource?: ZohoAttachmentSourcePort;
  /** Web base for record links, e.g. https://books.zoho.com or a custom finance domain. */
  appBaseUrl?: string;
}): Tool<Args, Res> => ({
  id:           asToolId('zohoBooks'),
  family:       'zoho',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema:   Schema,
  resultSchema: ResultSchema,

  description: [
    'Access Zoho Books: read, write, and report on invoices, bills, expenses, payments, contacts, items, taxes, bank transactions.',
    'A created invoice is a draft until mark_invoice_sent or send_invoice; report the status the tool returns rather than assuming it was issued.',
    'attach_document puts a file the member sent in this Lark conversation onto an invoice or bill, and verifies it against Zoho documents[].',
    'Plain list operations fetch one bounded page and return only the requested limit.',
    'For custom analysis (grouping, aggregation, ranking), add a `script` parameter to fetch up to 4000 records with pre-converted INR fields (_amount_inr, _balance_inr, _total_inr).',
    'For an exact aggregate that may require more than 4000 records, use a governed backend workflow; do not create a member-facing file from paged script rows.',
    'Use populated _amount_inr/_balance_inr for INR calculations; never infer an original currency when _currency is UNKNOWN.',
    'Set exportAll=true only to publish a replayable export candidate; use dataExport op=plan to choose Sheet, Excel, CSV, destination account, direct queue, or sample-first flow.',
    'Export example: first call {"op":"list_invoices","dateFrom":"2026-07-01","dateTo":"2026-07-31","exportAll":true,"connectionId":"<exact Zoho UUID>"}, then call dataExport op=plan with the returned exportCandidate.candidateId.',
  ].join(' '),

  parameterDocs: [
    'connectionId: exact accessible Zoho UUID. In backend-hosted channels, omit it when only one Zoho account is accessible; the backend resolves that account. If multiple are available, retry with the exact ID returned by the error.',
    'op: list_invoices|get_invoice|create_invoice|update_invoice|mark_invoice_sent|attach_document|list_contacts|get_contact|create_contact|list_expenses|list_bills|list_payments|list_items|list_taxes|get_chart_of_accounts|get_account_balance|list_bank_transactions|search_transactions|get_tax_summary|send_invoice|record_payment|create_expense|create_bill|void_invoice|build_overdue_report',
    'read params: invoiceId, accountId, searchQuery, dateFrom, dateTo, status, taxYear, exportAll, limit (1-100)',
    'get_invoice accepts a Zoho numeric invoice ID or an exact human invoice number. list_invoices forwards searchQuery to Zoho and returns newest invoice dates first.',
    'limit is the requested maximum. Once that many rows are returned, do not fetch more pages or switch to script mode unless the user explicitly asks for an export or an aggregate within script mode’s documented 4,000-record ceiling.',
    'write params: invoiceId, email, fields',
    'create_invoice/update_invoice/create_bill/create_contact/create_expense/record_payment take fields; the tool returns the stored record, its status, and its link. Never restate a status the tool did not return.',
    'create_invoice: supply invoice_number only when the member gave one — the tool then overrides Zoho auto-numbering. Omit it to let Zoho number the invoice.',
    'mark_invoice_sent issues a draft without emailing anyone. send_invoice emails it. They are different acts; do not substitute one for the other.',
    'create_contact only after list_contacts with searchQuery returns no match, and say in the reply that a new contact was created.',
    'attach_document params: recordType (invoice|bill), recordId, fileName — the exact name of a file the member sent in this Lark conversation. Never invent a filename, and never claim an attachment the tool did not confirm.',
    'list_items gives item_id and rate for invoice line_items. list_taxes gives the real tax_id values for GST; never guess a tax rate or tax id.',
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
    'Script results stay bounded inline. For a governed artifact, publish an export candidate with exportAll=true and let dataExport own the destination and queue.',
  ].join('\n'),

  permissionCheck(args, perm) {
    const action: ToolActionGroup = readOps.has(args.op)
      ? 'read'
      : createOps.has(args.op)
        ? 'create'
        : updateOps.has(args.op)
          ? 'update'
          : 'delete';
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
        !deps.exportCandidates
        || ctx.runContext.channel !== 'lark'
        || !ctx.runContext.chatId
        || !args.connectionId
      ) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: 'Governed Zoho exports require an exact connection UUID and a Lark chat so Divo can prepare an export candidate.',
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
        dataExportRunRequestId(ctx.runContext, ctx.correlationId),
      );
      const recipe = datasetSourceSchema.safeParse(payload.source);
      if (!recipe.success) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: `This export cannot be run as asked — ${recipe.error.errors.map(issue => issue.message).join('; ')}`,
        }));
      }
      const candidate = await publishExportCandidate({
        candidates: deps.exportCandidates,
        eligible: true,
        payload: () => payload,
        metadata: exportCandidateMetadata({
          columns: [],
          previewRowCount: 0,
          coverage: { kind: 'unknown', returnedRows: 0 },
        }),
        logger: ctx.logger,
        scope: 'zoho_books',
        correlationId: ctx.correlationId,
      });
      if (candidate.kind !== 'published') {
        return err(new ToolError({
          toolId: 'dataExport',
          reason: 'upstream_failure',
          message: 'Could not prepare a Zoho Books export candidate. Ask Divo to retry.',
        }));
      }
      return ok({
        success: true,
        exportCandidate: {
          candidateId: candidate.candidateId,
          sourceKind: 'zoho_books' as const,
          previewRowCount: 0,
          ...(candidate.estimatedRows === undefined ? {} : { estimatedRows: candidate.estimatedRows }),
          expiresAt: candidate.expiresAt.toISOString(),
        },
        message: 'Zoho Books export candidate is ready. Use dataExport op=plan with this candidate to choose Sheet, Excel, CSV, destination account, direct export, or sample-first review.',
      });
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

    // ── CRUD operations ──────────────────────────────────────────────────────
    const appBaseUrl = deps.appBaseUrl ?? 'https://books.zoho.com';

    /** Single-record GET. Unlike getRecord() this surfaces provider errors
     *  instead of turning an expired token into "not found". */
    const getOne = async (moduleName: ZohoBooksModule, recordId: string) => {
      const payload = await deps.booksClient.getEndpoint({
        companyId,
        ...connectionContext,
        path: `/${moduleName}/${encodeURIComponent(recordId)}`,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
      });
      return unwrapZohoRecord(payload, moduleName);
    };

    const write = async (input: {
      method: 'POST' | 'PUT';
      path:   string;
      params?: Record<string, string>;
      body?:  Record<string, unknown>;
      multipart?: { field: string; fileName: string; mimeType: string; content: Buffer };
    }) => deps.booksClient.mutate({
      companyId,
      userId,
      connectionId: args.connectionId,
      ...(args.organizationId ? { organizationId: args.organizationId } : {}),
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      ...input,
    });

    /**
     * Put a file the member already sent into this conversation onto an invoice
     * or a bill.
     *
     * Re-reads `documents[]` first: Zoho appends rather than replaces, so an
     * unchecked retry silently leaves the same PDF on the record twice.
     */
    const attachDocument = async (): Promise<Result<Res, ToolError>> => {
      if (!args.recordType || !args.recordId || !args.fileName) {
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'bad_args',
          message: 'attach_document needs recordType (invoice or bill), recordId, and the exact fileName the member sent.',
        }));
      }
      if (!deps.attachmentSource || ctx.runContext.channel !== 'lark') {
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'bad_args',
          message: `Divo cannot attach files from the ${ctx.runContext.channel} channel yet — only files sent in Lark. `
            + 'The record itself is unchanged; say the attachment could not be made rather than that it was.',
        }));
      }
      const conversationKey = ctx.runContext.runtimeThreadId ?? ctx.runContext.chatId;
      if (!conversationKey) {
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'bad_args',
          message: 'Divo cannot tell which conversation this file was sent in, so it will not guess at one.',
        }));
      }

      const moduleName = attachModule[args.recordType];
      const before = attachedDocumentNames(await getOne(moduleName, args.recordId));

      const resolved = await deps.attachmentSource.resolve({
        companyId,
        userId,
        channel: ctx.runContext.channel,
        conversationKey,
        fileName: args.fileName,
      });
      if (resolved.kind === 'unavailable') {
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'bad_args', message: resolved.message,
        }));
      }

      if (before.some(name => name.trim().toLowerCase() === resolved.fileName.trim().toLowerCase())) {
        return ok({
          success: true,
          id: args.recordId,
          message: `"${resolved.fileName}" is already attached to this ${args.recordType}. Nothing was uploaded again. Attached: ${before.join(', ')}.`,
        });
      }

      const policy = validateAttachmentPolicy([{
        fileName: resolved.fileName,
        mimeType: resolved.mimeType,
        sizeBytes: resolved.content.length,
        content: resolved.content,
        source: 'lark',
      }]);
      if (!policy.ok) {
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'bad_args', message: policy.error.message,
        }));
      }

      ctx.onProgress?.(`Attaching ${resolved.fileName} to the ${args.recordType}…`);
      await write({
        method: 'POST',
        path: `/${moduleName}/${encodeURIComponent(args.recordId)}/attachment`,
        multipart: {
          field: 'attachment',
          fileName: resolved.fileName,
          mimeType: resolved.mimeType,
          content: resolved.content,
        },
      });

      // Zoho's own record is the only proof the upload landed.
      const after = attachedDocumentNames(await getOne(moduleName, args.recordId));
      const landed = after.some(name => name.trim().toLowerCase() === resolved.fileName.trim().toLowerCase());
      return ok({
        success: landed,
        id: args.recordId,
        message: landed
          ? `Attached "${resolved.fileName}" to the ${args.recordType}. Zoho now lists: ${after.join(', ')}.`
          : `Zoho accepted the upload but does not list "${resolved.fileName}" on the ${args.recordType}. Treat the attachment as unconfirmed.`,
      });
    };

    /** Write, then report what Zoho actually stored rather than that it accepted the call. */
    const writtenRecord = async (
      moduleName: ZohoWriteModule,
      verb: string,
      input: Parameters<typeof write>[0],
    ): Promise<Res> => {
      const { organizationId, payload } = await write(input);
      const record = unwrapZohoRecord(payload, moduleName);
      const summary = summarizeZohoWrite({
        module: moduleName,
        verb,
        record,
        appBaseUrl,
        organizationId,
      });
      return {
        success: true,
        ...(summary.id ? { id: summary.id } : {}),
        data: formatZohoResult(record),
        message: summary.message,
        ...(summary.recordUrl ? { recordUrl: summary.recordUrl } : {}),
      };
    };

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
      const canPublishExportCandidate = args.limit === undefined
        && !personalizedScope
        && deps.exportCandidates !== undefined
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
        suggestExportOnOverflow: canPublishExportCandidate,
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
      const candidate = await publishExportCandidate({
        candidates: deps.exportCandidates,
        eligible: result.suggestExport && canPublishExportCandidate,
        payload: () => exportPayloadFor(
          moduleName,
          dataExportRunRequestId(ctx.runContext, ctx.correlationId),
        ),
        metadata: exportCandidateMetadata({
          columns: formattedItems.length > 0 ? Object.keys(formattedItems[0]!) : [],
          previewRowCount: formattedItems.length,
          estimatedRows: result.coverage.kind === 'complete' ? formattedItems.length : undefined,
          coverage: result.coverage,
        }),
        logger: ctx.logger,
        scope: 'zoho_books',
        correlationId: ctx.correlationId,
      });
      const preview = createDatasetPreview({
        rows: formattedItems,
        coverage: result.coverage,
      });

      return {
        success: true,
        message: candidate.kind === 'published'
          ? `${result.summary} Use dataExport op=plan with the returned export candidate if the member wants a file.`
          : result.summary,
        preview,
        ...(candidate.kind === 'published'
          ? {
              exportCandidate: {
                candidateId: candidate.candidateId,
                sourceKind: 'zoho_books' as const,
                previewRowCount: formattedItems.length,
                ...(candidate.estimatedRows === undefined ? {} : { estimatedRows: candidate.estimatedRows }),
                expiresAt: candidate.expiresAt.toISOString(),
              },
            }
          : {}),
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
          const invoice = await getOne('invoices', resolvedInvoiceId);
          if (personalizedScope && !recordMatchesZohoEmail(invoice, requesterEmail!)) return ok({ success: true, data: null, message: 'Invoice not found' });
          return ok({ success: true, data: formatZohoResult(invoice) });
        }

        case 'create_invoice': {
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for create_invoice' }));
          const fields = args.fields as Record<string, unknown>;
          return ok(await writtenRecord('invoices', 'created', {
            method: 'POST',
            path: '/invoices',
            // Zoho rejects a supplied invoice_number outright while auto-numbering
            // is on, unless this says the member meant to override it.
            ...(typeof fields['invoice_number'] === 'string' && fields['invoice_number'].trim()
              ? { params: { ignore_auto_number_generation: 'true' } }
              : {}),
            body: fields,
          }));
        }

        case 'update_invoice': {
          if (!args.invoiceId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'invoiceId required for update_invoice' }));
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for update_invoice' }));
          return ok(await writtenRecord('invoices', 'updated', {
            method: 'PUT',
            path: `/invoices/${encodeURIComponent(args.invoiceId)}`,
            body: args.fields as Record<string, unknown>,
          }));
        }

        case 'mark_invoice_sent': {
          if (!args.invoiceId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'invoiceId required for mark_invoice_sent' }));
          await write({
            method: 'POST',
            path: `/invoices/${encodeURIComponent(args.invoiceId)}/status/sent`,
          });
          // Zoho's status endpoint answers with a bare code/message, so the
          // record has to be re-read for the reply to describe the real state.
          const invoice = await getOne('invoices', args.invoiceId);
          return ok({
            success: true,
            id: args.invoiceId,
            data: formatZohoResult(invoice),
            message: `Invoice ${stringValue(invoice, 'invoice_number') || args.invoiceId} is now marked sent in Zoho Books. It was not emailed — use send_invoice for that.`,
          });
        }

        case 'send_invoice': {
          if (!args.invoiceId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'invoiceId required for send_invoice' }));
          await write({
            method: 'POST',
            path: `/invoices/${encodeURIComponent(args.invoiceId)}/email`,
            body: args.email ? { to_mail_ids: [args.email] } : {},
          });
          return ok({
            success: true,
            id: args.invoiceId,
            message: args.email
              ? `Invoice emailed to ${args.email}.`
              : 'Invoice emailed to the contacts Zoho holds for this customer.',
          });
        }

        case 'record_payment': {
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for record_payment' }));
          return ok(await writtenRecord('customerpayments', 'recorded', {
            method: 'POST',
            path: '/customerpayments',
            body: args.fields as Record<string, unknown>,
          }));
        }

        case 'create_expense': {
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for create_expense' }));
          return ok(await writtenRecord('expenses', 'created', {
            method: 'POST',
            path: '/expenses',
            body: args.fields as Record<string, unknown>,
          }));
        }

        case 'create_bill': {
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for create_bill' }));
          return ok(await writtenRecord('bills', 'created', {
            method: 'POST',
            path: '/bills',
            body: args.fields as Record<string, unknown>,
          }));
        }

        case 'create_contact': {
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for create_contact' }));
          return ok(await writtenRecord('contacts', 'created', {
            method: 'POST',
            path: '/contacts',
            body: args.fields as Record<string, unknown>,
          }));
        }

        case 'attach_document':
          return attachDocument();

        case 'void_invoice': {
          if (!args.invoiceId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'invoiceId required for void_invoice' }));
          await write({
            method: 'POST',
            path: `/invoices/${encodeURIComponent(args.invoiceId)}/status/void`,
          });
          const voided = await getOne('invoices', args.invoiceId);
          return ok({
            success: true,
            id: args.invoiceId,
            data: formatZohoResult(voided),
            message: `Invoice ${stringValue(voided, 'invoice_number') || args.invoiceId} is now voided in Zoho Books.`,
          });
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
          const contact = await getOne('contacts', args.contactId);
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

        case 'list_items':
          return ok(await listBounded('items', 'items', {
            ...(args.searchQuery ? { query: args.searchQuery } : {}),
            amountKeys: ['rate'],
            columns: [
              commonColumns.id('Item ID'),
              { key: 'name', header: 'Item' },
              { key: 'sku', header: 'SKU' },
              { key: 'rate', header: 'Rate' },
              { key: 'unit', header: 'Unit' },
              { key: 'tax_name', header: 'Tax' },
              { key: 'tax_percentage', header: 'Tax %' },
              commonColumns.currency,
              commonColumns.status,
            ],
          }));

        case 'list_taxes': {
          // Not a module — the configured tax rates live under settings, the
          // same shape as the chart of accounts.
          const data = await deps.booksClient.getEndpoint({
            companyId,
            ...connectionContext,
            path: '/settings/taxes',
            ...(args.organizationId ? { organizationId: args.organizationId } : {}),
          });
          return ok({ success: true, data: formatZohoResult(data['taxes'] ?? data) });
        }

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
