/**
 * zohoBooks tool — Zoho Books read/write + deep financial reports.
 *
 * Operations:
 *   CRUD:
 *     list_invoices   — paginated invoice list (first page, bounded)
 *     get_invoice     — single invoice by ID
 *     create_invoice  — create a new invoice
 *     list_purchase_orders — paginated purchase-order list
 *     get_purchase_order   — single purchase order by ID or exact number
 *     stage_purchase_order — validate and hold a purchase order for confirmation
 *     create_purchase_order — create exactly the confirmed staged draft
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
 *     stage_bill            — validate and hold a bill for confirmation
 *     create_bill           — create exactly the confirmed staged bill
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
 *   - Plain list ops return at most `limit` records (default 25, max 200)
 *     and fetch only one bounded page on the model-facing path
 *   - Complete artifacts page through the governed terminal without entering model context
 */

import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result }                     from '../../../shared/result';
import { ok, err }                         from '../../../shared/result';
import { PermissionError, ToolError }      from '../../../shared/errors';
import type { ToolActionGroup }            from '../../../domain/permissions/tool-action-group';
import type { ZohoBooksScopeModule }       from '../../../domain/zoho/zoho-scope';
import { asToolId }                        from '../../../shared/ids';
import {
  ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE,
  ZOHO_BOOKS_OUTSTANDING_RULE,
  ZOHO_BOOKS_ROW_CONTRACT,
} from '../../../shared/zoho-books-row-contract';
import type { ZohoFinanceOps }             from '../../zoho/zoho-finance-ops';
import {
  unwrapZohoRecord,
  type ZohoWriteModule,
} from '../../zoho/zoho-books-write-result';
import {
  createZohoBooksWriteRunner,
  type ZohoBooksMutationRequest,
} from '../../zoho/zoho-books-write';
import {
  createZohoAttachmentService,
  type ZohoAttachmentSourcePort,
} from '../../zoho/zoho-attachment.service';
import { createZohoBillService } from '../../zoho/zoho-bill.service';
import type { StagedBillStore } from '../../zoho/zoho-bill-staging';
import { createZohoContactService } from '../../zoho/zoho-contact.service';
import {
  createZohoInvoiceService,
  type ZohoInvoiceConversationHistory,
  type ZohoInvoiceDocumentParser,
} from '../../zoho/zoho-invoice.service';
import {
  type StagedInvoiceStore,
} from '../../zoho/zoho-invoice-staging';
import type { StagedPurchaseOrderStore } from '../../zoho/zoho-purchase-order-staging';
import { createZohoPurchaseOrderService } from '../../zoho/zoho-purchase-order.service';

import type { InvoiceReviewer } from '../../zoho/zoho-invoice-reviewer';
import { mapZohoError }                    from '../../zoho/zoho-error.utils';
import { normalizeInvoiceFields }          from '../../zoho/zoho-invoice-fields';
import { formatAmount, formatDate }        from '../../zoho/zoho-format.utils';
import { normalizeStatus, parseDateFilter } from '../../zoho/zoho-filter.utils';
import { handleZohoList, type ZohoListCsvColumn } from '../../zoho/zoho-list-handler';
import type { ZohoBooksPaginatedClient, ZohoBooksModule } from '../../../infrastructure/zoho/zoho-books-paginated.client';
import { filterZohoRecordsByEmail, normalizedEmail, recordMatchesZohoEmail } from '../../../shared/zoho-personalization';
import {
  createDatasetPreview,
  DATASET_PREVIEW_ROW_LIMIT,
} from '../../provider-data/dataset-preview';

// ─── Args schema ──────────────────────────────────────────────────────────────

const MAX_TERMINAL_PAGE = 100;
const TERMINAL_FILE_PAGE_LIMIT = 200;

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
    'list_purchase_orders',
    'get_purchase_order',
    'stage_purchase_order',
    'create_purchase_order',
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
    'stage_bill',
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
  purchaseOrderId: z.string().optional(),
  contactId:      z.string().optional(),
  accountId:      z.string().optional(),
  // attach_document — which record the file belongs on, and which file it is.
  recordType:     z.enum(['invoice', 'purchase_order', 'bill']).optional(),
  recordId:       z.string().optional(),
  fileName:       z.string().optional(),
  /** Stored draft identity returned by invoice, purchase-order, or bill staging. */
  stagingId:      z.string().uuid().optional(),
  /** The draft this staging corrects, when the reviewer sent one back. */
  supersedesStagingId: z.string().uuid().optional(),
  searchQuery:    z.string().optional(),
  email:          z.string().email().optional(),
  fields:         z.record(z.unknown()).optional(),
  limit:          z.number().int().min(1).max(TERMINAL_FILE_PAGE_LIMIT).optional(),
  // Each response remains bounded to at most 25 model-facing rows. A higher
  // cursor ceiling lets governed terminal workflows page large date ranges.
  page:           z.number().int().min(1).max(MAX_TERMINAL_PAGE).optional(),
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

}).strict();

type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success:      z.boolean(),
  data:         z.unknown().optional(),
  id:           z.string().optional(),
  message:      z.string().optional(),
  /** Zoho web link for a record a write just created or changed. */
  recordUrl:    z.string().optional(),
  /** Draft identity to hand back to the matching create operation once the member agrees. */
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
  // Script-mode fields
  rowCount:        z.number().optional(),
  totalFetched:    z.number().optional(),
  moduleSchema:    z.unknown().optional(),
  sourceTruncated: z.boolean().optional(),
  preview: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.unknown())).max(TERMINAL_FILE_PAGE_LIMIT),
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
});

type Res = z.infer<typeof ResultSchema>;

const readOps = new Set<Args['op']>([
  'list_invoices',
  'get_invoice',
  'list_contacts',
  'get_contact',
  'list_expenses',
  'list_bills',
  'list_purchase_orders',
  'get_purchase_order',
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
  'stage_bill',
  'create_bill',
  'stage_purchase_order',
  'create_purchase_order',
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

export const zohoBooksActionFor = (op: string): ToolActionGroup =>
  readOps.has(op as Args['op']) ? 'read'
    : createOps.has(op as Args['op']) ? 'create'
      : updateOps.has(op as Args['op']) ? 'update'
        : 'delete';

const oauthModuleByCreateOp = new Map<string, ZohoBooksScopeModule>([
  ['stage_invoice', 'invoices'],
  ['create_invoice', 'invoices'],
  ['stage_purchase_order', 'purchaseorders'],
  ['create_purchase_order', 'purchaseorders'],
  ['stage_bill', 'bills'],
  ['create_bill', 'bills'],
]);

/** The narrow Zoho OAuth module that may authorize a supported staged/create flow. */
export const zohoBooksScopeModuleFor = (op: string): ZohoBooksScopeModule | undefined =>
  oauthModuleByCreateOp.get(op);

const listOpToModule: Record<string, ZohoBooksModule> = {
  list_invoices:         'invoices',
  list_bills:            'bills',
  list_purchase_orders:  'purchaseorders',
  list_expenses:         'expenses',
  list_payments:         'customerpayments',
  list_contacts:         'contacts',
  list_items:            'items',
  list_bank_transactions: 'banktransactions',
  search_transactions:   'banktransactions',
};

/**
 * How many unresolved twins one create will investigate before refusing.
 *
 * Nothing retires an unresolved draft, so a connection that keeps losing
 * responses accumulates them. Reading every one back would put hundreds of
 * Zoho calls inside a single tool call; ignoring the excess would quietly
 * disable the duplicate guard. Refusing says so out loud.
 */
const TWIN_READ_BACK_LIMIT = 5;

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
    value: item => stringValue(item, 'invoice_id', 'purchaseorder_id', 'bill_id', 'payment_id', 'expense_id', 'contact_id', 'transaction_id', 'item_id', 'id'),
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
 * Provider filters for one module, derived once for every read mode.
 *
 * They have to agree: otherwise a terminal page and a direct preview can apply
 * different scopes. `accountId` was once accepted and then dropped, widening a
 * one-account question to every account in the organisation.
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

// ─── Tool factory ─────────────────────────────────────────────────────────────

export const createZohoBooksTool = (deps: {
  /** Paginated client — every read and every write goes through this one. */
  booksClient:  ZohoBooksPaginatedClient;
  /** Finance ops service for deep report operations. */
  financeOps:   ZohoFinanceOps;
  inlineThreshold?: number;
  /** Resolves a file the member sent in this conversation. Absent = attachments unavailable. */
  attachmentSource?: ZohoAttachmentSourcePort;
  /** Web base for record links, e.g. https://books.zoho.com or a custom finance domain. */
  appBaseUrl?: string;
  /** Holds invoice drafts between staging and creation. Absent disables staging. */
  invoiceStaging?: StagedInvoiceStore;
  /** Holds purchase-order drafts between member review and one-shot creation. */
  purchaseOrderStaging?: StagedPurchaseOrderStore;
  /** Holds bill drafts between member review and one-shot creation. */
  billStaging?: StagedBillStore;
  /** Reads a draft cold before the member is shown it. */
  invoiceReviewer?: InvoiceReviewer;
  /** The member's own words, for the reviewer. Never the model's account of them. */
  conversationHistory?: ZohoInvoiceConversationHistory;
  /** Reads the file the member sent, so the reviewer checks the document not a retelling of it. */
  documentParser?: ZohoInvoiceDocumentParser;
  /** The selling organisation's GST state code, for the IGST-versus-CGST rule. */
  homeGstStateCode?: string;
}): Tool<Args, Res> => ({
  id:           asToolId('zohoBooks'),
  family:       'zoho',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema:   Schema,
  resultSchema: ResultSchema,

  description: [
    'Access Zoho Books: read, write, and report on invoices, purchase orders, bills, expenses, payments, contacts, items, taxes, bank transactions.',
    'Before any write, read the matching current Invoice, Bill, Purchase Order, or Money skill in this turn.',
    'Resolve one ledger with get_chart_of_accounts plus a focused searchQuery, which returns at most ten candidates; move an explicitly requested full chart through the governed local-file workflow instead of model context.',
    'A created invoice is a draft until mark_invoice_sent or send_invoice; report the status the tool returns rather than assuming it was issued.',
    'attach_document puts a file the member sent or uploaded in this conversation onto an invoice, purchase order, or bill, and verifies it against Zoho documents[].',
    'Plain list operations fetch one bounded page and return only the requested limit.',
    'For a complete artifact or exact multi-page aggregate, use page/nextPage from one governed local Python file. Do not call this registered Pi tool for a preview first when the user already requested an export; begin the local workflow and call Zoho through divo-local.',
    'Use populated _amount_inr/_balance_inr for INR calculations; never infer an original currency when _currency is UNKNOWN.',
  ].join(' '),

  parameterDocs: [
    'connectionId: exact accessible Zoho UUID. In backend-hosted channels, omit it when only one Zoho account is accessible; the backend resolves that account. If multiple are available, retry with the exact ID returned by the error.',
    'op: list_invoices|get_invoice|stage_invoice|create_invoice|update_invoice|mark_invoice_sent|list_purchase_orders|get_purchase_order|stage_purchase_order|create_purchase_order|attach_document|list_contacts|get_contact|create_contact|list_expenses|list_bills|list_payments|list_items|list_taxes|get_chart_of_accounts|get_account_balance|list_bank_transactions|search_transactions|get_tax_summary|send_invoice|record_payment|create_expense|stage_bill|create_bill|void_invoice|build_overdue_report',
    `read params: invoiceId, purchaseOrderId, accountId, searchQuery, dateFrom, dateTo, status, taxYear, limit (1-${TERMINAL_FILE_PAGE_LIMIT}), page (1-${MAX_TERMINAL_PAGE})`,
    'For terminal paging, start with page=1 and continue with nextPage while hasMore=true.',
    'get_invoice accepts a Zoho numeric invoice ID or an exact human invoice number. list_invoices forwards searchQuery to Zoho and returns newest invoice dates first.',
    'For get_chart_of_accounts, pass a focused searchQuery when resolving a ledger for a write. It returns at most ten matching candidates with their live IDs; omit searchQuery only inside a governed local-file workflow for an explicitly requested full chart.',
    'limit is the requested maximum. Once that many rows are returned, do not fetch more pages unless the user explicitly asks for a complete export or aggregate.',
    'write params: invoiceId, email, fields, stagingId',
    'update_invoice/create_contact/create_expense/record_payment take fields; the tool returns the stored record, its status, and its link. Never restate a status the tool did not return.',
    'INVOICES ARE STAGED. stage_invoice takes fields (and fileName when a document is the source) and writes nothing to Zoho: it checks the draft, has a reviewer read it cold, and returns stagedSummary plus stagingId. Show the member that summary verbatim, including everything under review.unsourced, and create only once they agree.',
    // `fields` is z.record(z.unknown()), so the serialized schema says nothing
    // about its shape. Without this line the model has to guess the payload and
    // finds out from a blocking reviewer verdict, one model call later.
    'stage_invoice fields, at minimum: customer_id, date, due_date or payment_terms, and line_items, each carrying item_id or name, quantity, rate, and tax_id. Include place_of_supply whenever the draft carries tax — without it the IGST-versus-CGST check cannot run and only warns that it did not. The zoho-books-invoice recipe states the rest.',
    'create_invoice takes ONLY stagingId. It replays the approved payload, so what the member saw is what Zoho receives. It refuses a draft that failed review, one already created, and one with no stagingId.',
    'PURCHASE ORDERS ARE STAGED. stage_purchase_order takes fields with vendor_id, date, line_items (item_id, quantity, rate), optional expected_delivery_date, notes, terms, and fileName. Show stagedSummary exactly, obtain confirmation, then call create_purchase_order with only stagingId plus the same connectionId.',
    'A created purchase order remains a draft: create_purchase_order never submits, approves, marks open, or emails it. Report that nothing was sent to the vendor.',
    'BILLS ARE STAGED. stage_bill takes fields with vendor_id, bill_number, date, due_date, line_items, tax fields, notes, and fileName. Show stagedSummary exactly, obtain confirmation, then call create_bill with only stagingId plus the same connectionId.',
    'stage_bill refuses duplicate bill_number, missing vendor/date/due_date/line mappings, and mixed ordinary GST plus reverse-charge payloads before any Zoho write. create_bill replays only the staged payload.',
    'When review.outcome is fail, fix the exact fields named in review.issues and call stage_invoice again with supersedesStagingId. review.attemptsRemaining says how many corrections are left; at zero, put the objection to the member instead of re-staging.',
    'stage_invoice: supply invoice_number only when the member gave one — the tool then overrides Zoho auto-numbering. Omit it to let Zoho number the invoice.',
    'payment_terms is a whole number of days, never words: 15 for "Net 15", 0 for due on receipt. The tool records the original wording as payment_terms_label.',
    'mark_invoice_sent issues a draft without emailing anyone. send_invoice emails it. They are different acts; do not substitute one for the other.',
    'create_contact only after list_contacts with searchQuery returns no match, and say in the reply that a new contact was created.',
    'attach_document params: recordType (invoice|purchase_order|bill), recordId, fileName — the exact name of a file the member sent or uploaded in this conversation. Never invent a filename, and never claim an attachment the tool did not confirm.',
    'list_items gives item_id and rate for invoice line_items. list_taxes gives the real tax_id values for GST; never guess a tax rate or tax id.',
    'build_overdue_report params: asOfDate (ISO), minOverdueDays, invoiceDateFrom, invoiceDateTo',
    '',
    'ROW FIELDS (on every list result):',
    ZOHO_BOOKS_ROW_CONTRACT,
    '_amount/_total = original currency amount. _balance = original outstanding. _currency = ISO code or UNKNOWN; never label UNKNOWN as INR, and never produce an original-currency breakdown from UNKNOWN rows.',
    ZOHO_BOOKS_OUTSTANDING_RULE,
    ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE,
  ].join('\n'),

  permissionCheck(args, perm) {
    const action = zohoBooksActionFor(args.op);
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
      if (args.op === 'list_purchase_orders' || args.op === 'get_purchase_order') {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'permission_denied',
          message: 'Purchase orders are company-wide procurement records and are unavailable for personalized Zoho access.',
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

    // ── CRUD operations ──────────────────────────────────────────────────────
    const scopeFilter: Record<string, unknown> = personalizedScope
      ? { email: requesterEmail! }
      : {};

    const appBaseUrl = deps.appBaseUrl ?? 'https://books.zoho.com';
    const booksWriter = createZohoBooksWriteRunner({
      booksClient: deps.booksClient,
      companyId,
      userId,
      connectionId: args.connectionId,
      ...(args.organizationId ? { organizationId: args.organizationId } : {}),
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      appBaseUrl,
    });
    const bills = createZohoBillService({
      booksClient: deps.booksClient,
      ...(deps.billStaging ? { staging: deps.billStaging } : {}),
      appBaseUrl,
    });
    const contacts = createZohoContactService({
      booksClient: deps.booksClient,
      appBaseUrl,
    });
    const invoices = createZohoInvoiceService({
      booksClient: deps.booksClient,
      ...(deps.invoiceStaging ? { staging: deps.invoiceStaging } : {}),
      ...(deps.invoiceReviewer ? { reviewer: deps.invoiceReviewer } : {}),
      ...(deps.conversationHistory ? { conversationHistory: deps.conversationHistory } : {}),
      ...(deps.documentParser ? { documentParser: deps.documentParser } : {}),
      ...(deps.attachmentSource ? { attachmentSource: deps.attachmentSource } : {}),
      ...(deps.homeGstStateCode ? { homeGstStateCode: deps.homeGstStateCode } : {}),
      appBaseUrl,
    });
    const purchaseOrders = createZohoPurchaseOrderService({
      booksClient: deps.booksClient,
      ...(deps.purchaseOrderStaging ? { staging: deps.purchaseOrderStaging } : {}),
      appBaseUrl,
    });
    const invoiceContext = {
      companyId,
      userId,
      connectionId: args.connectionId,
      ...(args.organizationId ? { organizationId: args.organizationId } : {}),
      correlationId: ctx.correlationId,
      channel: ctx.runContext.channel,
      ...(ctx.runContext.chatId ? { chatId: ctx.runContext.chatId } : {}),
      ...(ctx.runContext.runtimeThreadId ? { runtimeThreadId: ctx.runContext.runtimeThreadId } : {}),
      now: ctx.clock.now(),
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      ...(ctx.onProgress ? { onProgress: (message: string) => { ctx.onProgress?.(message); } } : {}),
    };
    const purchaseOrderContext = {
      companyId,
      userId,
      connectionId: args.connectionId,
      ...(args.organizationId ? { organizationId: args.organizationId } : {}),
      correlationId: ctx.correlationId,
      now: ctx.clock.now(),
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      ...(ctx.onProgress ? { onProgress: (message: string) => { ctx.onProgress?.(message); } } : {}),
    };

    /** Single-record GET. Unlike getRecord() this surfaces provider errors
     *  instead of turning an expired token into "not found". */
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

    const write = async (input: ZohoBooksMutationRequest) => booksWriter.mutate(input);
    const attachments = createZohoAttachmentService({
      ...(deps.attachmentSource ? { attachmentSource: deps.attachmentSource } : {}),
      companyId,
      userId,
      channel: ctx.runContext.channel,
      ...(ctx.runContext.chatId ? { chatId: ctx.runContext.chatId } : {}),
      readRecord: getOne,
      write,
      ...(ctx.onProgress ? { onProgress: (message: string) => { ctx.onProgress?.(message); } } : {}),
    });
    const attachFileToRecord = attachments.attach;

    const attachDocument = async (): Promise<Result<Res, ToolError>> => {
      if (!args.recordType || !args.recordId || !args.fileName) {
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'bad_args',
          message: 'attach_document needs recordType (invoice, purchase_order, or bill), recordId, and the exact fileName the member sent.',
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

    /** Write, then report what Zoho actually stored rather than that it accepted the call. */
    const writtenRecord = async (
      moduleName: ZohoWriteModule,
      verb: string,
      input: ZohoBooksMutationRequest,
    ): Promise<Res> => {
      const { record, summary } = await booksWriter.writeRecord({
        module: moduleName,
        verb,
        ...input,
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
      const isLocalFileResult = ctx.resultAudience === 'local_file';
      const result = await handleZohoList({
        companyId,
        ...connectionContext,
        moduleName,
        moduleLabel,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        filters: { ...scopeFilter, ...moduleFilters(moduleName, args), ...options.filters },
        ...(options.query ? { query: options.query } : {}),
        ...(args.page !== undefined ? { page: args.page } : {}),
        inlineThreshold: isLocalFileResult
          ? Math.min(args.limit ?? TERMINAL_FILE_PAGE_LIMIT, TERMINAL_FILE_PAGE_LIMIT)
          : Math.min(
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
      const preview = isLocalFileResult
        ? {
            columns: Array.from(new Set(formattedItems.flatMap(row => Object.keys(row)))),
            rows: formattedItems,
            coverage: result.coverage,
          }
        : createDatasetPreview({
            rows: formattedItems,
            coverage: result.coverage,
          });

      return {
        success: true,
        message: result.summary,
        preview,
        report: {
          returnedCount: result.items.length,
          ...(result.totalCount !== undefined ? { totalCount: result.totalCount } : {}),
          summary: result.summary,
          truncated: result.truncated,
          hasMore: result.hasMore,
        },
        truncated: result.truncated,
        hasMore: result.hasMore,
        page: result.page,
        ...(result.hasMore && result.page < MAX_TERMINAL_PAGE ? { nextPage: result.page + 1 } : {}),
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

        case 'get_purchase_order': {
          if (!args.purchaseOrderId) {
            return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'purchaseOrderId required for get_purchase_order' }));
          }
          let resolvedId = args.purchaseOrderId;
          if (!isZohoRecordId(resolvedId)) {
            const lookup = await deps.booksClient.listRecords({
              companyId,
              ...connectionContext,
              moduleName: 'purchaseorders',
              ...(args.organizationId ? { organizationId: args.organizationId } : {}),
              filters: { purchaseorder_number: resolvedId },
              page: 1,
              perPage: 25,
            });
            const exact = lookup.items.filter(item =>
              normalizeRecordNumber(stringValue(item, 'purchaseorder_number')) === normalizeRecordNumber(resolvedId));
            if (exact.length !== 1) {
              return ok({
                success: true,
                data: null,
                message: exact.length === 0
                  ? `Purchase order number "${resolvedId}" was not found`
                  : `Purchase order number "${resolvedId}" is ambiguous`,
              });
            }
            resolvedId = stringValue(exact[0]!, 'purchaseorder_id');
          }
          if (!resolvedId) {
            return err(new ToolError({ toolId: 'zohoBooks', reason: 'upstream_failure', message: 'Zoho returned a purchase order without an ID.' }));
          }
          return ok({ success: true, data: formatZohoResult(await getOne('purchaseorders', resolvedId)) });
        }

        case 'stage_purchase_order': {
          const result = await purchaseOrders.stage({
            ...purchaseOrderContext,
            ...(args.fields ? { fields: args.fields } : {}),
            ...(args.fileName ? { fileName: args.fileName } : {}),
          });
          return result.ok ? ok(result.value) : err(result.error);
        }

        case 'create_purchase_order': {
          const result = await purchaseOrders.create({
            ...purchaseOrderContext,
            ...(args.stagingId ? { stagingId: args.stagingId } : {}),
            attach: (recordId, fileName, organizationId) => attachFileToRecord({
              recordType: 'purchase_order',
              recordId,
              fileName,
              destination: { connectionId: args.connectionId, organizationId },
            }),
          });
          return result.ok
            ? ok({
                success: true,
                id: result.value.id,
                data: formatZohoResult(result.value.record),
                message: result.value.message,
                ...(result.value.recordUrl ? { recordUrl: result.value.recordUrl } : {}),
              })
            : err(result.error);
        }

        case 'stage_invoice': {
          const result = await invoices.stage({
            ...invoiceContext,
            ...(args.fields ? { fields: args.fields as Record<string, unknown> } : {}),
            ...(args.fileName ? { fileName: args.fileName } : {}),
            ...(args.supersedesStagingId ? { supersedesStagingId: args.supersedesStagingId } : {}),
          });
          return result.ok ? ok(result.value) : err(result.error);
        }

        case 'create_invoice': {
          const result = await invoices.create({
            ...invoiceContext,
            ...(args.stagingId ? { stagingId: args.stagingId } : {}),
            attach: (invoiceId, fileName, organizationId) => attachFileToRecord({
              recordType: 'invoice',
              recordId: invoiceId,
              fileName,
              destination: {
                connectionId: args.connectionId,
                ...(organizationId ? { organizationId } : {}),
              },
            }),
          });
          return result.ok
            ? ok({
                success: true,
                ...(result.value.id ? { id: result.value.id } : {}),
                data: formatZohoResult(result.value.record),
                ...(result.value.recordUrl ? { recordUrl: result.value.recordUrl } : {}),
                ...(result.value.drift && result.value.drift.length > 0 ? { drift: result.value.drift } : {}),
                message: result.value.message,
              })
            : err(result.error);
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

        case 'stage_bill': {
          const result = await bills.stage({
            companyId,
            userId,
            connectionId: args.connectionId,
            ...(args.organizationId ? { organizationId: args.organizationId } : {}),
            correlationId: ctx.correlationId,
            now: ctx.clock.now(),
            ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
            ...(ctx.onProgress ? { onProgress: (message: string) => ctx.onProgress?.(message) } : {}),
            ...(args.fields ? { fields: args.fields as Record<string, unknown> } : {}),
            ...(args.fileName ? { fileName: args.fileName } : {}),
          });
          return result.ok ? ok(result.value) : err(result.error);
        }

        case 'create_bill': {
          const result = await bills.create({
            companyId,
            userId,
            connectionId: args.connectionId,
            ...(args.organizationId ? { organizationId: args.organizationId } : {}),
            correlationId: ctx.correlationId,
            now: ctx.clock.now(),
            ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
            ...(args.stagingId ? { stagingId: args.stagingId } : {}),
            attach: (recordId, fileName, organizationId) => attachFileToRecord({
              recordType: 'bill',
              recordId,
              fileName,
              destination: { connectionId: args.connectionId, organizationId },
            }),
          });
          return result.ok
            ? ok({
                success: true,
                ...(result.value.summary.id ? { id: result.value.summary.id } : {}),
                data: formatZohoResult(result.value.record),
                message: result.value.message,
                ...(result.value.summary.recordUrl ? { recordUrl: result.value.summary.recordUrl } : {}),
              })
            : err(result.error);
        }

        case 'create_contact': {
          const result = await contacts.create({
            companyId,
            userId,
            connectionId: args.connectionId,
            ...(args.organizationId ? { organizationId: args.organizationId } : {}),
            ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
            ...(args.fields ? { fields: args.fields as Record<string, unknown> } : {}),
          });
          return result.ok
            ? ok({
                success: true,
                ...(result.value.summary.id ? { id: result.value.summary.id } : {}),
                data: formatZohoResult(result.value.record),
                message: result.value.summary.message,
                ...(result.value.summary.recordUrl ? { recordUrl: result.value.summary.recordUrl } : {}),
              })
            : err(result.error);
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
              {
                key: 'amount',
                header: 'Amount',
                // Zoho's expense-list response normally calls this `total`;
                // older responses and fixtures may use `amount`.
                value: item => amountValue(item, 'total', 'amount'),
              },
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

        case 'list_purchase_orders':
          return ok(await listBounded('purchaseorders', 'purchase orders', {
            filters: dateFilter,
            ...(args.searchQuery ? { query: args.searchQuery } : {}),
            amountKeys: ['total'],
            columns: [
              commonColumns.id('Purchase Order ID'),
              { key: 'purchaseorder_number', header: 'Purchase Order Number' },
              { key: 'reference_number', header: 'Reference' },
              { key: 'vendor_name', header: 'Vendor' },
              commonColumns.date,
              { key: 'delivery_date', header: 'Expected Delivery' },
              commonColumns.status,
              { key: 'total', header: 'Total' },
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
          if (args.searchQuery?.trim()) {
            const accounts = Array.isArray(data['chartofaccounts'])
              ? data['chartofaccounts'].filter((account): account is Record<string, unknown> =>
                Boolean(account) && typeof account === 'object' && !Array.isArray(account))
              : [];
            const query = args.searchQuery.trim().toLocaleLowerCase();
            const matches = accounts.filter(account => [
              account['account_name'],
              account['account_code'],
              account['account_type'],
              account['description'],
            ].some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(query)));
            const candidates = matches.slice(0, 10);
            return ok({
              success: true,
              data: formatZohoResult(candidates),
              truncated: matches.length > candidates.length,
              message: matches.length > candidates.length
                ? `Found ${matches.length} matching accounts; returned the first ${candidates.length}. Refine searchQuery before choosing an ID.`
                : `Found ${matches.length} matching account${matches.length === 1 ? '' : 's'} for "${args.searchQuery}".`,
            });
          }
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
