import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { err, ok } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import {
  larkConnectionRequiredMessage,
  larkConnectionSelectionData,
  resolveLarkUserClient,
  type LarkUserTokenResolver,
} from './lark-user-connection';

const Schema = z.object({
  op: z.enum(['search', 'get', 'get_recording']),
  meetingId: z.string().min(1).optional(),
  query: z.string().min(1).max(500).optional(),
  /** Unix timestamp in seconds, as required by Lark VC search. */
  startTime: z.string().regex(/^\d+$/).optional(),
  /** Unix timestamp in seconds, as required by Lark VC search. */
  endTime: z.string().regex(/^\d+$/).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  /** Divo-managed Lark connection. Required only if multiple are accessible. */
  connectionId: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  if ((value.startTime && !value.endTime) || (!value.startTime && value.endTime)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'startTime and endTime must be supplied together' });
  }
});

type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  message: z.string().optional(),
});
type Res = z.infer<typeof ResultSchema>;

export interface LarkMeetingClientPort {
  searchMeetings(input: { query?: string; startTime?: string; endTime?: string; limit?: number }): Promise<unknown[]>;
  getMeeting(meetingId: string): Promise<unknown>;
  getRecording(meetingId: string): Promise<unknown>;
}

const inferAction = (_op: Args['op']): ToolActionGroup => 'read';

/**
 * Read-only Lark Video Conferencing capability. Live meeting controls remain
 * intentionally outside this first slice because they require a separate
 * approval posture for an active call.
 */
export const createLarkMeetingTool = (deps: {
  client: LarkMeetingClientPort;
  userTokenResolver?: LarkUserTokenResolver;
  createUserClient?: (userToken: string) => LarkMeetingClientPort;
}): Tool<Args, Res> => ({
  id: asToolId('larkMeeting'),
  family: 'lark',
  actionGroups: new Set(['read']),
  argsSchema: Schema,
  resultSchema: ResultSchema,
  description: 'Search Lark video meetings, retrieve meeting details, and retrieve the recording link when available.',
  parameterDocs: `
- op: search|get|get_recording
- meetingId: Required for get and get_recording
- query: Optional title/keyword for search
- startTime, endTime: Optional Unix timestamps in seconds; must be supplied together
- limit: Max search results (default 20, max 50)
- connectionId: Exact UUID when supplied. Omit it to auto-select one accessible account or receive safe choices when several are available.

This tool is read-only. It does not join, end, or control a live meeting.
  `.trim(),

  permissionCheck(_args: Args, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action = 'read' as const;
    const allowed = perm.allowedActionsByTool.get(asToolId('larkMeeting'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'larkMeeting', action, reason: 'not_allowed' }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    try {
      const userConnection = await resolveLarkUserClient(deps, ctx, {
        ...(args.connectionId ? { connectionId: args.connectionId } : {}),
        minimumAccess: 'read_only',
      });
      if (userConnection.status === 'choose_connection') {
        return ok({
          success: false,
          data: larkConnectionSelectionData(userConnection.connections),
          message: 'Choose a Lark connection before continuing.',
        });
      }
      if (deps.userTokenResolver && userConnection.status === 'unavailable') {
        return err(new ToolError({ toolId: 'larkMeeting', reason: 'unrecoverable', message: larkConnectionRequiredMessage }));
      }
      const client = userConnection.status === 'resolved' ? userConnection.client : deps.client;

      switch (args.op) {
        case 'search':
          ctx.onProgress?.('Searching Lark meetings…');
          return ok({
            success: true,
            data: await client.searchMeetings({
              ...(args.query ? { query: args.query } : {}),
              ...(args.startTime ? { startTime: args.startTime } : {}),
              ...(args.endTime ? { endTime: args.endTime } : {}),
              ...(args.limit ? { limit: args.limit } : {}),
            }),
          });
        case 'get':
          if (!args.meetingId) return err(new ToolError({ toolId: 'larkMeeting', reason: 'bad_args', message: 'meetingId required' }));
          ctx.onProgress?.('Fetching meeting details…');
          return ok({ success: true, data: await client.getMeeting(args.meetingId) });
        case 'get_recording':
          if (!args.meetingId) return err(new ToolError({ toolId: 'larkMeeting', reason: 'bad_args', message: 'meetingId required' }));
          ctx.onProgress?.('Fetching meeting recording…');
          return ok({ success: true, data: await client.getRecording(args.meetingId) });
      }
    } catch (cause) {
      return err(new ToolError({ toolId: 'larkMeeting', reason: 'upstream_failure', cause, message: String(cause) }));
    }
  },
});
