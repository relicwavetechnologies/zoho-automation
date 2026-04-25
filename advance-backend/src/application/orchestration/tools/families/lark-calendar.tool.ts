import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

const Schema = z.object({
  op: z.enum(['list', 'get', 'create', 'update', 'delete']),
  eventId: z.string().optional(),
  calendarId: z.string().optional(),
  title: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  attendeeIds: z.array(z.string()).optional(),
  description: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type Args = z.infer<typeof Schema>;
const ResultSchema = z.object({ success: z.boolean(), data: z.unknown().optional(), eventId: z.string().optional(), message: z.string().optional() });
type Res = z.infer<typeof ResultSchema>;

export interface LarkCalendarClientPort {
  listEvents(calendarId: string, limit?: number): Promise<unknown[]>;
  getEvent(calendarId: string, eventId: string): Promise<unknown>;
  createEvent(calendarId: string, params: { title: string; startTime: string; endTime: string; attendeeIds?: string[]; description?: string }): Promise<{ eventId: string }>;
  updateEvent(calendarId: string, eventId: string, params: object): Promise<void>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

const inferAction = (op: Args['op']): ToolActionGroup => {
  if (op === 'list' || op === 'get') return 'read';
  if (op === 'create') return 'create';
  if (op === 'update') return 'update';
  return 'delete';
};

export const createLarkCalendarTool = (deps: { client: LarkCalendarClientPort }): Tool<Args, Res> => ({
  id: asToolId('larkCalendar'), family: 'lark',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema: Schema, resultSchema: ResultSchema,
  description: 'List, get, create, update, or delete Lark calendar events.',
  parameterDocs: 'op: list|get|create|update|delete. calendarId, eventId, title, startTime, endTime, attendeeIds, description.',
  permissionCheck(args, perm) {
    const action = inferAction(args.op);
    const allowed = perm.allowedActionsByTool.get(asToolId('larkCalendar'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'larkCalendar', action, reason: 'not_allowed' }));
  },
  async execute(args, ctx): Promise<Result<Res, ToolError>> {
    const calId = args.calendarId ?? 'primary';
    try {
      switch (args.op) {
        case 'list': return ok({ success: true, data: await deps.client.listEvents(calId, args.limit) });
        case 'get': {
          if (!args.eventId) return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: 'eventId required' }));
          return ok({ success: true, data: await deps.client.getEvent(calId, args.eventId) });
        }
        case 'create': {
          if (!args.title || !args.startTime || !args.endTime) return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: 'title, startTime, endTime required' }));
          const r = await deps.client.createEvent(calId, { title: args.title, startTime: args.startTime, endTime: args.endTime, ...(args.attendeeIds !== undefined ? { attendeeIds: args.attendeeIds } : {}), ...(args.description !== undefined ? { description: args.description } : {}) });
          return ok({ success: true, eventId: r.eventId, message: 'Event created' });
        }
        case 'update': {
          if (!args.eventId) return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: 'eventId required' }));
          await deps.client.updateEvent(calId, args.eventId, { title: args.title, startTime: args.startTime, endTime: args.endTime });
          return ok({ success: true, eventId: args.eventId, message: 'Event updated' });
        }
        case 'delete': {
          if (!args.eventId) return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: 'eventId required' }));
          await deps.client.deleteEvent(calId, args.eventId);
          return ok({ success: true, message: 'Event deleted' });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkCalendar', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
