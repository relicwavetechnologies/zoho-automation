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
  type ShopifyOrdersArgs,
} from '../../shopify/shopify.types';
import {
  createDatasetPreview,
  DATASET_PREVIEW_ROW_LIMIT,
  type DatasetCoverage,
} from '../../provider-data/dataset-preview';
import {
  flattenShopifyAnalyticsRows,
  flattenShopifyCustomerRows,
  flattenShopifyOrderRows,
  previewCoverageForAnalytics,
  previewCoverageForShopifyList,
  readShopifyAnalyticsTable,
  readShopifyListNodes,
  shopifyAnalyticsPreviewable,
  shopifyCustomersPreviewable,
  shopifyOrdersPreviewable,
} from '../../shopify/shopify-result';

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
      ].join('\n'),
      execute: (args, ctx) => deps.service.orders(args, ctx),
      audit: deps.audit,
      previewable: shopifyOrdersPreviewable,
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
      ].join('\n'),
      execute: (args, ctx) => deps.service.customers(args, ctx),
      audit: deps.audit,
      previewable: shopifyCustomersPreviewable,
      flattenRows: (data) => flattenShopifyCustomerRows(readShopifyListNodes(data)),
    }),
  ];
}

function createAnalyticsTool(deps: {
  readonly service: ShopifyService;
  readonly audit: AuditService;
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
      'Ranked reports return top-N rows only; never describe them as a complete dataset.',
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
        ...(result.queryCost ? { queryCost: result.queryCost } : {}),
        ...(result.requestId ? { requestId: result.requestId } : {}),
        retrievedAt: result.retrievedAt,
        message: messageForAnalytics({
          rowCount: flatRows.length,
          returnedRows: preview?.rows.length ?? 0,
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
  readonly previewable: (operation: string) => boolean;
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

      const listPreviewable = input.previewable(operation);
      const flatRows = listPreviewable ? input.flattenRows(result.data) : [];
      const coverage = listPreviewable
        ? previewCoverageForShopifyList(result.pageInfo?.hasNextPage ?? false, flatRows.length)
        : undefined;
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
        ...(result.queryCost ? { queryCost: result.queryCost } : {}),
        ...(result.requestId ? { requestId: result.requestId } : {}),
        retrievedAt: result.retrievedAt,
        message: listPreviewable
          ? messageForProtectedList({
            rowCount: flatRows.length,
            returnedRows: preview?.rows.length ?? 0,
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

function messageForAnalytics(input: {
  readonly rowCount: number;
  readonly returnedRows: number;
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
  return parts.join(' ');
}

function messageForProtectedList(input: {
  readonly rowCount: number;
  readonly returnedRows: number;
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
