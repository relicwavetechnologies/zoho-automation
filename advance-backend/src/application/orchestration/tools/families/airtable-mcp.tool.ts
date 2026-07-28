import { z } from 'zod';
import Ajv from 'ajv';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { err, ok } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { TOOL_SUPPORTED_ACTIONS } from '../../../../domain/tools/tool-id';
import { asToolId } from '../../../../shared/ids';
import type { DataExportQueue } from '../../../data-export/data-export.queue';
import {
  DATA_EXPORT_ROW_LIMIT,
  type DataExportJobPayload,
} from '../../../data-export/data-export.types';
import {
  AIRTABLE_MCP_AUTH_CONTRACT,
  AIRTABLE_PRODUCTS,
  airtableOperationFor,
  airtableScopeGroupsFor,
  type AirtableOperationDefinition,
  type AirtableProductDefinition,
} from '../../../airtable/airtable-mcp-manifest';

const ArgsSchema = z.object({
  connectionId: z.string().uuid().optional(),
  op: z.enum(['describe', 'call']),
  nativeTool: z.string().min(1),
  input: z.record(z.unknown()).optional(),
  exportAll: z.boolean().optional(),
}).superRefine((value, context) => {
  // A real call must name exactly one account. Besides preventing accidental
  // cross-account writes, this is what lets the backend apply the connection
  // owner's governance policy and rate budget to the request.
  if (value.op === 'call' && !value.connectionId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connectionId'],
      message: 'is required for Airtable calls; reuse the run-bootstrap account or use connections.list once when none was loaded',
    });
  }
});
export type AirtableMcpArgs = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  success: z.boolean(),
  nativeTool: z.string(),
  data: z.unknown().optional(),
  message: z.string().optional(),
  exportQueued: z.boolean().optional(),
  exportJobId: z.string().optional(),
});
export type AirtableMcpToolResult = z.infer<typeof ResultSchema>;

const nativeSchemaValidator = new Ajv({ strict: false, allErrors: true });
const RECORD_READ_OPERATIONS = new Set(['list_records_for_table', 'search_records']);
const RECORD_PREVIEW_LIMIT = 10;
const RECORD_PREVIEW_MAX_BYTES = 24_000;
const RECORD_PREVIEW_MAX_FIELD_BYTES = 2_000;

export interface AirtableMcpToolDescription {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface AirtableMcpPort {
  describeTool(name: string): Promise<AirtableMcpToolDescription | null>;
  callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal; readonly maxTotalTimeoutMs?: number },
  ): Promise<unknown>;
  listFieldNamesForTable?(
    baseId: string,
    tableId: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string>>;
  listRecordsPage?(
    input: {
      readonly baseId: string;
      readonly tableId: string;
      readonly fieldIds?: readonly string[];
      readonly offset?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly records: readonly unknown[]; readonly nextCursor?: string }>;
}

export interface AirtableMcpConnection {
  readonly client: AirtableMcpPort;
}

export interface AirtableMcpConnectionChoice {
  readonly connectionId: string;
  readonly label: string;
  readonly accountEmail?: string;
  readonly accountName?: string;
  readonly access: 'read_only' | 'read_write' | 'admin';
}

export type AirtableMcpConnectionResolution =
  | { readonly status: 'resolved'; readonly connection: AirtableMcpConnection }
  | { readonly status: 'unavailable' }
  | { readonly status: 'choose_connection'; readonly connections: readonly AirtableMcpConnectionChoice[] };

export type ResolveAirtableMcpConnection = (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId?: string;
  readonly minimumAccess: 'read_only' | 'read_write';
  readonly requiredScopeGroups: readonly (readonly string[])[];
}) => Promise<AirtableMcpConnectionResolution>;

export function createAirtableMcpTools(deps: {
  readonly getConnection: ResolveAirtableMcpConnection;
  readonly exportQueue?: Pick<DataExportQueue, 'enqueue'>;
}): Tool<AirtableMcpArgs, AirtableMcpToolResult>[] {
  return AIRTABLE_PRODUCTS.map((product) => createProductTool(product, deps));
}

/**
 * Every action group an operation may exercise for the given input. An input
 * flag such as performUpsert can widen what a call actually does, so the caller
 * must hold all of them, not just the operation's nominal action.
 */
function requiredActionsFor(
  operation: AirtableOperationDefinition,
  input: Readonly<Record<string, unknown>>,
): ToolActionGroup[] {
  const actions = new Set<ToolActionGroup>([operation.action]);
  for (const escalation of operation.escalations ?? []) {
    if (input[escalation.whenInputPresent] !== undefined) actions.add(escalation.requires);
  }
  return [...actions];
}

function createProductTool(
  product: AirtableProductDefinition,
  deps: {
    readonly getConnection: ResolveAirtableMcpConnection;
    readonly exportQueue?: Pick<DataExportQueue, 'enqueue'>;
  },
): Tool<AirtableMcpArgs, AirtableMcpToolResult> {
  const supportedActions = new Set<ToolActionGroup>(
    TOOL_SUPPORTED_ACTIONS[product.toolId] as readonly ToolActionGroup[],
  );
  const nativeToolNames = product.operations.map(o => o.nativeTool);

  return {
    id: asToolId(product.toolId),
    family: 'airtable',
    actionGroups: supportedActions,
    argsSchema: ArgsSchema,
    resultSchema: ResultSchema,
    description: product.description,
    parameterDocs: [
      'connectionId: required for call. Reuse an exact run-bootstrap Airtable connectionId. If no account was supplied, do not call the provider; report that Airtable must be connected or shared. Describe may omit connectionId only to inspect an approved operation schema.',
      'op: describe|call. Prefer the exact schema already loaded in bootstrap.nativeContracts. Use describe once only for a required operation whose schema is absent; input may be omitted for describe.',
      `nativeTool: one of ${nativeToolNames.join('|')}.`,
      `input: exact object accepted by the described MCP tool. ${AIRTABLE_MCP_AUTH_CONTRACT.agentGuidance}`,
      `Record reads are capped to a byte-safe preview. For a governed artifact of up to ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} rows, set top-level exportAll=true; disclose this cap whenever the user asks for more or every row.`,
    ].join(' '),

    permissionCheck(args, permission) {
      const operation = airtableOperationFor(product.toolId, args.nativeTool);
      if (!operation) {
        return err(new PermissionError({
          toolId: product.toolId,
          action: 'read',
          reason: 'not_allowed',
          message: `${args.nativeTool} is not an approved ${product.name} operation`,
        }));
      }
      if (args.op === 'describe') {
        const allowed = permission.allowedActionsByTool.get(asToolId(product.toolId))?.has('read') ?? false;
        return allowed
          ? ok('read')
          : err(new PermissionError({ toolId: product.toolId, action: 'read', reason: 'not_allowed' }));
      }

      const granted = permission.allowedActionsByTool.get(asToolId(product.toolId));
      const required = requiredActionsFor(operation, args.input ?? {});
      const missing = required.find(action => !(granted?.has(action) ?? false));
      if (missing) {
        return err(new PermissionError({ toolId: product.toolId, action: missing, reason: 'not_allowed' }));
      }
      if (
        args.exportAll
        && !permission.allowedActionsByTool.get(asToolId('dataExport'))?.has('create')
      ) {
        return err(new PermissionError({ toolId: 'dataExport', action: 'create', reason: 'not_allowed' }));
      }
      // Report the operation's own action group so approval gating, audit rows
      // and the approval card all describe the write the member actually asked
      // for rather than an escalation implied by one input flag.
      return ok(operation.action);
    },

    async preflight(args, ctx) {
      const resolved = await resolveForRequest(product, deps, args, ctx);
      if (!resolved.ok) return resolved;
      const { operation, action, connection } = resolved.value;

      try {
        const description = await connection.client.describeTool(args.nativeTool);
        if (!description) return missingNativeTool(product, args.nativeTool);
        if (args.op === 'call') {
          const issue = validateNativeInput(description.inputSchema, args.nativeTool, args.input ?? {});
          if (issue) return badArgs(product.toolId, issue);
        }
        return ok({
          level: 'native_schema_and_connection',
          connectionEligible: true,
          nativeSchemaValidated: true,
          nativeTool: args.nativeTool,
          action,
          requiredActions: requiredActionsFor(operation, args.input ?? {}),
        });
      } catch (cause) {
        return upstreamFailure(product.toolId, cause);
      }
    },

    async execute(args, ctx): Promise<Result<AirtableMcpToolResult, ToolError>> {
      const resolved = await resolveForRequest(product, deps, args, ctx);
      if (!resolved.ok) {
        // A pending account choice is a normal, recoverable turn — surface the
        // options instead of failing the run.
        if (resolved.error instanceof PendingConnectionChoice) {
          return ok({
            success: false,
            nativeTool: args.nativeTool,
            data: {
              code: 'airtable_connection_selection_required',
              connections: resolved.error.connections,
            },
            message: 'Choose an Airtable connection before continuing.',
          });
        }
        return resolved as Result<never, ToolError>;
      }
      const { action, connection } = resolved.value;

      try {
        if (args.op === 'describe') {
          ctx.onProgress?.(`Loading ${product.name} operation schema…`);
          const description = await connection.client.describeTool(args.nativeTool);
          if (!description) return missingNativeTool(product, args.nativeTool);
          return ok({ success: true, nativeTool: args.nativeTool, data: description });
        }

        ctx.onProgress?.(`${progressVerb(action)} ${product.name}…`);
        if (args.exportAll) {
          if (!ctx.perm.allowedActionsByTool.get(asToolId('dataExport'))?.has('create')) {
            return err(new ToolError({
              toolId: 'dataExport',
              reason: 'permission_denied',
              message: `Governed Airtable exports of up to ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} rows are not permitted for this member`,
            }));
          }
          if (!RECORD_READ_OPERATIONS.has(args.nativeTool)) {
            return badArgs(product.toolId, 'exportAll is supported only for Airtable record list/search operations');
          }
          if (
            deps.exportQueue
            && ctx.runContext.channel === 'lark'
            && ctx.runContext.chatId
            && args.connectionId
          ) {
            const payload: DataExportJobPayload = {
              companyId: ctx.runContext.companyId,
              userId: ctx.runContext.userId,
              ...(ctx.runContext.departmentId ? { departmentId: ctx.runContext.departmentId } : {}),
              source: {
                kind: 'airtable_records',
                connectionId: args.connectionId,
                toolId: product.toolId as 'airtableBase' | 'airtableRecords',
                nativeTool: args.nativeTool as 'list_records_for_table' | 'search_records',
                input: args.input ?? {},
              },
              destination: {
                format: 'auto',
                title: `Airtable ${String(args.input?.['tableId'] ?? 'records')} export`,
              },
              chatId: ctx.runContext.chatId,
              requestId: ctx.runContext.requestId ?? ctx.correlationId,
              ...(ctx.runContext.traceId ? { traceId: ctx.runContext.traceId } : {}),
            };
            const exportJobId = await deps.exportQueue.enqueue(payload);
            return ok({
              success: true,
              nativeTool: args.nativeTool,
              exportQueued: true,
              exportJobId,
              message: `Airtable export queued through dataExport with the current ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')}-row cap. I will deliver the verified invoker-only Google reader link to this Lark chat. If more rows exist, they will be omitted and the result will not be described as complete.`,
            });
          }
          return badArgs(product.toolId, `Governed exports of up to ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} rows require a Lark chat so dataExport can deliver the verified Google artifact`);
        }

        const nativeInput = RECORD_READ_OPERATIONS.has(args.nativeTool)
          ? boundedRecordInput(args.input ?? {})
          : args.input ?? {};
        const data = await connection.client.callTool(
          args.nativeTool,
          nativeInput,
          ctx.abortSignal ? { signal: ctx.abortSignal } : undefined,
        );
        const modelData = RECORD_READ_OPERATIONS.has(args.nativeTool)
          ? compactRecordResult(data)
          : data;
        return ok({
          success: true,
          nativeTool: args.nativeTool,
          data: modelData,
          message: RECORD_READ_OPERATIONS.has(args.nativeTool)
            ? `${product.name} preview completed. Set top-level exportAll=true on this same call for a governed invoker-only export capped at ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} rows.`
            : `${product.name} operation completed`,
        });
      } catch (cause) {
        return upstreamFailure(product.toolId, cause);
      }
    },
  };
}

function boundedRecordInput(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const requested = typeof input['pageSize'] === 'number' && Number.isFinite(input['pageSize'])
    ? Math.trunc(input['pageSize'])
    : RECORD_PREVIEW_LIMIT;
  return {
    ...input,
    pageSize: Math.max(1, Math.min(requested, RECORD_PREVIEW_LIMIT)),
  };
}

function compactRecordResult(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value['records'])) return value;
  const records = value['records'];
  const compactRecords: unknown[] = [];
  for (const record of records.slice(0, RECORD_PREVIEW_LIMIT)) {
    const compact = compactRecord(record);
    const candidate = {
      ...value,
      records: [...compactRecords, compact],
      returnedRecordCount: compactRecords.length + 1,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > RECORD_PREVIEW_MAX_BYTES) break;
    compactRecords.push(compact);
  }
  return {
    ...value,
    records: compactRecords,
    returnedRecordCount: compactRecords.length,
    omittedFromPreview: Math.max(0, records.length - compactRecords.length),
    hasMore: typeof value['nextCursor'] === 'string' || records.length > compactRecords.length,
  };
}

function compactRecord(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const sourceKey = isRecord(value['cellValuesByFieldId'])
    ? 'cellValuesByFieldId'
    : isRecord(value['fields'])
      ? 'fields'
      : undefined;
  if (!sourceKey) return value;
  const sourceFields = value[sourceKey] as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  let omittedFieldCount = 0;
  for (const [name, fieldValue] of Object.entries(sourceFields)) {
    const serialized = JSON.stringify(fieldValue);
    const safeValue = serialized && Buffer.byteLength(serialized, 'utf8') > RECORD_PREVIEW_MAX_FIELD_BYTES
      ? `[value omitted from preview: ${Buffer.byteLength(serialized, 'utf8')} bytes]`
      : fieldValue;
    const candidate = { ...value, [sourceKey]: { ...fields, [name]: safeValue } };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > RECORD_PREVIEW_MAX_BYTES / 2) {
      omittedFieldCount += 1;
      continue;
    }
    fields[name] = safeValue;
  }
  return {
    ...value,
    [sourceKey]: fields,
    fieldCount: Object.keys(sourceFields).length,
    ...(omittedFieldCount > 0 ? { omittedFieldCount } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Signals that execute() should return account choices rather than an error. */
class PendingConnectionChoice extends ToolError {
  constructor(
    toolId: string,
    readonly connections: readonly AirtableMcpConnectionChoice[],
  ) {
    super({ toolId, reason: 'bad_args', message: 'Choose an Airtable connection before continuing.' });
  }
}

async function resolveForRequest(
  product: AirtableProductDefinition,
  deps: { readonly getConnection: ResolveAirtableMcpConnection },
  args: AirtableMcpArgs,
  ctx: { readonly runContext: { readonly companyId: string; readonly userId: string } },
): Promise<Result<{
  operation: AirtableOperationDefinition;
  action: ToolActionGroup;
  connection: AirtableMcpConnection;
}, ToolError>> {
  const operation = airtableOperationFor(product.toolId, args.nativeTool);
  if (!operation) {
    return badArgs(product.toolId, `${args.nativeTool} is not an approved ${product.name} operation`);
  }
  const action: ToolActionGroup = args.op === 'describe' ? 'read' : operation.action;

  const resolution = await deps.getConnection({
    companyId: ctx.runContext.companyId,
    userId: ctx.runContext.userId,
    ...(args.connectionId ? { connectionId: args.connectionId } : {}),
    minimumAccess: action === 'read' ? 'read_only' : 'read_write',
    requiredScopeGroups: args.op === 'describe' ? [] : airtableScopeGroupsFor(product, action),
  });

  if (resolution.status === 'choose_connection') {
    return err(new PendingConnectionChoice(product.toolId, resolution.connections));
  }
  if (resolution.status === 'unavailable') {
    return err(new ToolError({
      toolId: product.toolId,
      reason: 'unrecoverable',
      message: `${product.name} connection is unavailable, not shared for this action, or missing required scopes. Reconnect Airtable to grant the complete scopes.`,
    }));
  }
  return ok({ operation, action, connection: resolution.connection });
}

function validateNativeInput(
  inputSchema: unknown,
  nativeTool: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const validate = nativeSchemaValidator.compile(inputSchema as object);
  if (validate(input)) return undefined;
  return `Invalid native input for ${nativeTool} — ${nativeSchemaValidator.errorsText(validate.errors)}`;
}

function missingNativeTool(
  product: AirtableProductDefinition,
  nativeTool: string,
): Result<never, ToolError> {
  return err(new ToolError({
    toolId: product.toolId,
    reason: 'upstream_failure',
    message: `${nativeTool} is missing from the Airtable MCP server this manifest was pinned against`,
  }));
}

function progressVerb(action: ToolActionGroup): string {
  if (action === 'read') return 'Reading';
  if (action === 'delete') return 'Removing from';
  if (action === 'create') return 'Creating in';
  return 'Updating';
}

function badArgs(toolId: string, message: string): Result<never, ToolError> {
  return err(new ToolError({ toolId, reason: 'bad_args', message }));
}

function upstreamFailure(toolId: string, cause: unknown): Result<never, ToolError> {
  return err(new ToolError({
    toolId,
    reason: 'upstream_failure',
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  }));
}
