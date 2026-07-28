import { z } from 'zod';
import type { Tool } from '../tool.contract';
import { err, ok } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import { asToolId } from '../../../../shared/ids';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import type { DataExportQueue } from '../../../data-export/data-export.queue';
import {
  DATA_EXPORT_ROW_LIMIT,
  type DataExportJobPayload,
} from '../../../data-export/data-export.types';

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('airtable_records'),
    connectionId: z.string().uuid(),
    toolId: z.enum(['airtableBase', 'airtableRecords']),
    nativeTool: z.enum(['list_records_for_table', 'search_records']),
    input: z.record(z.unknown()),
  }).strict(),
  z.object({
    kind: z.literal('zoho_books'),
    connectionId: z.string().uuid(),
    module: z.enum([
      'contacts', 'invoices', 'estimates', 'creditnotes', 'bills',
      'salesorders', 'purchaseorders', 'customerpayments', 'vendorpayments',
      'bankaccounts', 'banktransactions', 'expenses', 'items',
    ]),
    organizationId: z.string().optional(),
    filters: z.record(z.unknown()).optional(),
    query: z.string().optional(),
  }).strict(),
]);

const Schema = z.object({
  source: sourceSchema,
  transform: z.object({
    script: z.string().min(1).max(20_000),
    args: z.record(z.unknown()).optional(),
  }).strict().optional(),
  destination: z.object({
    format: z.enum(['auto', 'google_sheet', 'csv']),
    title: z.string().min(1).max(120),
    columns: z.array(z.string().min(1)).max(500).optional(),
  }).strict(),
}).strict();

type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success: z.boolean(),
  exportQueued: z.boolean(),
  exportJobId: z.string(),
  message: z.string(),
});

type Res = z.infer<typeof ResultSchema>;

export function createDataExportTool(deps: {
  readonly queue: Pick<DataExportQueue, 'enqueue'>;
}): Tool<Args, Res> {
  return {
    id: asToolId('dataExport'),
    family: 'data',
    actionGroups: new Set(['create']),
    argsSchema: Schema,
    resultSchema: ResultSchema,
    description:
      `Export up to ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} Airtable or Zoho Books rows through a governed, queued pipeline. Source pages and sandboxed transforms stay server-side; only a verified invoker-only Google Sheet or Drive CSV is returned.`,
    parameterDocs: [
      `Use this for large tabular results. The current hard cap is ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} rows. If the user requests more or every row, disclose the cap and never call the result complete.`,
      'source.kind: airtable_records or zoho_books. Always use the exact source connection UUID.',
      'transform.script: optional JavaScript function body. It receives row, index, and args. Return an object, an array of objects, or null to filter.',
      'destination.format: auto chooses Google Sheets for manageable datasets and CSV in Google Drive for large datasets.',
      'destination.title: human-readable artifact title. destination.columns optionally fixes column order.',
      'Artifact access is fixed: the verified invoking user receives reader access. Access changes, additional recipients, domain sharing, and public links are unsupported and must be refused.',
      'The backend re-checks requester RBAC, source access, the configured Google export account, invoker-only sharing, and artifact integrity before delivery.',
    ].join('\n'),

    permissionCheck(args, perm) {
      if (!perm.allowedActionsByTool.get(asToolId('dataExport'))?.has('create')) {
        return err(new PermissionError({ toolId: 'dataExport', action: 'create', reason: 'not_allowed' }));
      }
      const sourceToolId = args.source.kind === 'airtable_records'
        ? args.source.toolId
        : 'zohoBooks';
      if (!perm.allowedActionsByTool.get(asToolId(sourceToolId))?.has('read')) {
        return err(new PermissionError({ toolId: sourceToolId, action: 'read', reason: 'not_allowed' }));
      }
      return ok('create' as ToolActionGroup);
    },

    async execute(args, ctx) {
      if (ctx.runContext.channel !== 'lark' || !ctx.runContext.chatId) {
        return err(new ToolError({
          toolId: 'dataExport',
          reason: 'bad_args',
          message: 'Queued data export currently requires a Lark chat for completion delivery',
        }));
      }
      try {
        const source: DataExportJobPayload['source'] = args.source.kind === 'airtable_records'
          ? { ...args.source }
          : {
              kind: args.source.kind,
              connectionId: args.source.connectionId,
              module: args.source.module,
              ...(args.source.organizationId ? { organizationId: args.source.organizationId } : {}),
              ...(args.source.filters ? { filters: args.source.filters } : {}),
              ...(args.source.query ? { query: args.source.query } : {}),
            };
        const transform: DataExportJobPayload['transform'] = args.transform
          ? {
              script: args.transform.script,
              ...(args.transform.args ? { args: args.transform.args } : {}),
            }
          : undefined;
        const destination: DataExportJobPayload['destination'] = {
          format: args.destination.format,
          title: args.destination.title,
          ...(args.destination.columns ? { columns: args.destination.columns } : {}),
        };
        const payload: DataExportJobPayload = {
          companyId: ctx.runContext.companyId,
          userId: ctx.runContext.userId,
          ...(ctx.runContext.departmentId ? { departmentId: ctx.runContext.departmentId } : {}),
          source,
          ...(transform ? { transform } : {}),
          destination,
          chatId: ctx.runContext.chatId,
          requestId: ctx.runContext.requestId ?? ctx.correlationId,
          ...(ctx.runContext.traceId ? { traceId: ctx.runContext.traceId } : {}),
        };
        const exportJobId = await deps.queue.enqueue(payload);
        return ok({
          success: true,
          exportQueued: true,
          exportJobId,
          message: `Governed data export queued with the current ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')}-row cap. The verified invoker-only Google reader link will be delivered to this Lark chat.`,
        });
      } catch (cause) {
        return err(new ToolError({
          toolId: 'dataExport',
          reason: 'upstream_failure',
          cause,
          message: `Could not queue data export: ${cause instanceof Error ? cause.message : String(cause)}`,
        }));
      }
    },
  };
}
