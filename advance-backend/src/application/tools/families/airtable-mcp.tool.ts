import { z } from 'zod';
import Ajv from 'ajv';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { TOOL_SUPPORTED_ACTIONS } from '../../../domain/tools/tool-id';
import { asToolId } from '../../../shared/ids';
import {
  AIRTABLE_MCP_AUTH_CONTRACT,
  AIRTABLE_PRODUCTS,
  airtableOperationFor,
  airtableScopeGroupsFor,
  type AirtableOperationDefinition,
  type AirtableProductDefinition,
} from '../../airtable/airtable-mcp-manifest';

const LIST_RECORDS_TOOL = 'list_records_for_table';
const AirtablePageInputSchema = z.object({
  baseId: z.string().min(1),
  tableId: z.string().min(1),
  fieldIds: z.array(z.string().min(1)).max(100).optional(),
  cursor: z.string().min(1).optional(),
}).strict();

function nativeArgsBranches(nativeTool: z.ZodType<string>) {
  return [
    z.object({
      connectionId: z.string().uuid().optional(),
      op: z.literal('describe'),
      nativeTool,
      input: z.record(z.unknown()).optional(),
    }),
    z.object({
      connectionId: z.string().uuid(),
      op: z.literal('call'),
      nativeTool,
      input: z.record(z.unknown()).optional(),
    }),
  ] as const;
}

function createNativeArgsSchema(nativeTool: z.ZodType<string>) {
  return z.discriminatedUnion('op', nativeArgsBranches(nativeTool));
}

function createPageArgsSchema(nativeTool: z.ZodType<string>) {
  return z.discriminatedUnion('op', [
    ...nativeArgsBranches(nativeTool),
    z.object({
      connectionId: z.string().uuid(),
      op: z.literal('page'),
      nativeTool: z.literal(LIST_RECORDS_TOOL),
      input: AirtablePageInputSchema,
    }),
  ]);
}

const ArgsSchema = createPageArgsSchema(z.string().min(1));
export type AirtableMcpArgs = z.infer<typeof ArgsSchema>;

function nativeToolEnum(values: readonly string[]): z.ZodEnum<[string, ...string[]]> {
  const [first, ...rest] = values;
  if (!first) throw new Error('Airtable product must publish at least one native tool');
  return z.enum([first, ...rest]);
}

const ResultSchema = z.object({
  success: z.boolean(),
  nativeTool: z.string(),
  data: z.unknown().optional(),
  message: z.string().optional(),
});
export type AirtableMcpToolResult = z.infer<typeof ResultSchema>;

const nativeSchemaValidator = new Ajv({ strict: false, allErrors: true });
const RECORD_READ_OPERATIONS = new Set(['list_records_for_table', 'search_records']);
const RECORD_PREVIEW_LIMIT = 10;
const RECORD_PREVIEW_MAX_BYTES = 24_000;
const RECORD_PREVIEW_MAX_FIELD_BYTES = 2_000;
const LIST_FIELDS_TOOL = 'list_fields_for_table';
const ListFieldsInputSchema = z.object({
  baseId: z.string().min(1),
  tableId: z.string().min(1),
}).strict();
const LIST_FIELDS_DESCRIPTION: AirtableMcpToolDescription = {
  name: LIST_FIELDS_TOOL,
  description: 'List every field ID and name for one Airtable table before selecting fields or requesting detailed schemas.',
  inputSchema: {
    type: 'object',
    properties: {
      baseId: { type: 'string' },
      tableId: { type: 'string' },
    },
    required: ['baseId', 'tableId'],
    additionalProperties: false,
  },
};

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
    argsSchema: (product.service === 'base' || product.service === 'records'
      ? createPageArgsSchema(nativeToolEnum(nativeToolNames))
      : createNativeArgsSchema(nativeToolEnum(nativeToolNames))) as z.ZodType<AirtableMcpArgs>,
    resultSchema: ResultSchema,
    description: product.description,
    parameterDocs: [
      'connectionId: required for call. Reuse an exact run-bootstrap Airtable connectionId. If no account was supplied, do not call the provider; report that Airtable must be connected or shared. Describe may omit connectionId only to inspect an approved operation schema.',
      product.service === 'base' || product.service === 'records'
        ? 'op: describe|call|page. Prefer the exact schema already loaded in bootstrap.nativeContracts. Use describe once only for a required operation whose schema is absent. page is restricted to list_records_for_table through divo-local and returns one 100-row Web API page plus nextCursor.'
        : 'op: describe|call. Prefer the exact schema already loaded in bootstrap.nativeContracts. Use describe once only for a required operation whose schema is absent.',
      `nativeTool: one of ${nativeToolNames.join('|')}.`,
      `input: exact object accepted by the described MCP tool. ${AIRTABLE_MCP_AUTH_CONTRACT.agentGuidance}`,
      'Ordinary record calls are capped to a byte-safe preview and do not expose continuation cursors. A persistent terminal workflow may use op=page with input {baseId,tableId,fieldIds?,cursor?}; pass each returned nextCursor as the next cursor, keep every response file outside model context, and stop when hasMore=false.',
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
        if (args.op === 'page') {
          const issue = validatePageRequest(product, args, ctx);
          if (issue) return badArgs(product.toolId, issue);
          return ok({
            level: 'native_schema_and_connection',
            connectionEligible: true,
            nativeSchemaValidated: true,
            nativeTool: args.nativeTool,
            action,
            requiredActions: ['read'],
          });
        }
        const description = await describeOperation(connection.client, args.nativeTool);
        if (!description) return missingNativeTool(product, args.nativeTool);
        if (args.op === 'call') {
          const issue = validateOperationInput(description.inputSchema, args.nativeTool, args.input ?? {});
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
        if (args.op === 'page') {
          const issue = validatePageRequest(product, args, ctx);
          if (issue) return badArgs(product.toolId, issue);
          if (!connection.client.listRecordsPage) {
            return missingNativeTool(product, 'Airtable Web API page reader');
          }
          const input = AirtablePageInputSchema.parse(args.input ?? {});
          ctx.onProgress?.(`Reading ${product.name} page…`);
          const page = await connection.client.listRecordsPage({
            baseId: input.baseId,
            tableId: input.tableId,
            ...(input.fieldIds ? { fieldIds: input.fieldIds } : {}),
            ...(input.cursor ? { offset: input.cursor } : {}),
          }, ctx.abortSignal);
          return ok({
            success: true,
            nativeTool: args.nativeTool,
            data: {
              records: page.records,
              returnedRecordCount: page.records.length,
              hasMore: Boolean(page.nextCursor),
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            },
            message: `${product.name} file page completed`,
          });
        }
        if (args.op === 'describe') {
          ctx.onProgress?.(`Loading ${product.name} operation schema…`);
          const description = await describeOperation(connection.client, args.nativeTool);
          if (!description) return missingNativeTool(product, args.nativeTool);
          return ok({ success: true, nativeTool: args.nativeTool, data: description });
        }

        ctx.onProgress?.(`${progressVerb(action)} ${product.name}…`);
        if (args.nativeTool === LIST_FIELDS_TOOL) {
          const parsed = ListFieldsInputSchema.safeParse(args.input ?? {});
          if (!parsed.success) {
            return badArgs(product.toolId, parsed.error.errors
              .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
              .join('; '));
          }
          const fields = await connection.client.listFieldNamesForTable?.(
            parsed.data.baseId,
            parsed.data.tableId,
            ctx.abortSignal,
          );
          if (!fields || fields.size === 0) {
            return badArgs(
              product.toolId,
              `No Airtable fields found for table ${parsed.data.tableId}. Resolve the table ID with list_tables_for_base and try again.`,
            );
          }
          return ok({
            success: true,
            nativeTool: args.nativeTool,
            data: {
              fields: [...fields].map(([id, name]) => ({ id, name })),
              fieldCount: fields.size,
            },
            message: `${product.name} field index completed`,
          });
        }

        const nativeInput = RECORD_READ_OPERATIONS.has(args.nativeTool)
          ? boundedRecordInput(args.nativeTool, args.input ?? {})
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
            ? `${product.name} preview completed. This MCP preview is not a full export or broad analytics source; use Menhood Data for synced Menhood analysis.`
            : `${product.name} operation completed`,
        });
      } catch (cause) {
        return upstreamFailure(product.toolId, cause);
      }
    },
  };
}

function boundedRecordInput(
  nativeTool: string,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const limitKey = nativeTool === 'search_records' ? 'limit' : 'pageSize';
  const requested = typeof input[limitKey] === 'number' && Number.isFinite(input[limitKey])
    ? Math.trunc(input[limitKey])
    : RECORD_PREVIEW_LIMIT;
  const normalized = normalizeRecordReadInput(nativeTool, input);
  return {
    ...normalized,
    [limitKey]: Math.max(1, Math.min(requested, RECORD_PREVIEW_LIMIT)),
  };
}

function normalizeRecordReadInput(
  nativeTool: string,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (nativeTool === 'search_records') {
    const {
      pageSize: _pageSize,
      tableId,
      fieldIds,
      filter,
      ...rest
    } = input;
    return {
      ...rest,
      ...(rest['table'] === undefined && tableId !== undefined ? { table: tableId } : {}),
      ...(rest['resultFieldIds'] === undefined && fieldIds !== undefined ? { resultFieldIds: fieldIds } : {}),
      ...(rest['filters'] === undefined && filter !== undefined ? { filters: filter } : {}),
    };
  }
  if (nativeTool === 'list_records_for_table') {
    const { limit: _limit, filter, ...rest } = input;
    return rest['filters'] === undefined && filter !== undefined
      ? { ...rest, filters: filter }
      : rest;
  }
  return { ...input };
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
  // Keep ordinary MCP record reads as bounded previews. Trusted terminal
  // workflows use op=page, whose result is written to a local file.
  const { nextCursor: _nextCursor, offset: _offset, ...previewValue } = value;
  return {
    ...previewValue,
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

function validateOperationInput(
  inputSchema: unknown,
  nativeTool: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  if (nativeTool === LIST_FIELDS_TOOL) {
    const parsed = ListFieldsInputSchema.safeParse(input);
    return parsed.success
      ? undefined
      : parsed.error.errors
        .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
  }
  return validateNativeInput(inputSchema, nativeTool, input);
}

async function describeOperation(
  client: AirtableMcpPort,
  nativeTool: string,
): Promise<AirtableMcpToolDescription | null> {
  return nativeTool === LIST_FIELDS_TOOL
    ? LIST_FIELDS_DESCRIPTION
    : client.describeTool(nativeTool);
}

function validatePageRequest(
  product: AirtableProductDefinition,
  args: AirtableMcpArgs,
  ctx: ToolExecutionContext,
): string | undefined {
  if (args.nativeTool !== LIST_RECORDS_TOOL) {
    return 'op=page is available only for list_records_for_table';
  }
  if (product.service !== 'base' && product.service !== 'records') {
    return `op=page is not available through ${product.name}`;
  }
  if (ctx.resultAudience !== 'local_file') {
    return 'op=page is available only inside a divo-local terminal workflow so bulk rows stay outside model context';
  }
  const parsed = AirtablePageInputSchema.safeParse(args.input ?? {});
  return parsed.success
    ? undefined
    : parsed.error.errors
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
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
