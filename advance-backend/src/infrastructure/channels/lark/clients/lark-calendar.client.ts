import type { LarkCalendarClientPort } from '../../../../application/orchestration/tools/families/lark-calendar.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type EventRecord = Record<string, unknown>;

const normalizeEvent = (r: EventRecord) => ({
  eventId: (r['event_id'] ?? r['id'] ?? '') as string,
  summary: (r['summary'] ?? r['title'] ?? '') as string,
  startTime: (r['start_time'] as Record<string, unknown> | undefined)?.['timestamp'] as string | undefined,
  endTime: (r['end_time'] as Record<string, unknown> | undefined)?.['timestamp'] as string | undefined,
});

export class LarkCalendarClient implements LarkCalendarClientPort {
  private readonly http: LarkHttpClient;

  constructor(deps: LarkHttpClientDeps) {
    this.http = new LarkHttpClient(deps);
  }

  async listEvents(calendarId: string, limit?: number): Promise<unknown[]> {
    type ListResponse = { items?: EventRecord[] };
    const pageSize = Math.min(50, Math.max(1, limit ?? 50));
    const data = await this.http.request<ListResponse>(
      'GET',
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`,
      { query: { page_size: pageSize } },
    );
    return (data.items ?? []).map(normalizeEvent);
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
    params: { title: string; startTime: string; endTime: string; attendeeIds?: string[]; description?: string },
  ): Promise<{ eventId: string }> {
    const toTimestamp = (iso: string) => ({ timestamp: String(Math.floor(new Date(iso).getTime() / 1000)), timezone: 'UTC' });
    type CreateResponse = { event: EventRecord };
    const data = await this.http.request<CreateResponse>(
      'POST',
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        body: {
          summary: params.title,
          start_time: toTimestamp(params.startTime),
          end_time: toTimestamp(params.endTime),
          ...(params.description ? { description: params.description } : {}),
          ...(params.attendeeIds?.length
            ? { attendees: params.attendeeIds.map(id => ({ type: 'user', user_id: id })) }
            : {}),
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
}
