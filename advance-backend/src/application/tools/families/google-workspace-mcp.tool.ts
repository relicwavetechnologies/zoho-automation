import { z } from 'zod';
import Ajv from 'ajv';
import type { Tool } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { TOOL_SUPPORTED_ACTIONS } from '../../../domain/tools/tool-id';
import { asToolId } from '../../../shared/ids';
import {
  GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT,
  GOOGLE_WORKSPACE_PRODUCTS,
  googleWorkspaceActionFor,
  googleWorkspaceScopeGroupsFor,
  type GoogleWorkspaceProductDefinition,
} from '../../google/google-workspace-mcp-manifest';
import type { GoogleSheetReferenceParseResult } from '../../data-export/google-sheet-resource-reference';
import type { GoogleSheetResourceResolution } from '../../data-export/google-sheet-resource-resolver';

const ArgsSchema = z.discriminatedUnion('op', [
  z.object({
    connectionId: z.string().uuid().optional(),
    op: z.literal('describe'),
    nativeTool: z.string().min(1),
    input: z.record(z.unknown()).optional(),
  }),
  z.object({
    connectionId: z.string().uuid(),
    op: z.literal('call'),
    nativeTool: z.string().min(1),
    input: z.record(z.unknown()).optional(),
  }),
  z.object({
    connectionId: z.string().uuid().optional(),
    op: z.literal('resolve_reference'),
    url: z.string().trim().min(1).max(2_048),
  }),
]);
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
  describeTool(name: string, abortSignal?: AbortSignal): Promise<GoogleWorkspaceMcpToolDescription | null>;
  callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    abortSignal?: AbortSignal,
  ): Promise<unknown>;
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
  | {
      readonly status: 'unavailable';
      /** Present when the caller named an account it cannot reach. */
      readonly reason?: 'none_accessible' | 'insufficient_access' | 'requested_not_accessible';
      readonly accessible?: readonly GoogleWorkspaceMcpConnectionChoice[];
    }
  | { readonly status: 'choose_connection'; readonly connections: readonly GoogleWorkspaceMcpConnectionChoice[] };

export type ResolveGoogleWorkspaceMcpConnection = (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId?: string;
  readonly minimumAccess: 'read_only' | 'read_write';
  readonly requiredScopeGroups: readonly (readonly string[])[];
  /** Discovery-only schema preload must not count as real account usage. */
  readonly markLastUsed?: boolean;
  readonly abortSignal?: AbortSignal;
}) => Promise<GoogleWorkspaceMcpConnectionResolution>;

export type ResolveGoogleSheetReference = (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly url: string;
  readonly connectionId?: string;
  readonly abortSignal?: AbortSignal;
}) => Promise<
  GoogleSheetResourceResolution
  | {
      readonly status: 'invalid_reference';
      readonly reason: Exclude<GoogleSheetReferenceParseResult, { readonly ok: true }>['reason'];
    }
>;

export type BeginGoogleWorkspaceAuthorization = (input: {
  readonly toolId: string;
  readonly reason: string;
  readonly runContext: import('../../../domain/orchestration/run-context').RunContext;
}) => Promise<
  | { readonly status: 'sent'; readonly intentId: string }
  | { readonly status: 'already_pending'; readonly intentId: string }
  | { readonly status: 'unavailable' }
>;

/**
 * What to say when no Connect card can reach the member.
 *
 * A run outside Lark has no conversation to deliver a card into, and card
 * delivery can fail inside one. The old behaviour was to return the connection
 * problem on its own, which reads as "you are stuck" — the member is perfectly
 * able to connect Google themselves, and this names where.
 */
export const SELF_SERVICE_CONNECT_HINT =
  'Divo could not send a Connect card here. Tell the user to open Connected '
  + 'apps in Divo and connect Google there, then ask again; do not retry.';

export function createGoogleWorkspaceMcpTools(deps: {
  readonly getConnection: ResolveGoogleWorkspaceMcpConnection;
  readonly resolveSheetReference?: ResolveGoogleSheetReference;
  readonly beginAuthorization?: BeginGoogleWorkspaceAuthorization;
}): Tool<Args, ToolResult>[] {
  return GOOGLE_WORKSPACE_PRODUCTS.map((product) => createProductTool(product, deps));
}

function createProductTool(
  product: GoogleWorkspaceProductDefinition,
  deps: {
    readonly getConnection: ResolveGoogleWorkspaceMcpConnection;
    readonly resolveSheetReference?: ResolveGoogleSheetReference;
    readonly beginAuthorization?: BeginGoogleWorkspaceAuthorization;
  },
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
      product.toolId === 'googleSheets'
        ? 'op: describe|call|resolve_reference. Use resolve_reference with url for an exact pasted Google Sheet before any web lookup; connectionId is optional until Divo returns an account choice. Prefer the exact schema already loaded in bootstrap.nativeContracts. Use describe once only for a required native operation whose schema is absent; input may be omitted for describe.'
        : 'op: describe|call. Prefer the exact schema already loaded in bootstrap.nativeContracts. Use describe once only for a required native operation whose schema is absent; input may be omitted for describe.',
      `nativeTool: one of ${product.tools.join('|')}.`,
      `input: exact object accepted by the described MCP tool. ${GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.agentGuidance}`,
    ].join(' '),
    permissionCheck(args, permission) {
      if (args.op === 'resolve_reference') {
        const allowed = product.toolId === 'googleSheets'
          && (permission.allowedActionsByTool.get(asToolId(product.toolId))?.has('read') ?? false);
        return allowed
          ? ok('read')
          : err(new PermissionError({ toolId: product.toolId, action: 'read', reason: 'not_allowed' }));
      }
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
      if (args.op === 'resolve_reference') {
        if (product.toolId !== 'googleSheets' || !deps.resolveSheetReference) {
          return badArgs(product.toolId, 'Pasted Sheet reference resolution is unavailable');
        }
        return ok({
          level: 'resource_reference',
          nativeTool: 'resolve_sheet_reference',
          action: 'read' as const,
        });
      }
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
        ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
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
          message: unavailableMessage(product, connectionResolution),
        }));
      }

      try {
        const description = await connectionResolution.connection.client.describeTool(
          args.nativeTool,
          ctx.abortSignal,
        );
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
      if (args.op === 'resolve_reference') {
        if (product.toolId !== 'googleSheets' || !deps.resolveSheetReference) {
          return badArgs(product.toolId, 'Pasted Sheet reference resolution is unavailable');
        }
        try {
          ctx.onProgress?.('Checking this Google Sheet and its writable account…');
          const resolution = await deps.resolveSheetReference({
            companyId: ctx.runContext.companyId,
            userId: ctx.runContext.userId,
            url: args.url,
            ...(args.connectionId ? { connectionId: args.connectionId } : {}),
            ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          });
          if (
            (resolution.status === 'no_connection' || resolution.status === 'missing_scope')
            && !args.connectionId
            && deps.beginAuthorization
          ) {
            const authorization = await deps.beginAuthorization({
              toolId: product.toolId,
              reason: resolution.status === 'missing_scope'
                ? 'Reconnect Google to grant Drive and Sheets write access for this Sheet.'
                : 'Connect a writable personal Google account to open this Sheet.',
              runContext: ctx.runContext,
            });
            if (authorization.status !== 'unavailable') {
              return ok({
                success: false,
                nativeTool: 'resolve_sheet_reference',
                data: {
                  code: 'google_workspace_authorization_pending',
                  intentId: authorization.intentId,
                },
                message:
                  'The Google connection card was sent. End this run now; '
                  + 'Divo will start a fresh run automatically after OAuth completes.',
              });
            }
          }
          return ok({
            success: resolution.status === 'resolved',
            nativeTool: 'resolve_sheet_reference',
            data: resolution,
            message: sheetReferenceResolutionMessage(resolution),
          });
        } catch (cause) {
          return err(new ToolError({
            toolId: product.toolId,
            reason: 'upstream_failure',
            cause,
            message: cause instanceof Error ? cause.message : String(cause),
          }));
        }
      }
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
        ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
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
        const reason = unavailableMessage(product, connectionResolution);
        if (
          deps.beginAuthorization
          && (connectionResolution.accessible?.length ?? 0) === 0
        ) {
          const authorization = await deps.beginAuthorization({
            toolId: product.toolId,
            reason,
            runContext: ctx.runContext,
          });
          if (authorization.status !== 'unavailable') {
            return ok({
              success: false,
              nativeTool: args.nativeTool,
              data: {
                code: 'google_workspace_authorization_pending',
                intentId: authorization.intentId,
              },
              message:
                'The Google connection card was sent. End this run now; '
                + 'Divo will start a fresh run automatically after OAuth completes.',
            });
          }
        }
        // No card is coming — off Lark there is no conversation to send one
        // into, and delivery can fail inside one. Naming the self-service route
        // turns a dead end into something the member can act on.
        return err(new ToolError({
          toolId: product.toolId,
          reason: 'unrecoverable',
          message: `${reason} ${SELF_SERVICE_CONNECT_HINT}`,
        }));
      }
      const connection = connectionResolution.connection;

      try {
        if (args.op === 'describe') {
          ctx.onProgress?.(`Loading ${product.name} operation schema…`);
          const description = await connection.client.describeTool(
            args.nativeTool,
            ctx.abortSignal,
          );
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
        const data = await connection.client.callTool(
          args.nativeTool,
          args.input ?? {},
          ctx.abortSignal,
        );
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

function sheetReferenceResolutionMessage(
  resolution: Awaited<ReturnType<ResolveGoogleSheetReference>>,
): string {
  if (resolution.status === 'resolved') return 'Google Sheet access verified.';
  if (resolution.status === 'choose_connection') {
    return resolution.connections.length === 1
      ? 'Retry with the exact returned connectionId to verify this Google Sheet.'
      : 'Choose which writable personal Google account Divo should use for this Sheet.';
  }
  if (resolution.status === 'invalid_reference') return 'This is not a supported Google Sheet URL.';
  if (resolution.status === 'no_connection') return 'No writable personal Google account is connected.';
  if (resolution.status === 'missing_scope') return 'The connected Google account is missing Drive or Sheets write access.';
  if (resolution.status === 'read_only') return 'This Google Sheet is read-only for the connected personal account.';
  if (resolution.status === 'trashed') return 'This Google Sheet is in the trash.';
  if (resolution.status === 'wrong_type') return 'This Google Drive resource is not a Google Sheet.';
  return 'This Google Sheet is not accessible through the connected personal account.';
}

function badArgs(toolId: string, message: string): Result<never, ToolError> {
  return err(new ToolError({ toolId, reason: 'bad_args', message }));
}

/**
 * "No account" and "not that account" need different answers.
 *
 * Told only that a connection was unavailable, a model that had guessed an ID
 * concluded the member had no Google account at all and said so — while the
 * member held a read-only grant on one. Naming the accounts that do work turns
 * a dead end into a correction.
 */
function unavailableMessage(
  product: GoogleWorkspaceProductDefinition,
  resolution: {
    readonly reason?: 'none_accessible' | 'insufficient_access' | 'requested_not_accessible';
    readonly accessible?: readonly GoogleWorkspaceMcpConnectionChoice[];
  },
): string {
  const accessible = resolution.accessible ?? [];
  // A usable account is worth naming whatever went wrong. Withholding the list
  // on any branch strands a request that a different account could have served.
  if (accessible.length > 0) {
    const options = accessible
      .map((choice) => `${choice.accountEmail ?? choice.label} (${choice.access}) — connectionId ${choice.connectionId}`)
      .join('; ');
    const lead = resolution.reason === 'insufficient_access'
      ? `That ${product.name} account cannot perform this action.`
      : `That connectionId is not an account this member can use for ${product.name}.`;
    return `${lead} Use one of these exact accounts instead: ${options}`;
  }
  if (resolution.reason === 'none_accessible') {
    return `This member has no ${product.name} account connected or shared with them, so the request cannot be completed. Ask the user to connect Google Workspace or have an admin share an existing account; do not retry.`;
  }
  if (resolution.reason === 'insufficient_access') {
    return `This member's ${product.name} account is shared read-only or lacks the scopes this action needs, and no other account is available. Tell the user which access is missing; do not retry.`;
  }
  return `${product.name} connection is unavailable, not shared for this action, or missing required scopes. Reconnect Google Workspace to grant the complete Workspace scopes.`;
}
