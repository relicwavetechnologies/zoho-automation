import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import { err, ok, type Result } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { PermissionResult } from '../../permissions/permission.types';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../shared/ids';
import type { AuditService } from '../../observability/audit.service';
import { ShopifyService, ShopifyServiceError, type ShopifyOperationResult } from '../../shopify/shopify.service';
import {
  ShopifyAnalyticsArgsSchema,
  ShopifyCustomersArgsSchema,
  ShopifyOrdersArgsSchema,
  type ShopifyAnalyticsArgs,
  type ShopifyCustomersArgs,
  type ShopifyCustomersListExportArgs,
  type ShopifyOrdersArgs,
  type ShopifyOrdersListExportArgs,
} from '../../shopify/shopify.types';
import type { DataExportOrchestrationService } from '../../data-export/data-export-orchestration.service';
import type { DataExportOfferPayload } from '../../data-export/export-offer';
import {
  createDatasetPreview,
  DATASET_PREVIEW_ROW_LIMIT,
  type DatasetCoverage,
} from '../../data-export/dataset-preview';
import {
  exportCandidateMetadata,
  publishExportCandidate,
} from '../../data-export/tool-export-candidate';
import { dataExportRunRequestId } from '../../data-export/export-request-identity';
import {
  flattenShopifyAnalyticsRows,
  flattenShopifyCustomerRows,
  flattenShopifyOrderRows,
  exportReplayArgsForList,
  previewCoverageForAnalytics,
  previewCoverageForShopifyList,
  readShopifyAnalyticsTable,
  readShopifyListNodes,
  shopifyAnalyticsExportable,
  shopifyCustomersExportable,
  shopifyExportTitle,
  shopifyOrdersExportable,
  type ShopifyExportArgs,
  type ShopifyExportToolId,
} from '../../shopify/shopify-export';

const legacyResultSchema = z.object({
  status: z.enum(['complete', 'empty', 'pending']),
  operation: z.string(),
  store: z.object({ domain: z.string(), name: z.string().optional() }),
  apiVersion: z.string(),
  data: z.unknown(),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().optional() }).optional(),
  preview: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.unknown())).max(DATASET_PREVIEW_ROW_LIMIT),
    coverage: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('complete'), totalRows: z.number().int().nonnegative() }),
      z.object({
        kind: z.literal('truncated'),
        returnedRows: z.number().int().nonnegative(),
        knownTotal: z.number().int().nonnegative().optional(),
        reason: z.string(),
      }),
      z.object({
        kind: z.literal('provider_limited'),
        returnedRows: z.number().int().nonnegative(),
        reason: z.string(),
      }),
      z.object({ kind: z.literal('unknown'), returnedRows: z.number().int().nonnegative() }),
    ]),
  }).optional(),
  exportCandidate: z.object({
    candidateId: z.string().uuid(),
    sourceKind: z.literal('shopify_snapshot'),
    previewRowCount: z.number().int().nonnegative(),
    estimatedRows: z.number().int().nonnegative().optional(),
    expiresAt: z.string(),
  }).strict().optional(),
  queryCost: z.record(z.unknown()).optional(),
  requestId: z.string().optional(),
  retrievedAt: z.string(),
  message: z.string(),
});

const analyticsResultSchema = z.object({
  status: z.enum(['complete', 'empty', 'pending']),
  operation: z.string(),
  store: z.object({ domain: z.string(), name: z.string().optional() }),
  apiVersion: z.string(),
  preview: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.unknown())).max(DATASET_PREVIEW_ROW_LIMIT),
    coverage: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('complete'), totalRows: z.number().int().nonnegative() }),
      z.object({
        kind: z.literal('truncated'),
        returnedRows: z.number().int().nonnegative(),
        knownTotal: z.number().int().nonnegative().optional(),
        reason: z.string(),
      }),
      z.object({
        kind: z.literal('provider_limited'),
        returnedRows: z.number().int().nonnegative(),
        reason: z.string(),
      }),
      z.object({ kind: z.literal('unknown'), returnedRows: z.number().int().nonnegative() }),
    ]),
  }).optional(),
  exportCandidate: z.object({
    candidateId: z.string().uuid(),
    sourceKind: z.literal('shopify_snapshot'),
    previewRowCount: z.number().int().nonnegative(),
    estimatedRows: z.number().int().nonnegative().optional(),
    expiresAt: z.string(),
  }).strict().optional(),
  queryCost: z.record(z.unknown()).optional(),
  requestId: z.string().optional(),
  retrievedAt: z.string(),
  message: z.string(),
});

type ShopifyToolId = 'shopifyAnalytics' | 'shopifyOrders' | 'shopifyCustomers';
type AnalyticsRes = z.infer<typeof analyticsResultSchema>;
type ProtectedListRes = z.infer<typeof legacyResultSchema>;

export function createShopifyTools(deps: {
  readonly service: ShopifyService;
  readonly audit: AuditService;
  readonly exportCandidates?: Pick<DataExportOrchestrationService, 'publishCandidate'>;
}): [
  Tool<ShopifyAnalyticsArgs, AnalyticsRes>,
  Tool<ShopifyOrdersArgs, ProtectedListRes>,
  Tool<ShopifyCustomersArgs, ProtectedListRes>,
] {
  return [
    createAnalyticsTool(deps),
    createProtectedListTool({
      id: 'shopifyOrders',
      argsSchema: ShopifyOrdersArgsSchema,
      description: 'List and inspect Shopify orders and retrieve first/last-visit attribution without modifying store data.',
      parameterDocs: [
        'connectionId: exact accessible Shopify store connection UUID.',
        'operation: list_orders, get_order, get_order_by_identifier, get_order_attribution, or list_order_line_items.',
        'list_orders returns at most 100 records and a cursor. Divo enforces an inclusive created_at floor of exactly 60 days before the request unless the caller explicitly supplies an older createdAtMin.',
        'An older list createdAtMin, or includeHistorical=true on a direct lookup, requires Shopify-approved read_all_orders.',
        'get_order and get_order_by_identifier with includeHistorical=false omit orders older than the same 60-day floor even when the connection token also has read_all_orders.',
        'Use list_order_line_items with its endCursor to page through orders with more than the bounded detail page.',
        'get_order_attribution may return pending while customerJourneySummary.ready is false; never infer missing UTM data.',
        'list_orders may return exportCandidate on Lark when dataExport create is granted; use dataExport op=plan for Sheet, Excel, or CSV instead of manually paging cursors.',
      ].join('\n'),
      execute: (args, ctx) => deps.service.orders(args, ctx),
      audit: deps.audit,
      exportCandidates: deps.exportCandidates,
      exportable: shopifyOrdersExportable,
      flattenRows: (data) => flattenShopifyOrderRows(readShopifyListNodes(data)),
    }),
    createProtectedListTool({
      id: 'shopifyCustomers',
      argsSchema: ShopifyCustomersArgsSchema,
      description: 'List, search, count, and inspect protected Shopify customer metadata through a separately governed capability.',
      parameterDocs: [
        'connectionId: exact accessible Shopify store connection UUID.',
        'operation: list_customers, get_customer, search_customers, or count_customers.',
        'Search accepts one structured email, phone, or name field; arbitrary Shopify search syntax is not accepted.',
        'All customer-level results are protected data and require this separately granted capability. includeContact is rejected; names, email, and phone are never returned.',
        'list_customers and search_customers may return exportCandidate on Lark when dataExport create is granted; use dataExport op=plan for Sheet, Excel, or CSV instead of manually paging cursors.',
      ].join('\n'),
      execute: (args, ctx) => deps.service.customers(args, ctx),
      audit: deps.audit,
      exportCandidates: deps.exportCandidates,
      exportable: shopifyCustomersExportable,
      flattenRows: (data) => flattenShopifyCustomerRows(readShopifyListNodes(data)),
    }),
  ];
}

function createAnalyticsTool(deps: {
  readonly service: ShopifyService;
  readonly audit: AuditService;
  readonly exportCandidates?: Pick<DataExportOrchestrationService, 'publishCandidate'>;
}): Tool<ShopifyAnalyticsArgs, AnalyticsRes> {
  return {
    id: asToolId('shopifyAnalytics'),
    family: 'shopify',
    actionGroups: new Set(['read']),
    argsSchema: ShopifyAnalyticsArgsSchema as z.ZodType<ShopifyAnalyticsArgs>,
    resultSchema: analyticsResultSchema,
    description: 'Run bounded, read-only Shopify sales, customer, product, inventory, payment, and attribution reports through server-compiled ShopifyQL.',
    parameterDocs: [
      'connectionId: exact accessible Shopify store connection UUID.',
      'operation: sales_summary, sales_timeseries, sales_by_channel, sales_attribution, sales_by_utm, product_performance, customer_acquisition, inventory_position, payments_summary, or payments_by_method.',
      'Queries are compiled from enums. Raw ShopifyQL, GraphQL, headers, credentials, and arbitrary fields are not accepted.',
      'For last-click marketing attribution use sales_attribution with dimension referring_channel and attribution LAST_CLICK_ATTRIBUTION.',
      'Ranked reports return top-N rows only. If exportCandidate is present and the member asks for Sheet, Excel, or CSV, use dataExport op=plan instead of rerunning this tool.',
    ].join('\n'),
    permissionCheck(_args: ShopifyAnalyticsArgs, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
      const allowed = perm.allowedActionsByTool.get(asToolId('shopifyAnalytics'))?.has('read') ?? false;
      return allowed
        ? ok('read' as ToolActionGroup)
        : err(new PermissionError({ toolId: 'shopifyAnalytics', action: 'read', reason: 'not_allowed' }));
    },
    async execute(args: ShopifyAnalyticsArgs, ctx: ToolExecutionContext): Promise<Result<AnalyticsRes, ToolError>> {
      const startedAt = Date.now();
      const connectionId = args.connectionId;
      let result: ShopifyOperationResult;
      try {
        ctx.onProgress?.(`Reading Shopify ${args.operation.replace(/_/g, ' ')}…`);
        result = await deps.service.analytics(args, ctx);
      } catch (error) {
        const normalized = error instanceof ShopifyServiceError
          ? error
          : new ShopifyServiceError('provider_failure', 'Shopify request failed.', error);
        try {
          await deps.audit.recordRequired({
            actorId: ctx.runContext.userId,
            companyId: ctx.runContext.companyId,
            action: 'shopify.shopifyAnalytics.read',
            outcome: 'failure',
            metadata: {
              operation: args.operation,
              connectionId,
              failureCode: normalized.code,
              latencyMs: Date.now() - startedAt,
              correlationId: ctx.correlationId,
            },
          });
        } catch (auditError) {
          return err(auditUnavailable('shopifyAnalytics', auditError));
        }
        return err(toToolError('shopifyAnalytics', normalized));
      }

      const table = readShopifyAnalyticsTable(result.data);
      const flatRows = table ? flattenShopifyAnalyticsRows(table.columns, table.rows) : [];
      const candidate = await publishExportCandidate({
        candidates: deps.exportCandidates,
        eligible: flatRows.length > 0
          && shopifyAnalyticsExportable(args.operation)
          && ctx.runContext.channel === 'lark'
          && Boolean(ctx.runContext.chatId)
          && ctx.perm.allowedActionsByTool.get(asToolId('dataExport'))?.has('create') === true,
        payload: () => exportPayloadForShopify('shopifyAnalytics', args, ctx, result.store.domain),
        metadata: exportCandidateMetadata({
          columns: flatRows.length > 0 ? Object.keys(flatRows[0]!) : [],
          previewRowCount: flatRows.length,
          estimatedRows: flatRows.length,
          coverage: previewCoverageForAnalytics(args, flatRows.length),
        }),
        logger: ctx.logger,
        scope: 'shopify',
        correlationId: ctx.correlationId,
      });
      const preview = flatRows.length > 0
        ? createDatasetPreview({
          rows: flatRows,
          coverage: previewCoverageForAnalytics(args, flatRows.length),
        })
        : undefined;

      const response: AnalyticsRes = {
        status: result.status,
        operation: result.operation,
        store: result.store,
        apiVersion: result.apiVersion,
        preview,
        ...(candidate.kind === 'published'
          ? {
              exportCandidate: {
                candidateId: candidate.candidateId,
                sourceKind: 'shopify_snapshot' as const,
                previewRowCount: flatRows.length,
                ...(candidate.estimatedRows === undefined ? {} : { estimatedRows: candidate.estimatedRows }),
                expiresAt: candidate.expiresAt.toISOString(),
              },
            }
          : {}),
        ...(result.queryCost ? { queryCost: result.queryCost } : {}),
        ...(result.requestId ? { requestId: result.requestId } : {}),
        retrievedAt: result.retrievedAt,
        message: messageForAnalytics({
          rowCount: flatRows.length,
          returnedRows: preview?.rows.length ?? 0,
          hasCandidate: candidate.kind === 'published',
          status: result.status,
          ...(preview?.coverage !== undefined ? { coverage: preview.coverage } : {}),
        }),
      };

      try {
        await deps.audit.recordRequired({
          actorId: ctx.runContext.userId,
          companyId: ctx.runContext.companyId,
          action: 'shopify.shopifyAnalytics.read',
          outcome: 'success',
          metadata: {
            operation: args.operation,
            connectionId,
            status: result.status,
            rowCount: flatRows.length,
            returnedRowCount: preview?.rows.length ?? 0,
            exportCandidateId: candidate.kind === 'published' ? candidate.candidateId : null,
            requestId: result.requestId ?? null,
            latencyMs: Date.now() - startedAt,
            correlationId: ctx.correlationId,
          },
        });
      } catch (auditError) {
        return err(auditUnavailable('shopifyAnalytics', auditError));
      }
      return ok(response);
    },
  };
}

function createProtectedListTool<TArgs extends ShopifyOrdersArgs | ShopifyCustomersArgs>(input: {
  readonly id: Exclude<ShopifyToolId, 'shopifyAnalytics'>;
  readonly argsSchema: z.ZodType<TArgs, z.ZodTypeDef, any>;
  readonly description: string;
  readonly parameterDocs: string;
  readonly execute: (args: TArgs, ctx: ToolExecutionContext) => Promise<ShopifyOperationResult>;
  readonly audit: AuditService;
  readonly exportCandidates?: Pick<DataExportOrchestrationService, 'publishCandidate'> | undefined;
  readonly exportable: (operation: string) => boolean;
  readonly flattenRows: (data: unknown) => Record<string, unknown>[];
}): Tool<TArgs, ProtectedListRes> {
  return {
    id: asToolId(input.id),
    family: 'shopify',
    actionGroups: new Set(['read']),
    argsSchema: input.argsSchema,
    resultSchema: legacyResultSchema,
    description: input.description,
    parameterDocs: input.parameterDocs,
    permissionCheck(_args: TArgs, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
      const allowed = perm.allowedActionsByTool.get(asToolId(input.id))?.has('read') ?? false;
      return allowed
        ? ok('read' as ToolActionGroup)
        : err(new PermissionError({ toolId: input.id, action: 'read', reason: 'not_allowed' }));
    },
    async execute(args: TArgs, ctx: ToolExecutionContext): Promise<Result<ProtectedListRes, ToolError>> {
      const startedAt = Date.now();
      const operation = readOperation(args);
      const connectionId = readConnectionId(args);
      let result: ShopifyOperationResult;
      try {
        ctx.onProgress?.(`Reading Shopify ${operation.replace(/_/g, ' ')}…`);
        result = await input.execute(args, ctx);
      } catch (error) {
        const normalized = error instanceof ShopifyServiceError
          ? error
          : new ShopifyServiceError('provider_failure', 'Shopify request failed.', error);
        try {
          await input.audit.recordRequired({
            actorId: ctx.runContext.userId,
            companyId: ctx.runContext.companyId,
            action: `shopify.${input.id}.read`,
            outcome: 'failure',
            metadata: {
              operation,
              connectionId,
              failureCode: normalized.code,
              latencyMs: Date.now() - startedAt,
              correlationId: ctx.correlationId,
            },
          });
        } catch (auditError) {
          return err(auditUnavailable(input.id, auditError));
        }
        return err(toToolError(input.id, normalized));
      }

      const listExportable = input.exportable(operation);
      const flatRows = listExportable ? input.flattenRows(result.data) : [];
      const coverage = listExportable
        ? previewCoverageForShopifyList(result.pageInfo?.hasNextPage ?? false, flatRows.length)
        : undefined;
      const replayArgs = listExportable
        ? exportReplayArgsForList(args)
        : undefined;
      const candidate = listExportable && replayArgs
        ? await publishExportCandidate({
          candidates: input.exportCandidates,
          eligible: flatRows.length > 0
            && ctx.runContext.channel === 'lark'
            && Boolean(ctx.runContext.chatId)
            && ctx.perm.allowedActionsByTool.get(asToolId('dataExport'))?.has('create') === true,
          payload: () => exportPayloadForShopify(input.id, replayArgs, ctx, result.store.domain),
          metadata: exportCandidateMetadata({
            columns: flatRows.length > 0 ? Object.keys(flatRows[0]!) : [],
            previewRowCount: flatRows.length,
            estimatedRows: result.pageInfo?.hasNextPage ? undefined : flatRows.length,
            ...(coverage ? { coverage } : {}),
          }),
          logger: ctx.logger,
          scope: 'shopify',
          correlationId: ctx.correlationId,
        })
        : { kind: 'none' as const };
      const preview = flatRows.length > 0 && coverage
        ? createDatasetPreview({ rows: flatRows, coverage })
        : undefined;

      const response: ProtectedListRes = {
        status: result.status,
        operation: result.operation,
        store: result.store,
        apiVersion: result.apiVersion,
        data: result.data,
        ...(result.pageInfo ? { pageInfo: result.pageInfo } : {}),
        ...(preview ? { preview } : {}),
        ...(candidate.kind === 'published'
          ? {
              exportCandidate: {
                candidateId: candidate.candidateId,
                sourceKind: 'shopify_snapshot' as const,
                previewRowCount: flatRows.length,
                ...(candidate.estimatedRows === undefined ? {} : { estimatedRows: candidate.estimatedRows }),
                expiresAt: candidate.expiresAt.toISOString(),
              },
            }
          : {}),
        ...(result.queryCost ? { queryCost: result.queryCost } : {}),
        ...(result.requestId ? { requestId: result.requestId } : {}),
        retrievedAt: result.retrievedAt,
        message: listExportable
          ? messageForProtectedList({
            rowCount: flatRows.length,
            returnedRows: preview?.rows.length ?? 0,
            hasCandidate: candidate.kind === 'published',
            status: result.status,
            hasNextPage: result.pageInfo?.hasNextPage ?? false,
            ...(coverage !== undefined ? { coverage } : {}),
          })
          : result.message,
      };

      try {
        await input.audit.recordRequired({
          actorId: ctx.runContext.userId,
          companyId: ctx.runContext.companyId,
          action: `shopify.${input.id}.read`,
          outcome: 'success',
          metadata: {
            operation,
            connectionId,
            status: result.status,
            requestId: result.requestId ?? null,
            hasNextPage: result.pageInfo?.hasNextPage ?? false,
            rowCount: flatRows.length,
            returnedRowCount: preview?.rows.length ?? 0,
            exportCandidateId: candidate.kind === 'published' ? candidate.candidateId : null,
            latencyMs: Date.now() - startedAt,
            correlationId: ctx.correlationId,
          },
        });
      } catch (auditError) {
        return err(auditUnavailable(input.id, auditError));
      }
      return ok(response);
    },
  };
}

function exportPayloadForShopify(
  toolId: ShopifyExportToolId,
  args: ShopifyExportArgs,
  ctx: ToolExecutionContext,
  storeDomain: string,
): DataExportOfferPayload {
  const shared = {
    companyId: ctx.runContext.companyId,
    userId: ctx.runContext.userId,
    ...(ctx.runContext.departmentId ? { departmentId: ctx.runContext.departmentId } : {}),
    destination: {
      format: 'auto' as const,
      title: shopifyExportTitle(toolId, args, storeDomain),
    },
    chatId: ctx.runContext.chatId!,
    ...(ctx.runContext.runtimeThreadId
      ? { conversationKey: ctx.runContext.runtimeThreadId }
      : {}),
    ...(ctx.runContext.replyToMessageId ? { replyToMessageId: ctx.runContext.replyToMessageId } : {}),
    ...(ctx.runContext.replyInThread !== undefined ? { replyInThread: ctx.runContext.replyInThread } : {}),
    requestId: dataExportRunRequestId(ctx.runContext, ctx.correlationId),
    ...(ctx.runContext.traceId ? { traceId: ctx.runContext.traceId } : {}),
  };
  if (toolId === 'shopifyAnalytics') {
    return {
      ...shared,
      source: {
        kind: 'shopify_snapshot',
        connectionId: args.connectionId,
        toolId: 'shopifyAnalytics',
        args: args as ShopifyAnalyticsArgs,
      },
    };
  }
  if (toolId === 'shopifyOrders') {
    return {
      ...shared,
      source: {
        kind: 'shopify_snapshot',
        connectionId: args.connectionId,
        toolId: 'shopifyOrders',
        args: args as ShopifyOrdersListExportArgs,
      },
    };
  }
  return {
    ...shared,
    source: {
      kind: 'shopify_snapshot',
      connectionId: args.connectionId,
      toolId: 'shopifyCustomers',
      args: args as ShopifyCustomersListExportArgs,
    },
  };
}

function messageForAnalytics(input: {
  readonly rowCount: number;
  readonly returnedRows: number;
  readonly hasCandidate: boolean;
  readonly status: AnalyticsRes['status'];
  readonly coverage?: DatasetCoverage;
}): string {
  if (input.status === 'empty' || input.rowCount === 0) {
    return 'Shopify returned no matching records for this report.';
  }
  const parts = [`Retrieved ${input.rowCount} row${input.rowCount === 1 ? '' : 's'}.`];
  if (input.rowCount > input.returnedRows) {
    parts.push(`Showing the first ${input.returnedRows} rows in chat.`);
  }
  if (input.coverage?.kind === 'provider_limited') {
    parts.push('This ranked Shopify report is top-N only.');
  }
  if (input.hasCandidate) {
    parts.push('If the member asks for Sheet, Excel, or CSV, use the returned export candidate; Divo reruns current Shopify data for the file.');
  }
  return parts.join(' ');
}

function messageForProtectedList(input: {
  readonly rowCount: number;
  readonly returnedRows: number;
  readonly hasCandidate: boolean;
  readonly status: ProtectedListRes['status'];
  readonly hasNextPage: boolean;
  readonly coverage?: DatasetCoverage;
}): string {
  if (input.status === 'empty' || input.rowCount === 0) {
    return 'Shopify returned no matching records for this request.';
  }
  const parts = [`Retrieved ${input.rowCount} row${input.rowCount === 1 ? '' : 's'} on this page.`];
  if (input.rowCount > input.returnedRows) {
    parts.push(`Showing the first ${input.returnedRows} rows in chat.`);
  }
  if (input.hasNextPage || input.coverage?.kind === 'truncated') {
    parts.push('More rows are available beyond this page.');
  }
  if (input.hasCandidate) {
    parts.push('If the member asks for Sheet, Excel, or CSV, use the returned export candidate; Divo replays current Shopify data for the file.');
  }
  return parts.join(' ');
}

function auditUnavailable(toolId: ShopifyToolId, cause: unknown): ToolError {
  return new ToolError({
    toolId,
    reason: 'unrecoverable',
    message: 'Shopify access could not be safely audited.',
    cause,
  });
}

function readOperation(args: unknown): string {
  return args && typeof args === 'object' && typeof (args as Record<string, unknown>)['operation'] === 'string'
    ? String((args as Record<string, unknown>)['operation'])
    : 'unknown';
}

function readConnectionId(args: unknown): string | null {
  return args && typeof args === 'object' && typeof (args as Record<string, unknown>)['connectionId'] === 'string'
    ? String((args as Record<string, unknown>)['connectionId'])
    : null;
}

function toToolError(toolId: ShopifyToolId, error: ShopifyServiceError): ToolError {
  const reason = error.code === 'bad_args' ? 'bad_args'
    : error.code === 'inaccessible' || error.code === 'missing_scope' ? 'permission_denied'
      : error.code === 'rate_limited' ? 'retryable'
        : 'upstream_failure';
  return new ToolError({ toolId, reason, message: error.message, cause: error });
}
