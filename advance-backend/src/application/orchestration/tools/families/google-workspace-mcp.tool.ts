import { z } from 'zod';
import Ajv from 'ajv';
import type { Tool } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { err, ok } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { TOOL_SUPPORTED_ACTIONS } from '../../../../domain/tools/tool-id';
import { asToolId } from '../../../../shared/ids';
import {
  GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT,
  GOOGLE_WORKSPACE_PRODUCTS,
  googleWorkspaceActionFor,
  googleWorkspaceScopeGroupsFor,
  type GoogleWorkspaceProductDefinition,
} from '../../../google/google-workspace-mcp-manifest';

const ArgsSchema = z.object({
  connectionId: z.string().uuid().optional(),
  op: z.enum(['describe', 'call']),
  nativeTool: z.string().min(1),
  input: z.record(z.unknown()).optional(),
}).superRefine((value, context) => {
  // Mutating or data-reading calls must identify one account exactly. Besides
  // avoiding accidental cross-account work, this is what lets the backend
  // enforce the connection owner's operating policy and live rate budget.
  if (value.op === 'call' && !value.connectionId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connectionId'],
      message: 'is required for Google Workspace calls; reuse the run-bootstrap account or use connections.list once when none was loaded',
    });
  }
});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  success: z.boolean(),
  nativeTool: z.string(),
  data: z.unknown().optional(),
  message: z.string().optional(),
});
type ToolResult = z.infer<typeof ResultSchema>;

const nativeSchemaValidator = new Ajv({ strict: false, allErrors: true });

export interface GoogleWorkspaceMcpToolDescription {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface GoogleWorkspaceMcpPort {
  describeTool(name: string): Promise<GoogleWorkspaceMcpToolDescription | null>;
  callTool(name: string, input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface GoogleWorkspaceMcpConnection {
  readonly client: GoogleWorkspaceMcpPort;
}

export interface GoogleWorkspaceMcpConnectionChoice {
  readonly connectionId: string;
  readonly label: string;
  readonly accountEmail?: string;
  readonly accountName?: string;
  readonly access: 'read_only' | 'read_write' | 'admin';
}

export type GoogleWorkspaceMcpConnectionResolution =
  | { readonly status: 'resolved'; readonly connection: GoogleWorkspaceMcpConnection }
  | { readonly status: 'unavailable' }
  | { readonly status: 'choose_connection'; readonly connections: readonly GoogleWorkspaceMcpConnectionChoice[] };

export type ResolveGoogleWorkspaceMcpConnection = (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId?: string;
  readonly minimumAccess: 'read_only' | 'read_write';
  readonly requiredScopeGroups: readonly (readonly string[])[];
  /** Discovery-only schema preload must not count as real account usage. */
  readonly markLastUsed?: boolean;
}) => Promise<GoogleWorkspaceMcpConnectionResolution>;

export function createGoogleWorkspaceMcpTools(deps: {
  readonly getConnection: ResolveGoogleWorkspaceMcpConnection;
}): Tool<Args, ToolResult>[] {
  return GOOGLE_WORKSPACE_PRODUCTS.map((product) => createProductTool(product, deps));
}

function createProductTool(
  product: GoogleWorkspaceProductDefinition,
  deps: { readonly getConnection: ResolveGoogleWorkspaceMcpConnection },
): Tool<Args, ToolResult> {
  const supportedActions = new Set<ToolActionGroup>(
    TOOL_SUPPORTED_ACTIONS[product.toolId] as readonly ToolActionGroup[],
  );

  return {
    id: asToolId(product.toolId),
    family: 'google',
    actionGroups: supportedActions,
    argsSchema: ArgsSchema,
    resultSchema: ResultSchema,
    description: product.description,
    parameterDocs: [
      'connectionId: reuse the exact run-bootstrap account when supplied. In backend-hosted channels, omit it when no account was supplied; the backend selects only one eligible account or returns safe choices. Reuse the same connectionId for describe and call.',
      'op: describe|call. Prefer the exact schema already loaded in bootstrap.nativeContracts. Use describe once only for a required native operation whose schema is absent; input may be omitted for describe.',
      `nativeTool: one of ${product.tools.join('|')}.`,
      `input: exact object accepted by the described MCP tool. ${GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.agentGuidance}`,
    ].join(' '),
    permissionCheck(args, permission) {
      if (!product.tools.includes(args.nativeTool)) {
        return err(new PermissionError({
          toolId: product.toolId,
          action: 'read',
          reason: 'not_allowed',
          message: `${args.nativeTool} is not an approved ${product.name} operation`,
        }));
      }
      const action = args.op === 'describe'
        ? 'read'
        : googleWorkspaceActionFor(args.nativeTool, args.input ?? {});
      const allowed = permission.allowedActionsByTool.get(asToolId(product.toolId))?.has(action) ?? false;
      return allowed
        ? ok(action)
        : err(new PermissionError({ toolId: product.toolId, action, reason: 'not_allowed' }));
    },
    async preflight(args, ctx) {
      if (!product.tools.includes(args.nativeTool)) {
        return badArgs(product.toolId, `${args.nativeTool} is not an approved ${product.name} operation`);
      }
      const nativeInputIssue = validateDivoNativeInput(product.toolId, args.nativeTool, args.input ?? {});
      if (nativeInputIssue) return badArgs(product.toolId, nativeInputIssue);

      const action = args.op === 'describe'
        ? 'read'
        : googleWorkspaceActionFor(args.nativeTool, args.input ?? {});
      const connectionResolution = await deps.getConnection({
        companyId: ctx.runContext.companyId,
        userId: ctx.runContext.userId,
        ...(args.connectionId ? { connectionId: args.connectionId } : {}),
        minimumAccess: action === 'read' ? 'read_only' : 'read_write',
        requiredScopeGroups: args.op === 'describe'
          ? []
          : googleWorkspaceScopeGroupsFor(product, args.nativeTool, action),
      });
      if (connectionResolution.status === 'choose_connection') {
        return badArgs(
          product.toolId,
          `${product.name} preflight requires one exact user-selected connectionId; multiple eligible accounts are available`,
        );
      }
      if (connectionResolution.status === 'unavailable') {
        return err(new ToolError({
          toolId: product.toolId,
          reason: 'unrecoverable',
          message: `${product.name} preflight failed because the selected connection is unavailable, not shared for this action, or missing required scopes.`,
        }));
      }

      try {
        const description = await connectionResolution.connection.client.describeTool(args.nativeTool);
        if (!description) {
          return err(new ToolError({
            toolId: product.toolId,
            reason: 'upstream_failure',
            message: `${args.nativeTool} is missing from the pinned Google Workspace MCP server`,
          }));
        }
        if (args.op === 'call') {
          const validate = nativeSchemaValidator.compile(description.inputSchema as object);
          const valid = validate(args.input ?? {});
          if (!valid) {
            return badArgs(
              product.toolId,
              `Invalid native input for ${args.nativeTool} — ${nativeSchemaValidator.errorsText(validate.errors)}`,
            );
          }
        }
        return ok({
          level: 'native_schema_and_connection',
          connectionEligible: true,
          nativeSchemaValidated: true,
          nativeTool: args.nativeTool,
          action,
        });
      } catch (cause) {
        return err(new ToolError({
          toolId: product.toolId,
          reason: 'upstream_failure',
          cause,
          message: cause instanceof Error ? cause.message : String(cause),
        }));
      }
    },
    async execute(args, ctx): Promise<Result<ToolResult, ToolError>> {
      if (!product.tools.includes(args.nativeTool)) {
        return badArgs(product.toolId, `${args.nativeTool} is not an approved ${product.name} operation`);
      }
      const nativeInputIssue = validateDivoNativeInput(product.toolId, args.nativeTool, args.input ?? {});
      if (nativeInputIssue) return badArgs(product.toolId, nativeInputIssue);

      const action = args.op === 'describe'
        ? 'read'
        : googleWorkspaceActionFor(args.nativeTool, args.input ?? {});
      const connectionResolution = await deps.getConnection({
        companyId: ctx.runContext.companyId,
        userId: ctx.runContext.userId,
        ...(args.connectionId ? { connectionId: args.connectionId } : {}),
        minimumAccess: action === 'read' ? 'read_only' : 'read_write',
        requiredScopeGroups: args.op === 'describe'
          ? []
          : googleWorkspaceScopeGroupsFor(product, args.nativeTool, action),
      });
      if (connectionResolution.status === 'choose_connection') {
        return ok({
          success: false,
          nativeTool: args.nativeTool,
          data: {
            code: 'google_workspace_connection_selection_required',
            connections: connectionResolution.connections,
          },
          message: 'Choose a Google Workspace connection before continuing.',
        });
      }
      if (connectionResolution.status === 'unavailable') {
        return err(new ToolError({
          toolId: product.toolId,
          reason: 'unrecoverable',
          message: `${product.name} connection is unavailable, not shared for this action, or missing required scopes. Reconnect Google Workspace to grant the complete Workspace scopes.`,
        }));
      }
      const connection = connectionResolution.connection;

      try {
        if (args.op === 'describe') {
          ctx.onProgress?.(`Loading ${product.name} operation schema…`);
          const description = await connection.client.describeTool(args.nativeTool);
          if (!description) {
            return err(new ToolError({
              toolId: product.toolId,
              reason: 'upstream_failure',
              message: `${args.nativeTool} is missing from the pinned Google Workspace MCP server`,
            }));
          }
          return ok({ success: true, nativeTool: args.nativeTool, data: description });
        }

        ctx.onProgress?.(`${progressVerb(action)} ${product.name}…`);
        const data = await connection.client.callTool(args.nativeTool, args.input ?? {});
        return ok({
          success: true,
          nativeTool: args.nativeTool,
          data,
          message: `${product.name} operation completed`,
        });
      } catch (cause) {
        return err(new ToolError({
          toolId: product.toolId,
          reason: 'upstream_failure',
          cause,
          message: cause instanceof Error ? cause.message : String(cause),
        }));
      }
    },
  };
}

function validateDivoNativeInput(
  toolId: string,
  nativeTool: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  if (toolId !== 'googleSheets' || nativeTool !== 'modify_sheet_values') return undefined;
  const values = input['values'];
  if (!Array.isArray(values)) return undefined;

  for (let rowIndex = 0; rowIndex < values.length; rowIndex++) {
    const row = values[rowIndex];
    if (!Array.isArray(row)) {
      return `Invalid native input for ${nativeTool} — values[${rowIndex}] must be an array of cells`;
    }
    for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
      if (!isGoogleSheetScalar(row[columnIndex])) {
        return `Invalid native input for ${nativeTool} — values[${rowIndex}][${columnIndex}] must be string, number, boolean, or null; serialize objects and arrays deliberately before writing`;
      }
    }
  }
  return undefined;
}

function isGoogleSheetScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

function progressVerb(action: ToolActionGroup): string {
  if (action === 'read') return 'Reading';
  if (action === 'send') return 'Sending with';
  if (action === 'execute') return 'Running';
  return 'Updating';
}

function badArgs(toolId: string, message: string): Result<never, ToolError> {
  return err(new ToolError({ toolId, reason: 'bad_args', message }));
}
