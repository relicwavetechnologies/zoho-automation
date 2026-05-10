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
 *   - CRUD ops return at most `limit` records (default 25, max 100)
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
import { mapZohoError }                    from '../../../zoho/zoho-error.utils';
import { formatAmount, formatDate }        from '../../../zoho/zoho-format.utils';
import { normalizeStatus, parseDateFilter } from '../../../zoho/zoho-filter.utils';
import type { ZohoBooksPaginatedClient, ZohoBooksModule } from '../../../../infrastructure/zoho/zoho-books-paginated.client';

// ─── Args schema ──────────────────────────────────────────────────────────────

const Schema = z.object({
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
});

type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success:      z.boolean(),
  data:         z.unknown().optional(),
  id:           z.string().optional(),
  message:      z.string().optional(),
  // Report fields (present only for build_overdue_report)
  report:       z.unknown().optional(),
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
  return typeof currency === 'string' && currency.trim() ? currency : 'USD';
};

const numericAmount = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value.trim())) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

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
      if (amount !== null) formatted[displayKey(key)] = formatAmount(Math.round(amount * 100), currency);
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
      from_date: parseDateFilter(from).from,
      to_date:   parseDateFilter(to).to,
    };
  }

  if (from) {
    const range = parseDateFilter(from);
    return { from_date: range.from, to_date: range.to };
  }

  if (to) {
    const range = parseDateFilter(to);
    return { from_date: range.from, to_date: range.to };
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
    ...(range['from_date'] ? { invoiceDateFrom: range['from_date'] } : {}),
    ...(range['to_date'] ? { invoiceDateTo: range['to_date'] } : {}),
  };
};

const singleDateValue = (input: string): string => parseDateFilter(input).to;

// ─── Tool factory ─────────────────────────────────────────────────────────────

export const createZohoBooksTool = (deps: {
  /** Factory for simple per-request CRUD client (token resolved per call). */
  getClient:    (companyId: string, userId: string) => Promise<ZohoBooksClientPort | null>;
  /** Paginated client for module reads and raw Books report endpoints. */
  booksClient:  ZohoBooksPaginatedClient;
  /** Finance ops service for deep report operations. */
  financeOps:   ZohoFinanceOps;
}): Tool<Args, Res> => ({
  id:           asToolId('zohoBooks'),
  family:       'zoho',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema:   Schema,
  resultSchema: ResultSchema,

  description: [
    'Access Zoho Books with 19 operations: list_invoices, get_invoice, create_invoice, list_contacts, get_contact, list_expenses, list_bills, list_payments, get_chart_of_accounts, get_account_balance, list_bank_transactions, search_transactions, get_tax_summary, send_invoice, record_payment, create_expense, create_bill, void_invoice, and build_overdue_report.',
    'For financial analysis use build_overdue_report which scans ALL invoices deeply,',
    'computes aging buckets and top customers, and returns a CSV link for large datasets.',
  ].join(' '),

  parameterDocs: [
    'op: list_invoices|get_invoice|create_invoice|list_contacts|get_contact|list_expenses|list_bills|list_payments|get_chart_of_accounts|get_account_balance|list_bank_transactions|search_transactions|get_tax_summary|send_invoice|record_payment|create_expense|create_bill|void_invoice|build_overdue_report',
    'new read params: accountId, searchQuery, dateFrom, dateTo, status, taxYear',
    'write params: invoiceId, email, fields',
    'build_overdue_report params: asOfDate (ISO), minOverdueDays, invoiceDateFrom, invoiceDateTo',
    'CRUD params: invoiceId, contactId, fields, limit (1-100)',
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

    // ── Report operations (use financeOps — deep pagination + CSV) ──────────
    if (args.op === 'build_overdue_report') {
      try {
        const report = await deps.financeOps.buildOverdueReport({
          companyId,
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

    // ── CRUD operations (use simple client) ──────────────────────────────────
    const client = await deps.getClient(companyId, userId);
    if (!client) {
      return err(new ToolError({
        toolId:  'zohoBooks',
        reason:  'unrecoverable',
        message: 'Zoho Books not connected for this company',
      }));
    }

    const listRecords = async (moduleName: ZohoBooksModule, filters?: Record<string, unknown>, query?: string) =>
      deps.booksClient.listRecords({
        companyId,
        moduleName,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        ...(filters ? { filters } : {}),
        ...(query ? { query } : {}),
        perPage: args.limit ?? 25,
      });

    try {
      switch (args.op) {
        case 'list_invoices':
          return ok({ success: true, data: formatZohoResult(await client.listInvoices(args.limit)) });

        case 'get_invoice': {
          if (!args.invoiceId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'invoiceId required for get_invoice' }));
          return ok({ success: true, data: formatZohoResult(await client.getInvoice(args.invoiceId)) });
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
          return ok({ success: true, data: formatZohoResult(await client.listContacts(args.limit)) });

        case 'get_contact': {
          if (!args.contactId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'contactId required for get_contact' }));
          return ok({ success: true, data: formatZohoResult(await client.getContact(args.contactId)) });
        }

        case 'list_expenses':
          return ok({ success: true, data: formatZohoResult(await client.listExpenses(args.limit)) });

        case 'list_bills':
          return ok({ success: true, data: formatZohoResult(await listRecords('bills', dateParams(args))) });

        case 'list_payments':
          return ok({ success: true, data: formatZohoResult(await listRecords('customerpayments', dateParams(args))) });

        case 'get_chart_of_accounts': {
          const data = await deps.booksClient.getEndpoint({
            companyId,
            path: '/chartofaccounts',
            ...(args.organizationId ? { organizationId: args.organizationId } : {}),
          });
          return ok({ success: true, data: formatZohoResult(data['chartofaccounts'] ?? data) });
        }

        case 'get_account_balance': {
          const data = args.accountId
            ? await deps.booksClient.getEndpoint({
              companyId,
              path: `/bankaccounts/${encodeURIComponent(args.accountId)}`,
              ...(args.organizationId ? { organizationId: args.organizationId } : {}),
            })
            : await listRecords('bankaccounts');
          return ok({ success: true, data: formatZohoResult(data) });
        }

        case 'list_bank_transactions':
          return ok({ success: true, data: formatZohoResult(await listRecords('banktransactions', dateParams(args))) });

        case 'search_transactions': {
          if (!args.searchQuery) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'searchQuery required for search_transactions' }));
          const data = await deps.booksClient.getEndpoint({
            companyId,
            path: '/search',
            ...(args.organizationId ? { organizationId: args.organizationId } : {}),
            params: { search_text: args.searchQuery, ...dateParams(args) },
          });
          return ok({ success: true, data: formatZohoResult(data) });
        }

        case 'get_tax_summary': {
          const data = await deps.booksClient.getEndpoint({
            companyId,
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
