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

function nativeArgsBranches(nativeTool: z.ZodType<string>) {
  return [
    z.object({
      connectionId: z.string().uuid().optional(),
      op: z.literal('describe'),
      nativeTool,
      input: z.record(z.unknown()).optional(),
    }),
    z.object({
      connectionId: z.string().uuid().optional(),
      op: z.literal('call'),
      nativeTool,
      input: z.record(z.unknown()).optional(),
    }),
  ] as const;
}

function createNativeArgsSchema(nativeTool: z.ZodType<string>) {
  return z.discriminatedUnion('op', nativeArgsBranches(nativeTool));
}

const ArgsSchema = createNativeArgsSchema(z.string().min(1));
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
const RECORD_READ_DEFAULT_ROWS = 100;
export const AIRTABLE_RECORD_READ_MAX_ROWS = 200;
const RECORD_PREVIEW_MAX_BYTES = 24_000;
const RECORD_PREVIEW_MAX_FIELD_BYTES = 2_000;
const SCHEMA_CHOICE_PREVIEW_LIMIT = 50;
const LIST_FIELDS_TOOL = 'list_fields_for_table';
const TABLE_SCHEMA_TOOL = 'get_table_schema';
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
    argsSchema: createNativeArgsSchema(nativeToolEnum(nativeToolNames)) as z.ZodType<AirtableMcpArgs>,
    resultSchema: ResultSchema,
    description: product.description,
    parameterDocs: [
      'connectionId: optional unless the user selected an account or the previous result returned eligible choices. When omitted, Divo selects the only account eligible for the exact action and scopes or returns safe choices. Never pre-list accounts merely to fill this field.',
      'op: describe|call. Prefer the exact schema already loaded in bootstrap.nativeContracts. Use describe once only for a required operation whose schema is absent.',
      `nativeTool: one of ${nativeToolNames.join('|')}.`,
      `input: exact object accepted by the described MCP tool. ${AIRTABLE_MCP_AUTH_CONTRACT.agentGuidance}`,
      'Ordinary record calls are capped to a byte-safe preview of at most 200 rows and do not expose continuation cursors. The exact same op=call through divo-local returns the raw MCP page and cursor into a protected local file. Filter at Airtable with the native structured filters, request only required fields, pass each returned cursor into the next call, and stop when the provider says no page remains. Before a materially large unfiltered scan, estimate the scope and ask the user.',
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
        const isRecordRead = RECORD_READ_OPERATIONS.has(args.nativeTool);
        const fileBackedRead = isRecordRead && ctx.resultAudience === 'local_file';
        const fileBackedSchema = args.nativeTool === TABLE_SCHEMA_TOOL
          && ctx.resultAudience === 'local_file';
        const returnedData = isRecordRead && !fileBackedRead
          ? compactRecordResult(data)
          : args.nativeTool === TABLE_SCHEMA_TOOL && !fileBackedSchema
            ? compactSchemaResult(data)
            : data;
        return ok({
          success: true,
          nativeTool: args.nativeTool,
          data: returnedData,
          message: fileBackedRead
            ? `${product.name} file page completed`
            : isRecordRead
              ? `${product.name} preview completed. Use metadata.totalRecordCount for an exact filtered count or a protected local-file call for complete rows.`
            : `${product.name} operation completed`,
        });
      } catch (cause) {
        return upstreamFailure(product.toolId, cause);
      }
    },
  };
}

/**
 * A select field can contain hundreds of choices. Returning every choice in a
 * direct discovery call makes the schema larger than the actual dataset the
 * member asked about. Keep small choice sets useful inline; large catalogues
 * stay available through the same governed call written to a local file.
 */
function compactSchemaResult(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value['tables'])) return value;
  return {
    ...value,
    tables: value['tables'].map(table => {
      if (!isRecord(table) || !Array.isArray(table['fields'])) return table;
      return {
        ...table,
        fields: table['fields'].map(field => compactSchemaField(field)),
      };
    }),
  };
}

function compactSchemaField(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value['config'])) return value;
  const config = value['config'];
  const choices = Array.isArray(config['choices']) ? config['choices'] : undefined;
  if (!choices || choices.length <= SCHEMA_CHOICE_PREVIEW_LIMIT) return value;
  const { choices: _choices, ...compactConfig } = config;
  return {
    ...value,
    config: {
      ...compactConfig,
      choiceCount: choices.length,
      choicesOmittedFromPreview: true,
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
    : RECORD_READ_DEFAULT_ROWS;
  const normalized = normalizeRecordReadInput(nativeTool, input);
  return {
    ...normalized,
    [limitKey]: Math.max(1, Math.min(requested, AIRTABLE_RECORD_READ_MAX_ROWS)),
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
  for (const record of records.slice(0, AIRTABLE_RECORD_READ_MAX_ROWS)) {
    const compact = compactRecord(record);
    const candidate = {
      ...value,
      records: [...compactRecords, compact],
      returnedRecordCount: compactRecords.length + 1,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > RECORD_PREVIEW_MAX_BYTES) break;
    compactRecords.push(compact);
  }
  // Keep ordinary model-facing record reads as bounded previews. The same
  // native call remains raw when divo-local writes the result to a local file.
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
