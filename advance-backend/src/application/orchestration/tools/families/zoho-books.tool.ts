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

const dateParams = (args: Args): Record<string, unknown> => ({
  ...(args.dateFrom ? { from_date: args.dateFrom } : {}),
  ...(args.dateTo   ? { to_date:   args.dateTo   } : {}),
});

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
    'Access Zoho Books: list/read invoices, contacts, expenses, bills, payments, bank transactions, accounts, and tax summaries; create invoices, bills, expenses, payments; send or void invoices.',
    'For financial analysis use build_overdue_report which scans ALL invoices deeply,',
    'computes aging buckets and top customers, and returns a CSV link for large datasets.',
  ].join(' '),

  parameterDocs: [
    'op: list_invoices|get_invoice|create_invoice|list_contacts|get_contact|list_expenses|list_bills|list_payments|get_chart_of_accounts|get_account_balance|list_bank_transactions|search_transactions|get_tax_summary|send_invoice|record_payment|create_expense|create_bill|void_invoice|build_overdue_report',
    'new read params: accountId, searchQuery, dateFrom, dateTo, taxYear',
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
          ...(args.asOfDate        ? { asOfDate:        args.asOfDate        } : {}),
          ...(args.minOverdueDays !== undefined ? { minOverdueDays: args.minOverdueDays } : {}),
          ...(args.invoiceDateFrom ? { invoiceDateFrom: args.invoiceDateFrom } : {}),
          ...(args.invoiceDateTo   ? { invoiceDateTo:   args.invoiceDateTo   } : {}),
        });

        return ok({
          success: true,
          message: report.summary,
          report,   // full structured data — synthesis uses this to format the reply
        });
      } catch (e) {
        return err(new ToolError({
          toolId:  'zohoBooks',
          reason:  'upstream_failure',
          cause:   e,
          message: `Overdue report failed: ${e instanceof Error ? e.message : String(e)}`,
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
          return ok({ success: true, data: await client.listInvoices(args.limit) });

        case 'get_invoice': {
          if (!args.invoiceId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'invoiceId required for get_invoice' }));
          return ok({ success: true, data: await client.getInvoice(args.invoiceId) });
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
          return ok({ success: true, data: await client.listContacts(args.limit) });

        case 'get_contact': {
          if (!args.contactId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'contactId required for get_contact' }));
          return ok({ success: true, data: await client.getContact(args.contactId) });
        }

        case 'list_expenses':
          return ok({ success: true, data: await client.listExpenses(args.limit) });

        case 'list_bills':
          return ok({ success: true, data: await listRecords('bills', dateParams(args)) });

        case 'list_payments':
          return ok({ success: true, data: await listRecords('customerpayments', dateParams(args)) });

        case 'get_chart_of_accounts': {
          const data = await deps.booksClient.getEndpoint({
            companyId,
            path: '/chartofaccounts',
            ...(args.organizationId ? { organizationId: args.organizationId } : {}),
          });
          return ok({ success: true, data: data['chartofaccounts'] ?? data });
        }

        case 'get_account_balance': {
          const data = args.accountId
            ? await deps.booksClient.getEndpoint({
              companyId,
              path: `/bankaccounts/${encodeURIComponent(args.accountId)}`,
              ...(args.organizationId ? { organizationId: args.organizationId } : {}),
            })
            : await listRecords('bankaccounts');
          return ok({ success: true, data });
        }

        case 'list_bank_transactions':
          return ok({ success: true, data: await listRecords('banktransactions', dateParams(args)) });

        case 'search_transactions': {
          if (!args.searchQuery) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'searchQuery required for search_transactions' }));
          const data = await deps.booksClient.getEndpoint({
            companyId,
            path: '/search',
            ...(args.organizationId ? { organizationId: args.organizationId } : {}),
            params: { search_text: args.searchQuery, ...dateParams(args) },
          });
          return ok({ success: true, data });
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
          return ok({ success: true, data });
        }
      }
    } catch (e) {
      return err(new ToolError({
        toolId:  'zohoBooks',
        reason:  'upstream_failure',
        cause:   e,
        message: e instanceof Error ? e.message : String(e),
      }));
    }
  },
});
