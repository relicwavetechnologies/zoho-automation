/**
 * dataProcessor tool — sandboxed JavaScript execution for data transformation.
 *
 * Two modes:
 *   1. Direct data: LLM passes `data` array from a previous tool call (small datasets)
 *   2. Zoho fetch + process: LLM passes `zohoSource` describing what to fetch from Zoho Books.
 *      The tool fetches ALL records internally (exhaustive pagination), then runs the script.
 *      The LLM never sees the raw dataset — only the processed result.
 *
 * The script runs in a Node.js `vm` sandbox with no filesystem, network, or process access.
 * 5-second timeout, 10 MB data limit.
 */

import vm from 'node:vm';
import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import type { CloudinaryAdapter } from '../../../../infrastructure/cloudinary/cloudinary.adapter';
import type { ZohoBooksPaginatedClient, ZohoBooksModule } from '../../../../infrastructure/zoho/zoho-books-paginated.client';
import { getModuleSchema, injectSyntheticFields, toSchemaHint } from '../../../../infrastructure/zoho/zoho-books-schema.cache';
import { formatAmount, formatDate } from '../../../zoho/zoho-format.utils';

const EXECUTION_TIMEOUT_MS = 5_000;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const INLINE_RESULT_LIMIT = 50;

const zohoSourceSchema = z.object({
  module: z.string().describe('Zoho Books module: invoices, bills, expenses, contacts, customerpayments, bankaccounts, banktransactions, items, etc.'),
  filters: z.record(z.unknown()).optional().describe(
    'Zoho API filters. For "status", pass a single value OR comma-separated values (e.g. "sent,overdue") — the tool splits and merges automatically. ' +
    'Invoice status values: draft, sent, overdue, paid, void, partially_paid, viewed. ' +
    'Bill status values: open, paid, overdue, void. ' +
    'Example: { status: "sent,overdue", from_date: "2025-04-01", to_date: "2026-03-31" }',
  ),
  query: z.string().optional().describe('Search query string'),
}).describe('Fetch ALL records from a Zoho Books module (exhaustive pagination, up to 4000 records). The tool fetches the data internally — the LLM never sees the raw records.');

const Schema = z.object({
  script: z.string().describe(
    'JavaScript code to execute. Receives `data` (array) and `args` (object). Must return the result. ' +
    'ALWAYS use `item._amount` for monetary values when data comes from zohoSource — each record has a pre-computed `_amount` field with the correct value for that module (e.g. expenses use `total`, bills use `total`, payments use `amount`). ' +
    'Example (vendor bill grouping): "const g = {}; for (const b of data) { const v = b.vendor_name || \'Unknown\'; if (!g[v]) g[v] = { vendor: v, count: 0, total: 0 }; g[v].count++; g[v].total += b._amount || 0; } return Object.values(g).sort((a,b) => b.total - a.total)" ' +
    'Example (expense by month): "const m = {}; for (const e of data) { const mon = (e.date || \'\').slice(0,7); if (!mon) continue; if (!m[mon]) m[mon] = { month: mon, count: 0, total: 0 }; m[mon].count++; m[mon].total += e._amount || 0; } return Object.values(m).sort((a,b) => a.month.localeCompare(b.month))"',
  ),
  data: z.unknown().optional().describe(
    'Direct data to process (small datasets from a previous tool call). Omit this when using zohoSource.',
  ),
  zohoSource: zohoSourceSchema.optional().describe(
    'Fetch data from Zoho Books before processing. When set, the tool fetches ALL records internally (exhaustive pagination) then runs the script on them. Use this for large datasets — the LLM only sees the processed result, not the raw records.',
  ),
  args: z.record(z.unknown()).optional().describe(
    'Optional extra parameters for the script (e.g. { minAmount: 1000, groupBy: "vendor_name" }).',
  ),
  exportCsv: z.boolean().optional().describe(
    'If true and result is an array, export as CSV to Cloudinary and return a download link.',
  ),
  csvColumns: z.array(z.string()).optional().describe(
    'Column order for CSV export. If not provided, uses all keys from first result row.',
  ),
});

type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  rowCount: z.number().optional(),
  totalFetched: z.number().optional(),
  message: z.string().optional(),
  csvLink: z.string().optional(),
  csvExpiresAt: z.string().optional(),
  moduleSchema: z.unknown().optional(),
});

type Res = z.infer<typeof ResultSchema>;

function escapeCsvCell(v: unknown): string {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function arrayToCsv(headers: string[], rows: unknown[]): Buffer {
  const lines: string[] = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    if (row && typeof row === 'object') {
      const r = row as Record<string, unknown>;
      lines.push(headers.map(h => escapeCsvCell(r[h])).join(','));
    }
  }
  lines.push('');
  lines.push(`Generated by Divo on ${new Date().toISOString()}`);
  return Buffer.from(lines.join('\n'), 'utf-8');
}

export const createDataProcessorTool = (deps: {
  cloudinary:  CloudinaryAdapter;
  booksClient: ZohoBooksPaginatedClient;
  csvLinkTtl?: number;
}): Tool<Args, Res> => ({
  id: asToolId('dataProcessor'),
  family: 'data',
  actionGroups: new Set(['read']),
  argsSchema: Schema,
  resultSchema: ResultSchema,

  description: [
    'Process and transform data using a sandboxed JavaScript script.',
    'Two modes: (1) pass data directly for small datasets, (2) set zohoSource to fetch ALL records from a Zoho Books module internally (exhaustive pagination, up to 4000 records) then process.',
    'Use zohoSource for grouping/aggregation/analysis queries — the tool fetches the complete dataset, runs your script, and returns only the processed result.',
    'The script receives `data` (array) and `args` (object). It must return a value.',
    'IMPORTANT: Every record fetched via zohoSource has a synthetic `_amount` field with the correct monetary value for that module — always use `item._amount` for totals instead of guessing field names like `amount` or `total`.',
    'Set exportCsv=true to get a downloadable CSV of the processed result.',
  ].join(' '),

  parameterDocs: [
    'script: JS code. Receives `data` (array) and `args` (object). Must `return` a value.',
    '  ALWAYS use `item._amount` for the monetary value — Zoho uses different field names per module.',
    '  expenses/_amount = total, bills/_amount = total, invoices/_amount = total, payments/_amount = amount',
    '  Example (expense breakdown by month):',
    '  "const m = {}; for (const e of data) { const mon = (e.date||e.expense_date||\'\').slice(0,7); if (!m[mon]) m[mon]={month:mon,count:0,total:0,currency:e.currency_code||\'INR\'}; m[mon].count++; m[mon].total+=e._amount||0; } return Object.values(m).sort((a,b)=>a.month.localeCompare(b.month))"',
    '',
    'zohoSource: { module: "expenses", filters: { from_date: "2025-11-01", to_date: "2026-04-30" } }',
    '  Fetches ALL records from the specified Zoho Books module with filters.',
    '  Supported modules: invoices, bills, expenses, contacts, customerpayments, bankaccounts, banktransactions, items',
    '  The fetched records become `data` in the script. You do NOT need to call zohoBooks separately.',
    '  Note: For expenses, date filtering uses from_date/to_date but Zoho may return all records — filter in the script using the date field.',
    '',
    'data: pass directly for small datasets (< 100 items). Omit when using zohoSource.',
    'args: optional extra parameters for the script',
    'exportCsv: true to upload processed result as CSV and return download link',
    'csvColumns: column order for CSV (optional, auto-detected if omitted)',
  ].join('\n'),

  permissionCheck(_args, perm) {
    const allowed = perm.allowedToolIds.has(asToolId('dataProcessor'));
    return allowed
      ? ok('read' as ToolActionGroup)
      : err(new PermissionError({ toolId: 'dataProcessor', action: 'read', reason: 'not_allowed' }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    const { companyId } = ctx.runContext;

    // ── Resolve input data ─────────────────────────────────────────────────
    let inputData: unknown;
    let totalFetched: number | undefined;
    let moduleSchemaHint: Record<string, unknown> | undefined;

    if (args.zohoSource) {
      // Fetch from Zoho Books internally — LLM never sees the raw records
      ctx.logger.info('data_processor.zoho_fetch.start', {
        companyId,
        module: args.zohoSource.module,
        filters: args.zohoSource.filters,
        query: args.zohoSource.query,
      });

      // 1. Fetch data from Zoho
      let fetchResult: Awaited<ReturnType<typeof deps.booksClient.listAllRecords>>;
      try {
        fetchResult = await deps.booksClient.listAllRecords({
          companyId,
          moduleName: args.zohoSource.module as ZohoBooksModule,
          ...(args.zohoSource.filters ? { filters: args.zohoSource.filters as Record<string, string> } : {}),
          ...(args.zohoSource.query ? { query: args.zohoSource.query } : {}),
        });
      } catch (e) {
        ctx.logger.error('data_processor.zoho_fetch.failed', {
          companyId,
          module: args.zohoSource.module,
          error: e instanceof Error ? e.message : String(e),
        });
        return err(new ToolError({
          toolId: 'dataProcessor',
          reason: 'upstream_failure',
          message: `Failed to fetch ${args.zohoSource.module} from Zoho Books: ${e instanceof Error ? e.message : String(e)}`,
        }));
      }

      // 2. Resolve field schema from static registry (zero API calls, no async)
      const schema = getModuleSchema(args.zohoSource.module);

      // 3. Inject _amount / _date / _id synthetic fields so LLM scripts use consistent names
      const items = injectSyntheticFields(fetchResult.items, schema);
      moduleSchemaHint = toSchemaHint(schema);

      ctx.logger.info('data_processor.schema_injected', {
        companyId,
        module:        args.zohoSource.module,
        primaryAmount: schema.primaryAmount,
        primaryDate:   schema.primaryDate,
      });

      inputData    = items;
      totalFetched = items.length;

      ctx.logger.info('data_processor.zoho_fetch.done', {
        companyId,
        module:         args.zohoSource.module,
        recordsFetched: totalFetched,
        truncated:      fetchResult.truncated,
      });
    } else if (args.data !== undefined) {
      inputData = args.data;
    } else {
      return err(new ToolError({
        toolId: 'dataProcessor',
        reason: 'bad_args',
        message: 'Either data or zohoSource must be provided.',
      }));
    }

    // ── Input size guard ───────────────────────────────────────────────────
    const dataStr = JSON.stringify(inputData);
    if (dataStr.length > MAX_INPUT_BYTES) {
      return err(new ToolError({
        toolId: 'dataProcessor',
        reason: 'bad_args',
        message: `Input data too large (${(dataStr.length / 1024 / 1024).toFixed(1)} MB). Max is 10 MB.`,
      }));
    }

    ctx.logger.info('data_processor.execute', {
      companyId,
      scriptLength: args.script.length,
      dataSize: dataStr.length,
      dataRecords: Array.isArray(inputData) ? inputData.length : 'non-array',
      hasArgs: !!args.args,
      exportCsv: args.exportCsv ?? false,
      source: args.zohoSource ? 'zoho_fetch' : 'direct',
    });

    // ── Build sandbox ──────────────────────────────────────────────────────
    const sandbox = {
      data:   JSON.parse(dataStr),
      args:   args.args ?? {},
      schema: moduleSchemaHint ?? null,  // available in script as `schema.primaryAmount` etc.
      formatAmount,
      formatDate,
      Math,
      Date,
      JSON,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      console: { log: () => {}, warn: () => {}, error: () => {} },
    };

    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });

    // ── Execute script ─────────────────────────────────────────────────────
    let result: unknown;
    try {
      const wrappedScript = `(function() { ${args.script} })()`;
      result = vm.runInContext(wrappedScript, context, {
        timeout: EXECUTION_TIMEOUT_MS,
        filename: 'data-processor-sandbox.js',
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.logger.warn('data_processor.script_error', { companyId, error: message });

      if (message.includes('Script execution timed out')) {
        return err(new ToolError({
          toolId: 'dataProcessor',
          reason: 'upstream_failure',
          message: 'Script timed out after 5 seconds. Simplify the processing logic.',
        }));
      }

      return err(new ToolError({
        toolId: 'dataProcessor',
        reason: 'upstream_failure',
        message: `Script error: ${message}`,
      }));
    }

    // ── Serialize result ───────────────────────────────────────────────────
    let serialized: unknown;
    try {
      serialized = JSON.parse(JSON.stringify(result));
    } catch {
      return err(new ToolError({
        toolId: 'dataProcessor',
        reason: 'upstream_failure',
        message: 'Script returned a value that cannot be serialized to JSON.',
      }));
    }

    const serializedArray = Array.isArray(serialized) ? serialized as unknown[] : null;
    const rowCount = serializedArray?.length;

    ctx.logger.info('data_processor.result', {
      companyId,
      isArray: !!serializedArray,
      rowCount,
      resultSize: JSON.stringify(serialized).length,
      source: args.zohoSource ? 'zoho_fetch' : 'direct',
    });

    // ── CSV export ─────────────────────────────────────────────────────────
    let csvLink: string | undefined;
    let csvExpiresAt: string | undefined;

    if (args.exportCsv && serializedArray && serializedArray.length > 0 && deps.cloudinary.isAvailable) {
      try {
        const firstRow = serializedArray[0] as Record<string, unknown>;
        const columns = args.csvColumns ?? Object.keys(firstRow);
        const csvBuffer = arrayToCsv(columns, serializedArray);
        const dateStr = new Date().toISOString().slice(0, 10);
        const fileName = `divo-export-${dateStr}-${companyId.slice(0, 8)}.csv`;

        const exported = await deps.cloudinary.uploadCsvBuffer({
          buffer: csvBuffer,
          fileName,
          companyId,
          ttlSeconds: deps.csvLinkTtl ?? 86_400,
        });

        if (exported) {
          csvLink = exported.signedUrl;
          csvExpiresAt = exported.expiresAt;
          ctx.logger.info('data_processor.csv_exported', { companyId, fileName, rows: serializedArray.length });
        }
      } catch (e) {
        ctx.logger.warn('data_processor.csv_failed', { companyId, error: String(e) });
      }
    }

    // ── Response ───────────────────────────────────────────────────────────
    const inlineData = serializedArray && serializedArray.length > INLINE_RESULT_LIMIT
      ? serializedArray.slice(0, INLINE_RESULT_LIMIT)
      : serialized;

    const parts: string[] = [];
    if (totalFetched !== undefined) parts.push(`Fetched ${totalFetched} records from Zoho Books.`);
    if (serializedArray) {
      parts.push(`Processed into ${serializedArray.length} rows.`);
      if (serializedArray.length > INLINE_RESULT_LIMIT) parts.push(`Showing first ${INLINE_RESULT_LIMIT} inline.`);
    } else {
      parts.push('Processing complete.');
    }
    if (csvLink) parts.push('Full CSV available via download link.');

    return ok({
      success: true,
      data: inlineData,
      rowCount,
      totalFetched,
      message: parts.join(' '),
      ...(csvLink ? { csvLink } : {}),
      ...(csvExpiresAt ? { csvExpiresAt } : {}),
      ...(moduleSchemaHint ? { moduleSchema: moduleSchemaHint } : {}),
    });
  },
});
