import { z } from 'zod';
import type { Tool } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { TOOL_SUPPORTED_ACTIONS } from '../../../domain/tools/tool-id';
import { asToolId } from '../../../shared/ids';
import {
  AITABLE_AUTH_CONTRACT,
  AITABLE_PRODUCTS,
  aitableOperationFor,
  aitableOperationNames,
  type AitableProductDefinition,
} from '../../aitable/aitable-manifest';
import {
  AitableError,
  AitablePartialWriteError,
  type AitableClient,
} from '../../../infrastructure/aitable/aitable.client';
import {
  encodeRecordFields,
  describeFieldsForModel,
  AitableFieldEncodingError,
} from '../../../infrastructure/aitable/aitable-field-codec';

const ArgsSchema = z.object({
  connectionId: z.string().uuid().optional(),
  operation: z.string().min(1),
  input: z.record(z.unknown()).optional(),
}).superRefine((value, context) => {
  // Naming one account is what lets the backend apply that connection's
  // governance and audit trail to the call, and prevents a write landing in
  // whichever workspace happened to sort first.
  if (!value.connectionId && !READ_ONLY_DISCOVERY.has(value.operation)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connectionId'],
      message: 'is required; reuse the run-bootstrap AITable account or call list_spaces once to discover one',
    });
  }
});
type Args = z.infer<typeof ArgsSchema>;

/** Operations safe to attempt before an account has been chosen. */
const READ_ONLY_DISCOVERY = new Set(['list_spaces']);

const ResultSchema = z.object({
  success: z.boolean(),
  operation: z.string(),
  data: z.unknown().optional(),
  message: z.string().optional(),
});
type ToolResult = z.infer<typeof ResultSchema>;

export interface AitableConnectionChoice {
  readonly connectionId: string;
  readonly label: string;
  readonly accountName?: string;
  readonly access: 'read_only' | 'read_write' | 'admin';
}

export type AitableConnectionResolution =
  | { readonly status: 'resolved'; readonly connectionId: string; readonly connection: { readonly client: AitableClient } }
  | { readonly status: 'unavailable' }
  | { readonly status: 'choose_connection'; readonly connections: readonly AitableConnectionChoice[] }
  /** The account exists and is shared, but its API key was revoked upstream. */
  | { readonly status: 'needs_key'; readonly connections: readonly AitableConnectionChoice[] };

export type ResolveAitableConnection = (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId?: string;
  readonly minimumAccess: 'read_only' | 'read_write';
}) => Promise<AitableConnectionResolution>;

export function createAitableTools(deps: {
  readonly getConnection: ResolveAitableConnection;
  /** Records that AITable rejected a stored key, so it stops being offered. */
  readonly onKeyRejected: (companyId: string, connectionId: string) => Promise<void>;
}): Tool<Args, ToolResult>[] {
  return AITABLE_PRODUCTS.map(product => createProductTool(product, deps));
}

function createProductTool(
  product: AitableProductDefinition,
  deps: {
    readonly getConnection: ResolveAitableConnection;
    readonly onKeyRejected: (companyId: string, connectionId: string) => Promise<void>;
  },
): Tool<Args, ToolResult> {
  const supportedActions = new Set<ToolActionGroup>(
    TOOL_SUPPORTED_ACTIONS[product.toolId] as readonly ToolActionGroup[],
  );

  return {
    id: asToolId(product.toolId),
    family: 'aitable',
    actionGroups: supportedActions,
    argsSchema: ArgsSchema,
    resultSchema: ResultSchema,
    description: product.description,
    parameterDocs: [
      'connectionId: reuse the exact run-bootstrap AITable account when supplied. Only list_spaces may omit it.',
      `operation: one of ${aitableOperationNames(product.toolId).join('|')}.`,
      'input: the arguments for that operation. Read get_fields before writing — it reports which fields are writable and what each accepts.',
      AITABLE_AUTH_CONTRACT.agentGuidance,
    ].join(' '),

    permissionCheck(args, permission) {
      const operation = aitableOperationFor(product.toolId, args.operation);
      // Unknown operations are rejected here, before any network call, so the
      // manifest really is the RBAC surface rather than a suggestion.
      if (!operation) {
        return err(new PermissionError({
          toolId: product.toolId,
          action: 'read',
          reason: 'not_allowed',
          message: `${args.operation} is not an approved ${product.name} operation`,
        }));
      }
      const granted = permission.allowedActionsByTool.get(asToolId(product.toolId));
      if (!granted?.has(operation.action)) {
        return err(new PermissionError({
          toolId: product.toolId,
          action: operation.action,
          reason: 'not_allowed',
        }));
      }
      return ok(operation.action);
    },

    async execute(args, ctx): Promise<Result<ToolResult, ToolError>> {
      const operation = aitableOperationFor(product.toolId, args.operation);
      if (!operation) {
        return badArgs(product.toolId, `${args.operation} is not an approved ${product.name} operation`);
      }

      const resolution = await deps.getConnection({
        companyId: ctx.runContext.companyId,
        userId: ctx.runContext.userId,
        ...(args.connectionId ? { connectionId: args.connectionId } : {}),
        minimumAccess: operation.action === 'read' ? 'read_only' : 'read_write',
      });

      // A pending account choice is a normal, recoverable turn, not a failure.
      if (resolution.status === 'choose_connection') {
        return ok({
          success: false,
          operation: args.operation,
          data: { code: 'aitable_connection_selection_required', connections: resolution.connections },
          message: 'Choose an AITable connection before continuing.',
        });
      }
      // Naming the connection and the fix is the whole point: without it a dead
      // key is indistinguishable from a permissions problem and repeats forever.
      if (resolution.status === 'needs_key') {
        const names = resolution.connections.map(connection => connection.label).join(', ');
        return ok({
          success: false,
          operation: args.operation,
          data: { code: 'aitable_key_needs_replacing', connections: resolution.connections },
          message: `AITable rejected the stored API key for ${names}. Re-enter the key in Divo to reconnect.`,
        });
      }
      if (resolution.status === 'unavailable') {
        return err(new ToolError({
          toolId: product.toolId,
          reason: 'unrecoverable',
          message: `No AITable connection is available for this action. Connect AITable in Divo first.`,
        }));
      }

      try {
        ctx.onProgress?.(progressFor(operation.action, product.name));
        const data = await runOperation(resolution.connection.client, args);
        return ok({ success: true, operation: args.operation, data, message: `${product.name}: ${operation.summary}` });
      } catch (cause) {
        // The only moment a revoked key can be discovered — there is no refresh
        // cycle to find it during — so it is recorded here rather than lost.
        if (cause instanceof AitableError && cause.code === 'invalid_key') {
          await deps.onKeyRejected(ctx.runContext.companyId, resolution.connectionId);
          return ok({
            success: false,
            operation: args.operation,
            data: { code: 'aitable_key_needs_replacing', connectionId: resolution.connectionId },
            message: 'AITable rejected the stored API key for this connection. Re-enter the key in Divo to reconnect.',
          });
        }
        return failureFor(product.toolId, args.operation, cause);
      }
    },
  };
}

async function runOperation(client: AitableClient, args: Args): Promise<unknown> {
  const input = (args.input ?? {}) as Record<string, any>;

  switch (args.operation) {
    case 'list_spaces':
      return { spaces: await client.listSpaces() };

    case 'search_nodes':
      requireString(input, 'spaceId');
      return {
        nodes: await client.searchNodes(input['spaceId'], {
          ...(input['type'] ? { type: input['type'] } : {}),
          ...(input['query'] ? { query: input['query'] } : {}),
        }),
      };

    case 'get_node':
      requireString(input, 'spaceId');
      requireString(input, 'nodeId');
      return await client.getNode(input['spaceId'], input['nodeId']);

    case 'list_views':
      requireString(input, 'datasheetId');
      return { views: await client.listViews(input['datasheetId']) };

    case 'get_fields': {
      requireString(input, 'datasheetId');
      const fields = await client.listFields(input['datasheetId'], input['viewId']);
      // Both shapes: the raw schema, and the writability summary the model
      // needs before composing a write.
      return { fields, ...describeFieldsForModel(fields) };
    }

    case 'list_records':
      requireString(input, 'datasheetId');
      return await client.listRecords(input['datasheetId'], {
        ...(input['viewId'] ? { viewId: input['viewId'] } : {}),
        ...(input['fields'] ? { fields: input['fields'] } : {}),
        ...(input['filterByFormula'] ? { filterByFormula: input['filterByFormula'] } : {}),
        ...(input['sort'] ? { sort: input['sort'] } : {}),
        ...(input['recordIds'] ? { recordIds: input['recordIds'] } : {}),
        ...(input['pageNum'] ? { pageNum: input['pageNum'] } : {}),
        ...(input['pageSize'] ? { pageSize: input['pageSize'] } : {}),
      });

    case 'create_records': {
      requireString(input, 'datasheetId');
      const records = requireRecordArray(input, 'records');
      // The schema is fetched rather than trusted from the model, because
      // encoding is only safe against the datasheet's real field types.
      const schema = await client.listFields(input['datasheetId']);
      return {
        records: await client.createRecords(
          input['datasheetId'],
          records.map(record => ({ fields: encodeRecordFields(schema, record.fields ?? {}) })),
        ),
      };
    }

    case 'update_records': {
      requireString(input, 'datasheetId');
      const records = requireRecordArray(input, 'records');
      const schema = await client.listFields(input['datasheetId']);
      return {
        records: await client.updateRecords(
          input['datasheetId'],
          records.map(record => ({
            // Left absent rather than set to undefined when missing, so the
            // client's own "every update needs a recordId" check is the single
            // place that rejects it.
            ...(record.recordId ? { recordId: record.recordId } : {}),
            fields: encodeRecordFields(schema, record.fields ?? {}),
          })),
        ),
      };
    }

    case 'delete_records': {
      requireString(input, 'datasheetId');
      const recordIds = input['recordIds'];
      if (!Array.isArray(recordIds) || recordIds.length === 0) {
        throw new AitableError('bad_request', 'delete_records needs a non-empty recordIds array.');
      }
      await client.deleteRecords(input['datasheetId'], recordIds);
      return { deleted: recordIds.length, recordIds };
    }

    case 'create_field': {
      requireString(input, 'spaceId');
      requireString(input, 'datasheetId');
      requireString(input, 'name');
      requireString(input, 'type');
      return await client.createField(input['spaceId'], input['datasheetId'], {
        name: input['name'],
        type: input['type'],
        ...(input['property'] ? { property: input['property'] } : {}),
      });
    }

    case 'delete_field': {
      requireString(input, 'spaceId');
      requireString(input, 'datasheetId');
      requireString(input, 'fieldId');
      await client.deleteField(input['spaceId'], input['datasheetId'], input['fieldId']);
      return { deleted: input['fieldId'] };
    }

    default:
      // Unreachable: permissionCheck rejects anything absent from the manifest
      // before execute runs. Kept as a loud failure rather than a silent
      // success in case the two ever drift apart.
      throw new AitableError('bad_request', `${args.operation} has no implementation.`);
  }
}

function requireString(input: Record<string, unknown>, key: string): void {
  if (typeof input[key] !== 'string' || !String(input[key]).trim()) {
    throw new AitableError('bad_request', `${key} is required and must be a string.`);
  }
}

function requireRecordArray(
  input: Record<string, unknown>,
  key: string,
): { recordId?: string; fields?: Record<string, unknown> }[] {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new AitableError('bad_request', `${key} must be a non-empty array.`);
  }
  return value as { recordId?: string; fields?: Record<string, unknown> }[];
}

function progressFor(action: ToolActionGroup, productName: string): string {
  if (action === 'read') return `Reading ${productName}…`;
  if (action === 'delete') return `Removing from ${productName}…`;
  if (action === 'create') return `Creating in ${productName}…`;
  return `Updating ${productName}…`;
}

function failureFor(toolId: string, operation: string, cause: unknown): Result<ToolResult, ToolError> {
  // A partial write is reported as a result rather than an error, because the
  // caller must be told what already landed. Retrying blind duplicates rows.
  if (cause instanceof AitablePartialWriteError) {
    const undone = cause.deleted.length > 0
      ? ' Those records are already gone; do not report the deletion as failed.'
      : ' Check the datasheet before retrying — the accepted records are already there.';
    return ok({
      success: false,
      operation,
      data: {
        code: 'aitable_partial_write',
        written: cause.written,
        ...(cause.deleted.length > 0 ? { deleted: cause.deleted } : {}),
      },
      message: cause.message + undone,
    });
  }
  // A field that could not be encoded is the caller's to fix, and the message
  // already names the field and what it expected.
  if (cause instanceof AitableFieldEncodingError) {
    return err(new ToolError({ toolId, reason: 'bad_args', message: cause.message, cause }));
  }
  if (cause instanceof AitableError) {
    const reason = cause.code === 'rate_limited' ? 'retryable'
      : cause.code === 'bad_request' ? 'bad_args'
        : cause.code === 'forbidden' ? 'unrecoverable'
          : 'upstream_failure';
    return err(new ToolError({ toolId, reason, message: cause.message, cause }));
  }
  return err(new ToolError({
    toolId,
    reason: 'upstream_failure',
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  }));
}

function badArgs(toolId: string, message: string): Result<ToolResult, ToolError> {
  return err(new ToolError({ toolId, reason: 'bad_args', message }));
}
