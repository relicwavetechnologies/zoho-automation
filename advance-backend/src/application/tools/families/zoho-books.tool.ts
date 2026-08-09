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
 *   - Complete artifacts page through the governed terminal without entering model context
 */

import { randomUUID } from 'node:crypto';
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
import {
  checkInvoice,
  hasBlockingFinding,
} from '../../zoho/zoho-invoice-checks';
import {
  INVOICE_CLAIM_ABSENT,
  INVOICE_CLAIM_PENDING,
  INVOICE_CLAIM_UNRESOLVED,
  INVOICE_WRITE_CEILING_MS,
  classifyWriteFailure,
  compareStagedToStored,
  describePayloadChange,
  matchStagedInvoice,
  MAX_INVOICE_FIX_ATTEMPTS,
  renderStagedInvoice,
  stagedInvoiceSearchWindow,
  STAGED_INVOICE_TTL_MS,
  type StagedInvoice,
  type StagedInvoiceStore,
} from '../../zoho/zoho-invoice-staging';
import type { InvoiceReviewer } from '../../zoho/zoho-invoice-reviewer';
import { validateAttachmentPolicy }        from '../../email/attachment-policy';
import { WriteNotDispatchedError }         from '../../../shared/errors';
import { mapZohoError }                    from '../../zoho/zoho-error.utils';
import { normalizeInvoiceFields }          from '../../zoho/zoho-invoice-fields';
import { refuseSelfDealing }               from '../../zoho/zoho-self-dealing';
import { formatAmount, formatDate }        from '../../zoho/zoho-format.utils';
import { normalizeStatus, parseDateFilter } from '../../zoho/zoho-filter.utils';
import { handleZohoList, type ZohoListCsvColumn } from '../../zoho/zoho-list-handler';
import type { ZohoBooksPaginatedClient, ZohoBooksModule, ZohoBooksOrganization } from '../../../infrastructure/zoho/zoho-books-paginated.client';
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
    'stage_invoice',
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
  /** Draft produced by stage_invoice. create_invoice replays it rather than re-reading fields. */
  stagingId:      z.string().uuid().optional(),
  /** The draft this staging corrects, when the reviewer sent one back. */
  supersedesStagingId: z.string().uuid().optional(),
  searchQuery:    z.string().optional(),
  email:          z.string().email().optional(),
  fields:         z.record(z.unknown()).optional(),
  limit:          z.number().int().min(1).max(100).optional(),
  page:           z.number().int().min(1).max(20).optional(),
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
  /** Draft identity to hand back to create_invoice once the member agrees. */
  stagingId:    z.string().optional(),
  /** Exactly what to show the member before creating anything. */
  stagedSummary: z.string().optional(),
  review: z.object({
    outcome: z.enum(['pass', 'fail', 'unavailable']),
    reason: z.string(),
    issues: z.array(z.object({
      field: z.string(),
      problem: z.string(),
      suggestedFix: z.string().optional(),
    })),
    unsourced: z.array(z.object({
      field: z.string(),
      value: z.string(),
      note: z.string(),
    })),
    attempt: z.number().int(),
    attemptsRemaining: z.number().int(),
  }).optional(),
  /** Fields Zoho stored differently from what was approved. */
  drift: z.array(z.object({
    field: z.string(),
    staged: z.string(),
    stored: z.string(),
  })).optional(),
  // Report fields (present only for build_overdue_report)
  report:       z.unknown().optional(),
  truncated:    z.boolean().optional(),
  hasMore:      z.boolean().optional(),
  page:         z.number().int().positive().optional(),
  nextPage:     z.number().int().positive().optional(),
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
    companyId: string;
    userId:    string;
    channel:   string;
    chatId:    string;
    fileName:  string;
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
  // Staging writes nothing to Zoho, but it reads what a create would and it is
  // the only route to one, so it carries the same permission.
  'stage_invoice',
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

/**
 * How many candidate invoices a read-back will fetch in full before giving up.
 *
 * One customer's invoices across a three-day window is normally a handful.
 * Beyond this the answer is reported as unknown rather than quietly sampled —
 * a partial search that reports "not found" is the one outcome that must never
 * happen, because it authorises a second real invoice.
 */
const READ_BACK_DETAIL_LIMIT = 25;

/**
 * How many unresolved twins one create will investigate before refusing.
 *
 * Nothing retires an unresolved draft, so a connection that keeps losing
 * responses accumulates them. Reading every one back would put hundreds of
 * Zoho calls inside a single tool call; ignoring the excess would quietly
 * disable the duplicate guard. Refusing says so out loud.
 */
const TWIN_READ_BACK_LIMIT = 5;

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
    value: item => stringValue(item, 'invoice_id', 'bill_id', 'payment_id', 'expense_id', 'contact_id', 'transaction_id', 'item_id', 'id'),
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
  /** Holds invoice drafts between staging and creation. Absent disables staging. */
  invoiceStaging?: StagedInvoiceStore;
  /** Reads a draft cold before the member is shown it. */
  invoiceReviewer?: InvoiceReviewer;
  /** The member's own words, for the reviewer. Never the model's account of them. */
  conversationHistory?: {
    getHistory(chatId: string, limit?: number, scope?: { companyId: string; channel: string }):
      Promise<{ ok: true; value: Array<{ role: string; content: string }> } | { ok: false; error: unknown }>;
  };
  /** Reads the file the member sent, so the reviewer checks the document not a retelling of it. */
  documentParser?: {
    parse(input: { buffer: Buffer; fileName: string; mimeType: string; signal: AbortSignal }):
      Promise<{ units: readonly { text: string }[] }>;
  };
  /** The selling organisation's GST state code, for the IGST-versus-CGST rule. */
  homeGstStateCode?: string;
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
    'For a complete artifact or exact multi-page aggregate, use page/nextPage from one governed local Python file.',
    'Use populated _amount_inr/_balance_inr for INR calculations; never infer an original currency when _currency is UNKNOWN.',
  ].join(' '),

  parameterDocs: [
    'connectionId: exact accessible Zoho UUID. In backend-hosted channels, omit it when only one Zoho account is accessible; the backend resolves that account. If multiple are available, retry with the exact ID returned by the error.',
    'op: list_invoices|get_invoice|create_invoice|update_invoice|mark_invoice_sent|attach_document|list_contacts|get_contact|create_contact|list_expenses|list_bills|list_payments|list_items|list_taxes|get_chart_of_accounts|get_account_balance|list_bank_transactions|search_transactions|get_tax_summary|send_invoice|record_payment|create_expense|create_bill|void_invoice|build_overdue_report',
    'read params: invoiceId, accountId, searchQuery, dateFrom, dateTo, status, taxYear, limit (1-100), page (1-20)',
    'For terminal paging, start with page=1 and continue with nextPage while hasMore=true.',
    'get_invoice accepts a Zoho numeric invoice ID or an exact human invoice number. list_invoices forwards searchQuery to Zoho and returns newest invoice dates first.',
    'limit is the requested maximum. Once that many rows are returned, do not fetch more pages or switch to script mode unless the user explicitly asks for an export or an aggregate within script mode’s documented 4,000-record ceiling.',
    'write params: invoiceId, email, fields',
    'update_invoice/create_bill/create_contact/create_expense/record_payment take fields; the tool returns the stored record, its status, and its link. Never restate a status the tool did not return.',
    'INVOICES ARE STAGED. stage_invoice takes fields (and fileName when a document is the source) and writes nothing to Zoho: it checks the draft, has a reviewer read it cold, and returns stagedSummary plus stagingId. Show the member that summary verbatim, including everything under review.unsourced, and create only once they agree.',
    'create_invoice takes ONLY stagingId. It replays the approved payload, so what the member saw is what Zoho receives. It refuses a draft that failed review, one already created, and one with no stagingId.',
    'When review.outcome is fail, fix the exact fields named in review.issues and call stage_invoice again with supersedesStagingId. review.attemptsRemaining says how many corrections are left; at zero, put the objection to the member instead of re-staging.',
    'stage_invoice: supply invoice_number only when the member gave one — the tool then overrides Zoho auto-numbering. Omit it to let Zoho number the invoice.',
    'payment_terms is a whole number of days, never words: 15 for "Net 15", 0 for due on receipt. The tool records the original wording as payment_terms_label.',
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
    'Script results stay bounded inline. For a complete artifact, page from governed local Python and use the destination specialist.',
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
    /**
     * The organisation being written to, fetched once per call.
     *
     * Memoised because more than one guard wants it and the answer cannot
     * change mid-operation; failure resolves to undefined so that not knowing
     * who we are never blocks a write on its own.
     */
    let sellingOrganizationPromise: Promise<ZohoBooksOrganization | undefined> | null = null;
    const sellingOrganization = (): Promise<ZohoBooksOrganization | undefined> => {
      // try/catch rather than .catch(): a client without this method throws
      // synchronously, before there is a promise to attach a handler to, and
      // that would take down a write the guard was only meant to observe.
      sellingOrganizationPromise ??= (async () => {
        try {
          const orgs = await deps.booksClient.listOrganizations(
            companyId, { userId, connectionId: args.connectionId },
          );
          return args.organizationId
            ? orgs.find(org => org.organizationId === args.organizationId)
            : orgs.find(org => org.isDefault === true) ?? orgs[0];
        } catch {
          return undefined;
        }
      })();
      return sellingOrganizationPromise;
    };

    const getOne = async (
      moduleName: ZohoBooksModule,
      recordId: string,
      destination?: { connectionId: string; organizationId?: string | undefined },
    ) => {
      const organizationId = destination?.organizationId ?? args.organizationId;
      const payload = await deps.booksClient.getEndpoint({
        companyId,
        userId,
        connectionId: destination?.connectionId ?? args.connectionId,
        path: `/${moduleName}/${encodeURIComponent(recordId)}`,
        ...(organizationId ? { organizationId } : {}),
      });
      return unwrapZohoRecord(payload, moduleName);
    };

    const write = async (input: {
      method: 'POST' | 'PUT';
      path:   string;
      params?: Record<string, string>;
      body?:  Record<string, unknown>;
      multipart?: { field: string; fileName: string; mimeType: string; content: Buffer };
      /**
       * Where this write goes, when that is not simply where the call says.
       * A staged invoice was reviewed against one organisation's customers and
       * rates, so it has to be created there and not wherever the confirming
       * call happens to point.
       */
      connectionId?: string;
      organizationId?: string | undefined;
    }) => {
      const { connectionId, organizationId, ...rest } = input;
      const destinationOrg = organizationId ?? args.organizationId;
      return deps.booksClient.mutate({
        companyId,
        userId,
        connectionId: connectionId ?? args.connectionId,
        ...(destinationOrg ? { organizationId: destinationOrg } : {}),
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        ...rest,
      });
    };

    /**
     * Go and look in Zoho for an invoice a draft may already have created.
     *
     * This is the answer to the one question a member cannot be asked. When a
     * create's outcome is lost, the honest options used to be "retry and risk
     * billing twice" or "refuse forever and make someone go hunting". Neither is
     * necessary: Divo holds the same connection Zoho was written through, and
     * can simply read back.
     *
     * Narrowed by customer and a three-day window — both filters Zoho honours —
     * then matched on what the member actually approved. Failure is reported as
     * `unknown`, never as `absent`: a lookup that could not run has not proved
     * the invoice missing, and treating it as proof is how a duplicate gets
     * written with a clean conscience.
     */
    const findInvoiceCreatedFrom = async (
      staged: StagedInvoice,
    ): Promise<
      | { readonly state: 'found'; readonly invoice: Record<string, unknown>; readonly invoiceId: string }
      | { readonly state: 'absent' }
      | { readonly state: 'unknown'; readonly why: string }
    > => {
      const window = stagedInvoiceSearchWindow(staged, ctx.clock.now());
      if (!window) return { state: 'unknown', why: 'the draft names no customer to search by' };

      const destination = {
        connectionId: staged.connectionId,
        ...(staged.organizationId ? { organizationId: staged.organizationId } : {}),
      };

      /**
       * Answer with the full record, never the list row that led to it.
       *
       * A list row has no `line_items` and no `sub_total`, so returning one
       * would report invented drift — "line count was 1, Zoho has 0" — about an
       * invoice that is in fact correct, on the one path whose whole purpose is
       * to be believable.
       */
      const found = async (candidate: Record<string, unknown>) => {
        const invoiceId = typeof candidate['invoice_id'] === 'string' ? candidate['invoice_id'] : '';
        // An invoice with no usable id cannot be settled against, and claiming
        // the draft with an empty marker would make it look unclaimed again.
        if (!invoiceId) return { state: 'unknown' as const, why: 'Zoho returned a matching invoice with no id' };
        // Already a full record — it was matched on fields a list row lacks.
        if (Array.isArray(candidate['line_items'])) {
          return { state: 'found' as const, invoice: candidate, invoiceId };
        }
        try {
          return { state: 'found' as const, invoice: await getOne('invoices', invoiceId, destination), invoiceId };
        } catch (error) {
          return { state: 'unknown' as const, why: mapZohoError(error) };
        }
      };

      let listed: { items: readonly Record<string, unknown>[]; hasMore: boolean };
      try {
        const result = await deps.booksClient.listRecords({
          companyId,
          userId,
          connectionId: staged.connectionId,
          moduleName: 'invoices',
          ...(staged.organizationId ? { organizationId: staged.organizationId } : {}),
          filters: {
            customer_id: window.customerId,
            date_start:  window.dateStart,
            date_end:    window.dateEnd,
          },
          perPage: 200,
          ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        });
        listed = { items: result.items, hasMore: result.hasMore };
      } catch (error) {
        return { state: 'unknown', why: mapZohoError(error) };
      }

      // A page that does not contain everything cannot rule anything out, and
      // `absent` is the single answer that authorises a second real invoice.
      if (listed.hasMore) {
        return { state: 'unknown', why: 'this customer has more invoices in that period than Divo could read in one pass' };
      }

      // Only invoices that could have come from *this* dispatch.
      //
      // Bounded at both ends, and anchored on when the write actually went out.
      // A recurring charge — same customer, same amount, same lines — matches
      // this draft perfectly whether it was billed last month or next month,
      // so a one-sided bound still lets the wrong invoice answer the question.
      // Too early, and last month's invoice reports a write that never landed
      // as a success. Too late, and *next* month's legitimate invoice gets
      // claimed by a months-old orphaned draft, which then refuses to bill it.
      //
      // A response is lost within seconds; nothing created a ceiling later than
      // the dispatch can have come from it. A candidate whose age cannot be
      // read is kept rather than dropped, and the full record settles it.
      const dispatchAt = (staged.claimedAt ?? staged.createdAt)?.getTime();
      const candidates = dispatchAt === undefined ? [...listed.items] : listed.items.filter(item => {
        const created = typeof item['created_time'] === 'string' ? Date.parse(item['created_time']) : NaN;
        if (Number.isNaN(created)) return true;
        // A minute of slack below: Zoho stamps in the organisation's zone and clocks drift.
        return created >= dispatchAt - 60_000
          && created <= dispatchAt + INVOICE_WRITE_CEILING_MS;
      });

      // Zoho's list rows carry `total` but neither `sub_total` nor
      // `line_items`, so a draft that let Zoho assign the number cannot be
      // decided from them. Those candidates are fetched in full rather than
      // being written off — a list row that cannot answer the question is not
      // the same as an invoice that is not there.
      const undecided: Record<string, unknown>[] = [];
      for (const candidate of candidates) {
        const verdict = matchStagedInvoice(staged, candidate);
        if (verdict === 'match') return found(candidate);
        if (verdict === 'undecidable') undecided.push(candidate);
      }

      for (const candidate of undecided.slice(0, READ_BACK_DETAIL_LIMIT)) {
        const id = typeof candidate['invoice_id'] === 'string' ? candidate['invoice_id'] : '';
        if (!id) return { state: 'unknown', why: 'Zoho listed an invoice with no id to fetch' };
        let detail: Record<string, unknown>;
        try {
          detail = await getOne('invoices', id, destination);
        } catch (error) {
          return { state: 'unknown', why: mapZohoError(error) };
        }
        const verdict = matchStagedInvoice(staged, detail);
        if (verdict === 'match') return found(detail);
        // Still undecidable with the full record in hand: something is missing
        // that this cannot reason about, and guessing "absent" here is what
        // authorises a duplicate.
        if (verdict === 'undecidable') {
          return { state: 'unknown', why: 'an invoice in Zoho could not be compared against the draft' };
        }
      }

      if (undecided.length > READ_BACK_DETAIL_LIMIT) {
        return {
          state: 'unknown',
          why: `there were more invoices for this customer than Divo could check one by one (${undecided.length})`,
        };
      }
      return { state: 'absent' };
    };

    /**
     * Put a named file from this conversation onto a record that already exists.
     *
     * Shared by attach_document and by invoice creation, so a file the member
     * approved as part of a draft lands the same way and is proved the same way
     * as one they asked for directly.
     *
     * Never throws: by the time this runs the record exists, and losing the
     * attachment must not be reported as losing the invoice.
     */
    const attachFileToRecord = async (input: {
      recordType: 'invoice' | 'bill';
      recordId:   string;
      fileName:   string;
      destination?: { connectionId: string; organizationId?: string | undefined };
    }): Promise<{ outcome: 'attached' | 'unconfirmed' | 'refused'; message: string }> => {
      const { recordType, recordId, fileName } = input;
      if (!deps.attachmentSource || ctx.runContext.channel !== 'lark') {
        return {
          outcome: 'refused',
          message: `Divo cannot attach files from the ${ctx.runContext.channel} channel yet — only files sent in Lark.`,
        };
      }
      const chatId = ctx.runContext.chatId;
      if (!chatId) {
        return { outcome: 'refused', message: 'Divo cannot tell which conversation this file was sent in, so it will not guess at one.' };
      }

      const moduleName = attachModule[recordType];
      const readDocuments = async () => {
        try {
          return attachedDocumentNames(await getOne(moduleName, recordId, input.destination));
        } catch {
          return null;
        }
      };
      const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

      // Zoho appends rather than replaces, so an unchecked retry leaves the same
      // PDF on the record twice.
      const before = await readDocuments();
      if (before?.some(name => sameName(name, fileName))) {
        return { outcome: 'attached', message: `"${fileName}" was already attached; it was not uploaded again.` };
      }

      const resolved = await deps.attachmentSource.resolve({
        companyId, userId, channel: ctx.runContext.channel, chatId, fileName,
      });
      if (resolved.kind === 'unavailable') return { outcome: 'refused', message: resolved.message };

      const policy = validateAttachmentPolicy([{
        fileName: resolved.fileName,
        mimeType: resolved.mimeType,
        sizeBytes: resolved.content.length,
        content: resolved.content,
        source: 'lark',
      }]);
      if (!policy.ok) return { outcome: 'refused', message: policy.error.message };

      ctx.onProgress?.(`Attaching ${resolved.fileName} to the ${recordType}…`);
      try {
        await write({
          method: 'POST',
          path: `/${moduleName}/${encodeURIComponent(recordId)}/attachment`,
          ...(input.destination
            ? {
                connectionId: input.destination.connectionId,
                ...(input.destination.organizationId ? { organizationId: input.destination.organizationId } : {}),
              }
            : {}),
          multipart: {
            field: 'attachment',
            fileName: resolved.fileName,
            mimeType: resolved.mimeType,
            content: resolved.content,
          },
        });
      } catch (error) {
        // A dispatched upload that then failed may still have landed, so this
        // cannot claim the record is untouched.
        return error instanceof WriteNotDispatchedError
          ? { outcome: 'refused', message: `The upload was never sent: ${error.message}` }
          : { outcome: 'unconfirmed', message: `Zoho did not accept the upload cleanly: ${mapZohoError(error)}` };
      }

      // Zoho's own record is the only proof the upload landed.
      const after = await readDocuments();
      if (after === null) {
        return { outcome: 'unconfirmed', message: `Zoho accepted "${resolved.fileName}" but the record could not be re-read, so the attachment is unconfirmed.` };
      }
      return after.some(name => sameName(name, resolved.fileName))
        ? { outcome: 'attached', message: `Attached "${resolved.fileName}". Zoho now lists: ${after.join(', ')}.` }
        : { outcome: 'unconfirmed', message: `Zoho accepted the upload but does not list "${resolved.fileName}" on the ${recordType}. Treat the attachment as unconfirmed.` };
    };

    const attachDocument = async (): Promise<Result<Res, ToolError>> => {
      if (!args.recordType || !args.recordId || !args.fileName) {
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'bad_args',
          message: 'attach_document needs recordType (invoice or bill), recordId, and the exact fileName the member sent.',
        }));
      }
      const outcome = await attachFileToRecord({
        recordType: args.recordType,
        recordId: args.recordId,
        fileName: args.fileName,
      });
      if (outcome.outcome === 'refused') {
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'bad_args',
          message: `${outcome.message} The ${args.recordType} itself is unchanged — say the attachment could not be made rather than that it was.`,
        }));
      }
      return ok({
        success: outcome.outcome === 'attached',
        id: args.recordId,
        message: outcome.outcome === 'attached'
          ? outcome.message
          : `${outcome.message} Do not upload it again — check the ${args.recordType} in Zoho first, or the same file may end up on it twice.`,
      });
    };

    /**
     * Assemble everything the reviewer is allowed to see, gathering it from the
     * providers rather than from the caller. A model that searched badly hands
     * over a tidy list, and a reviewer reading that list is reassured by exactly
     * the mistake it exists to catch.
     */
    const gatherReviewSources = async (payload: Record<string, unknown>) => {
      // Resolved once, then given to every lookup below.
      //
      // Each of these calls used to resolve the organisation independently, so
      // the customer could be read from one and the duplicate check run against
      // another — and the organisation pinned on the draft came from whichever
      // single call happened to report one, silently becoming "unpinned" when
      // that call failed. A draft created in an organisation it was not judged
      // against posts ids that mean something else there.
      //
      // Listed even when the caller named an organisation, because the state it
      // sells from decides whether a sale is IGST or CGST/SGST, and only the
      // organisation record knows it.
      const organizations = await deps.booksClient
        .listOrganizations(companyId, { userId, connectionId: args.connectionId })
        .catch(() => []);
      const chosenOrg = args.organizationId
        ? organizations.find(org => org.organizationId === args.organizationId)
        : (organizations.find(org => org.isDefault === true) ?? organizations[0]);
      const reviewOrg = args.organizationId ?? chosenOrg?.organizationId;
      const orgScope = reviewOrg ? { organizationId: reviewOrg } : {};

      const customerId = typeof payload['customer_id'] === 'string' ? payload['customer_id'] : '';
      const customerName = typeof payload['customer_name'] === 'string' ? payload['customer_name'] : '';
      // Only when the member supplied a number. Creating with one tells Zoho to
      // stand its own numbering down, so this is the one path where a repeat can
      // reach the books — and the only place to catch it is before it does.
      const invoiceNumber = typeof payload['invoice_number'] === 'string' ? payload['invoice_number'].trim() : '';

      const [chosenCustomer, otherMatches, taxes, items, sameNumber] = await Promise.all([
        customerId
          ? getOne('contacts', customerId, { connectionId: args.connectionId, ...orgScope })
            .catch(() => undefined)
          : Promise.resolve(undefined),
        // Divo's own search, not the one the builder reports having done.
        customerName
          ? deps.booksClient.listRecords({
              companyId, ...connectionContext, moduleName: 'contacts', ...orgScope,
              filters: {}, query: customerName, perPage: 10,
            }).then(result => result.items).catch(() => [])
          : Promise.resolve([]),
        deps.booksClient.getEndpoint({
          companyId, ...connectionContext, path: '/settings/taxes', ...orgScope,
        }).then(data => Array.isArray(data['taxes']) ? data['taxes'] as Record<string, unknown>[] : [])
          .catch(() => []),
        deps.booksClient.listRecords({
          companyId, ...connectionContext, moduleName: 'items', ...orgScope,
          filters: {}, perPage: 50,
        }).then(result => result.items).catch(() => [] as Record<string, unknown>[]),
        invoiceNumber
          ? deps.booksClient.listRecords({
              companyId, ...connectionContext, moduleName: 'invoices', ...orgScope,
              // The exact filter, not free-text search: a number like
              // EMI/2026/114 is not something a text match can be trusted with,
              // and a silent miss here reads as "no duplicate".
              filters: { invoice_number: invoiceNumber }, perPage: 25,
            }).then(result => ({ items: result.items, ran: true }))
              // An empty list and a failed lookup are not the same answer. The
              // other gathers here degrade into less context for the reviewer;
              // this one would degrade into a silent "that number is free" on
              // the single path where Zoho's own numbering is switched off.
              .catch(() => ({ items: [] as Record<string, unknown>[], ran: false }))
          : Promise.resolve({ items: [] as Record<string, unknown>[], ran: true }),
      ]);

      return {
        ...(chosenCustomer ? { chosenCustomer } : {}),
        otherCustomerMatches: otherMatches.filter(record =>
          String(record['contact_id'] ?? '') !== customerId),
        availableTaxes: taxes,
        catalogueItems: items,
        // The organisation these customers, items and taxes were actually read
        // from. A connection can expose several with no default flag, and which
        // one a later call resolves to is Zoho's response order, not a contract
        // — so the draft has to carry the one it was judged against.
        reviewedOrganizationId: reviewOrg,
        // The selling state that organisation trades from, in the spelling
        // `place_of_supply` uses, so the GST direction rule has a home to
        // compare against instead of a deployment-wide constant that can only
        // ever be right for one organisation on the connection.
        reviewedOrganizationStateCode: chosenOrg?.stateCode,
        // Zoho's own inter/intra classification per tax id. A draft carries ids,
        // not names, so without this the GST direction rules see no tax at all.
        taxDirectionById: Object.fromEntries(
          taxes.flatMap(tax => {
            const id = String(tax['tax_id'] ?? '');
            const spec = String(tax['tax_specification'] ?? '').toLowerCase();
            return id && (spec === 'inter' || spec === 'intra')
              ? [[id, spec] as const]
              : [];
          }),
        ),
        // Zoho's search is broad; the duplicate rule wants exact matches only.
        sameNumberInvoices: sameNumber.items.filter(record =>
          String(record['invoice_number'] ?? '').trim().toLowerCase() === invoiceNumber.toLowerCase()),
        duplicateCheckUnavailable: !sameNumber.ran,
      };
    };

    /** The member's own words, and the questions Divo put to them. Never Divo's summaries. */
    const gatherTurns = async () => {
      const threadId = ctx.runContext.runtimeThreadId ?? ctx.runContext.chatId;
      if (!deps.conversationHistory || !threadId) return [];
      const history = await deps.conversationHistory.getHistory(threadId, 30, {
        companyId, channel: ctx.runContext.channel,
      }).catch(() => null);
      if (!history?.ok) return [];
      return history.value
        .filter(turn => turn.role === 'user' || (turn.role === 'assistant' && turn.content.includes('?')))
        .map(turn => ({
          role: turn.role === 'user' ? 'member' as const : 'divo' as const,
          content: turn.content,
        }));
    };

    /** The document the member sent, read here rather than taken on trust. */
    const gatherDocument = async (fileName: string | undefined) => {
      if (!fileName || !deps.documentParser || !deps.attachmentSource) return undefined;
      if (ctx.runContext.channel !== 'lark' || !ctx.runContext.chatId) return undefined;
      const resolved = await deps.attachmentSource.resolve({
        companyId, userId, channel: ctx.runContext.channel,
        chatId: ctx.runContext.chatId, fileName,
      }).catch(() => null);
      if (!resolved || resolved.kind !== 'resolved') return undefined;
      const parsed = await deps.documentParser.parse({
        buffer: resolved.content,
        fileName: resolved.fileName,
        mimeType: resolved.mimeType,
        signal: ctx.abortSignal ?? AbortSignal.timeout(30_000),
      }).catch(() => null);
      if (!parsed) return undefined;
      const text = parsed.units.map(unit => unit.text).join('\n\n').trim();
      return text ? { fileName: resolved.fileName, text } : undefined;
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
        && args.page === undefined
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
        ...(args.page !== undefined ? { page: args.page } : {}),
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
        page: result.page,
        ...(result.hasMore && result.page < 20 ? { nextPage: result.page + 1 } : {}),
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

        case 'stage_invoice': {
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for stage_invoice' }));
          if (!deps.invoiceStaging || !deps.invoiceReviewer) {
            return err(new ToolError({
              toolId: 'zohoBooks', reason: 'bad_args',
              message: 'Invoice staging is not configured on this deployment, so an invoice cannot be prepared for review.',
            }));
          }
          // Translated before anything reads it, so the draft that is checked,
          // reviewed, summarised and later replayed is the one Zoho will accept
          // — not a payload that passes every check here and is refused there.
          const normalized = normalizeInvoiceFields(args.fields as Record<string, unknown>);
          if (!normalized.ok) {
            return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: normalized.message }));
          }
          const payload = normalized.fields;

          const previous = args.supersedesStagingId
            ? await deps.invoiceStaging.get({ stagingId: args.supersedesStagingId, companyId, userId })
            : null;
          const attempt = (previous?.attempt ?? 0) + 1;

          ctx.onProgress?.('Checking the draft invoice…');
          const [sources, turns, sourceDocument] = await Promise.all([
            gatherReviewSources(payload),
            gatherTurns(),
            gatherDocument(args.fileName),
          ]);

          // After the lookup, not before: the duplicate rule can only fire on
          // invoices Divo actually went and found.
          const {
            sameNumberInvoices, reviewedOrganizationId, duplicateCheckUnavailable,
            reviewedOrganizationStateCode, taxDirectionById, ...reviewSources
          } = sources;

          // Refused here, before the reviewer runs. An unpinned draft is one
          // that could be created somewhere it was never judged, and finding
          // that out after a model call has already been spent helps nobody.
          if (!reviewedOrganizationId) {
            return err(new ToolError({
              toolId: 'zohoBooks', reason: 'upstream_failure',
              message: 'Divo could not work out which Zoho organisation to prepare this invoice for, '
                + 'so it will not stage one that might be created in the wrong set of books. Try again.',
            }));
          }
          // The organisation being sold from decides the GST direction, so its
          // state wins over the configured default; the default remains for a
          // connection whose organisation record carries no state.
          const homeState = reviewedOrganizationStateCode ?? deps.homeGstStateCode;
          const findings = checkInvoice({
            invoice: payload,
            ...(homeState ? { homeGstStateCode: homeState } : {}),
            taxDirectionById,
            sameNumberInvoices,
            duplicateCheckUnavailable,
          });

          const customerName = typeof reviewSources.chosenCustomer?.['contact_name'] === 'string'
            ? reviewSources.chosenCustomer['contact_name'] as string
            : undefined;
          const summary = [
            renderStagedInvoice({
              payload,
              ...(customerName ? { customerName } : {}),
              findings,
              ...(args.fileName ? { attachFileName: args.fileName } : {}),
            }),
            // Anything the tool re-read on the member's behalf belongs in the
            // text they approve. A translation nobody is shown is a silent
            // change to what they are agreeing to.
            ...(normalized.notes.length > 0
              ? ['', `Divo read: ${normalized.notes.join('; ')}.`]
              : []),
          ].join('\n');

          ctx.onProgress?.('Reviewing the draft…');
          const review = await deps.invoiceReviewer.review({
            turns,
            stagedSummary: summary,
            ...reviewSources,
            ...(sourceDocument ? { sourceDocument } : {}),
            findings,
            ...(previous
              ? { changedSincePrevious: describePayloadChange(previous.payload, payload) }
              : {}),
          });

          const stagingId = randomUUID();
          await deps.invoiceStaging.put({
            stagingId, companyId, userId,
            connectionId: args.connectionId,
            // Pinned, not copied from the arguments: the model is told to omit
            // organizationId, and leaving it unset here is what let a draft be
            // reviewed in one organisation and created in another.
            organizationId: reviewedOrganizationId,
            payload, summary,
            ...(args.fileName ? { attachFileName: args.fileName } : {}),
            findings, review, attempt,
            ...(args.supersedesStagingId ? { supersedesId: args.supersedesStagingId } : {}),
            expiresAt: new Date(ctx.clock.now().getTime() + STAGED_INVOICE_TTL_MS),
          });

          const attemptsRemaining = Math.max(0, MAX_INVOICE_FIX_ATTEMPTS - (attempt - 1));
          const blocked = hasBlockingFinding(findings) || review.outcome === 'fail';
          return ok({
            success: !blocked,
            stagingId,
            stagedSummary: summary,
            review: {
              outcome: review.outcome,
              reason: review.reason,
              issues: [...review.issues],
              unsourced: [...review.unsourced],
              attempt,
              attemptsRemaining,
            },
            message: blocked
              ? `This draft is not ready. ${review.reason} Nothing has been created. Correct it and call stage_invoice again with supersedesStagingId, or ask the member about what could not be resolved.`
              : `Draft ready — nothing has been created yet. Show the member this summary exactly as written, including anything listed as unconfirmed, and create it only once they agree. Then call create_invoice with stagingId "${stagingId}".`,
          });
        }

        case 'create_invoice': {
          if (!args.stagingId) {
            return err(new ToolError({
              toolId: 'zohoBooks', reason: 'bad_args',
              message: 'create_invoice needs a stagingId. Call stage_invoice first, show the member the summary it returns, and create only what they agreed to.',
            }));
          }
          if (!deps.invoiceStaging) {
            return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'Invoice staging is not configured on this deployment.' }));
          }
          const staged = await deps.invoiceStaging.get({ stagingId: args.stagingId, companyId, userId });
          if (!staged) {
            return err(new ToolError({
              toolId: 'zohoBooks', reason: 'bad_args',
              message: 'That draft is unknown or has expired. Stage the invoice again and show the member the fresh summary.',
            }));
          }
          if (staged.expiresAt.getTime() <= ctx.clock.now().getTime()) {
            return err(new ToolError({
              toolId: 'zohoBooks', reason: 'bad_args',
              message: 'That draft has expired. Stage it again so the member confirms current figures.',
            }));
          }
          if (hasBlockingFinding(staged.findings) || staged.review.outcome === 'fail') {
            return err(new ToolError({
              toolId: 'zohoBooks', reason: 'bad_args',
              message: `This draft did not pass review, so it will not be created: ${staged.review.reason} Correct it with stage_invoice and supersedesStagingId.`,
            }));
          }

          // The draft was checked against one organisation's customers, items
          // and taxes. Creating it anywhere else would post ids that mean
          // something different there, and the drift check cannot catch it:
          // Zoho echoes back the customer_id it was sent, so the comparison
          // passes while the invoice names the wrong customer entirely.
          if (args.connectionId !== staged.connectionId) {
            return err(new ToolError({
              toolId: 'zohoBooks', reason: 'bad_args',
              message: 'This draft was prepared for a different Zoho account than the one this call names. '
                + 'Create it with the account it was staged against, or stage it again for this one.',
            }));
          }
          if (args.organizationId && args.organizationId !== staged.organizationId) {
            return err(new ToolError({
              toolId: 'zohoBooks', reason: 'bad_args',
              message: 'This draft was prepared for a different Zoho organisation than the one this call names. '
                + 'Create it in the organisation it was staged against, or stage it again for this one.',
            }));
          }

          // ── The same invoice, staged again ───────────────────────────────────
          // The claim above protects a draft. This protects the work. A member
          // told "that may or may not have gone through" asks for it again, the
          // model stages a fresh draft, and that draft carries no claim at all —
          // so every guard so far would wave it through into a second real
          // invoice. Asking the member does not help: they were just told the
          // last attempt had a problem, so they approve it believing nothing was
          // created, and their confirmation becomes the thing that bills twice.
          //
          // Keyed on the store rather than on supersedesStagingId, because a
          // model that omitted that argument is exactly the case this defends.
          const unresolved = await deps.invoiceStaging.findUnresolved({
            companyId, connectionId: staged.connectionId,
          });
          const staleBefore = ctx.clock.now().getTime() - INVOICE_WRITE_CEILING_MS;
          // 'undecidable' counts as a twin. Two drafts this code cannot tell
          // apart are exactly the pair it must not let through.
          const twins = unresolved.filter(earlier =>
            earlier.stagingId !== staged.stagingId
            && matchStagedInvoice(earlier, staged.payload) !== 'no');

          // Each twin costs a search and possibly a fetch per candidate. Past a
          // handful, something is wrong with this connection and grinding
          // through them all would be worse than saying so.
          if (twins.length > TWIN_READ_BACK_LIMIT) {
            return err(new ToolError({
              toolId: 'zohoBooks', reason: 'upstream_failure',
              message: `There are ${twins.length} earlier attempts at this same invoice whose outcome was never established, `
                + 'which is too many for Divo to check one by one. It will not create another until that is sorted out. '
                + 'Ask someone to look at this customer\'s invoices in Zoho.',
            }));
          }

          for (const earlier of twins) {

            // A twin whose create is still running cannot be read back: the
            // search would race the write and find nothing simply because the
            // write has not finished. Refuse and let it settle.
            const held = earlier.createdInvoiceId ?? '';
            if (held.startsWith(INVOICE_CLAIM_PENDING)
              && (earlier.claimedAt?.getTime() ?? 0) >= staleBefore) {
              return err(new ToolError({
                toolId: 'zohoBooks', reason: 'bad_args',
                message: 'This same invoice is being sent to Zoho right now by an earlier attempt. '
                  + 'Creating it again would bill the customer twice, so it will not be created. '
                  + 'Wait for that attempt to finish, then check Zoho before trying anything else.',
              }));
            }

            // An unresolved twin exists. Whether it reached Zoho is knowable —
            // so settle it by looking, not by asking someone to remember.
            const readBack = await findInvoiceCreatedFrom(earlier);
            if (readBack.state === 'found') {
              await deps.invoiceStaging.settle({
                stagingId: earlier.stagingId, companyId, invoiceId: readBack.invoiceId,
              });
              return err(new ToolError({
                toolId: 'zohoBooks', reason: 'bad_args',
                message: 'An earlier attempt at this same invoice did reach Zoho after all — it exists as invoice '
                  + `${String(readBack.invoice['invoice_number'] ?? readBack.invoiceId)}. This draft will not be created, `
                  + 'because it would bill the customer a second time. Show the member the existing invoice; '
                  + 'use update_invoice if it needs correcting.',
              }));
            }
            if (readBack.state === 'unknown') {
              return err(new ToolError({
                toolId: 'zohoBooks', reason: 'upstream_failure',
                message: `An earlier attempt at this same invoice never reported back, and Divo cannot check whether it exists (${readBack.why}). `
                  + 'Creating this draft could bill the customer twice, so it will not be created. '
                  + 'Ask the member to look in Zoho, and try again once the connection is working.',
              }));
            }
            // 'absent': the search ran and found nothing. That is real evidence
            // the earlier attempt never landed, so this one may proceed — and
            // the stale draft is retired so it stops blocking every future one.
            //
            // Conditional on the marker it was holding, so this cannot overwrite
            // a claim taken since. The rule it establishes: once a search has
            // concluded, only a settled invoice id supersedes it — that draft's
            // own request, if it ever reports back, will find its marker gone
            // and change nothing. Conservative on purpose; the member re-stages
            // rather than being told two different stories about one draft.
            await deps.invoiceStaging.markAbsent({
              stagingId: earlier.stagingId, companyId,
              marker: earlier.createdInvoiceId ?? '',
              absent: `${INVOICE_CLAIM_ABSENT}${ctx.correlationId}`,
            });
          }

          // Claimed before the call, not after: Zoho has no idempotency key, so a
          // create that succeeds and then times out would otherwise be retried
          // into a second real invoice.
          const marker = `${INVOICE_CLAIM_PENDING}${ctx.correlationId}`;
          const claim = await deps.invoiceStaging.claim({ stagingId: staged.stagingId, companyId, marker });
          if (!claim.claimed) {
            return err(new ToolError({
              toolId: 'zohoBooks', reason: 'bad_args',
              message: claim.heldBy?.startsWith(INVOICE_CLAIM_PENDING)
                ? 'This draft is already being sent to Zoho. Do not send it again — check Zoho for the invoice before retrying.'
                : claim.heldBy?.startsWith(INVOICE_CLAIM_UNRESOLVED)
                  ? 'An earlier attempt to create this invoice never reported back, so it may already exist in Zoho. '
                    + 'Divo will not send it again. Check Zoho for this invoice and tell the member what you find.'
                  : claim.heldBy?.startsWith(INVOICE_CLAIM_ABSENT)
                    ? 'This draft was already sent to Zoho once. The invoice could not be found afterwards, so it was most '
                      + 'likely never created — but this draft is spent either way. Stage it again if the member confirms it is missing.'
                    : `This draft was already created as invoice ${claim.heldBy}. It will not be created twice.`,
            }));
          }

          let created: Res;
          /** Set when the invoice was recovered by reading back rather than returned. */
          let recoveryNote = '';
          try {
            const invoiceNumber = staged.payload['invoice_number'];
            created = await writtenRecord('invoices', 'created', {
              method: 'POST',
              path: '/invoices',
              connectionId: staged.connectionId,
              ...(staged.organizationId ? { organizationId: staged.organizationId } : {}),
              // Zoho rejects a supplied invoice_number outright while auto-numbering
              // is on, unless this says the member meant to override it.
              ...(typeof invoiceNumber === 'string' && invoiceNumber.trim()
                ? { params: { ignore_auto_number_generation: 'true' } }
                : {}),
              body: staged.payload,
            });
          } catch (error) {
            // Three outcomes, not two. A request that never left, and one Zoho
            // read and refused, both prove the books are untouched — the draft
            // goes back and the member is told exactly what was wrong with it.
            const failure = classifyWriteFailure(error);
            if (failure.kind !== 'unknown') {
              await deps.invoiceStaging.release({ stagingId: staged.stagingId, companyId, marker });
              throw error;
            }

            // The answer was lost. Rather than making the member go and look,
            // Divo looks — through the same connection the write went down.
            const readBack = await findInvoiceCreatedFrom(staged);
            if (readBack.state === 'found') {
              // Recovered, not special. It falls through to the same
              // finalisation an ordinary create runs, so the file the member
              // approved is still attached and what Zoho stored is still
              // compared against what they agreed to.
              const summary = summarizeZohoWrite({
                module: 'invoices', verb: 'created',
                record: readBack.invoice, appBaseUrl,
                ...(staged.organizationId ? { organizationId: staged.organizationId } : {}),
              });
              created = {
                success: true,
                id: readBack.invoiceId,
                data: formatZohoResult(readBack.invoice),
                ...(summary.recordUrl ? { recordUrl: summary.recordUrl } : {}),
                message: summary.message,
              } as Res;
              recoveryNote = `${failure.why}, so Divo checked Zoho: the invoice was created. `;
            } else {
            // Recorded as what it is. Storing an 'absent' verdict as "never
            // reported back" would have a later retry told the opposite of what
            // this reply just said. It also takes the draft out of future twin
            // scans, which is the same trade the twin loop makes: a search that
            // ran and found nothing is evidence, and evidence is allowed to
            // settle the question.
            if (readBack.state === 'absent') {
              await deps.invoiceStaging.markAbsent({
                stagingId: staged.stagingId, companyId, marker,
                absent: `${INVOICE_CLAIM_ABSENT}${ctx.correlationId}`,
              });
            } else {
              await deps.invoiceStaging.markUnresolved({
                stagingId: staged.stagingId, companyId, marker,
                unresolved: `${INVOICE_CLAIM_UNRESOLVED}${ctx.correlationId}`,
              });
            }
            return err(new ToolError({
              toolId: 'zohoBooks', reason: 'upstream_failure', cause: error,
              message: readBack.state === 'absent'
                ? `${mapZohoError(error)} ${failure.why}. Divo then searched Zoho for this invoice and did not find it, `
                  + 'so it most likely was not created — but that search cannot be certain, and this draft will not be sent again. '
                  + 'Tell the member what happened and stage it afresh only if they confirm it is missing.'
                : `${mapZohoError(error)} ${failure.why}. Divo tried to check Zoho and could not (${readBack.why}), `
                  + 'so whether the invoice exists is genuinely unknown. It will not send this draft again. '
                  + 'Check Zoho for it and tell the member what you find.',
            }));
            }
          }

          const invoiceId = created.id ?? '';
          await deps.invoiceStaging.settle({ stagingId: staged.stagingId, companyId, invoiceId });

          // The summary the member approved said this file would be on it.
          let attachmentNote = '';
          if (staged.attachFileName && invoiceId) {
            const outcome = await attachFileToRecord({
              recordType: 'invoice',
              recordId: invoiceId,
              fileName: staged.attachFileName,
              destination: {
                connectionId: staged.connectionId,
                ...(staged.organizationId ? { organizationId: staged.organizationId } : {}),
              },
            });
            attachmentNote = outcome.outcome === 'attached'
              ? ` ${outcome.message}`
              : outcome.outcome === 'refused'
                ? ` The invoice exists, but the file the member approved was never uploaded: ${outcome.message}`
                  + ' Say so; attach_document can still put it on once the cause is fixed.'
                : ` The invoice exists, but the file the member approved is not confirmed on it: ${outcome.message}`
                  + ' Say so rather than leaving them to assume it was attached, and do not retry the upload blind.';
          }

          // Staging cannot see what Zoho does on the way in. This can.
          const stored = isRecord(created.data) ? created.data : {};
          const drift = compareStagedToStored(staged.payload, stored);
          const base = drift.length > 0
            ? `${created.message} Zoho stored some values differently from the draft the member approved: `
              + `${drift.map(d => `${d.field} was ${d.staged}, Zoho has ${d.stored}`).join('; ')}. Tell them before doing anything else with it.`
            : created.message ?? 'Invoice created.';
          return ok({
            ...created,
            ...(drift.length > 0 ? { drift } : {}),
            message: `${recoveryNote}${base}${attachmentNote}`,
          });
        }

        case 'update_invoice': {
          if (!args.invoiceId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'invoiceId required for update_invoice' }));
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for update_invoice' }));
          // A correction carries the same wording risk as the original draft.
          const updates = normalizeInvoiceFields(args.fields as Record<string, unknown>);
          if (!updates.ok) {
            return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: updates.message }));
          }
          const updated = await writtenRecord('invoices', 'updated', {
            method: 'PUT',
            path: `/invoices/${encodeURIComponent(args.invoiceId)}`,
            body: updates.fields,
          });
          // This path has no staging, no summary and no approval text, so it is
          // the one where a silent translation would go furthest unseen — the
          // write has already happened by the time anybody reads the reply.
          return ok(updates.notes.length > 0
            ? { ...updated, message: `${updated.message} Divo read: ${updates.notes.join('; ')}.` }
            : updated);
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

          // Money received and money *settled against an invoice* are different
          // events, and Zoho accepts the first while the caller means the second.
          // A payment with no application is booked as an on-account advance:
          // Zoho answers 201, the invoice keeps its full balance, and the
          // customer goes on being chased for money they have already paid.
          const paymentFields = args.fields as Record<string, unknown>;
          const applications = paymentFields['invoices'];
          const appliesToInvoice = Array.isArray(applications) && applications.length > 0;
          if (!appliesToInvoice && paymentFields['on_account'] !== true) {
            return err(new ToolError({
              toolId: 'zohoBooks', reason: 'bad_args',
              message: 'This payment names no invoice, so Zoho would hold it as an unapplied credit and the '
                + 'invoice would stay outstanding. Add invoices: [{ invoice_id, amount_applied }] with the '
                + 'invoice this settles. If the member really is recording money received in advance of any '
                + 'invoice, say so and pass on_account: true.',
            }));
          }
          // `on_account` is ours, not Zoho's — strip it before it travels.
          const { on_account: _onAccount, ...body } = paymentFields;

          const recorded = await writtenRecord('customerpayments', 'recorded', {
            method: 'POST',
            path: '/customerpayments',
            body,
          });

          // What Zoho did with it, not what we asked for. A partial application
          // leaves a remainder that nobody is watching unless it is said out loud.
          const stored = isRecord(recorded.data) ? recorded.data : {};
          const unused = numericAmount(stored['unused_amount']);
          if (appliesToInvoice && unused !== null && unused > 0) {
            // A remainder does not say which way it went. The customer may have
            // paid more than the invoice — in which case the invoice IS settled
            // and the surplus is a credit — or the payment may have covered only
            // part of it. Asserting either from this number alone would be the
            // same false statement in the opposite direction, so it reports the
            // figure and points at the record that actually decides.
            return ok({
              ...recorded,
              message: `${recorded.message} Zoho attached ${formatAmount(unused, stringValue(stored, 'currency_code') || 'INR')} `
                + 'of this payment to no invoice — either the customer paid more than was owed, or less was applied '
                + 'than intended. Read the invoice back before describing it as paid or outstanding, and tell the '
                + 'member the leftover figure either way.',
            });
          }
          return ok(recorded);
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
          const billFields = args.fields as Record<string, unknown>;

          // The vendor is a reference, so the party has to be read back before
          // it can be recognised. Worth one lookup: the failure it catches
          // writes a payable the company owes itself, and Zoho accepts it.
          const vendorId = stringValue(billFields, 'vendor_id');
          const vendor = vendorId
            ? await getOne('contacts', vendorId, { connectionId: args.connectionId }).catch(() => undefined)
            : undefined;
          const billRefusal = refuseSelfDealing({
            organization: await sellingOrganization(),
            party: {
              name: vendor ? stringValue(vendor, 'contact_name', 'company_name') : stringValue(billFields, 'vendor_name'),
              gstNo: vendor ? stringValue(vendor, 'gst_no') : stringValue(billFields, 'gst_no'),
            },
            role: 'vendor',
            act: 'Recording this bill',
          });
          if (billRefusal) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: billRefusal }));

          return ok(await writtenRecord('bills', 'created', {
            method: 'POST',
            path: '/bills',
            body: billFields,
          }));
        }

        case 'create_contact': {
          if (!args.fields) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for create_contact' }));
          const contactFields = args.fields as Record<string, unknown>;

          // Cheaper and earlier than the bill check: the party is named right
          // here, so the organisation is refused before it exists as a contact
          // at all rather than after a transaction has been hung off it.
          const contactRefusal = refuseSelfDealing({
            organization: await sellingOrganization(),
            party: {
              name: stringValue(contactFields, 'contact_name', 'company_name'),
              gstNo: stringValue(contactFields, 'gst_no'),
            },
            role: stringValue(contactFields, 'contact_type') === 'vendor' ? 'vendor' : 'customer',
            act: 'Creating this contact',
          });
          if (contactRefusal) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: contactRefusal }));

          return ok(await writtenRecord('contacts', 'created', {
            method: 'POST',
            path: '/contacts',
            body: contactFields,
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
            // No amountKeys: a catalogue's rates are unit prices, and adding
            // them up would present a meaningless total as a finding.
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
