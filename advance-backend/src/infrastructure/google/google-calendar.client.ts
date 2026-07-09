/**
 * GoogleCalendarClient — Google Calendar client backed by @googleapis/calendar.
 */

import { calendar } from '@googleapis/calendar';
import { OAuth2Client } from 'google-auth-library';
import type { GoogleCalendarClientPort } from '../../application/orchestration/tools/families/google-calendar.tool';

const DEFAULT_EVENT_TYPES = ['default', 'outOfOffice', 'workingLocation', 'focusTime', 'birthday'];

type CalendarEventMetadata = {
  readonly eventId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly status?: string;
  readonly webUrl?: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly attendees: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getEventDate(value: unknown): string {
  const record = asRecord(value);
  if (typeof record['dateTime'] === 'string') return record['dateTime'];
  if (typeof record['date'] === 'string') return record['date'];
  return '';
}

function toEventPatch(params: object): Record<string, unknown> {
  const input = params as Record<string, unknown>;
  const body: Record<string, unknown> = {};

  if (typeof input['title'] === 'string') body['summary'] = input['title'];
  if (typeof input['description'] === 'string') body['description'] = input['description'];
  if (typeof input['startTime'] === 'string') body['start'] = { dateTime: input['startTime'], timeZone: 'UTC' };
  if (typeof input['endTime'] === 'string') body['end'] = { dateTime: input['endTime'], timeZone: 'UTC' };
  if (Array.isArray(input['attendeeEmails'])) {
    body['attendees'] = input['attendeeEmails']
      .filter((email): email is string => typeof email === 'string' && email.trim().length > 0)
      .map(email => ({ email }));
  }

  return body;
}

function isHttpStatus(error: unknown, status: number): boolean {
  const record = asRecord(error);
  if (record['code'] === status) return true;
  const response = asRecord(record['response']);
  return response['status'] === status;
}

function toOAuth2Client(auth: OAuth2Client | string): OAuth2Client {
  if (typeof auth !== 'string') return auth;
  const client = new OAuth2Client();
  client.setCredentials({ access_token: auth });
  return client;
}

export class GoogleCalendarClient implements GoogleCalendarClientPort {
  private readonly client;

  constructor(auth: OAuth2Client | string) {
    this.client = calendar({ version: 'v3', auth: toOAuth2Client(auth) });
  }

  private normalizeEvent(event: Record<string, unknown>): CalendarEventMetadata {
    const attendees = Array.isArray(event['attendees'])
      ? event['attendees']
          .map(attendee => asRecord(attendee)['email'])
          .filter((email): email is string => typeof email === 'string' && email.length > 0)
      : [];

    const out: {
      eventId?: string;
      title?: string;
      description?: string;
      status?: string;
      webUrl?: string;
      startTime: string;
      endTime: string;
      attendees: string[];
    } = {
      startTime: getEventDate(event['start']),
      endTime: getEventDate(event['end']),
      attendees,
    };

    if (typeof event['id'] === 'string') out.eventId = event['id'];
    if (typeof event['summary'] === 'string') out.title = event['summary'];
    if (typeof event['description'] === 'string') out.description = event['description'];
    if (typeof event['status'] === 'string') out.status = event['status'];
    if (typeof event['htmlLink'] === 'string') out.webUrl = event['htmlLink'];
    return out;
  }

  async listEvents(
    calendarId: string,
    params: { limit?: number; startTime?: string; endTime?: string } = {},
  ): Promise<unknown[]> {
    const listParams: {
      calendarId: string;
      maxResults: number;
      orderBy: 'startTime';
      singleEvents: true;
      timeMin: string;
      timeMax?: string;
      eventTypes: string[];
    } = {
      calendarId,
      maxResults: Math.min(params.limit ?? 20, 250),
      orderBy: 'startTime',
      singleEvents: true,
      timeMin: params.startTime ?? new Date().toISOString(),
      eventTypes: DEFAULT_EVENT_TYPES,
    };
    if (params.endTime !== undefined) listParams.timeMax = params.endTime;

    const res = await this.client.events.list(listParams);
    return (res.data.items ?? []).map(event => this.normalizeEvent(event as Record<string, unknown>));
  }

  async getEvent(calendarId: string, eventId: string): Promise<unknown> {
    const res = await this.client.events.get({ calendarId, eventId });
    return this.normalizeEvent(res.data as Record<string, unknown>);
  }

  async createEvent(calendarId: string, params: object): Promise<{ eventId: string }> {
    const res = await this.client.events.insert({
      calendarId,
      requestBody: toEventPatch(params),
    });
    const eventId = res.data.id ?? '';
    if (!eventId) throw new Error('Calendar createEvent: response missing event id');
    return { eventId };
  }

  async updateEvent(calendarId: string, eventId: string, params: object): Promise<void> {
    await this.client.events.patch({
      calendarId,
      eventId,
      requestBody: toEventPatch(params),
    });
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.client.events.delete({ calendarId, eventId });
    } catch (error) {
      if (isHttpStatus(error, 404)) return;
      throw error;
    }
  }
}
