import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import type { PeopleResolverPort } from './lark-task.tool';
import {
  larkConnectionSelectionData,
  larkConnectionRequiredMessage,
  resolveLarkUserClient,
  type LarkUserTokenResolver,
} from './lark-user-connection';

const RecurrenceSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  days: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
  until: z.string().optional(),
  count: z.number().int().positive().optional(),
});

const Schema = z.object({
  op: z.enum(['list', 'get', 'create', 'update', 'delete', 'free_busy', 'list_attendees', 'create_recurring', 'update_attendees']),
  eventId: z.string().optional(),
  calendarId: z.string().optional(),
  title: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  attendeeIds: z.array(z.string()).optional(),
  attendeeNames: z.array(z.string()).optional(),
  description: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  // free_busy
  names: z.array(z.string()).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  // update_attendees
  addNames: z.array(z.string()).optional(),
  removeNames: z.array(z.string()).optional(),
  // create_recurring
  recurrence: RecurrenceSchema.optional(),
  /** Divo-managed Lark connection. Required when more than one is accessible. */
  connectionId: z.string().uuid().optional(),
});
type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  eventId: z.string().optional(),
  message: z.string().optional(),
});
type Res = z.infer<typeof ResultSchema>;

export interface LarkCalendarClientPort {
  listEvents(calendarId: string, limit?: number): Promise<unknown[]>;
  getEvent(calendarId: string, eventId: string): Promise<unknown>;
  createEvent(calendarId: string, params: {
    title: string;
    startTime: string;
    endTime: string;
    attendeeIds?: string[];
    description?: string;
    recurrence?: { frequency: string; days?: string[] | undefined; until?: string | undefined; count?: number | undefined };
  }): Promise<{ eventId: string }>;
  updateEvent(calendarId: string, eventId: string, params: object): Promise<void>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  queryFreeBusy(params: { userIds: string[]; timeMin: string; timeMax: string }): Promise<Record<string, { busy: Array<{ start: string; end: string }> }>>;
  listAttendees(calendarId: string, eventId: string): Promise<Array<{ attendeeId: string; userId: string; displayName: string; rsvpStatus: string }>>;
  updateAttendees(calendarId: string, eventId: string, params: { add?: string[]; remove?: string[] }): Promise<void>;
}

const inferAction = (op: Args['op']): ToolActionGroup => {
  if (op === 'list' || op === 'get' || op === 'free_busy' || op === 'list_attendees') return 'read';
  if (op === 'create' || op === 'create_recurring') return 'create';
  if (op === 'update' || op === 'update_attendees') return 'update';
  return 'delete';
};

const toTimestamp = (iso: string) => ({ timestamp: String(Math.floor(new Date(iso).getTime() / 1000)), timezone: 'UTC' });

export const createLarkCalendarTool = (deps: {
  client: LarkCalendarClientPort;
  peopleResolver: PeopleResolverPort;
  userTokenResolver?: LarkUserTokenResolver;
  createUserClient?: (userToken: string) => LarkCalendarClientPort;
}): Tool<Args, Res> => ({
  id: asToolId('larkCalendar'),
  family: 'lark',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema: Schema,
  resultSchema: ResultSchema,
  description: 'List, get, create, update, delete Lark calendar events; check free/busy; manage attendees; create recurring events.',
  parameterDocs: `
- op: list|get|create|update|delete|free_busy|list_attendees|create_recurring|update_attendees
- calendarId: Calendar ID (default "primary")
- eventId: Event ID (required for get, update, delete, list_attendees, update_attendees)
- title: Event title (required for create/create_recurring)
- startTime, endTime: ISO 8601 with timezone (required for create/create_recurring)
- attendeeNames: Human-readable names to invite — resolved to open_ids automatically
- attendeeIds: Lark open_ids to invite (takes priority over attendeeNames)
- description: Event description
- limit: Max events for list (default 50)
- names: Names to check free/busy for
- dateFrom, dateTo: ISO date range for free_busy
- addNames, removeNames: Names to add/remove for update_attendees
- recurrence: { frequency: daily|weekly|monthly|yearly, days?: MO|TU|WE|TH|FR|SA|SU[], until?: ISO date, count?: N }
- connectionId: A connected or shared Lark account. Required when more than one is available.
  `.trim(),

  permissionCheck(args: Args, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action = inferAction(args.op);
    const allowed = perm.allowedActionsByTool.get(asToolId('larkCalendar'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'larkCalendar', action, reason: 'not_allowed' }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    const calId = args.calendarId ?? 'primary';
    const companyId = String(ctx.runContext.companyId);
    const requesterOpenId = ctx.runContext.userExternalId ?? '';

    const resolveNames = async (names: string[]) => {
      const r = await deps.peopleResolver.resolve(companyId, names, requesterOpenId);
      if (r.ambiguous.length > 0) {
        const detail = r.ambiguous.map(a => `"${a.query}" → ${a.matches.map(m => m.displayName).join(' / ')}`).join('; ');
        throw new Error(`Ambiguous names — please clarify: ${detail}`);
      }
      return r;
    };

    try {
      const userConnection = await resolveLarkUserClient(deps, ctx, {
        ...(args.connectionId ? { connectionId: args.connectionId } : {}),
        minimumAccess: inferAction(args.op) === 'read' ? 'read_only' : 'read_write',
      });
      if (userConnection.status === 'choose_connection') {
        return ok({ success: false, data: larkConnectionSelectionData(userConnection.connections), message: 'Choose a Lark connection before continuing.' });
      }
      if (deps.userTokenResolver && userConnection.status === 'unavailable') {
        return err(new ToolError({ toolId: 'larkCalendar', reason: 'unrecoverable', message: larkConnectionRequiredMessage }));
      }
      const client = userConnection.status === 'resolved' ? userConnection.client : deps.client;
      switch (args.op) {
        case 'list':
          ctx.onProgress?.('Checking calendar…');
          return ok({ success: true, data: await client.listEvents(calId, args.limit) });

        case 'get': {
          if (!args.eventId) return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: 'eventId required' }));
          ctx.onProgress?.('Fetching event…');
          return ok({ success: true, data: await client.getEvent(calId, args.eventId) });
        }

        case 'create': {
          if (!args.title || !args.startTime || !args.endTime)
            return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: 'title, startTime, endTime required' }));
          ctx.onProgress?.('Creating event…');
          const attendees = [...(args.attendeeIds ?? [])];
          if (args.attendeeNames?.length && !args.attendeeIds?.length) {
            const r = await resolveNames(args.attendeeNames);
            attendees.push(...r.resolved.map(p => p.openId));
          }
          if (requesterOpenId && !attendees.includes(requesterOpenId)) attendees.push(requesterOpenId);
          const r = await client.createEvent(calId, {
            title: args.title, startTime: args.startTime, endTime: args.endTime,
            ...(attendees.length ? { attendeeIds: attendees } : {}),
            ...(args.description ? { description: args.description } : {}),
          });
          return ok({ success: true, eventId: r.eventId, message: 'Event created' });
        }

        case 'create_recurring': {
          if (!args.title || !args.startTime || !args.endTime || !args.recurrence)
            return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: 'title, startTime, endTime, recurrence required' }));
          ctx.onProgress?.('Creating recurring event…');
          const attendees = [...(args.attendeeIds ?? [])];
          if (args.attendeeNames?.length && !args.attendeeIds?.length) {
            const r = await resolveNames(args.attendeeNames);
            attendees.push(...r.resolved.map(p => p.openId));
          }
          if (requesterOpenId && !attendees.includes(requesterOpenId)) attendees.push(requesterOpenId);
          const r = await client.createEvent(calId, {
            title: args.title, startTime: args.startTime, endTime: args.endTime,
            recurrence: args.recurrence,
            ...(attendees.length ? { attendeeIds: attendees } : {}),
            ...(args.description ? { description: args.description } : {}),
          });
          return ok({ success: true, eventId: r.eventId, message: 'Recurring event created' });
        }

        case 'update': {
          if (!args.eventId) return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: 'eventId required' }));
          await client.updateEvent(calId, args.eventId, {
            ...(args.title ? { summary: args.title } : {}),
            ...(args.startTime ? { start_time: toTimestamp(args.startTime) } : {}),
            ...(args.endTime ? { end_time: toTimestamp(args.endTime) } : {}),
          });
          return ok({ success: true, eventId: args.eventId, message: 'Event updated' });
        }

        case 'delete': {
          if (!args.eventId) return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: 'eventId required' }));
          await client.deleteEvent(calId, args.eventId);
          return ok({ success: true, message: 'Event deleted' });
        }

        case 'free_busy': {
          if (!args.names?.length || !args.dateFrom || !args.dateTo)
            return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: 'names, dateFrom, dateTo required' }));
          ctx.onProgress?.('Checking availability…');
          const r = await resolveNames(args.names);
          if (r.notFound.length > 0)
            return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: `Users not found: ${r.notFound.join(', ')}` }));
          const openIdToName = new Map(r.resolved.map(p => [p.openId, p.displayName]));
          const freebusy = await client.queryFreeBusy({
            userIds: r.resolved.map(p => p.openId),
            timeMin: args.dateFrom,
            timeMax: args.dateTo,
          });
          const data = Object.entries(freebusy).map(([openId, info]) => ({
            name: openIdToName.get(openId) ?? openId,
            busy: info.busy,
          }));
          return ok({ success: true, data, message: `Free/busy for ${data.length} person(s)` });
        }

        case 'list_attendees': {
          if (!args.eventId) return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: 'eventId required' }));
          const attendees = await client.listAttendees(calId, args.eventId);
          return ok({ success: true, data: attendees, message: `${attendees.length} attendee(s)` });
        }

        case 'update_attendees': {
          if (!args.eventId) return err(new ToolError({ toolId: 'larkCalendar', reason: 'bad_args', message: 'eventId required' }));
          const addIds: string[] = [];
          const removeIds: string[] = [];
          if (args.addNames?.length) {
            const r = await resolveNames(args.addNames);
            addIds.push(...r.resolved.map(p => p.openId));
          }
          if (args.removeNames?.length) {
            const r = await resolveNames(args.removeNames);
            removeIds.push(...r.resolved.map(p => p.openId));
          }
          await client.updateAttendees(calId, args.eventId, {
            ...(addIds.length ? { add: addIds } : {}),
            ...(removeIds.length ? { remove: removeIds } : {}),
          });
          const parts: string[] = [];
          if (addIds.length) parts.push(`added ${addIds.length}`);
          if (removeIds.length) parts.push(`removed ${removeIds.length}`);
          return ok({ success: true, eventId: args.eventId, message: `Attendees updated: ${parts.join(', ')}` });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkCalendar', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
