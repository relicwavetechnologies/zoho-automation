import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

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

export interface GoogleCalendarClientPort {
  listEvents(calendarId: string, limit?: number): Promise<unknown[]>;
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
}) => Promise<GoogleCalendarClientPort | null> }): Tool<Args, Res> => ({
  id: asToolId('googleCalendar'), family: 'google',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema: Schema, resultSchema: ResultSchema,
  description: 'List, read, create, update, or delete Google Calendar events.',
  parameterDocs: 'connectionId: required backend connection id from connections.list. op: list|get|create|update|delete. calendarId, eventId, title, startTime, endTime, attendeeEmails.',
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
    });
    if (!client) return err(new ToolError({ toolId: 'googleCalendar', reason: 'unrecoverable', message: 'Google Calendar connection is unavailable or not allowed for this operation' }));
    const calId = args.calendarId ?? 'primary';
    try {
      switch (args.op) {
        case 'list': {
          ctx.onProgress?.('Checking Google Calendar…');
          return ok({ success: true, data: await client.listEvents(calId, args.limit) });
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
