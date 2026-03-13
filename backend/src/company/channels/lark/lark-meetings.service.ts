import type { LarkCredentialMode } from './lark-runtime-client';
import {
  larkRuntimeClient,
  LarkRuntimeClientError,
  readLarkArray,
  readLarkBoolean,
  readLarkRecord,
  readLarkString,
} from './lark-runtime-client';

type LarkMeetingsAuthInput = {
  companyId?: string;
  larkTenantKey?: string;
  appUserId?: string;
  credentialMode?: LarkCredentialMode;
};

type ListMeetingsInput = LarkMeetingsAuthInput & {
  pageSize?: number;
  pageToken?: string;
  startTime?: string;
  endTime?: string;
};

export type LarkMeeting = {
  meetingId: string;
  topic?: string;
  status?: string;
  url?: string;
  startTime?: string;
  endTime?: string;
  raw: Record<string, unknown>;
};

export type LarkListMeetingsResult = {
  items: LarkMeeting[];
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

const normalizeMeeting = (value: unknown): LarkMeeting | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }

  const meetingId = readLarkString(record.meeting_id)
    ?? readLarkString(record.meetingId)
    ?? readLarkString(record.id);
  if (!meetingId) {
    return null;
  }

  return {
    meetingId,
    topic: readLarkString(record.topic) ?? readLarkString(record.title) ?? readLarkString(record.summary),
    status: readLarkString(record.status),
    url: readLarkString(record.url) ?? readLarkString(record.join_url) ?? readLarkString(record.link),
    startTime: readTimeField(record.start_time),
    endTime: readTimeField(record.end_time),
    raw: record,
  };
};

class LarkMeetingsService {
  async listMeetings(input: ListMeetingsInput): Promise<LarkListMeetingsResult> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: '/open-apis/vc/v1/meetings',
      query: {
        page_size: input.pageSize,
        page_token: input.pageToken,
        start_time: input.startTime,
        end_time: input.endTime,
      },
    });

    const itemsSource = readLarkArray(data.items).length > 0
      ? readLarkArray(data.items)
      : readLarkArray(data.meetings);

    return {
      items: itemsSource
        .map((item) => normalizeMeeting(item))
        .filter((item): item is LarkMeeting => Boolean(item)),
      pageToken: readLarkString(data.page_token),
      hasMore: readLarkBoolean(data.has_more) ?? false,
    };
  }

  async getMeeting(input: LarkMeetingsAuthInput & { meetingId: string }): Promise<LarkMeeting> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: `/open-apis/vc/v1/meetings/${encodeURIComponent(input.meetingId)}`,
    });

    const meeting = normalizeMeeting(data.meeting ?? data.item ?? data);
    if (!meeting) {
      throw new LarkRuntimeClientError('Lark meeting lookup returned no meeting payload', 'lark_runtime_invalid_response');
    }
    return meeting;
  }
}

export const larkMeetingsService = new LarkMeetingsService();
