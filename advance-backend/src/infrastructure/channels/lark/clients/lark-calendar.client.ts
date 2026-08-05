import type { LarkCalendarClientPort } from '../../../../application/tools/families/lark-calendar.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type EventRecord = Record<string, unknown>;

const toTimestamp = (iso: string) => {
  const milliseconds = new Date(iso).getTime();
  if (Number.isNaN(milliseconds)) throw new Error(`Invalid calendar timestamp: ${iso}`);
  return { timestamp: String(Math.floor(milliseconds / 1000)), timezone: 'UTC' };
};

const normalizeEvent = (r: EventRecord) => ({
  eventId:   (r['event_id'] ?? r['id'] ?? '') as string,
  summary:   (r['summary'] ?? r['title'] ?? '') as string,
  startTime: (r['start_time'] as Record<string, unknown> | undefined)?.['timestamp'] as string | undefined,
  endTime:   (r['end_time']   as Record<string, unknown> | undefined)?.['timestamp'] as string | undefined,
});

function buildRRule(r: { frequency: string; days?: string[]; until?: string; count?: number }): string {
  let rule = `RRULE:FREQ=${r.frequency.toUpperCase()}`;
  if (r.days?.length) rule += `;BYDAY=${r.days.join(',')}`;
  if (r.count)        rule += `;COUNT=${r.count}`;
  else if (r.until)   rule += `;UNTIL=${toRRuleTimestamp(r.until)}`;
  return rule;
}

function toRRuleTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid recurrence end time: ${iso}`);
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export class LarkCalendarClient implements LarkCalendarClientPort {
  private readonly http: LarkHttpClient;

  constructor(deps: LarkHttpClientDeps) {
    this.http = new LarkHttpClient(deps);
  }

  async listEvents(calendarId: string, limit?: number): Promise<unknown[]> {
    type ListResponse = { items?: EventRecord[] };
    const resultLimit = Math.min(50, Math.max(1, limit ?? 50));
    const data = await this.http.request<ListResponse>(
      'GET',
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`,
      // Lark Calendar v4 rejects page_size below 50. Fetch one valid provider
      // page and enforce Divo's smaller caller limit after normalization.
      { query: { page_size: 50 } },
    );
    return (data.items ?? []).slice(0, resultLimit).map(normalizeEvent);
  }

  async getEvent(calendarId: string, eventId: string): Promise<unknown> {
    type GetResponse = { event: EventRecord };
    const data = await this.http.request<GetResponse>(
      'GET',
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
    return normalizeEvent(data.event);
  }

  async createEvent(
    calendarId: string,
    params: {
      title: string;
      startTime: string;
      endTime: string;
      attendeeIds?: string[];
      description?: string;
      recurrence?: { frequency: string; days?: string[]; until?: string; count?: number };
    },
  ): Promise<{ eventId: string }> {
    type CreateResponse = { event: EventRecord };
    const data = await this.http.request<CreateResponse>(
      'POST',
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        body: {
          summary:    params.title,
          start_time: toTimestamp(params.startTime),
          end_time:   toTimestamp(params.endTime),
          ...(params.description ? { description: params.description } : {}),
          ...(params.attendeeIds?.length
            ? { attendees: params.attendeeIds.map(id => ({ type: 'user', user_id: id })) }
            : {}),
          ...(params.recurrence ? { recurrence: [buildRRule(params.recurrence)] } : {}),
        },
      },
    );
    return { eventId: (data.event['event_id'] ?? '') as string };
  }

  async updateEvent(calendarId: string, eventId: string, params: object): Promise<void> {
    await this.http.request(
      'PATCH',
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { body: params },
    );
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.http.request(
      'DELETE',
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
  }

  async queryFreeBusy(params: {
    userIds: string[];
    timeMin: string;
    timeMax: string;
  }): Promise<Record<string, { busy: Array<{ start: string; end: string }> }>> {
    // Lark freebusy/list accepts one user_id per call — fan out in parallel
    type FreeBusyResponse = {
      freebusy_list?: Array<{ start_time: string; end_time: string }>;
    };
    const result: Record<string, { busy: Array<{ start: string; end: string }> }> = {};
    await Promise.all(
      params.userIds.map(async (userId) => {
        const data = await this.http.request<FreeBusyResponse>(
          'POST',
          '/open-apis/calendar/v4/freebusy/list',
          {
            body: {
              time_min: params.timeMin,
              time_max: params.timeMax,
              user_id: userId,
              user_id_type: 'open_id',
              only_busy: true,
            },
          },
        );
        result[userId] = {
          busy: (data.freebusy_list ?? []).map(b => ({ start: b.start_time, end: b.end_time })),
        };
      }),
    );
    return result;
  }

  async listAttendees(
    calendarId: string,
    eventId: string,
  ): Promise<Array<{ attendeeId: string; userId: string; displayName: string; rsvpStatus: string }>> {
    type AttendeesResponse = { items?: Array<Record<string, unknown>> };
    const data = await this.http.request<AttendeesResponse>(
      'GET',
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}/attendees`,
    );
    return (data.items ?? []).map(a => ({
      attendeeId:  a['attendee_id']  as string ?? '',
      userId:      a['user_id']      as string ?? '',
      displayName: a['display_name'] as string ?? '',
      rsvpStatus:  a['rsvp_status']  as string ?? 'needs_action',
    }));
  }

  async updateAttendees(
    calendarId: string,
    eventId: string,
    params: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    const base = `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}/attendees`;

    if (params.add?.length) {
      await this.http.request('POST', base, {
        body: { attendees: params.add.map(id => ({ type: 'user', user_id: id })) },
      });
    }

    if (params.remove?.length) {
      // List attendees to map open_id → attendee_id (Lark's internal attendee identifier)
      type ListAttendeesResponse = { items?: Array<{ attendee_id: string; user_id?: string }> };
      const listData = await this.http.request<ListAttendeesResponse>('GET', base);
      const removeSet = new Set(params.remove);
      const attendeeIds = (listData.items ?? [])
        .filter(a => a.user_id && removeSet.has(a.user_id))
        .map(a => a.attendee_id);
      if (attendeeIds.length > 0) {
        await this.http.request('POST', `${base}/batch_delete`, {
          body: { attendee_ids: attendeeIds },
        });
      }
    }
  }
}
