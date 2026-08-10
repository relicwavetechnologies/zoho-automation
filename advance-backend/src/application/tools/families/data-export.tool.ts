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
import { dataExportCallRequestId, dataExportRunRequestId } from '../../data-export/export-request-identity';
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

const ListCandidatesSchema = z.object({
  op: z.literal('list_candidates'),
  scope: z.enum(['chat', 'run']).optional(),
}).strict();

const Schema = z.union([
  RecipeSchema,
  ConfirmSchema,
  PlanSchema,
  ListCandidatesSchema,
]);

type Args = z.infer<typeof Schema>;
type ConfirmArgs = z.infer<typeof ConfirmSchema>;
type PlanArgs = z.infer<typeof PlanSchema>;
type ListCandidatesArgs = z.infer<typeof ListCandidatesSchema>;

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
  operation: z.literal('plan'),
  success: z.boolean(),
  exportQueued: z.boolean(),
  status: z.enum([
    'direct_queue',
    'choose_destination',
    'connect_pending',
    'connect_required',
    'blocked',
    'ambiguous',
  ]),
  planId: z.string().uuid().optional(),
  exportJobId: z.string().optional(),
  reason: z.string().optional(),
  message: z.string(),
  connections: z.array(z.object({
    connectionId: z.string().uuid(),
    label: z.string(),
    accountEmail: z.string().optional(),
  }).strict()).optional(),
}).strict();

const ListCandidatesResultSchema = z.object({
  operation: z.literal('list_candidates'),
  success: z.literal(true),
  candidates: z.array(z.object({
    candidateId: z.string().uuid(),
    label: z.string(),
    previewRowCount: z.number().int().nonnegative(),
    estimatedRows: z.number().int().nonnegative().optional(),
    columns: z.array(z.string()),
    shapeKey: z.string(),
    sourceKind: z.string(),
    argsSummary: z.string(),
    createdAt: z.string(),
  }).strict()),
  message: z.string(),
}).strict();

const ResultSchema = z.union([
  CreateResultSchema,
  ConfirmResultSchema,
  OrchestrationResultSchema,
  ListCandidatesResultSchema,
]);

type Res = z.infer<typeof ResultSchema>;

type DataExportOffers = Pick<DataExportOfferService, 'submitAuthorized'>
  & Partial<Pick<DataExportOfferService, 'confirmForActor' | 'confirmLatestForActor'>>;
type DataExportOrchestration = Pick<
  DataExportOrchestrationService,
  'planForActor' | 'listCandidatesForActor'
>;

export function createDataExportTool(deps: {
  readonly offers: DataExportOffers;
  readonly orchestration?: DataExportOrchestration;
}): Tool<Args, Res> {
  return {
    id: asToolId('dataExport'),
    family: 'data',
    actionGroups: new Set(['create']),
    argsSchema: Schema,
    resultSchema: ResultSchema,
    description:
      `Complete an opaque backend-replayable provider exportCandidate, up to ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')} governed rows, or confirm an existing provider export offer. Source pages and sandboxed transforms stay server-side; only a company-owned, verified invoker-reader Google Sheet, Excel file, or Drive CSV is returned.`,
    parameterDocs: [
      `Format limits: Excel ${DATA_EXPORT_XLSX_ROW_LIMIT.toLocaleString('en-IN')} rows/${DATA_EXPORT_XLSX_CELL_LIMIT.toLocaleString('en-IN')} cells; Google Sheets ${DATA_EXPORT_GOOGLE_SHEET_ROW_LIMIT.toLocaleString('en-IN')} rows/${DATA_EXPORT_GOOGLE_SHEET_CELL_LIMIT.toLocaleString('en-IN')} cells; CSV/auto ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')} rows. If the user requests more or every row, disclose the applicable cap and never call a truncated result complete.`,
      'When a source result returns exportCandidate, use op=plan to export that candidate. If the user did not ask for a file, do not call dataExport.',
      'op=list_candidates: list active export candidates for this chat or current run so you can plan op=plan from the table you showed. Never show candidate IDs to the member.',
      'op=plan: use one or more backend-returned candidate IDs plus the requested format/title. Assign tabName per dataset when exporting multiple tables to Sheet or Excel. A valid explicit plan queues the full governed export after destination and policy checks; do not create a sample or ask for another confirmation.',
      'Legacy op=confirm remains only for old provider offers that returned preview.exportOfferId. Do not use it for exportCandidate results.',
      'op=confirm.format: use google_sheet for Google Sheet/Sheet, csv for CSV, and xlsx for Excel/XL/XLSX. Do not invent source rows, filters, accounts, or a new offer. The backend resolves the active offer in the current authenticated Lark chat when offerId is omitted.',
      'op=confirm.offerId: optional opaque offer ID from the preceding governed result; use it to disambiguate a listed offer but never show it to the user. Do not supply connectionId; the backend derives the administrator-approved company export account.',
      'Direct source.kind is legacy/manual compatibility only. Prefer an opaque backend-returned exportCandidate for every provider. Never invent a direct source recipe; when an approved compatibility recipe is unavoidable, use only exact backend-resolved identifiers.',
      'transform.script: optional JavaScript function body. It receives row, index, and args. Return an object, an array of objects, or null to filter.',
      'destination.format: auto chooses Google Sheets for manageable datasets and CSV in Google Drive for large datasets.',
      'Use destination.format=xlsx only when the user explicitly requests Excel. Excel is limited to 5,000 rows and 100,000 cells; use CSV for wider datasets.',
      'destination.title: human-readable artifact title. destination.columns optionally fixes column order.',
      'Artifact access is fixed by the backend: the administrator-approved company Google account owns every new export and the verified invoker receives reader access only. Owner, recipient, and connection selection are not model arguments. Additional recipients, domain sharing, and public links are unsupported and must be refused.',
      'The backend re-checks requester RBAC, source access, the configured Google export account, invoker-only sharing, and artifact integrity before delivery.',
    ].join('\n'),

    permissionCheck(args, perm) {
      if (!perm.allowedActionsByTool.get(asToolId('dataExport'))?.has('create')) {
        return err(new PermissionError({ toolId: 'dataExport', action: 'create', reason: 'not_allowed' }));
      }
      if (isConfirmArgs(args) || isPlanArgs(args) || isListCandidatesArgs(args)) {
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
      if (isListCandidatesArgs(args)) return executeListCandidates(args, ctx, deps);
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

function isListCandidatesArgs(args: Args): args is ListCandidatesArgs {
  return 'op' in args && args.op === 'list_candidates';
}

async function executeListCandidates(
  args: ListCandidatesArgs,
  ctx: ToolExecutionContext,
  deps: {
    readonly orchestration?: DataExportOrchestration;
  },
): Promise<Result<Res, ToolError>> {
  if (!deps.orchestration) {
    return err(new ToolError({
      toolId: 'dataExport',
      reason: 'upstream_failure',
      message: 'Export candidate listing is not available in this environment.',
    }));
  }
  try {
    const scope = args.scope ?? 'run';
    const candidates = await deps.orchestration.listCandidatesForActor({
      companyId: ctx.runContext.companyId,
      userId: ctx.runContext.userId,
      chatId: ctx.runContext.chatId!,
      scope,
      ...(scope === 'run'
        ? {
            runRequestId: dataExportRunRequestId(ctx.runContext, ctx.correlationId),
            ...(ctx.runContext.traceId ? { traceId: ctx.runContext.traceId } : {}),
          }
        : {}),
    });
    return ok({
      operation: 'list_candidates',
      success: true,
      candidates: candidates.map(candidate => ({
        ...candidate,
        columns: [...candidate.columns],
      })),
      message: candidates.length === 0
        ? 'No active export candidates are available in this conversation. Prepare the data again before planning an export.'
        : `Found ${candidates.length} active export candidate${candidates.length === 1 ? '' : 's'} for planning.`,
    });
  } catch (cause) {
    return err(new ToolError({
      toolId: 'dataExport',
      reason: 'upstream_failure',
      cause,
      message: `Could not list export candidates: ${cause instanceof Error ? cause.message : String(cause)}`,
    }));
  }
}

async function executePlan(
  args: PlanArgs,
  ctx: ToolExecutionContext,
  deps: {
    readonly orchestration?: DataExportOrchestration;
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

async function executeConfirmation(
  args: ConfirmArgs,
  ctx: ToolExecutionContext,
  deps: {
    readonly offers: DataExportOffers;
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
        return companyExportUnavailableConfirmation();
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
      return companyExportUnavailableConfirmation();
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
        message: 'This stale export offer predates the company-owned destination policy. Prepare the data again before exporting.',
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

function companyExportUnavailableConfirmation(): Result<Res, ToolError> {
  return ok({
    operation: 'confirm',
    success: false,
    exportQueued: false,
    status: 'connect_required',
    message: 'The company Google export account is unavailable. Ask an administrator to configure or reconnect it, then retry this export.',
  });
}

function planResultToToolResult(
  result: DataExportPlanResult,
  format: DataExportFormat,
): Res {
  if (result.status === 'direct_queue') {
    return {
      operation: 'plan',
      success: true,
      exportQueued: true,
      status: 'direct_queue',
      planId: result.planId,
      exportJobId: result.exportJobId,
      message: `${formatLabel(format)} export queued. Divo will deliver the verified private artifact to this Lark chat. ${formatLimitReminder(format)}`,
    };
  }
  if (result.status === 'choose_destination') {
    return {
      operation: 'plan',
      success: false,
      exportQueued: false,
      status: 'choose_destination',
      planId: result.planId,
      connections: Array.from(result.connections),
      message: 'This stale export plan predates the company-owned destination policy. Prepare the data again before exporting.',
    };
  }
  if (result.status === 'connect_required') {
    return {
      operation: 'plan',
      success: false,
      exportQueued: false,
      status: 'connect_required',
      planId: result.planId,
      message: 'The company Google export account is unavailable. Ask an administrator to configure or reconnect it, then retry this export.',
    };
  }
  return {
    operation: 'plan',
    success: false,
    exportQueued: false,
    status: result.status,
    reason: result.status === 'blocked' ? result.reason : undefined,
    message: result.message,
  };
}

function formatLabel(format: DataExportFormat): string {
  if (format === 'xlsx') return 'Excel (.xlsx)';
  if (format === 'csv') return 'CSV';
  return 'Google Sheet';
}

function formatLimitReminder(format: DataExportFormat): string {
  return `Do not call it complete until the completion card reports final row coverage; ${formatLabel(format)} caps still apply.`;
}
