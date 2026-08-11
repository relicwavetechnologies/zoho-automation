/**
 * zohoCrm tool — Zoho CRM read/write + pipeline & lead reports.
 *
 * Operations:
 *   CRUD (generic — works with any module: Leads, Contacts, Accounts, Deals, Tasks):
 *     list           — paginated record list
 *     get            — single record by ID
 *     search         — criteria-based search (Zoho CRM criteria syntax)
 *     search_text    — free-text search across name/email fields
 *     create         — create a record
 *     update         — update a record
 *     delete         — delete a record
 *
 *   Reports (exhaustive pagination + token-safe output):
 *     build_pipeline_summary — deals by stage with amounts
 *     build_lead_report      — lead funnel by source/status
 *     build_deal_forecast    — deals closing within a date range
 *
 * Result safety:
 *   - CRUD ops return at most `limit` records (default 25, max 200)
 *   - Reports return a summary plus a bounded inline sample
 */

import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result }                     from '../../../shared/result';
import { ok, err }                         from '../../../shared/result';
import { PermissionError, ToolError }      from '../../../shared/errors';
import type { ToolActionGroup }            from '../../../domain/permissions/tool-action-group';
import { asToolId }                        from '../../../shared/ids';
import type { ZohoCrmOps }                 from '../../zoho/zoho-crm-ops';
import { mapZohoError }                    from '../../zoho/zoho-error.utils';
import type { ZohoCrmPaginatedClient } from '../../../infrastructure/zoho/zoho-crm-paginated.client';
import { parseDateFilter } from '../../zoho/zoho-filter.utils';
import { filterZohoRecordsByEmail, normalizedEmail, recordMatchesZohoEmail } from '../../../shared/zoho-personalization';

// ─── Args schema ──────────────────────────────────────────────────────────────

const connectionField = { connectionId: z.string().uuid().optional() } as const;
const moduleField = { module: z.string().min(1) } as const;
const pageField = {
  limit: z.number().int().min(1).max(200).optional(),
  page: z.number().int().min(1).max(10).optional(),
} as const;

const ListSchema = z.object({
  ...connectionField,
  ...moduleField,
  ...pageField,
  op: z.literal('list'),
  pageToken: z.string().min(1).max(2048).optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
}).strict();

const Schema = z.discriminatedUnion('op', [
  ListSchema,
  z.object({ ...connectionField, ...moduleField, op: z.literal('get'), recordId: z.string().min(1) }).strict(),
  z.object({ ...connectionField, ...moduleField, ...pageField, op: z.literal('search'), criteria: z.string().min(1) }).strict(),
  z.object({ ...connectionField, ...moduleField, ...pageField, op: z.literal('search_text'), query: z.string().min(1) }).strict(),
  z.object({ ...connectionField, ...moduleField, op: z.literal('create'), fields: z.record(z.unknown()) }).strict(),
  z.object({ ...connectionField, ...moduleField, op: z.literal('update'), recordId: z.string().min(1), fields: z.record(z.unknown()) }).strict(),
  z.object({ ...connectionField, ...moduleField, op: z.literal('delete'), recordId: z.string().min(1) }).strict(),
  z.object({ ...connectionField, op: z.literal('build_pipeline_summary') }).strict(),
  z.object({ ...connectionField, op: z.literal('build_lead_report') }).strict(),
  z.object({
    ...connectionField,
    op: z.literal('build_deal_forecast'),
    closingFrom: z.string().optional(),
    closingTo: z.string().optional(),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.op === 'list' && value.page !== undefined && value.pageToken !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pageToken'],
      message: 'pageToken cannot be combined with page',
    });
  }
});

type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success:         z.boolean(),
  data:            z.unknown().optional(),
  recordId:        z.string().optional(),
  message:         z.string().optional(),
  report:          z.unknown().optional(),
  truncated:       z.boolean().optional(),
  hasMore:         z.boolean().optional(),
  page:            z.number().int().positive().optional(),
  nextPage:        z.number().int().positive().optional(),
  nextPageToken:   z.string().optional(),
});

type Res = z.infer<typeof ResultSchema>;

// ─── Constants ────────────────────────────────────────────────────────────────

const readOps = new Set<Args['op']>([
  'list', 'get', 'search', 'search_text',
  'build_pipeline_summary', 'build_lead_report', 'build_deal_forecast',
]);

export const zohoCrmActionFor = (op: string): ToolActionGroup =>
  readOps.has(op as Args['op']) ? 'read'
    : op === 'create' ? 'create'
      : op === 'update' ? 'update'
        : 'delete';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function formatCrmResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(formatCrmResult);
  if (!isRecord(value)) return value;

  const formatted: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (isRecord(fieldValue) && 'id' in fieldValue && 'name' in fieldValue) {
      formatted[key] = fieldValue['name'];
      formatted[`${key}_id`] = fieldValue['id'];
    } else {
      formatted[key] = formatCrmResult(fieldValue);
    }
  }
  return formatted;
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export const createZohoCrmTool = (deps: {
  crmClient:  ZohoCrmPaginatedClient;
  crmOps:     ZohoCrmOps;
}): Tool<Args, Res> => ({
  id:           asToolId('zohoCrm'),
  family:       'zoho',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema:   Schema,
  resultSchema: ResultSchema,

  description: [
    'Access Zoho CRM: list, get, search, create, update, delete records across Leads, Contacts, Accounts, Deals, Tasks.',
    'Search uses Zoho criteria syntax: (Field:operator:value) with and/or.',
    'Reports: build_pipeline_summary (deals by stage), build_lead_report (funnel by source), build_deal_forecast (closing deals).',
    'For a complete list workflow, page from a governed local script using page/nextPage, then pageToken when returned.',
  ].join(' '),

  parameterDocs: [
    'connectionId: exact accessible Zoho UUID. In backend-hosted channels, omit it when only one Zoho account is accessible; the backend resolves that account. If multiple are available, retry with the exact ID returned by the error.',
    'op: list|get|search|search_text|create|update|delete|build_pipeline_summary|build_lead_report|build_deal_forecast',
    'module: Leads|Contacts|Accounts|Deals|Tasks (required for CRUD ops)',
    'recordId: record ID (required for get/update/delete)',
    'criteria: Zoho search criteria (for search op). Format: (Field:operator:value)and/or(Field:operator:value)',
    '  Operators: equals, starts_with, contains, not_equal, greater_than, less_than, between',
    '  Example: "(Deal_Name:contains:Acme)and(Stage:equals:Qualification)"',
    'query: free-text search (for search_text op) — searches name/email fields',
    'fields: record fields for create/update',
    'limit: max records to return (1-200, default 25 direct or 200 in a local-file workflow)',
    'page: list/search page 1-10. When hasMore=true, call nextPage; list switches to nextPageToken when Zoho returns one.',
    'pageToken: opaque continuation returned by a prior list call; do not combine with page.',
    'sortBy: field name to sort by (e.g., Created_Time, Amount)',
    'sortOrder: asc|desc',
    '',
    'REPORT PARAMS:',
    'build_deal_forecast: closingFrom, closingTo (ISO dates or natural: "this month", "this quarter")',
    '',
    'CRM MODULE FIELDS:',
    'Leads: First_Name, Last_Name, Email, Company, Phone, Lead_Source, Lead_Status, Annual_Revenue, Owner',
    'Contacts: First_Name, Last_Name, Email, Phone, Account_Name (lookup), Owner',
    'Accounts: Account_Name, Website, Phone, Industry, Annual_Revenue, Account_Type, Owner',
    'Deals: Deal_Name, Amount, Stage, Closing_Date, Account_Name (lookup), Contact_Name (lookup), Probability, Owner',
    'Tasks: Subject, Due_Date, Status, Priority, Who_Id (contact lookup), What_Id (deal/account lookup), Owner',
  ].join('\n'),

  permissionCheck(args, perm) {
    const action = zohoCrmActionFor(args.op);
    const allowed = perm.allowedActionsByTool.get(asToolId('zohoCrm'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'zohoCrm', action, reason: 'not_allowed' }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    const { companyId, userId } = ctx.runContext;
    const connectionContext = {
      userId,
      ...(args.connectionId ? { connectionId: args.connectionId } : {}),
    };
    const personalizedScope = ctx.perm.department?.zohoReadScope === 'personalized';
    const requesterEmail = normalizedEmail(ctx.runContext.requesterEmail);
    if (personalizedScope && !requesterEmail) {
      return err(new ToolError({
        toolId: 'zohoCrm',
        reason: 'permission_denied',
        message: 'Personalized Zoho access requires the signed-in member email.',
      }));
    }
    if (personalizedScope && !readOps.has(args.op)) {
      return err(new ToolError({
        toolId: 'zohoCrm',
        reason: 'permission_denied',
        message: 'Zoho write actions are unavailable while this role is restricted to personalized data.',
      }));
    }
    if (personalizedScope) {
      ctx.logger.info('zoho_crm.scope.personalized', { requesterEmail, op: args.op });
    }

    // ── Report operations ─────────────────────────────────────────────────────
    if (args.op === 'build_pipeline_summary') {
      if (personalizedScope) return err(new ToolError({ toolId: 'zohoCrm', reason: 'permission_denied', message: 'Pipeline summaries are unavailable for personalized Zoho access.' }));
      ctx.onProgress?.('Building CRM pipeline summary…');
      try {
        const report = await deps.crmOps.buildPipelineSummary({ companyId, ...connectionContext });
        return ok({
          success: true,
          message: report.summary,
          report:  formatCrmResult(report),
        });
      } catch (e) {
        return err(new ToolError({
          toolId: 'zohoCrm', reason: 'upstream_failure', cause: e,
          message: `Pipeline summary failed: ${mapZohoError(e)}`,
        }));
      }
    }

    if (args.op === 'build_lead_report') {
      if (personalizedScope) return err(new ToolError({ toolId: 'zohoCrm', reason: 'permission_denied', message: 'Lead reports are unavailable for personalized Zoho access.' }));
      ctx.onProgress?.('Building CRM lead report…');
      try {
        const report = await deps.crmOps.buildLeadReport({ companyId, ...connectionContext });
        return ok({
          success: true,
          message: report.summary,
          report:  formatCrmResult(report),
        });
      } catch (e) {
        return err(new ToolError({
          toolId: 'zohoCrm', reason: 'upstream_failure', cause: e,
          message: `Lead report failed: ${mapZohoError(e)}`,
        }));
      }
    }

    if (args.op === 'build_deal_forecast') {
      if (personalizedScope) return err(new ToolError({ toolId: 'zohoCrm', reason: 'permission_denied', message: 'Deal forecasts are unavailable for personalized Zoho access.' }));
      ctx.onProgress?.('Building deal forecast…');
      try {
        const closingFrom = args.closingFrom ? parseDateFilter(args.closingFrom).from : undefined;
        const closingTo   = args.closingTo   ? parseDateFilter(args.closingTo).to     : undefined;
        const report = await deps.crmOps.buildDealForecast({
          companyId,
          ...connectionContext,
          ...(closingFrom ? { closingFrom } : {}),
          ...(closingTo ? { closingTo } : {}),
        });
        return ok({
          success: true,
          message: report.summary,
          report:  formatCrmResult(report),
        });
      } catch (e) {
        return err(new ToolError({
          toolId: 'zohoCrm', reason: 'upstream_failure', cause: e,
          message: `Deal forecast failed: ${mapZohoError(e)}`,
        }));
      }
    }

    // ── CRUD operations via paginated client ──────────────────────────────────
    const mod = args.module;

    try {
      switch (args.op) {
        case 'list': {
          if (!mod) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'module is required for list' }));
          ctx.onProgress?.(`Listing ${mod}…`);

          const result = await deps.crmClient.listRecords({
            companyId, ...connectionContext, module: mod,
            perPage: args.limit ?? (ctx.resultAudience === 'local_file' ? 200 : 25),
            ...(args.pageToken ? { pageToken: args.pageToken } : { page: args.page ?? 1 }),
            ...(args.sortBy ? { sortBy: args.sortBy } : {}),
            ...(args.sortOrder ? { sortOrder: args.sortOrder } : {}),
          });

          const items = personalizedScope ? filterZohoRecordsByEmail(result.items, requesterEmail!) : result.items;
          const continuationMissing = result.hasMore
            && !result.nextPageToken
            && (result.page === undefined || result.page >= 10);
          return ok({
            success: true,
            data: formatCrmResult(items),
            message: continuationMissing
              ? `Found ${items.length} ${mod} record(s). Zoho reported more records but returned no continuation token.`
              : `Found ${items.length} ${mod} record(s).`,
            hasMore: result.hasMore,
            ...(continuationMissing ? { truncated: true } : {}),
            ...(result.page !== undefined ? { page: result.page } : {}),
            ...(result.hasMore && result.page !== undefined && result.page < 10 && !result.nextPageToken
              ? { nextPage: result.page + 1 }
              : {}),
            ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
          });
        }

        case 'get': {
          if (!mod) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'module is required for get' }));
          if (!args.recordId) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'recordId is required for get' }));
          ctx.onProgress?.(`Fetching ${mod} record…`);
          const record = await deps.crmClient.getRecord({ companyId, ...connectionContext, module: mod, recordId: args.recordId });
          if (!record || (personalizedScope && !recordMatchesZohoEmail(record, requesterEmail!))) return ok({ success: true, data: null, message: 'Record not found' });
          return ok({ success: true, data: formatCrmResult(record) });
        }

        case 'search': {
          if (!mod) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'module is required for search' }));
          if (!args.criteria) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'criteria is required for search' }));
          ctx.onProgress?.(`Searching ${mod}…`);
          const result = await deps.crmClient.searchRecords({
            companyId, ...connectionContext, module: mod,
            criteria: args.criteria,
            perPage: args.limit ?? (ctx.resultAudience === 'local_file' ? 200 : 25),
            page: args.page ?? 1,
          });
          const items = personalizedScope ? filterZohoRecordsByEmail(result.items, requesterEmail!) : result.items;
          const sourceTruncated = result.hasMore && (result.page ?? args.page ?? 1) >= 10;
          return ok({
            success: true,
            data: formatCrmResult(items),
            message: items.length > 0
              ? `Found ${items.length} ${mod} record(s).${sourceTruncated ? ' Zoho search reached its 2,000-record limit.' : ''}`
              : `No ${mod} records matched the search criteria.`,
            hasMore: result.hasMore,
            ...(result.page !== undefined ? { page: result.page } : {}),
            ...(result.hasMore && !sourceTruncated ? { nextPage: (result.page ?? 1) + 1 } : {}),
            ...(sourceTruncated ? { truncated: true } : {}),
          });
        }

        case 'search_text': {
          if (!mod) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'module is required for search_text' }));
          if (!args.query) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'query is required for search_text' }));
          ctx.onProgress?.(`Searching ${mod} for "${args.query}"…`);
          const result = await deps.crmClient.searchByText({
            companyId, ...connectionContext, module: mod,
            query: args.query,
            perPage: args.limit ?? (ctx.resultAudience === 'local_file' ? 200 : 25),
            page: args.page ?? 1,
          });
          const items = personalizedScope ? filterZohoRecordsByEmail(result.items, requesterEmail!) : result.items;
          const sourceTruncated = result.hasMore && (result.page ?? args.page ?? 1) >= 10;
          return ok({
            success: true,
            data: formatCrmResult(items),
            message: items.length > 0
              ? `Found ${items.length} ${mod} record(s) matching "${args.query}".${sourceTruncated ? ' Zoho search reached its 2,000-record limit.' : ''}`
              : `No ${mod} records found matching "${args.query}".`,
            hasMore: result.hasMore,
            ...(result.page !== undefined ? { page: result.page } : {}),
            ...(result.hasMore && !sourceTruncated ? { nextPage: (result.page ?? 1) + 1 } : {}),
            ...(sourceTruncated ? { truncated: true } : {}),
          });
        }

        case 'create': {
          if (!mod) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'module is required for create' }));
          if (!args.fields) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'fields is required for create' }));
          ctx.onProgress?.(`Creating ${mod} record…`);
          const result = await deps.crmClient.createRecord({ companyId, ...connectionContext, module: mod, fields: args.fields });
          return ok({ success: true, recordId: result.id, message: `${mod} record created` });
        }

        case 'update': {
          if (!mod) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'module is required for update' }));
          if (!args.recordId) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'recordId is required for update' }));
          if (!args.fields) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'fields is required for update' }));
          ctx.onProgress?.(`Updating ${mod} record…`);
          await deps.crmClient.updateRecord({ companyId, ...connectionContext, module: mod, recordId: args.recordId, fields: args.fields });
          return ok({ success: true, recordId: args.recordId, message: `${mod} record updated` });
        }

        case 'delete': {
          if (!mod) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'module is required for delete' }));
          if (!args.recordId) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'recordId is required for delete' }));
          ctx.onProgress?.(`Deleting ${mod} record…`);
          await deps.crmClient.deleteRecord({ companyId, ...connectionContext, module: mod, recordId: args.recordId });
          return ok({ success: true, recordId: args.recordId, message: `${mod} record deleted` });
        }
      }
    } catch (e) {
      return err(new ToolError({
        toolId:  'zohoCrm',
        reason:  'upstream_failure',
        cause:   e,
        message: mapZohoError(e),
      }));
    }
  },
});
