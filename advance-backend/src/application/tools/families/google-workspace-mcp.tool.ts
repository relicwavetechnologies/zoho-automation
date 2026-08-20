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
  prefersCompanyGoogleArtifactAccount,
  googleWorkspaceScopeGroupsFor,
  type GoogleWorkspaceProductDefinition,
} from '../../google/google-workspace-mcp-manifest';
import type { GoogleSheetReferenceParseResult } from '../../artifacts/google-sheet-resource-reference';
import type { GoogleSheetResourceResolution } from '../../artifacts/google-sheet-resource-resolver';
import {
  type GoogleDriveXlsxReferenceParseResult,
} from '../../artifacts/google-drive-xlsx-resource-reference';
import type { GoogleDriveXlsxResourceResolution } from '../../artifacts/google-drive-xlsx-resource-resolver';
import {
  classifyGoogleScopeGap,
  CONNECTIONS_SKILL_POINTER,
  googleConnectionScopeGap,
  googleScopeGapReasonText,
} from '../../connections/connection-request/google-scope-gap';
import {
  connectionAskSentResult,
  type ConnectionRequestService,
} from '../../connections/connection-request/connection-request.service';

function createNativeArgsSchema(nativeTool: z.ZodType<string>) {
  return z.discriminatedUnion('op', [
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
  ]);
}

function createSheetArgsSchema(nativeTool: z.ZodType<string>) {
  return z.discriminatedUnion('op', [
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
    z.object({
      connectionId: z.string().uuid().optional(),
      op: z.literal('resolve_reference'),
      url: z.string().trim().min(1).max(2_048),
    }),
    z.object({
      op: z.literal('call_resolved_sheet'),
      destinationReferenceId: z.string().uuid(),
      nativeTool,
      input: z.record(z.unknown()),
    }),
  ]);
}

const ArgsSchema = createSheetArgsSchema(z.string().min(1));
type Args = z.infer<typeof ArgsSchema>;

function nativeToolEnum(values: readonly string[]): z.ZodEnum<[string, ...string[]]> {
  const [first, ...rest] = values;
  if (!first) throw new Error('Google Workspace product must publish at least one native tool');
  return z.enum([first, ...rest]);
}

const ResultSchema = z.object({
  success: z.boolean(),
  nativeTool: z.string(),
  data: z.unknown().optional(),
  message: z.string().optional(),
  delivery: z.object({
    required: z.literal(true),
    toolId: z.literal('googleDrive'),
    connectionId: z.string().uuid(),
    nativeTool: z.literal('manage_drive_access'),
    input: z.object({
      file_id: z.string().min(1),
      action: z.literal('grant'),
      share_with: z.string().email(),
      role: z.literal('reader'),
      share_type: z.literal('user'),
      send_notification: z.boolean(),
    }),
  }).optional(),
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
  readonly connectionId?: string;
  readonly ownerType?: 'user' | 'company';
}

export interface GoogleWorkspaceMcpConnectionChoice {
  readonly connectionId: string;
  readonly label: string;
  readonly accountEmail?: string;
  readonly accountName?: string;
  readonly ownerType?: 'user' | 'company';
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
  readonly preferredOwnerType?: 'user' | 'company';
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
  | GoogleDriveXlsxResourceResolution
  | {
      readonly status: 'invalid_reference';
      readonly reason:
        | Exclude<GoogleSheetReferenceParseResult, { readonly ok: true }>['reason']
        | Exclude<GoogleDriveXlsxReferenceParseResult, { readonly ok: true }>['reason'];
    }
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
  readonly connectionRequest?: Pick<ConnectionRequestService, 'request'>;
}): Tool<Args, ToolResult>[] {
  return GOOGLE_WORKSPACE_PRODUCTS.map((product) => createProductTool(product, deps));
}

function createProductTool(
  product: GoogleWorkspaceProductDefinition,
  deps: {
    readonly getConnection: ResolveGoogleWorkspaceMcpConnection;
    readonly resolveSheetReference?: ResolveGoogleSheetReference;
    readonly connectionRequest?: Pick<ConnectionRequestService, 'request'>;
  },
): Tool<Args, ToolResult> {
  const supportedActions = new Set<ToolActionGroup>(
    TOOL_SUPPORTED_ACTIONS[product.toolId] as readonly ToolActionGroup[],
  );

  return {
    id: asToolId(product.toolId),
    family: 'google',
    actionGroups: supportedActions,
    argsSchema: (product.toolId === 'googleSheets'
      ? createSheetArgsSchema(nativeToolEnum(product.tools))
      : createNativeArgsSchema(nativeToolEnum(product.tools))) as z.ZodType<Args>,
    resultSchema: ResultSchema,
    description: product.description,
    parameterDocs: [
      'connectionId: reuse the exact run-bootstrap account when supplied. In backend-hosted channels, omit it when no account was supplied; new durable Google artifacts prefer one eligible company-owned account, while other calls select only one eligible account or return safe choices. Reuse the same connectionId for describe and call.',
      product.toolId === 'googleSheets'
        ? 'op: describe|call|resolve_reference|call_resolved_sheet. Use resolve_reference with url for an exact pasted Google Sheet or Google Drive Excel workbook before any web lookup. Use call_resolved_sheet only with the destinationReferenceId returned by resolve_reference in the same Lark run; the backend injects the verified connection and spreadsheet IDs. Excel workbooks require explicit confirmation before Divo creates a new Google Sheet copy; the original workbook is never changed. Prefer the exact schema already loaded in bootstrap.nativeContracts. Use describe once only for a required operation whose schema is absent.'
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
      if (args.op === 'call_resolved_sheet') {
        const action = googleWorkspaceActionFor(args.nativeTool, args.input);
        const allowed = product.toolId === 'googleSheets'
          && (permission.allowedActionsByTool.get(asToolId(product.toolId))?.has(action) ?? false);
        return allowed
          ? ok(action)
          : err(new PermissionError({ toolId: product.toolId, action, reason: 'not_allowed' }));
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
      if (args.op === 'call_resolved_sheet') {
        return badArgs(product.toolId, 'Resolved Sheet handles must be materialized by the governed gateway');
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
        ...(args.op === 'call' && prefersCompanyGoogleArtifactAccount(args.nativeTool)
          ? { preferredOwnerType: 'company' as const }
          : {}),
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
          ctx.onProgress?.('Checking this Google file and its writable account…');
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
            && deps.connectionRequest
          ) {
            const gap = googleConnectionScopeGap(
              product.toolId,
              resolution.status === 'missing_scope' ? 'missing_scope' : 'no_connection',
            );
            const authorization = await deps.connectionRequest.request({
              gap,
              runContext: ctx.runContext,
            });
            const sent = connectionAskSentResult('google_workspace', authorization);
            if (sent) {
              return ok({
                success: false,
                nativeTool: 'resolve_sheet_reference',
                data: sent,
                message: sent.message,
              });
            }
          }
          const data = resolution.status === 'resolved'
            && resolution.resource.kind === 'excel_workbook'
            ? {
                ...resolution,
                delivery: { replyInThread: ctx.runContext.replyInThread === true },
              }
            : resolution;
          return ok({
            success: resolution.status === 'resolved',
            nativeTool: 'resolve_sheet_reference',
            data,
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
      if (args.op === 'call_resolved_sheet') {
        return badArgs(product.toolId, 'Resolved Sheet handles must be materialized by the governed gateway');
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
        ...(args.op === 'call' && prefersCompanyGoogleArtifactAccount(args.nativeTool)
          ? { preferredOwnerType: 'company' as const }
          : {}),
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
          deps.connectionRequest
          && (connectionResolution.accessible?.length ?? 0) === 0
        ) {
          const gap = googleConnectionScopeGap(
            product.toolId,
            connectionResolution.reason === 'none_accessible' ? 'no_connection' : 'missing_scope',
          );
          const authorization = await deps.connectionRequest.request({
            gap,
            runContext: ctx.runContext,
          });
          const sent = connectionAskSentResult('google_workspace', authorization);
          if (sent) {
            return ok({
              success: false,
              nativeTool: args.nativeTool,
              data: sent,
              message: sent.message,
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
        const delivery = companySheetDelivery({
          nativeTool: args.nativeTool,
          data,
          connection,
          ...(ctx.runContext.requesterEmail
            ? { requesterEmail: ctx.runContext.requesterEmail }
            : {}),
        });
        return ok({
          success: true,
          nativeTool: args.nativeTool,
          data,
          message: `${product.name} operation completed`,
          ...(delivery ? { delivery } : {}),
        });
      } catch (cause) {
        const gap = classifyGoogleScopeGap(product.toolId, cause);
        if (gap) {
          return err(new ToolError({
            toolId: product.toolId,
            reason: 'permission_denied',
            cause,
            message: `${googleScopeGapReasonText(gap.reason)} [scope_gap:${gap.reason}] `
              + `${CONNECTIONS_SKILL_POINTER}`,
          }));
        }
        return err(new ToolError({
          toolId: product.toolId,
          reason: 'upstream_failure',
          cause,
          message: await withNativeSchema({
            message: withRecoveryHint(cause instanceof Error ? cause.message : String(cause)),
            nativeTool: args.nativeTool,
            describe: (name, signal) => connection.client.describeTool(name, signal),
            ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          }),
        }));
      }
    },
  };
}

function companySheetDelivery(input: {
  readonly nativeTool: string;
  readonly data: unknown;
  readonly connection: GoogleWorkspaceMcpConnection;
  readonly requesterEmail?: string;
}): ToolResult['delivery'] | undefined {
  if (
    input.nativeTool !== 'create_spreadsheet'
    || input.connection.ownerType !== 'company'
    || !input.connection.connectionId
    || !input.requesterEmail
    || !z.string().email().safeParse(input.requesterEmail).success
  ) return undefined;
  const spreadsheetId = isRecord(input.data)
    ? readNonEmptyString(input.data['spreadsheetId']) ?? readNonEmptyString(input.data['spreadsheet_id'])
    : undefined;
  if (!spreadsheetId) return undefined;
  return {
    required: true,
    toolId: 'googleDrive',
    connectionId: input.connection.connectionId,
    nativeTool: 'manage_drive_access',
    input: {
      file_id: spreadsheetId,
      action: 'grant',
      share_with: input.requesterEmail,
      role: 'reader',
      share_type: 'user',
      send_notification: false,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
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
  if (resolution.status === 'resolved') {
    return resolution.resource.kind === 'excel_workbook'
      ? 'Excel workbook access verified. Ask the requester to confirm creating a new private Google Sheet copy. The original Excel workbook will not change.'
      : 'Google Sheet access verified.';
  }
  if (resolution.status === 'choose_connection') {
    return resolution.connections.length === 1
      ? 'Retry with the exact returned connectionId to verify this Google Sheet.'
      : 'Choose which writable personal Google account Divo should use for this Google file.';
  }
  if (resolution.status === 'invalid_reference') return 'This is not a supported Google Sheet URL.';
  if (resolution.status === 'no_connection') return 'No writable personal Google account is connected.';
  if (resolution.status === 'missing_scope') return 'The connected Google account is missing Drive or Sheets write access.';
  if (resolution.status === 'read_only') return 'This Google Sheet is read-only for the connected personal account.';
  if (resolution.status === 'copy_restricted') return 'This Excel workbook cannot be copied or downloaded by the connected personal account.';
  if (resolution.status === 'trashed') return 'This Google file is in the trash.';
  if (resolution.status === 'wrong_type') return 'This is not a supported Google Sheet or Excel workbook.';
  return 'This Google file is not accessible through the connected personal account.';
}

/**
 * Google says an Office file cannot be used as a Sheet, and says it clearly.
 * The model still read that as a permissions problem twice and told the member
 * to reconnect Google — which changes nothing, because the grant was never the
 * issue. Saying so in the failure itself is what the Semrush country caveat
 * showed actually reaches the model: guidance in a skill is advisory, guidance
 * attached to the error arrives with the thing that went wrong.
 */
const OFFICE_FILE_RECOVERY = ' This file is an Excel or CSV upload, not a native Google Sheet,'
  + ' and the Sheets API cannot read or write one whatever the connection is allowed to do.'
  + ' It is not a permission problem: do not report missing scopes and do not ask the member'
  + ' to reconnect Google. Call `resolve_reference` on the same URL to offer an editable'
  + ' Google Sheet copy, and tell the member the file is an Excel export.';

export function withRecoveryHint(message: string): string {
  return /must not be an Office file/i.test(message) ? `${message}${OFFICE_FILE_RECOVERY}` : message;
}

/** A pinned MCP operation rejecting its input, as opposed to Google refusing the work. */
const NATIVE_SCHEMA_REJECTION = /validation errors? for |extra inputs are not permitted|field required/i;

/** Enough for the largest pinned Workspace contract, short of flooding the trace. */
const MAX_INLINED_SCHEMA_CHARS = 6_000;

export function isNativeSchemaRejection(message: string): boolean {
  return NATIVE_SCHEMA_REJECTION.test(message);
}

/**
 * Answers "then what *are* the fields?" in the same breath as "that field is wrong".
 *
 * A rejected argument name used to cost three round trips: the call fails, the
 * model calls `describe` to learn the contract, then repeats the call. The
 * second trip is pure ceremony — this code has just validated the input against
 * that very schema, so it already knows what the model is about to ask for.
 * Thirteen of one production session's failures were this exact loop
 * (`maxResults` for `page_size`, `title` for `sheet_name`, a nested `format`
 * object for flat keys).
 *
 * Only schema rejections get this. A quota error or a missing document is not a
 * contract problem, and pasting a schema under it would be noise.
 */
async function withNativeSchema(input: {
  readonly message: string;
  readonly nativeTool: string;
  readonly describe: (name: string, signal?: AbortSignal) => Promise<unknown>;
  readonly abortSignal?: AbortSignal;
}): Promise<string> {
  if (!isNativeSchemaRejection(input.message)) return input.message;
  try {
    const description = await input.describe(input.nativeTool, input.abortSignal);
    const schema = (description as { inputSchema?: unknown } | null)?.inputSchema ?? description;
    if (schema === undefined || schema === null) return input.message;
    const serialized = JSON.stringify(schema);
    if (serialized.length > MAX_INLINED_SCHEMA_CHARS) return input.message;
    return `${input.message}\n\nThe exact ${input.nativeTool} input schema follows. `
      + `Correct the arguments and retry; do not call describe for it.\n${serialized}`;
  } catch {
    // Best effort. The original rejection is still the useful part, and losing
    // it because the schema lookup failed would be a worse error than the one
    // being reported.
    return input.message;
  }
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
