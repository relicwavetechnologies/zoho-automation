/**
 * GoogleCalendarClient — Google Calendar REST API client.
 *
 * Implements GoogleCalendarClientPort (defined in google-calendar.tool.ts).
 * Takes a pre-resolved access token.
 *
 * API base: https://www.googleapis.com/calendar/v3
 */

import type { GoogleCalendarClientPort } from '../../application/orchestration/tools/families/google-calendar.tool';

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export class GoogleCalendarClient implements GoogleCalendarClientPort {
  constructor(private readonly accessToken: string) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${CALENDAR_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Calendar API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  private normalizeEvent(e: unknown): Record<string, unknown> {
    const r = asRec(e);
    const start = asRec(r['start']);
    const end   = asRec(r['end']);

    return {
      ...(typeof r['id']          === 'string' ? { eventId:     r['id'] }          : {}),
      ...(typeof r['summary']     === 'string' ? { title:       r['summary'] }      : {}),
      ...(typeof r['description'] === 'string' ? { description: r['description'] }  : {}),
      ...(typeof r['status']      === 'string' ? { status:      r['status'] }       : {}),
      ...(typeof r['htmlLink']    === 'string' ? { webUrl:      r['htmlLink'] }     : {}),
      startTime: typeof start['dateTime'] === 'string' ? start['dateTime']
               : typeof start['date']     === 'string' ? start['date']
               : '',
      endTime:   typeof end['dateTime'] === 'string' ? end['dateTime']
               : typeof end['date']     === 'string' ? end['date']
               : '',
      attendees: Array.isArray(r['attendees'])
        ? (r['attendees'] as unknown[]).map(a => {
            const ar = asRec(a);
            return typeof ar['email'] === 'string' ? ar['email'] : '';
          }).filter(Boolean)
        : [],
    };
  }

  async listEvents(calendarId: string, limit = 20): Promise<unknown[]> {
    const params = new URLSearchParams({
      maxResults:   String(Math.min(limit, 250)),
      orderBy:      'startTime',
      singleEvents: 'true',
      timeMin:      new Date().toISOString(),
    });
    const data = await this.call<Record<string, unknown>>(
      `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    );
    const items = Array.isArray(data['items']) ? data['items'] : [];
    return items.map(e => this.normalizeEvent(e));
  }

  async getEvent(calendarId: string, eventId: string): Promise<unknown> {
    const data = await this.call<Record<string, unknown>>(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
    return this.normalizeEvent(data);
  }

  async createEvent(
    calendarId: string,
    params: object,
  ): Promise<{ eventId: string }> {
    const p = params as Record<string, unknown>;

    const body: Record<string, unknown> = {
      ...(typeof p['title'] === 'string' ? { summary: p['title'] } : {}),
      ...(typeof p['description'] === 'string' ? { description: p['description'] } : {}),
    };

    if (typeof p['startTime'] === 'string') {
      body['start'] = { dateTime: p['startTime'], timeZone: 'UTC' };
    }
    if (typeof p['endTime'] === 'string') {
      body['end'] = { dateTime: p['endTime'], timeZone: 'UTC' };
    }
    if (Array.isArray(p['attendeeEmails'])) {
      body['attendees'] = (p['attendeeEmails'] as string[]).map(email => ({ email }));
    }

    const data = await this.call<Record<string, unknown>>(
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: 'POST', body: JSON.stringify(body) },
    );

    const eventId = typeof data['id'] === 'string' ? data['id'] : '';
    if (!eventId) throw new Error('Calendar createEvent: response missing event id');
    return { eventId };
  }

  async updateEvent(
    calendarId: string,
    eventId:    string,
    params:     object,
  ): Promise<void> {
    const p    = params as Record<string, unknown>;
    const body: Record<string, unknown> = {};

    if (typeof p['title']       === 'string') body['summary']     = p['title'];
    if (typeof p['description'] === 'string') body['description'] = p['description'];
    if (typeof p['startTime']   === 'string') body['start'] = { dateTime: p['startTime'], timeZone: 'UTC' };
    if (typeof p['endTime']     === 'string') body['end']   = { dateTime: p['endTime'],   timeZone: 'UTC' };
    if (Array.isArray(p['attendeeEmails'])) {
      body['attendees'] = (p['attendeeEmails'] as string[]).map(email => ({ email }));
    }

    await this.call(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const res = await fetch(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method:  'DELETE',
        headers: { Authorization: `Bearer ${this.accessToken}` },
      },
    );
    if (!res.ok && res.status !== 204 && res.status !== 404) {
      const text = await res.text().catch(() => '');
      throw new Error(`Calendar deleteEvent ${res.status}: ${text.slice(0, 200)}`);
    }
  }
}
