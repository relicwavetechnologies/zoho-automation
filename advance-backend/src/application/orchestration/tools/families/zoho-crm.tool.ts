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
 * Script mode:
 *   Add a `script` parameter to any list operation to auto-escalate to exhaustive
 *   fetch + VM sandbox (same pattern as Books tool).
 *
 * Token safety:
 *   - CRUD ops return at most `limit` records (default 25, max 200)
 *   - Reports return summary + top-N inline; full dataset → CSV link
 */

import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result }                     from '../../../../shared/result';
import { ok, err }                         from '../../../../shared/result';
import { PermissionError, ToolError }      from '../../../../shared/errors';
import type { ToolActionGroup }            from '../../../../domain/permissions/tool-action-group';
import { asToolId }                        from '../../../../shared/ids';
import type { ZohoCrmOps }                 from '../../../zoho/zoho-crm-ops';
import type { CloudinaryAdapter }          from '../../../../infrastructure/cloudinary/cloudinary.adapter';
import { mapZohoError }                    from '../../../zoho/zoho-error.utils';
import type { ZohoCrmPaginatedClient }     from '../../../../infrastructure/zoho/zoho-crm-paginated.client';
import { getCrmModuleSchema, injectCrmSyntheticFields, toCrmSchemaHint } from '../../../../infrastructure/zoho/zoho-crm-schema.cache';
import { runInSandbox, arrayToCsv, SandboxTimeoutError, SandboxScriptError, SandboxInputTooLargeError, SandboxSerializationError } from '../shared/sandbox-runner';
import { parseDateFilter } from '../../../zoho/zoho-filter.utils';
import { filterZohoRecordsByEmail, normalizedEmail, recordMatchesZohoEmail } from '../../../../shared/zoho-personalization';

// ─── Args schema ──────────────────────────────────────────────────────────────

const Schema = z.object({
  connectionId: z.string().uuid(),
  op: z.enum([
    'list', 'get', 'search', 'search_text', 'create', 'update', 'delete',
    'build_pipeline_summary', 'build_lead_report', 'build_deal_forecast',
  ]),

  module:    z.string().optional(),
  recordId:  z.string().optional(),
  criteria:  z.string().optional(),
  query:     z.string().optional(),
  fields:    z.record(z.unknown()).optional(),
  limit:     z.number().int().min(1).max(200).optional(),
  sortBy:    z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  exportAll: z.boolean().optional(),

  closingFrom: z.string().optional(),
  closingTo:   z.string().optional(),

  script:     z.string().optional(),
  scriptArgs: z.record(z.unknown()).optional(),
  exportCsv:  z.boolean().optional(),
  csvColumns: z.array(z.string()).optional(),
});

type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success:         z.boolean(),
  data:            z.unknown().optional(),
  recordId:        z.string().optional(),
  message:         z.string().optional(),
  report:          z.unknown().optional(),
  csvLink:         z.string().optional(),
  csvPublicId:     z.string().optional(),
  csvExpiresAt:    z.string().optional(),
  truncated:       z.boolean().optional(),
  hasMore:         z.boolean().optional(),
  rowCount:        z.number().optional(),
  totalFetched:    z.number().optional(),
  moduleSchema:    z.unknown().optional(),
  sourceTruncated: z.boolean().optional(),
});

type Res = z.infer<typeof ResultSchema>;

// ─── Client port (simple per-request client, for backwards compat) ────────────

export interface ZohoCrmClientPort {
  searchRecords(module: string, query: string, limit?: number): Promise<unknown[]>;
  getRecord(module: string, recordId: string): Promise<unknown>;
  createRecord(module: string, fields: Record<string, unknown>): Promise<{ recordId: string }>;
  updateRecord(module: string, recordId: string, fields: Record<string, unknown>): Promise<void>;
  deleteRecord(module: string, recordId: string): Promise<void>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const readOps = new Set<Args['op']>([
  'list', 'get', 'search', 'search_text',
  'build_pipeline_summary', 'build_lead_report', 'build_deal_forecast',
]);

const INLINE_SCRIPT_LIMIT = 50;

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

// ─── Script-mode handler ──────────────────────────────────────────────────────

async function executeScriptMode(
  args: Args,
  ctx: ToolExecutionContext,
  scriptDeps: {
    crmClient:  ZohoCrmPaginatedClient;
    cloudinary: CloudinaryAdapter;
    csvLinkTtl?: number;
    requesterEmail?: string | undefined;
  },
): Promise<Result<Res, ToolError>> {
  const { companyId } = ctx.runContext;
  const moduleName = args.module ?? 'Deals';

  ctx.onProgress?.(`Fetching ${moduleName} from Zoho CRM…`);

  let fetchResult: Awaited<ReturnType<typeof scriptDeps.crmClient.listAllRecords>>;
  try {
    fetchResult = await scriptDeps.crmClient.listAllRecords({
      companyId,
      connectionId: args.connectionId,
      userId: ctx.runContext.userId,
      module: moduleName,
      ...(args.sortBy ? { sortBy: args.sortBy } : {}),
      ...(args.sortOrder ? { sortOrder: args.sortOrder } : {}),
    });
  } catch (e) {
    return err(new ToolError({
      toolId: 'zohoCrm', reason: 'upstream_failure',
      message: `Failed to fetch ${moduleName}: ${e instanceof Error ? e.message : String(e)}`,
    }));
  }

  const schema = getCrmModuleSchema(moduleName);
  const scopedRecords = scriptDeps.requesterEmail
    ? filterZohoRecordsByEmail(fetchResult.items, scriptDeps.requesterEmail)
    : fetchResult.items;
  const items = injectCrmSyntheticFields(scopedRecords, schema);
  const schemaHint = toCrmSchemaHint(schema, items[0]);

  ctx.onProgress?.(`Processing ${items.length} ${moduleName}…`);

  ctx.logger.info('zohoCrm.script_mode.run', {
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
    });
  } catch (e) {
    if (e instanceof SandboxTimeoutError || e instanceof SandboxScriptError ||
        e instanceof SandboxInputTooLargeError || e instanceof SandboxSerializationError) {
      return err(new ToolError({ toolId: 'zohoCrm', reason: 'upstream_failure', message: e.message }));
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
      const columns = args.csvColumns ?? Object.keys(firstRow);
      const csvBuffer = arrayToCsv(columns, resultArray);
      const dateStr = new Date().toISOString().slice(0, 10);
      const exported = await scriptDeps.cloudinary.uploadCsvBuffer({
        buffer: csvBuffer,
        fileName: `divo-crm-export-${dateStr}-${companyId.slice(0, 8)}.csv`,
        companyId,
        ttlSeconds: scriptDeps.csvLinkTtl ?? 86_400,
      });
      if (exported) {
        csvLink = exported.signedUrl;
        csvPublicId = exported.publicId;
        csvExpiresAt = exported.expiresAt;
      }
    } catch (e) {
      ctx.logger.warn('zohoCrm.script_mode.csv_failed', { error: String(e) });
    }
  }

  const inlineData = resultArray && resultArray.length > INLINE_SCRIPT_LIMIT
    ? resultArray.slice(0, INLINE_SCRIPT_LIMIT) : sandboxResult.result;

  const parts: string[] = [`Fetched ${items.length} ${moduleName} records from Zoho CRM.`];
  if (fetchResult.truncated) {
    parts.push('DATA INCOMPLETE - pagination limit reached. Totals may be understated.');
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

export const createZohoCrmTool = (deps: {
  getClient:  (companyId: string, userId: string, connectionId?: string) => Promise<ZohoCrmClientPort | null>;
  crmClient:  ZohoCrmPaginatedClient;
  crmOps:     ZohoCrmOps;
  cloudinary: CloudinaryAdapter;
  csvLinkTtl?: number;
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
    'For data analysis, add a `script` parameter to the list operation — fetches ALL records and runs JS in sandbox.',
    'Set exportCsv=true for downloadable CSV of processed results.',
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
    'limit: max records to return (1-200, default 25)',
    'sortBy: field name to sort by (e.g., Created_Time, Amount)',
    'sortOrder: asc|desc',
    'exportAll: true to exhaust all pages for CSV export',
    '',
    'REPORT PARAMS:',
    'build_deal_forecast: closingFrom, closingTo (ISO dates or natural: "this month", "this quarter")',
    '',
    'SCRIPT MODE (list op only):',
    'script: JS code. Receives `data` (array) and `args` (object). Must return a value.',
    '  Synthetic fields: _amount (primary amount), _date (primary date), _id, _status, _owner (resolved name)',
    '  Example: "const g={}; data.forEach(d=>{const s=d._status||\'Unknown\'; if(!g[s])g[s]={stage:s,count:0,total:0}; g[s].count++; g[s].total+=d._amount;}); return Object.values(g).sort((a,b)=>b.total-a.total)"',
    'scriptArgs: extra parameters available as `args` in the script',
    'exportCsv: true to upload script result as CSV',
    'csvColumns: column order for CSV (auto-detected if omitted)',
    '',
    'CRM MODULE FIELDS:',
    'Leads: First_Name, Last_Name, Email, Company, Phone, Lead_Source, Lead_Status, Annual_Revenue, Owner',
    'Contacts: First_Name, Last_Name, Email, Phone, Account_Name (lookup), Owner',
    'Accounts: Account_Name, Website, Phone, Industry, Annual_Revenue, Account_Type, Owner',
    'Deals: Deal_Name, Amount, Stage, Closing_Date, Account_Name (lookup), Contact_Name (lookup), Probability, Owner',
    'Tasks: Subject, Due_Date, Status, Priority, Who_Id (contact lookup), What_Id (deal/account lookup), Owner',
  ].join('\n'),

  permissionCheck(args, perm) {
    const action: ToolActionGroup = readOps.has(args.op) ? 'read'
      : args.op === 'create' ? 'create'
      : args.op === 'update' ? 'update'
      : 'delete';
    const allowed = perm.allowedActionsByTool.get(asToolId('zohoCrm'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'zohoCrm', action, reason: 'not_allowed' }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    const { companyId, userId } = ctx.runContext;
    const connectionContext = {
      connectionId: args.connectionId,
      userId,
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
          ...(report.csvLink ? { csvLink: report.csvLink } : {}),
          ...(report.csvPublicId ? { csvPublicId: report.csvPublicId } : {}),
          ...(report.csvExpiresAt ? { csvExpiresAt: report.csvExpiresAt } : {}),
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
          ...(report.csvLink ? { csvLink: report.csvLink } : {}),
          ...(report.csvPublicId ? { csvPublicId: report.csvPublicId } : {}),
          ...(report.csvExpiresAt ? { csvExpiresAt: report.csvExpiresAt } : {}),
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
          ...(report.csvLink ? { csvLink: report.csvLink } : {}),
          ...(report.csvPublicId ? { csvPublicId: report.csvPublicId } : {}),
          ...(report.csvExpiresAt ? { csvExpiresAt: report.csvExpiresAt } : {}),
        });
      } catch (e) {
        return err(new ToolError({
          toolId: 'zohoCrm', reason: 'upstream_failure', cause: e,
          message: `Deal forecast failed: ${mapZohoError(e)}`,
        }));
      }
    }

    // ── Script mode (auto-escalate list to exhaustive fetch + sandbox) ─────────
    if (args.script && args.op === 'list') {
      return executeScriptMode(args, ctx, {
        crmClient:  deps.crmClient,
        cloudinary: deps.cloudinary,
        ...(deps.csvLinkTtl !== undefined ? { csvLinkTtl: deps.csvLinkTtl } : {}),
        ...(personalizedScope ? { requesterEmail: requesterEmail! } : {}),
      });
    }

    if (args.script) {
      return err(new ToolError({
        toolId: 'zohoCrm', reason: 'bad_args',
        message: 'script is only supported on the list operation, not ' + args.op,
      }));
    }

    // ── CRUD operations via paginated client ──────────────────────────────────
    const mod = args.module;

    try {
      switch (args.op) {
        case 'list': {
          if (!mod) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'module is required for list' }));
          ctx.onProgress?.(`Listing ${mod}…`);

          if (args.exportAll) {
            const { items: sourceItems, truncated } = await deps.crmClient.listAllRecords({
              companyId, ...connectionContext, module: mod,
              ...(args.sortBy ? { sortBy: args.sortBy } : {}),
              ...(args.sortOrder ? { sortOrder: args.sortOrder } : {}),
            });

            const items = personalizedScope ? filterZohoRecordsByEmail(sourceItems, requesterEmail!) : sourceItems;
            let csvLink: string | undefined;
            let csvPublicId: string | undefined;
            let csvExpiresAt: string | undefined;

            if (items.length > (args.limit ?? 25) && deps.cloudinary.isAvailable) {
              try {
                const columns = Object.keys(items[0] ?? {}).filter(k => !k.startsWith('$'));
                const csvBuffer = arrayToCsv(columns, items);
                const exported = await deps.cloudinary.uploadCsvBuffer({
                  buffer: csvBuffer,
                  fileName: `divo-crm-${mod.toLowerCase()}-${new Date().toISOString().slice(0, 10)}-${companyId.slice(0, 8)}.csv`,
                  companyId,
                  ttlSeconds: deps.csvLinkTtl ?? 86_400,
                });
                if (exported) {
                  csvLink = exported.signedUrl;
                  csvPublicId = exported.publicId;
                  csvExpiresAt = exported.expiresAt;
                }
              } catch (e) {
                ctx.logger.warn('zohoCrm.list.csv_failed', { error: String(e) });
              }
            }

            const inline = items.slice(0, args.limit ?? 25);
            let message = `Found ${items.length} ${mod} record(s).`;
            if (items.length > inline.length) message += ` Showing ${inline.length} inline.`;
            if (csvLink) message += ' Full dataset available as CSV.';
            if (truncated) message += ' Pagination limit reached — additional records may exist.';

            return ok({
              success: true,
              data: formatCrmResult(inline),
              message,
              truncated,
              ...(csvLink ? { csvLink } : {}),
              ...(csvPublicId ? { csvPublicId } : {}),
              ...(csvExpiresAt ? { csvExpiresAt } : {}),
            });
          }

          const result = await deps.crmClient.listRecords({
            companyId, ...connectionContext, module: mod,
            perPage: args.limit ?? 25,
            ...(args.sortBy ? { sortBy: args.sortBy } : {}),
            ...(args.sortOrder ? { sortOrder: args.sortOrder } : {}),
          });

          const items = personalizedScope ? filterZohoRecordsByEmail(result.items, requesterEmail!) : result.items;
          return ok({
            success: true,
            data: formatCrmResult(items),
            message: `Found ${items.length} ${mod} record(s).`,
            hasMore: result.hasMore,
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
            perPage: args.limit ?? 25,
          });
          const items = personalizedScope ? filterZohoRecordsByEmail(result.items, requesterEmail!) : result.items;
          return ok({
            success: true,
            data: formatCrmResult(items),
            message: items.length > 0
              ? `Found ${items.length} ${mod} record(s).`
              : `No ${mod} records matched the search criteria.`,
            hasMore: result.hasMore,
          });
        }

        case 'search_text': {
          if (!mod) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'module is required for search_text' }));
          if (!args.query) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'query is required for search_text' }));
          ctx.onProgress?.(`Searching ${mod} for "${args.query}"…`);
          const result = await deps.crmClient.searchByText({
            companyId, ...connectionContext, module: mod,
            query: args.query,
            perPage: args.limit ?? 25,
          });
          const items = personalizedScope ? filterZohoRecordsByEmail(result.items, requesterEmail!) : result.items;
          return ok({
            success: true,
            data: formatCrmResult(items),
            message: items.length > 0
              ? `Found ${items.length} ${mod} record(s) matching "${args.query}".`
              : `No ${mod} records found matching "${args.query}".`,
            hasMore: result.hasMore,
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
