import { z } from 'zod';
import Ajv from 'ajv';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { err, ok } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { TOOL_SUPPORTED_ACTIONS } from '../../../../domain/tools/tool-id';
import { asToolId } from '../../../../shared/ids';
import type { CloudinaryAdapter } from '../../../../infrastructure/cloudinary/cloudinary.adapter';
import type {
  AirtableExportJobPayload,
  AirtableExportQueue,
} from '../../../airtable/airtable-export.queue';
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
  csvLink: z.string().optional(),
  csvPublicId: z.string().optional(),
  csvExpiresAt: z.string().optional(),
  totalFetched: z.number().optional(),
  sourceTruncated: z.boolean().optional(),
  exportQueued: z.boolean().optional(),
  exportJobId: z.string().optional(),
});
export type AirtableMcpToolResult = z.infer<typeof ResultSchema>;

const nativeSchemaValidator = new Ajv({ strict: false, allErrors: true });
const RECORD_READ_OPERATIONS = new Set(['list_records_for_table', 'search_records']);
const RECORD_PREVIEW_LIMIT = 10;
const RECORD_PREVIEW_MAX_BYTES = 24_000;
const RECORD_PREVIEW_MAX_FIELD_BYTES = 2_000;
const EXPORT_MAX_PAGE_SIZE = 1_000;
const EXPORT_TARGET_CELLS_PER_PAGE = 24_000;
const MCP_EXPORT_MAX_PAGES = 100;
const REST_EXPORT_MAX_PAGES = 1_000;
const EXPORT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const REST_EXPORT_INPUT_KEYS = new Set([
  'baseId',
  'tableId',
  'fieldIds',
  'returnFieldsByFieldId',
]);

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
  readonly cloudinary?: CloudinaryAdapter;
  readonly csvLinkTtl?: number;
  readonly exportQueue?: Pick<AirtableExportQueue, 'enqueue'>;
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
    readonly cloudinary?: CloudinaryAdapter;
    readonly csvLinkTtl?: number;
    readonly exportQueue?: Pick<AirtableExportQueue, 'enqueue'>;
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
      'Record reads are capped to a byte-safe preview. For a complete record CSV, set top-level exportAll=true on list_records_for_table or search_records; do not fetch cursors manually or use another storage tool.',
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
          if (!RECORD_READ_OPERATIONS.has(args.nativeTool)) {
            return badArgs(product.toolId, 'exportAll is supported only for Airtable record list/search operations');
          }
          if (
            deps.exportQueue
            && ctx.runContext.channel === 'lark'
            && ctx.runContext.chatId
            && args.connectionId
          ) {
            const payload: AirtableExportJobPayload = {
              companyId: ctx.runContext.companyId,
              userId: ctx.runContext.userId,
              ...(ctx.runContext.departmentId ? { departmentId: ctx.runContext.departmentId } : {}),
              connectionId: args.connectionId,
              toolId: product.toolId,
              nativeTool: args.nativeTool as AirtableExportJobPayload['nativeTool'],
              input: args.input ?? {},
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
              message: 'Airtable export queued. I will deliver the temporary CSV link to this Lark chat when it is ready.',
            });
          }
          return exportAirtableRecords({
            args,
            ctx,
            client: connection.client,
            toolId: product.toolId,
            ...(deps.cloudinary ? { cloudinary: deps.cloudinary } : {}),
            ...(deps.csvLinkTtl !== undefined ? { csvLinkTtl: deps.csvLinkTtl } : {}),
          });
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
            ? `${product.name} preview completed. Set top-level exportAll=true on this same tool call for a complete temporary CSV; do not fetch cursors manually.`
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

export async function exportAirtableRecords(input: {
  readonly args: AirtableMcpArgs;
  readonly ctx: ToolExecutionContext;
  readonly client: AirtableMcpPort;
  readonly toolId: AirtableProductDefinition['toolId'];
  readonly cloudinary?: CloudinaryAdapter;
  readonly csvLinkTtl?: number;
}): Promise<Result<AirtableMcpToolResult, ToolError>> {
  const records: Record<string, unknown>[] = [];
  const baseInput = { ...(input.args.input ?? {}) };
  delete baseInput['cursor'];
  delete baseInput['pageSize'];
  let cursor: string | undefined;
  let sourceTruncated = false;
  let bufferedBytes = 0;
  const seenCursors = new Set<string>();
  const baseId = String(baseInput['baseId'] ?? '');
  const tableId = String(baseInput['tableId'] ?? '');
  const useRestList = input.args.nativeTool === 'list_records_for_table'
    && Boolean(baseId && tableId && input.client.listRecordsPage)
    && Object.keys(baseInput).every(key => REST_EXPORT_INPUT_KEYS.has(key));
  const fieldNames = !useRestList && baseId && tableId
    ? await input.client.listFieldNamesForTable?.(baseId, tableId, input.ctx.abortSignal) ?? new Map()
    : new Map<string, string>();
  const selectedFieldCount = Array.isArray(baseInput['fieldIds'])
    ? baseInput['fieldIds'].length
    : fieldNames.size;
  const pageSize = useRestList
    ? 100
    : Math.max(
        1,
        Math.min(
          EXPORT_MAX_PAGE_SIZE,
          Math.floor(EXPORT_TARGET_CELLS_PER_PAGE / Math.max(1, selectedFieldCount)),
        ),
      );

  const maxPages = useRestList ? REST_EXPORT_MAX_PAGES : MCP_EXPORT_MAX_PAGES;
  pageLoop: for (let page = 0; page < maxPages; page += 1) {
    input.ctx.abortSignal?.throwIfAborted();
    input.ctx.onProgress?.(`Exporting Airtable records — page ${page + 1}…`);
    const fieldIds = Array.isArray(baseInput['fieldIds'])
      ? baseInput['fieldIds'].filter((value): value is string => typeof value === 'string')
      : undefined;
    const pageResult = useRestList
      ? await input.client.listRecordsPage!({
          baseId,
          tableId,
          ...(fieldIds ? { fieldIds } : {}),
          ...(cursor ? { offset: cursor } : {}),
        }, input.ctx.abortSignal)
      : await input.client.callTool(input.args.nativeTool, {
          ...baseInput,
          pageSize,
          ...(cursor ? { cursor } : {}),
        }, {
          ...(input.ctx.abortSignal ? { signal: input.ctx.abortSignal } : {}),
          maxTotalTimeoutMs: 60_000,
        });
    if (!isRecord(pageResult) || !Array.isArray(pageResult['records'])) {
      return err(new ToolError({
        toolId: input.toolId,
        reason: 'upstream_failure',
        message: `${input.args.nativeTool} returned an unexpected record response`,
      }));
    }
    for (const record of pageResult['records'].filter(isRecord)) {
      const recordBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
      if (bufferedBytes + recordBytes > EXPORT_MAX_BUFFERED_BYTES) {
        sourceTruncated = true;
        break pageLoop;
      }
      records.push(record);
      bufferedBytes += recordBytes;
    }
    const nextCursor = typeof pageResult['nextCursor'] === 'string' && pageResult['nextCursor'].trim()
      ? pageResult['nextCursor']
      : undefined;
    if (!nextCursor) {
      cursor = undefined;
      break;
    }
    if (seenCursors.has(nextCursor) || page === maxPages - 1) {
      sourceTruncated = true;
      cursor = nextCursor;
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  const preview = compactRecordResult({
    records: records.slice(0, RECORD_PREVIEW_LIMIT),
    ...(cursor ? { nextCursor: cursor } : {}),
  });
  if (!input.cloudinary?.isAvailable) {
    return ok({
      success: false,
      nativeTool: input.args.nativeTool,
      data: preview,
      totalFetched: records.length,
      sourceTruncated,
      message: 'Airtable records were read, but temporary CSV storage is unavailable. The full dataset was not returned to the model.',
    });
  }
  if (records.length === 0) {
    return ok({
      success: true,
      nativeTool: input.args.nativeTool,
      data: preview,
      totalFetched: 0,
      sourceTruncated,
      message: 'No Airtable records matched the request, so no CSV was created.',
    });
  }

  const rows = records.map(record => flattenAirtableRecord(record, fieldNames));
  const columns = collectColumns(rows);
  const csvBuffer = buildCsv(columns, rows);
  const safeBaseId = safeFilePart(baseId || 'base');
  const safeTableId = safeFilePart(tableId || 'records');
  const exported = await input.cloudinary.uploadCsvBuffer({
    buffer: csvBuffer,
    fileName: `airtable-${safeBaseId}-${safeTableId}-${new Date().toISOString().slice(0, 10)}.csv`,
    companyId: input.ctx.runContext.companyId,
    ttlSeconds: input.csvLinkTtl ?? 86_400,
  });
  if (!exported) {
    return ok({
      success: false,
      nativeTool: input.args.nativeTool,
      data: preview,
      totalFetched: records.length,
      sourceTruncated,
      message: 'Airtable records were read, but CSV upload failed. The full dataset was not returned to the model.',
    });
  }

  input.ctx.logger.info('airtable.records.csv_exported', {
    companyId: input.ctx.runContext.companyId,
    nativeTool: input.args.nativeTool,
    recordsFetched: records.length,
    sourceTruncated,
    expiresAt: exported.expiresAt,
  });
  return ok({
    success: true,
    nativeTool: input.args.nativeTool,
    data: preview,
    csvLink: exported.signedUrl,
    csvPublicId: exported.publicId,
    csvExpiresAt: exported.expiresAt,
    totalFetched: records.length,
    sourceTruncated,
    message: `Exported ${records.length} Airtable records to a temporary CSV.${sourceTruncated ? ' Pagination safety limit reached; additional records may exist.' : ''}`,
  });
}

function flattenAirtableRecord(
  record: Record<string, unknown>,
  fieldNames: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    record_id: record['id'] ?? '',
    created_time: record['createdTime'] ?? record['created_time'] ?? '',
  };
  const fields = isRecord(record['cellValuesByFieldId'])
    ? record['cellValuesByFieldId']
    : isRecord(record['fields'])
      ? record['fields']
      : {};
  for (const [fieldIdOrName, value] of Object.entries(fields)) {
    row[fieldNames.get(fieldIdOrName) ?? fieldIdOrName] = csvValue(value);
  }
  return row;
}

function csvValue(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function collectColumns(rows: readonly Record<string, unknown>[]): string[] {
  const columns = new Set<string>(['record_id', 'created_time']);
  for (const row of rows) {
    for (const key of Object.keys(row)) columns.add(key);
  }
  return [...columns];
}

function buildCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): Buffer {
  const lines = [
    columns.map(escapeCsvCell).join(','),
    ...rows.map(row => columns.map(column => escapeCsvCell(row[column])).join(',')),
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

function escapeCsvCell(value: unknown): string {
  const raw = typeof value === 'string' && /^[=+\-@]/.test(value)
    ? `'${value}`
    : String(value ?? '');
  if (raw.includes(',') || raw.includes('"') || raw.includes('\n') || raw.includes('\r')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function safeFilePart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'records';
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
