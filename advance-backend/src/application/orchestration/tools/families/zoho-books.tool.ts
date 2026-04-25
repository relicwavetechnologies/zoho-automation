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
    // Reports
    'build_overdue_report',
  ]),

  // CRUD params
  invoiceId:      z.string().optional(),
  contactId:      z.string().optional(),
  fields:         z.record(z.unknown()).optional(),
  limit:          z.number().int().min(1).max(100).optional(),
  organizationId: z.string().optional(),

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
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export const createZohoBooksTool = (deps: {
  /** Factory for simple per-request CRUD client (token resolved per call). */
  getClient:    (companyId: string, userId: string) => Promise<ZohoBooksClientPort | null>;
  /** Finance ops service for deep report operations. */
  financeOps:   ZohoFinanceOps;
}): Tool<Args, Res> => ({
  id:           asToolId('zohoBooks'),
  family:       'zoho',
  actionGroups: new Set(['read', 'create', 'update']),
  argsSchema:   Schema,
  resultSchema: ResultSchema,

  description: [
    'Access Zoho Books: list/read invoices, contacts, expenses; create invoices.',
    'For financial analysis use build_overdue_report which scans ALL invoices deeply,',
    'computes aging buckets and top customers, and returns a CSV link for large datasets.',
  ].join(' '),

  parameterDocs: [
    'op: list_invoices|get_invoice|create_invoice|list_contacts|get_contact|list_expenses|build_overdue_report',
    'build_overdue_report params: asOfDate (ISO), minOverdueDays, invoiceDateFrom, invoiceDateTo',
    'CRUD params: invoiceId, contactId, fields, limit (1-100)',
  ].join('\n'),

  permissionCheck(args, perm) {
    const action: ToolActionGroup = args.op === 'create_invoice' ? 'create' : 'read';
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

        case 'list_contacts':
          return ok({ success: true, data: await client.listContacts(args.limit) });

        case 'get_contact': {
          if (!args.contactId) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'contactId required for get_contact' }));
          return ok({ success: true, data: await client.getContact(args.contactId) });
        }

        case 'list_expenses':
          return ok({ success: true, data: await client.listExpenses(args.limit) });
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
