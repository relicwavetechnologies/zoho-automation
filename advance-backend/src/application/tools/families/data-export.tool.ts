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
import {
  exportPlanRequestSchema,
  type ExportPlanRequest,
} from '../../data-export/export-candidate';
import type {
  DataExportOrchestrationService,
  DataExportPlanResult,
} from '../../data-export/data-export-orchestration.service';
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

const PlanSchema = exportPlanRequestSchema.extend({
  op: z.literal('plan'),
}).strict();

const SampleSchema = z.object({
  op: z.literal('sample'),
  planId: z.string().uuid(),
}).strict();

const ConfirmSampleSchema = z.object({
  op: z.literal('confirm_sample'),
  sampleRunId: z.string().uuid(),
}).strict();

const Schema = z.union([RecipeSchema, ConfirmSchema, PlanSchema, SampleSchema, ConfirmSampleSchema]);

type Args = z.infer<typeof Schema>;
type ConfirmArgs = z.infer<typeof ConfirmSchema>;
type PlanArgs = z.infer<typeof PlanSchema>;
type SampleArgs = z.infer<typeof SampleSchema>;
type ConfirmSampleArgs = z.infer<typeof ConfirmSampleSchema>;

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

const OrchestrationResultSchema = z.object({
  operation: z.enum(['plan', 'sample', 'confirm_sample']),
  success: z.boolean(),
  exportQueued: z.boolean(),
  status: z.enum([
    'direct_queue',
    'sample_required',
    'sample_queued',
    'full_queued',
    'already_confirmed',
    'choose_destination',
    'connect_pending',
    'connect_required',
    'blocked',
    'ambiguous',
  ]),
  planId: z.string().uuid().optional(),
  sampleRunId: z.string().uuid().optional(),
  exportJobId: z.string().optional(),
  sampleRows: z.number().int().positive().optional(),
  reason: z.string().optional(),
  message: z.string(),
  connections: z.array(z.object({
    connectionId: z.string().uuid(),
    label: z.string(),
    accountEmail: z.string().optional(),
  }).strict()).optional(),
}).strict();

const ResultSchema = z.union([CreateResultSchema, ConfirmResultSchema, OrchestrationResultSchema]);

type Res = z.infer<typeof ResultSchema>;

type DataExportOffers = Pick<DataExportOfferService, 'submitAuthorized'>
  & Partial<Pick<DataExportOfferService, 'confirmForActor' | 'confirmLatestForActor'>>;
type DataExportOrchestration = Pick<
  DataExportOrchestrationService,
  'planForActor' | 'queueSample' | 'confirmSample'
>;

export function createDataExportTool(deps: {
  readonly offers: DataExportOffers;
  readonly orchestration?: DataExportOrchestration;
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
      'When a source result returns exportCandidate, use op=plan to export that candidate. If the user did not ask for a file, do not call dataExport.',
      'op=plan: use one or more backend-returned candidate IDs plus the requested format/title. The backend may queue directly, ask for a Google account, require Google connection, require a 100-row sample, or block unsafe plans.',
      'op=sample: queue the backend-held 100-row sample for a plan that returned sample_required. op=confirm_sample: queue the full export after the member confirms the sample.',
      'Legacy op=confirm remains only for old provider offers that returned preview.exportOfferId. Do not use it for exportCandidate results.',
      'op=confirm.format: use google_sheet for Google Sheet/Sheet, csv for CSV, and xlsx for Excel/XL/XLSX. Do not invent source rows, filters, accounts, or a new offer. The backend resolves the active offer in the current authenticated Lark chat when offerId is omitted.',
      'op=confirm.offerId: optional opaque offer ID from the preceding governed result; use it to disambiguate a listed offer but never show it to the user. op=confirm.connectionId is allowed only when Divo returned that exact account choice.',
      'Direct source.kind is for legacy/manual recipes: prefer airtable_records. zoho_books direct recipes are compatibility-only; when a provider result returns exportCandidate, use op=plan instead. Always use the exact source connection UUID.',
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
      if (isConfirmArgs(args) || isPlanArgs(args) || isSampleArgs(args) || isConfirmSampleArgs(args)) {
        return ok('create' as ToolActionGroup);
      }
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
      if (isPlanArgs(args)) return executePlan(args, ctx, deps);
      if (isSampleArgs(args)) return executeSample(args, ctx, deps);
      if (isConfirmSampleArgs(args)) return executeConfirmSample(args, ctx, deps);
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

function isPlanArgs(args: Args): args is PlanArgs {
  return 'op' in args && args.op === 'plan';
}

function isSampleArgs(args: Args): args is SampleArgs {
  return 'op' in args && args.op === 'sample';
}

function isConfirmSampleArgs(args: Args): args is ConfirmSampleArgs {
  return 'op' in args && args.op === 'confirm_sample';
}

async function executePlan(
  args: PlanArgs,
  ctx: ToolExecutionContext,
  deps: {
    readonly orchestration?: DataExportOrchestration;
    readonly beginAuthorization?: BeginGoogleWorkspaceAuthorization;
  },
): Promise<Result<Res, ToolError>> {
  if (!deps.orchestration) {
    return err(new ToolError({
      toolId: 'dataExport',
      reason: 'upstream_failure',
      message: 'AI-controlled export planning is not available in this environment.',
    }));
  }
  const { op: _op, ...plan } = args;
  try {
    const result = await deps.orchestration.planForActor({
      companyId: ctx.runContext.companyId,
      userId: ctx.runContext.userId,
      chatId: ctx.runContext.chatId!,
      ...(ctx.runContext.replyToMessageId ? { progressMessageId: ctx.runContext.replyToMessageId } : {}),
      plan: plan as ExportPlanRequest,
    });
    if (result.status === 'connect_required') {
      return requestGoogleConnectionForPlan(ctx, deps, {
        operation: 'plan',
        planId: result.planId,
        format: args.destination.format,
      });
    }
    return ok(planResultToToolResult(result, args.destination.format));
  } catch (cause) {
    return err(new ToolError({
      toolId: 'dataExport',
      reason: 'upstream_failure',
      cause,
      message: `Could not plan data export: ${cause instanceof Error ? cause.message : String(cause)}`,
    }));
  }
}

async function executeSample(
  args: SampleArgs,
  ctx: ToolExecutionContext,
  deps: {
    readonly orchestration?: DataExportOrchestration;
    readonly beginAuthorization?: BeginGoogleWorkspaceAuthorization;
  },
): Promise<Result<Res, ToolError>> {
  if (!deps.orchestration) {
    return err(new ToolError({
      toolId: 'dataExport',
      reason: 'upstream_failure',
      message: 'AI-controlled export samples are not available in this environment.',
    }));
  }
  try {
    const result = await deps.orchestration.queueSample({
      planId: args.planId,
      companyId: ctx.runContext.companyId,
      userId: ctx.runContext.userId,
      chatId: ctx.runContext.chatId!,
    });
    if (result.status === 'connect_required') {
      return requestGoogleConnectionForPlan(ctx, deps, {
        operation: 'sample',
        planId: result.planId,
        format: 'google_sheet',
      });
    }
    if (result.status === 'sample_queued') {
      return ok({
        operation: 'sample',
        success: true,
        exportQueued: true,
        status: 'sample_queued',
        planId: result.planId,
        sampleRunId: result.sampleRunId,
        exportJobId: result.exportJobId,
        sampleRows: result.sampleRows,
        message: `Queued a ${result.sampleRows.toLocaleString('en-IN')}-row private sample. Review it, then confirm if it looks right and Divo will run the full export.`,
      });
    }
    return ok(planResultToToolResult(
      { ...result, planId: args.planId } as DataExportPlanResult,
      'google_sheet',
      'sample',
      args.planId,
    ));
  } catch (cause) {
    return err(new ToolError({
      toolId: 'dataExport',
      reason: 'upstream_failure',
      cause,
      message: `Could not queue data export sample: ${cause instanceof Error ? cause.message : String(cause)}`,
    }));
  }
}

async function executeConfirmSample(
  args: ConfirmSampleArgs,
  ctx: ToolExecutionContext,
  deps: {
    readonly orchestration?: DataExportOrchestration;
    readonly beginAuthorization?: BeginGoogleWorkspaceAuthorization;
  },
): Promise<Result<Res, ToolError>> {
  if (!deps.orchestration) {
    return err(new ToolError({
      toolId: 'dataExport',
      reason: 'upstream_failure',
      message: 'AI-controlled export sample confirmation is not available in this environment.',
    }));
  }
  try {
    const result = await deps.orchestration.confirmSample({
      sampleRunId: args.sampleRunId,
      companyId: ctx.runContext.companyId,
      userId: ctx.runContext.userId,
      chatId: ctx.runContext.chatId!,
    });
    if (result.status === 'connect_required') {
      return requestGoogleConnectionForPlan(ctx, deps, {
        operation: 'confirm_sample',
        planId: result.planId,
        format: 'google_sheet',
      });
    }
    if (result.status === 'full_queued' || result.status === 'already_confirmed') {
      return ok({
        operation: 'confirm_sample',
        success: true,
        exportQueued: result.status === 'full_queued',
        status: result.status,
        planId: result.planId,
        exportJobId: result.exportJobId,
        message: result.status === 'full_queued'
          ? 'Full export queued from the approved sample plan. Divo will deliver the verified private artifact to this Lark chat. The selected format caps still apply; the completion card will say if rows were omitted.'
          : 'The full export for this sample was already confirmed.',
      });
    }
    return ok(planResultToToolResult(
      { ...result, planId: args.sampleRunId } as DataExportPlanResult,
      'google_sheet',
      'confirm_sample',
      args.sampleRunId,
    ));
  } catch (cause) {
    return err(new ToolError({
      toolId: 'dataExport',
      reason: 'upstream_failure',
      cause,
      message: `Could not confirm data export sample: ${cause instanceof Error ? cause.message : String(cause)}`,
    }));
  }
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
        ? `${formatLabel(format)} export queued. Divo will deliver the verified private artifact to this Lark chat. ${formatLimitReminder(format)}`
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

function planResultToToolResult(
  result: DataExportPlanResult,
  format: DataExportFormat,
  operation: 'plan' | 'sample' | 'confirm_sample' = 'plan',
  planIdFallback?: string,
): Res {
  if (result.status === 'direct_queue') {
    return {
      operation,
      success: true,
      exportQueued: true,
      status: 'direct_queue',
      planId: result.planId,
      exportJobId: result.exportJobId,
      message: `${formatLabel(format)} export queued. Divo will deliver the verified private artifact to this Lark chat. ${formatLimitReminder(format)}`,
    };
  }
  if (result.status === 'sample_required') {
    return {
      operation,
      success: false,
      exportQueued: false,
      status: 'sample_required',
      planId: result.planId,
      sampleRows: result.sampleRows,
      reason: result.reason,
      message: `This export needs a ${result.sampleRows.toLocaleString('en-IN')}-row sample first. Queue the sample, review it, then confirm if it looks right.`,
    };
  }
  if (result.status === 'choose_destination') {
    return {
      operation,
      success: false,
      exportQueued: false,
      status: 'choose_destination',
      planId: result.planId,
      connections: Array.from(result.connections),
      message: 'Choose which Google account should own this export, then retry the same plan with that account.',
    };
  }
  if (result.status === 'connect_required') {
    return {
      operation,
      success: false,
      exportQueued: false,
      status: 'connect_required',
      planId: result.planId,
      message: 'A writable Google account is required for this export. Connect Google in Divo, then ask for the same export again.',
    };
  }
  return {
    operation,
    success: false,
    exportQueued: false,
    status: result.status,
    ...(planIdFallback ? { planId: planIdFallback } : {}),
    reason: result.status === 'blocked' ? result.reason : undefined,
    message: result.message,
  };
}

async function requestGoogleConnectionForPlan(
  ctx: ToolExecutionContext,
  deps: {
    readonly beginAuthorization?: BeginGoogleWorkspaceAuthorization;
  },
  input: {
    readonly operation: 'plan' | 'sample' | 'confirm_sample';
    readonly planId: string;
    readonly format: DataExportFormat;
  },
): Promise<Result<Res, ToolError>> {
  const authorization = await deps.beginAuthorization?.({
    toolId: 'dataExport',
    reason: `Connect your Google account to own this ${formatLabel(input.format)} export. Otherwise Divo can use the company export account and give you read-only access when available.`,
    runContext: ctx.runContext,
  });
  if (authorization && authorization.status !== 'unavailable') {
    return ok({
      operation: input.operation,
      success: false,
      exportQueued: false,
      status: 'connect_pending',
      planId: input.planId,
      message: 'The Google connection card was sent. After Google is connected, ask Divo to continue this export.',
    });
  }
  return ok({
    operation: input.operation,
    success: false,
    exportQueued: false,
    status: 'connect_required',
    planId: input.planId,
    message: 'A writable Google account is required for this export. Connect Google in Divo, then ask for the same export again.',
  });
}

function formatLabel(format: DataExportFormat): string {
  if (format === 'xlsx') return 'Excel (.xlsx)';
  if (format === 'csv') return 'CSV';
  return 'Google Sheet';
}

function formatLimitReminder(format: DataExportFormat): string {
  return `Do not call it complete until the completion card reports final row coverage; ${formatLabel(format)} caps still apply.`;
}
