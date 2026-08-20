import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../shared/ids';
import { CONNECTION_PROVIDER_IDS } from '../../../domain/connections/connection-provider';
import { googleScopeGroupsForToolIds } from '../../google/google-scope-request';
import { GOOGLE_WORKSPACE_TOOL_IDS } from '../../google/google-workspace-mcp-manifest';
import type { ConnectionRequestService } from '../../connections/connection-request/connection-request.service';

const ProviderSchema = z.enum([...CONNECTION_PROVIDER_IDS] as [string, ...string[]]);
const ArgsSchema = z.object({
  provider: ProviderSchema,
  toolIds: z.array(z.string().trim().min(1)).min(1).max(20),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  success: z.boolean(),
  code: z.literal('connection_ask_sent').optional(),
  intentId: z.string().optional(),
  provider: z.string().optional(),
  message: z.string().optional(),
});
type Res = z.infer<typeof ResultSchema>;

const GOOGLE_TOOL_IDS = new Set<string>([
  ...GOOGLE_WORKSPACE_TOOL_IDS,
  'mailAutomations',
]);

export const CONNECTION_PROVIDER_NOT_SUPPORTED = 'connection_provider_not_supported';
export const CONNECTION_TOOL_ID_UNKNOWN = 'connection_tool_id_unknown';
export const CONNECTION_ASK_UNREACHABLE = 'connection_ask_unreachable';

/** Register the one provider-neutral front door for connection asks. */
export function createConnectionsTool(deps: {
  readonly connectionRequest: Pick<ConnectionRequestService, 'request'>;
}): Tool<Args, Res> {
  return {
    id: asToolId('connectApp'),
    family: 'context',
    actionGroups: new Set<ToolActionGroup>(['create']),
    argsSchema: ArgsSchema,
    resultSchema: ResultSchema,
    description: 'Ask a member to connect or widen a provider account for the requested Divo tools.',
    parameterDocs:
      '- provider: The connection provider. Google Workspace is the only provider supported by this tool today.\n'
      + '- toolIds: The Divo tool IDs that need access, such as googleDrive, googleSheets, or mailAutomations.\n'
      + '- Do not pass scopes. Divo derives the narrow Google consent request from toolIds.',
    permissionCheck(_args, perm) {
      const allowed = perm.allowedActionsByTool.get(asToolId('connectApp'))?.has('create') ?? false;
      return allowed
        ? ok('create')
        : err(new PermissionError({ toolId: 'connectApp', action: 'create', reason: 'not_allowed' }));
    },
    async execute(args, ctx): Promise<Result<Res, ToolError>> {
      if (args.provider !== 'google_workspace') {
        return unsupportedProvider(args.provider);
      }

      const unknownToolIds = args.toolIds.filter(toolId => !GOOGLE_TOOL_IDS.has(toolId));
      if (unknownToolIds.length > 0) {
        return err(new ToolError({
          toolId: 'connectApp',
          reason: 'bad_args',
          message: `${CONNECTION_TOOL_ID_UNKNOWN}: ${unknownToolIds.join(', ')}. `
            + 'Pass registered Divo tool IDs, not provider scopes or native operation names.',
        }));
      }

      // This is the authority for the Google consent surface. The model names
      // work; it never names OAuth scopes.
      const missingScopeGroups = googleScopeGroupsForToolIds(args.toolIds);
      if (missingScopeGroups.length === 0) {
        return err(new ToolError({
          toolId: 'connectApp',
          reason: 'bad_args',
          message: `${CONNECTION_TOOL_ID_UNKNOWN}: no requested tool maps to Google Workspace scopes.`,
        }));
      }

      const firstToolId = args.toolIds[0]!;
      const outcome = await deps.connectionRequest.request({
        gap: {
          provider: 'google_workspace',
          toolId: firstToolId,
          toolIds: [...args.toolIds],
          missingScopeGroups,
          reason: 'not_connected',
        },
        runContext: ctx.runContext,
      });
      if (outcome.status === 'unreachable') {
        return err(new ToolError({
          toolId: 'connectApp',
          reason: 'unrecoverable',
          message: `${CONNECTION_ASK_UNREACHABLE}: Divo could not deliver a Google connection ask on this channel.`,
        }));
      }

      const alreadyPending = outcome.status === 'already_pending';
      return ok({
        success: false,
        code: 'connection_ask_sent' as const,
        intentId: outcome.intentId,
        provider: args.provider,
        message: alreadyPending
          ? 'A Google connection ask is already open for this request. End this run and wait for the member to finish it.'
          : 'A Google connection ask was sent to the member. End this run and wait for OAuth to complete.',
      });
    },
  };
}

function unsupportedProvider(provider: string): Result<never, ToolError> {
  return err(new ToolError({
    toolId: 'connectApp',
    reason: 'bad_args',
    message: `${CONNECTION_PROVIDER_NOT_SUPPORTED}: ${provider}. Only google_workspace is supported.`,
  }));
}
