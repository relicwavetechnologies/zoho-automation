import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import { CALENDAR_READ_SCOPES, CALENDAR_WRITE_SCOPES } from '../../../google/google-scope-policy';

const Schema = z.object({
  connectionId: z.string().min(1),
  op: z.enum(['list', 'get', 'create', 'update', 'delete']),
  eventId: z.string().optional(),
  calendarId: z.string().optional(),
  title: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  attendeeEmails: z.array(z.string()).optional(),
  description: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type Args = z.infer<typeof Schema>;
const ResultSchema = z.object({ success: z.boolean(), data: z.unknown().optional(), eventId: z.string().optional(), message: z.string().optional() });
type Res = z.infer<typeof ResultSchema>;

function hasTimezone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function validateListDateBounds(args: Args): string | null {
  for (const field of ['startTime', 'endTime'] as const) {
    const value = args[field];
    if (value && !hasTimezone(value)) {
      return `${field} must include a timezone offset or Z, e.g. 2026-07-09T00:00:00+05:30`;
    }
  }
  if (args.startTime && args.endTime) {
    const start = Date.parse(args.startTime);
    const end = Date.parse(args.endTime);
    if (Number.isNaN(start)) return 'startTime must be a valid ISO 8601 timestamp';
    if (Number.isNaN(end)) return 'endTime must be a valid ISO 8601 timestamp';
    if (end <= start) return 'endTime must be after startTime';
  }
  return null;
}

export interface GoogleCalendarClientPort {
  listEvents(calendarId: string, params?: { limit?: number; startTime?: string; endTime?: string }): Promise<unknown[]>;
  getEvent(calendarId: string, eventId: string): Promise<unknown>;
  createEvent(calendarId: string, params: object): Promise<{ eventId: string }>;
  updateEvent(calendarId: string, eventId: string, params: object): Promise<void>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

export const createGoogleCalendarTool = (deps: { getClient: (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly minimumAccess: 'read_only' | 'read_write';
  readonly requiredScopes: readonly string[];
}) => Promise<GoogleCalendarClientPort | null> }): Tool<Args, Res> => ({
  id: asToolId('googleCalendar'), family: 'google',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema: Schema, resultSchema: ResultSchema,
  description: 'List, read, create, update, or delete Google Calendar events.',
  parameterDocs: 'connectionId: required backend connection id from connections.list. op: list|get|create|update|delete. Use key op, never action. calendarId, eventId, title, startTime, endTime, attendeeEmails. For list, startTime/endTime are optional ISO 8601 bounds; pass both for date-window requests such as today, tomorrow, this week, or next 7 days. Calendar timestamps must include a timezone offset or Z.',
  permissionCheck(args, perm) {
    const op = args.op;
    const action: ToolActionGroup = op === 'list' || op === 'get' ? 'read'
      : op === 'create' ? 'create' : op === 'update' ? 'update' : 'delete';
    const allowed = perm.allowedActionsByTool.get(asToolId('googleCalendar'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'googleCalendar', action, reason: 'not_allowed' }));
  },
  async execute(args, ctx): Promise<Result<Res, ToolError>> {
    const writeOp = args.op === 'create' || args.op === 'update' || args.op === 'delete';
    const client = await deps.getClient({
      companyId:     ctx.runContext.companyId,
      userId:        ctx.runContext.userId,
      connectionId:  args.connectionId,
      minimumAccess: writeOp ? 'read_write' : 'read_only',
      requiredScopes: writeOp ? CALENDAR_WRITE_SCOPES : CALENDAR_READ_SCOPES,
    });
    if (!client) return err(new ToolError({ toolId: 'googleCalendar', reason: 'unrecoverable', message: 'Google Calendar connection is unavailable or not allowed for this operation' }));
    const calId = args.calendarId ?? 'primary';
    try {
      switch (args.op) {
        case 'list': {
          const dateBoundsError = validateListDateBounds(args);
          if (dateBoundsError) return err(new ToolError({ toolId: 'googleCalendar', reason: 'bad_args', message: dateBoundsError }));
          ctx.onProgress?.('Checking Google Calendar…');
          const listParams: { limit?: number; startTime?: string; endTime?: string } = {};
          if (args.limit !== undefined) listParams.limit = args.limit;
          if (args.startTime !== undefined) listParams.startTime = args.startTime;
          if (args.endTime !== undefined) listParams.endTime = args.endTime;
          return ok({ success: true, data: await client.listEvents(calId, listParams) });
        }
        case 'get': {
          if (!args.eventId) return err(new ToolError({ toolId: 'googleCalendar', reason: 'bad_args', message: 'eventId required' }));
          return ok({ success: true, data: await client.getEvent(calId, args.eventId) });
        }
        case 'create': {
          if (!args.title || !args.startTime || !args.endTime) return err(new ToolError({ toolId: 'googleCalendar', reason: 'bad_args', message: 'title, startTime, endTime required' }));
          ctx.onProgress?.('Creating calendar event…');
          const r = await client.createEvent(calId, { title: args.title, startTime: args.startTime, endTime: args.endTime, attendeeEmails: args.attendeeEmails, description: args.description });
          return ok({ success: true, eventId: r.eventId, message: 'Event created' });
        }
        case 'update': {
          if (!args.eventId) return err(new ToolError({ toolId: 'googleCalendar', reason: 'bad_args', message: 'eventId required' }));
          await client.updateEvent(calId, args.eventId, {
            title: args.title,
            startTime: args.startTime,
            endTime: args.endTime,
            attendeeEmails: args.attendeeEmails,
            description: args.description,
          });
          return ok({ success: true, message: 'Event updated' });
        }
        case 'delete': {
          if (!args.eventId) return err(new ToolError({ toolId: 'googleCalendar', reason: 'bad_args', message: 'eventId required' }));
          await client.deleteEvent(calId, args.eventId);
          return ok({ success: true, message: 'Event deleted' });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'googleCalendar', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
