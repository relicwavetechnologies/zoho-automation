import { z } from 'zod';
import type { Tool } from '../tool.contract';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import { asToolId } from '../../../shared/ids';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import type { DataExportOfferService } from '../../data-export/data-export-offer.service';
import {
  DATA_EXPORT_ROW_LIMIT,
  datasetSourceSchema,
  datasetSourceToolId,
} from '../../data-export/data-export.types';
import {
  dataExportDestinationSchema,
  dataExportTransformSchema,
  type DataExportOfferPayload,
} from '../../data-export/export-offer';

const RecipeSchema = z.object({
  source: datasetSourceSchema,
  transform: dataExportTransformSchema.optional(),
  destination: dataExportDestinationSchema.extend({
    connectionId: z.string().uuid().optional(),
  }).strict(),
}).strict();

const ConfirmOfferSchema = z.object({
  offerId: z.string().uuid(),
  destinationConnectionId: z.string().uuid().optional(),
}).strict();

const Schema = z.union([RecipeSchema, ConfirmOfferSchema]);

type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success: z.boolean(),
  exportQueued: z.boolean(),
  exportJobId: z.string(),
  message: z.string(),
});

type Res = z.infer<typeof ResultSchema>;

export function createDataExportTool(deps: {
  readonly offers: Pick<DataExportOfferService, 'submitAuthorized' | 'confirmForActor'>;
}): Tool<Args, Res> {
  return {
    id: asToolId('dataExport'),
    family: 'data',
    actionGroups: new Set(['create']),
    argsSchema: Schema,
    resultSchema: ResultSchema,
    description:
      `Export up to ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} Airtable or Zoho Books rows through a governed, queued pipeline. Source pages and sandboxed transforms stay server-side; only a verified invoker-only Google Sheet, Excel file, or Drive CSV is returned.`,
    parameterDocs: [
      `Use this for large tabular results. The current hard cap is ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} rows. If the user requests more or every row, disclose the cap and never call the result complete.`,
      'offerId: when a source preview returned preview.exportOfferId and the user explicitly confirms, call dataExport with that opaque offerId. Include destinationConnectionId only when a prior confirmation response asked the user to choose one exact eligible Google account.',
      'source.kind: airtable_records or zoho_books. Always use the exact source connection UUID.',
      'transform.script: optional JavaScript function body. It receives row, index, and args. Return an object, an array of objects, or null to filter.',
      'destination.format: auto chooses Google Sheets for manageable datasets and CSV in Google Drive for large datasets.',
      'Use destination.format=xlsx only when the user explicitly requests Excel. Excel is limited to 5,000 rows and 100,000 cells; use CSV for wider datasets.',
      'destination.title: human-readable artifact title. destination.columns optionally fixes column order.',
      'Artifact access is fixed by the backend: a selected personal Google account owns its export; the governed company fallback grants reader access only to the verified invoker. Additional recipients, domain sharing, and public links are unsupported and must be refused.',
      'The backend re-checks requester RBAC, source access, the configured Google export account, invoker-only sharing, and artifact integrity before delivery.',
    ].join('\n'),

    permissionCheck(args, perm) {
      if (!perm.allowedActionsByTool.get(asToolId('dataExport'))?.has('create')) {
        return err(new PermissionError({ toolId: 'dataExport', action: 'create', reason: 'not_allowed' }));
      }
      if ('source' in args) {
        const sourceToolId = datasetSourceToolId(args.source);
        if (!perm.allowedActionsByTool.get(asToolId(sourceToolId))?.has('read')) {
          return err(new PermissionError({ toolId: sourceToolId, action: 'read', reason: 'not_allowed' }));
        }
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
        if ('offerId' in args) {
          const confirmed = await deps.offers.confirmForActor({
            offerId: args.offerId,
            companyId: ctx.runContext.companyId,
            userId: ctx.runContext.userId,
            chatId: ctx.runContext.chatId,
            ...(args.destinationConnectionId
              ? { destinationConnectionId: args.destinationConnectionId }
              : {}),
          });
          if (confirmed.disposition === 'choose_destination') {
            const choices = confirmed.connections
              .map(connection => `${connection.accountEmail ?? connection.label} — ${connection.connectionId}`)
              .join('; ');
            return ok({
              success: true,
              exportQueued: false,
              exportJobId: args.offerId,
              message: `Ask the user which Google account should own the export, then retry with its exact destinationConnectionId: ${choices}`,
            });
          }
          if (confirmed.disposition === 'connect_required') {
            return ok({
              success: true,
              exportQueued: false,
              exportJobId: args.offerId,
              message: 'Use the export card in Lark to connect Google. Divo will resume this exact export after authorization.',
            });
          }
          return ok({
            success: true,
            exportQueued: confirmed.disposition !== 'in_progress',
            exportJobId: confirmed.exportJobId,
            message: confirmed.disposition === 'in_progress'
              ? 'This data export confirmation is already in progress. If no progress update appears within a minute, confirm it again.'
              : confirmed.disposition === 'already_confirmed'
                ? 'This data export was already confirmed. Its existing job will deliver the result to the original Divo conversation.'
                : `Data export confirmed with the current ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')}-row cap. The result will be delivered to the original Divo conversation.`,
          });
        }
        const source: DataExportOfferPayload['source'] = args.source.kind === 'airtable_records'
          ? { ...args.source }
          : {
              kind: args.source.kind,
              connectionId: args.source.connectionId,
              module: args.source.module,
              ...(args.source.organizationId ? { organizationId: args.source.organizationId } : {}),
              ...(args.source.filters ? { filters: args.source.filters } : {}),
              ...(args.source.query ? { query: args.source.query } : {}),
            };
        const transform: DataExportOfferPayload['transform'] = args.transform
          ? {
              script: args.transform.script,
              ...(args.transform.args ? { args: args.transform.args } : {}),
            }
          : undefined;
        const destination: DataExportOfferPayload['destination'] = {
          format: args.destination.format,
          title: args.destination.title,
          ...(args.destination.columns ? { columns: args.destination.columns } : {}),
        };
        const payload: DataExportOfferPayload = {
          companyId: ctx.runContext.companyId,
          userId: ctx.runContext.userId,
          ...(ctx.runContext.departmentId ? { departmentId: ctx.runContext.departmentId } : {}),
          source,
          ...(transform ? { transform } : {}),
          destination,
          chatId: ctx.runContext.chatId,
          ...(ctx.runContext.replyToMessageId
            ? { replyToMessageId: ctx.runContext.replyToMessageId }
            : {}),
          ...(ctx.runContext.replyInThread !== undefined
            ? { replyInThread: ctx.runContext.replyInThread }
            : {}),
          requestId: ctx.runContext.requestId ?? ctx.correlationId,
          ...(ctx.runContext.traceId ? { traceId: ctx.runContext.traceId } : {}),
        };
        const exportJobId = await deps.offers.submitAuthorized(
          payload,
          args.destination.connectionId,
        );
        return ok({
          success: true,
          exportQueued: true,
          exportJobId,
          message: `Governed data export queued with the current ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')}-row cap. The verified private Google artifact will be delivered to this Lark chat.`,
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
