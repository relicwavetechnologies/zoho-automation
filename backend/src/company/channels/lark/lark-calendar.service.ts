import type { LarkCredentialMode } from './lark-runtime-client';
import {
  larkRuntimeClient,
  LarkRuntimeClientError,
  readLarkArray,
  readLarkBoolean,
  readLarkRecord,
  readLarkString,
} from './lark-runtime-client';

type LarkCalendarAuthInput = {
  companyId?: string;
  larkTenantKey?: string;
  appUserId?: string;
  credentialMode?: LarkCredentialMode;
};

type ListCalendarEventsInput = LarkCalendarAuthInput & {
  calendarId: string;
  pageSize?: number;
  pageToken?: string;
  startTime?: string;
  endTime?: string;
};

type ListCalendarsInput = LarkCalendarAuthInput & {
  pageSize?: number;
  pageToken?: string;
};

type MutateCalendarEventInput = LarkCalendarAuthInput & {
  calendarId: string;
  eventId?: string;
  body: Record<string, unknown>;
};

export type LarkCalendarEvent = {
  eventId: string;
  summary?: string;
  description?: string;
  url?: string;
  startTime?: string;
  endTime?: string;
  raw: Record<string, unknown>;
};

export type LarkListCalendarEventsResult = {
  items: LarkCalendarEvent[];
  pageToken?: string;
  hasMore: boolean;
};

export type LarkCalendarInfo = {
  calendarId: string;
  summary?: string;
  description?: string;
  permission?: string;
  raw: Record<string, unknown>;
};

export type LarkListCalendarsResult = {
  items: LarkCalendarInfo[];
  pageToken?: string;
  hasMore: boolean;
};

const readTimeField = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  const record = readLarkRecord(value);
  if (!record) {
    return undefined;
  }

  return readLarkString(record.timestamp)
    ?? readLarkString(record.time)
    ?? readLarkString(record.date)
    ?? readLarkString(record.datetime);
};

const normalizeEvent = (value: unknown): LarkCalendarEvent | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }

  const eventId = readLarkString(record.event_id)
    ?? readLarkString(record.eventId)
    ?? readLarkString(record.id);
  if (!eventId) {
    return null;
  }

  return {
    eventId,
    summary: readLarkString(record.summary) ?? readLarkString(record.title) ?? readLarkString(record.name),
    description: readLarkString(record.description),
    url: readLarkString(record.url) ?? readLarkString(record.link),
    startTime: readTimeField(record.start_time),
    endTime: readTimeField(record.end_time),
    raw: record,
  };
};

const normalizeCalendar = (value: unknown): LarkCalendarInfo | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }

  const calendarId = readLarkString(record.calendar_id)
    ?? readLarkString(record.calendarId)
    ?? readLarkString(record.id);
  if (!calendarId) {
    return null;
  }

  return {
    calendarId,
    summary: readLarkString(record.summary) ?? readLarkString(record.name),
    description: readLarkString(record.description),
    permission: readLarkString(record.permission) ?? readLarkString(record.role),
    raw: record,
  };
};

class LarkCalendarService {
  async getPrimaryCalendar(input: LarkCalendarAuthInput): Promise<LarkCalendarInfo> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'POST',
      path: '/open-apis/calendar/v4/calendars/primary',
    });

    const calendars = readLarkArray(data.calendars);
    const firstCalendarRecord = readLarkRecord(calendars[0]);
    const calendar = normalizeCalendar(firstCalendarRecord?.calendar ?? data.calendar ?? data.item ?? data);
    if (!calendar) {
      throw new LarkRuntimeClientError('Lark primary calendar lookup returned no calendar payload', 'lark_runtime_invalid_response');
    }
    return calendar;
  }

  async listCalendars(input: ListCalendarsInput): Promise<LarkListCalendarsResult> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: '/open-apis/calendar/v4/calendars',
      query: {
        page_size: input.pageSize && input.pageSize >= 50 ? input.pageSize : undefined,
        page_token: input.pageToken,
      },
    });

    const itemsSource = readLarkArray(data.calendar_list).length > 0
      ? readLarkArray(data.calendar_list)
      : readLarkArray(data.items).length > 0
        ? readLarkArray(data.items)
        : readLarkArray(data.calendars);

    return {
      items: itemsSource
        .map((item) => normalizeCalendar(item))
        .filter((item): item is LarkCalendarInfo => Boolean(item)),
      pageToken: readLarkString(data.page_token),
      hasMore: readLarkBoolean(data.has_more) ?? false,
    };
  }

  async listEvents(input: ListCalendarEventsInput): Promise<LarkListCalendarEventsResult> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(input.calendarId)}/events`,
      query: {
        page_size: input.pageSize && input.pageSize >= 50 ? input.pageSize : undefined,
        page_token: input.pageToken,
        start_time: input.startTime,
        end_time: input.endTime,
      },
    });

    const itemsSource = readLarkArray(data.items).length > 0
      ? readLarkArray(data.items)
      : readLarkArray(data.events);

    return {
      items: itemsSource
        .map((item) => normalizeEvent(item))
        .filter((item): item is LarkCalendarEvent => Boolean(item)),
      pageToken: readLarkString(data.page_token),
      hasMore: readLarkBoolean(data.has_more) ?? false,
    };
  }

  async createEvent(input: MutateCalendarEventInput): Promise<LarkCalendarEvent> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'POST',
      path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(input.calendarId)}/events`,
      body: input.body,
    });

    const event = normalizeEvent(data.event ?? data.item ?? data);
    if (!event) {
      throw new LarkRuntimeClientError('Lark calendar create returned no event payload', 'lark_runtime_invalid_response');
    }
    return event;
  }

  async updateEvent(input: MutateCalendarEventInput & { eventId: string }): Promise<LarkCalendarEvent> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'PATCH',
      path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
      body: input.body,
    });

    const event = normalizeEvent(data.event ?? data.item ?? data);
    if (!event) {
      throw new LarkRuntimeClientError('Lark calendar update returned no event payload', 'lark_runtime_invalid_response');
    }
    return event;
  }

  async deleteEvent(input: LarkCalendarAuthInput & { calendarId: string; eventId: string }): Promise<void> {
    await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'DELETE',
      path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
    });
  }
}

export const larkCalendarService = new LarkCalendarService();
