import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import { err, ok, type Result } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import { asToolId } from '../../../shared/ids';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import type {
  DataExportFormat,
  DataExportOfferService,
  NaturalLanguageDataExportConfirmationResult,
} from '../../data-export/data-export-offer.service';
import type { BeginGoogleWorkspaceAuthorization } from './google-workspace-mcp.tool';
import {
  directDatasetSourceSchema,
  datasetSourceToolId,
} from '../../data-export/data-export.types';
import { dataExportCallRequestId } from '../../data-export/export-request-identity';
import {
  DATA_EXPORT_CSV_ROW_LIMIT,
  DATA_EXPORT_GOOGLE_SHEET_CELL_LIMIT,
  DATA_EXPORT_GOOGLE_SHEET_ROW_LIMIT,
  DATA_EXPORT_XLSX_CELL_LIMIT,
  DATA_EXPORT_XLSX_ROW_LIMIT,
  dataExportRowLimitForFormat,
} from '../../data-export/data-export-limits';
import {
  dataExportDestinationSchema,
  dataExportTransformSchema,
  type DataExportOfferPayload,
} from '../../data-export/export-offer';

const RecipeSchema = z.object({
  op: z.literal('create').optional(),
  source: directDatasetSourceSchema,
  transform: dataExportTransformSchema.optional(),
  destination: dataExportDestinationSchema.extend({
    connectionId: z.string().uuid().optional(),
  }).strict(),
}).strict();

const ConfirmSchema = z.object({
  op: z.literal('confirm'),
  /** Optional opaque handle when the preceding offer is still in context. */
  offerId: z.string().uuid().optional(),
  format: z.enum(['google_sheet', 'csv', 'xlsx']),
  /** Only use an exact connection returned by a prior backend result. */
  connectionId: z.string().uuid().optional(),
}).strict();

const Schema = z.union([RecipeSchema, ConfirmSchema]);

type Args = z.infer<typeof Schema>;
type ConfirmArgs = z.infer<typeof ConfirmSchema>;

const CreateResultSchema = z.object({
  success: z.boolean(),
  exportQueued: z.boolean(),
  exportJobId: z.string(),
  message: z.string(),
});

const ConfirmResultSchema = z.object({
  operation: z.literal('confirm'),
  success: z.boolean(),
  exportQueued: z.boolean(),
  status: z.enum([
    'queued',
    'already_confirmed',
    'in_progress',
    'connect_pending',
    'connect_required',
    'choose_destination',
    'no_pending_offer',
    'ambiguous',
  ]),
  exportJobId: z.string().optional(),
  message: z.string(),
  connections: z.array(z.object({
    connectionId: z.string().uuid(),
    label: z.string(),
    accountEmail: z.string().optional(),
  }).strict()).optional(),
  offers: z.array(z.object({
    offerId: z.string().uuid(),
    title: z.string(),
    sourceKind: z.string(),
    createdAt: z.string(),
  }).strict()).optional(),
  moreAvailable: z.boolean().optional(),
}).strict();

const ResultSchema = z.union([CreateResultSchema, ConfirmResultSchema]);

type Res = z.infer<typeof ResultSchema>;

type DataExportOffers = Pick<DataExportOfferService, 'submitAuthorized'>
  & Partial<Pick<DataExportOfferService, 'confirmForActor' | 'confirmLatestForActor'>>;

export function createDataExportTool(deps: {
  readonly offers: DataExportOffers;
  readonly beginAuthorization?: BeginGoogleWorkspaceAuthorization;
}): Tool<Args, Res> {
  return {
    id: asToolId('dataExport'),
    family: 'data',
    actionGroups: new Set(['create']),
    argsSchema: Schema,
    resultSchema: ResultSchema,
    description:
      `Export up to ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')} governed rows through Divo's queued pipeline, or confirm an existing provider export offer from a natural-language format choice. Source pages and sandboxed transforms stay server-side; only a verified invoker-only Google Sheet, Excel file, or Drive CSV is returned.`,
    parameterDocs: [
      `Format limits: Excel ${DATA_EXPORT_XLSX_ROW_LIMIT.toLocaleString('en-IN')} rows/${DATA_EXPORT_XLSX_CELL_LIMIT.toLocaleString('en-IN')} cells; Google Sheets ${DATA_EXPORT_GOOGLE_SHEET_ROW_LIMIT.toLocaleString('en-IN')} rows/${DATA_EXPORT_GOOGLE_SHEET_CELL_LIMIT.toLocaleString('en-IN')} cells; CSV/auto ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')} rows. If the user requests more or every row, disclose the applicable cap and never call a truncated result complete.`,
      'When a source preview returns preview.exportOfferId, preserve the offer and finish the answer with the available card. If the user later chooses a format in natural language, call this tool with op=confirm instead of rerunning the source query.',
      'op=confirm.format: use google_sheet for Google Sheet/Sheet, csv for CSV, and xlsx for Excel/XL/XLSX. Do not invent source rows, filters, accounts, or a new offer. The backend resolves the active offer in the current authenticated Lark chat when offerId is omitted.',
      'op=confirm.offerId: optional opaque offer ID from the preceding governed result; use it to disambiguate a listed offer but never show it to the user. op=confirm.connectionId is allowed only when Divo returned that exact account choice.',
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
      if (isConfirmArgs(args)) return ok('create' as ToolActionGroup);
      const sourceToolId = datasetSourceToolId(args.source);
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
      if (isConfirmArgs(args)) return executeConfirmation(args, ctx, deps);
      try {
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
          ...(ctx.runContext.runtimeThreadId
            ? { conversationKey: ctx.runContext.runtimeThreadId }
            : {}),
          ...(ctx.runContext.replyToMessageId
            ? { replyToMessageId: ctx.runContext.replyToMessageId }
            : {}),
          ...(ctx.runContext.replyInThread !== undefined
            ? { replyInThread: ctx.runContext.replyInThread }
            : {}),
          requestId: dataExportCallRequestId(ctx.runContext, ctx.correlationId),
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
          message: `Governed data export queued with the ${dataExportRowLimitForFormat(args.destination.format).toLocaleString('en-IN')}-row limit for ${args.destination.format}. The verified private Google artifact will be delivered to this Lark chat.`,
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

function isConfirmArgs(args: Args): args is ConfirmArgs {
  return 'op' in args && args.op === 'confirm';
}

async function executeConfirmation(
  args: ConfirmArgs,
  ctx: ToolExecutionContext,
  deps: {
    readonly offers: DataExportOffers;
    readonly beginAuthorization?: BeginGoogleWorkspaceAuthorization;
  },
): Promise<Result<Res, ToolError>> {
  const format = args.format as DataExportFormat;
  ctx.logger.info('data_export.natural_confirmation.requested', {
    correlationId: ctx.correlationId,
    companyId: ctx.runContext.companyId,
    userId: ctx.runContext.userId,
    chatId: ctx.runContext.chatId,
    format,
    hasOfferId: Boolean(args.offerId),
  });
  try {
    let naturalResult: NaturalLanguageDataExportConfirmationResult;
    if (args.offerId) {
      if (!deps.offers.confirmForActor) {
        throw new Error('Natural-language data export confirmation has no offerId handler.');
      }
      const confirmation = await deps.offers.confirmForActor({
        offerId: args.offerId,
        companyId: ctx.runContext.companyId,
        userId: ctx.runContext.userId,
        chatId: ctx.runContext.chatId!,
        destinationFormat: format,
        ...(args.connectionId ? { destinationConnectionId: args.connectionId } : {}),
        ...(ctx.runContext.replyToMessageId
          ? { progressMessageId: ctx.runContext.replyToMessageId }
          : {}),
      });
      if (confirmation.disposition === 'connect_required') {
        return requestGoogleConnection(ctx, deps, format, args.offerId);
      }
      naturalResult = { ...confirmation, offerId: args.offerId };
    } else {
      if (!deps.offers.confirmLatestForActor) {
        throw new Error('Natural-language data export confirmation has no active offer lookup handler.');
      }
      naturalResult = await deps.offers.confirmLatestForActor({
        companyId: ctx.runContext.companyId,
        userId: ctx.runContext.userId,
        chatId: ctx.runContext.chatId!,
        destinationFormat: format,
        ...(args.connectionId ? { destinationConnectionId: args.connectionId } : {}),
        ...(ctx.runContext.replyToMessageId
          ? { progressMessageId: ctx.runContext.replyToMessageId }
          : {}),
      });
    }
    if (naturalResult.disposition === 'connect_required') {
      const offerId = 'offerId' in naturalResult ? naturalResult.offerId : undefined;
      if (!offerId) throw new Error('Google continuation is missing the export offer ID.');
      return requestGoogleConnection(ctx, deps, format, offerId);
    }
    ctx.logger.info('data_export.natural_confirmation.resolved', {
      correlationId: ctx.correlationId,
      companyId: ctx.runContext.companyId,
      userId: ctx.runContext.userId,
      chatId: ctx.runContext.chatId,
      format,
      disposition: naturalResult.disposition,
      offerId: 'offerId' in naturalResult ? naturalResult.offerId : undefined,
      candidateCount: 'offers' in naturalResult ? naturalResult.offers.length : undefined,
      moreAvailable: 'moreAvailable' in naturalResult ? naturalResult.moreAvailable : undefined,
    });
    if (naturalResult.disposition === 'no_pending_offer') {
      return ok({
        operation: 'confirm',
        success: false,
        exportQueued: false,
        status: 'no_pending_offer',
        message: 'I could not find an active export offer in this Divo conversation. Ask me to prepare the data again, then choose the format.',
      });
    }
    if (naturalResult.disposition === 'ambiguous') {
      return ok({
        operation: 'confirm',
        success: false,
        exportQueued: false,
        status: 'ambiguous',
        message: 'I found multiple active export requests in this conversation. Tell me which result you want in this format.',
        offers: Array.from(naturalResult.offers),
        moreAvailable: naturalResult.moreAvailable,
      });
    }
    if (naturalResult.disposition === 'choose_destination') {
      return ok({
        operation: 'confirm',
        success: false,
        exportQueued: false,
        status: 'choose_destination',
        message: 'Choose which Google account should own this export, then tell me the format again.',
        connections: Array.from(naturalResult.connections),
      });
    }

    ctx.logger.info('data_export.natural_confirmation.completed', {
      correlationId: ctx.correlationId,
      companyId: ctx.runContext.companyId,
      userId: ctx.runContext.userId,
      chatId: ctx.runContext.chatId,
      format,
      offerId: 'offerId' in naturalResult ? naturalResult.offerId : args.offerId,
      disposition: naturalResult.disposition,
      exportJobId: 'exportJobId' in naturalResult ? naturalResult.exportJobId : undefined,
    });
    return ok({
      operation: 'confirm',
      success: true,
      exportQueued: naturalResult.disposition === 'queued',
      status: naturalResult.disposition,
      exportJobId: 'exportJobId' in naturalResult ? naturalResult.exportJobId : undefined,
      message: naturalResult.disposition === 'queued'
        ? `${formatLabel(format)} export queued. Divo will deliver the verified private artifact to this Lark chat.`
        : naturalResult.disposition === 'in_progress'
        ? 'An export for this request is already being processed. Divo will deliver the active artifact; ask again for this format after it completes.'
        : `The ${formatLabel(format)} export was already confirmed for this request.`,
    });
  } catch (cause) {
    ctx.logger.warn('data_export.natural_confirmation.failed', {
      correlationId: ctx.correlationId,
      companyId: ctx.runContext.companyId,
      userId: ctx.runContext.userId,
      chatId: ctx.runContext.chatId,
      format,
      hasOfferId: Boolean(args.offerId),
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return err(new ToolError({
      toolId: 'dataExport',
      reason: 'upstream_failure',
      cause,
      message: `Could not confirm data export: ${cause instanceof Error ? cause.message : String(cause)}`,
    }));
  }
}

async function requestGoogleConnection(
  ctx: ToolExecutionContext,
  deps: {
    readonly offers: DataExportOffers;
    readonly beginAuthorization?: BeginGoogleWorkspaceAuthorization;
  },
  format: DataExportFormat,
  offerId: string,
): Promise<Result<Res, ToolError>> {
  const authorization = await deps.beginAuthorization?.({
    toolId: 'dataExport',
    reason: `Connect a writable Google account to create this ${formatLabel(format)} export.`,
    runContext: ctx.runContext,
    ...(ctx.runContext.replyToMessageId
      ? {
          continuationPayload: {
            kind: 'data_export_confirmation' as const,
            offerId,
            progressMessageId: ctx.runContext.replyToMessageId,
            format,
          },
        }
      : {}),
  });
  if (authorization && authorization.status !== 'unavailable') {
    ctx.logger.info('data_export.natural_confirmation.authorization_pending', {
      correlationId: ctx.correlationId,
      companyId: ctx.runContext.companyId,
      userId: ctx.runContext.userId,
      format,
      authorizationStatus: authorization.status,
    });
    return ok({
      operation: 'confirm',
      success: false,
      exportQueued: false,
      status: 'connect_pending',
      message: ctx.runContext.replyToMessageId
        ? 'The Google connection card was sent. Divo will continue this exact export after Google is connected.'
        : 'The Google connection card was sent. After Google is connected, ask Divo for this format again.',
    });
  }
  ctx.logger.warn('data_export.natural_confirmation.authorization_unavailable', {
    correlationId: ctx.correlationId,
    companyId: ctx.runContext.companyId,
    userId: ctx.runContext.userId,
    format,
  });
  return ok({
    operation: 'confirm',
    success: false,
    exportQueued: false,
    status: 'connect_required',
    message: 'A writable Google account is required for this export. Connect Google in Divo, then ask for the same format again.',
  });
}

function formatLabel(format: DataExportFormat): string {
  if (format === 'xlsx') return 'Excel (.xlsx)';
  if (format === 'csv') return 'CSV';
  return 'Google Sheet';
}
