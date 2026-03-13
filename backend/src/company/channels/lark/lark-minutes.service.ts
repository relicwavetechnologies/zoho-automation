import type { LarkCredentialMode } from './lark-runtime-client';
import {
  larkRuntimeClient,
  LarkRuntimeClientError,
  readLarkRecord,
  readLarkString,
} from './lark-runtime-client';

type LarkMinutesAuthInput = {
  companyId?: string;
  larkTenantKey?: string;
  appUserId?: string;
  credentialMode?: LarkCredentialMode;
};

export type LarkMinute = {
  minuteToken: string;
  title?: string;
  url?: string;
  status?: string;
  summary?: string;
  raw: Record<string, unknown>;
};

const normalizeMinuteToken = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const pathMatch = url.pathname.match(/\/minutes\/([^/?#]+)/i);
    if (pathMatch?.[1]) {
      return pathMatch[1];
    }
    const queryToken = url.searchParams.get('token') ?? url.searchParams.get('minute_token');
    return queryToken?.trim() || undefined;
  } catch {
    return undefined;
  }
};

const normalizeMinute = (value: unknown): LarkMinute | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }

  const minuteToken = readLarkString(record.minute_token)
    ?? readLarkString(record.minuteToken)
    ?? readLarkString(record.token)
    ?? readLarkString(record.id);
  if (!minuteToken) {
    return null;
  }

  return {
    minuteToken,
    title: readLarkString(record.title) ?? readLarkString(record.topic) ?? readLarkString(record.name),
    url: readLarkString(record.url) ?? readLarkString(record.link),
    status: readLarkString(record.status),
    summary: readLarkString(record.summary) ?? readLarkString(record.abstract),
    raw: record,
  };
};

class LarkMinutesService {
  async getMinute(input: LarkMinutesAuthInput & { minuteTokenOrUrl: string }): Promise<LarkMinute> {
    const minuteToken = normalizeMinuteToken(input.minuteTokenOrUrl);
    if (!minuteToken) {
      throw new LarkRuntimeClientError('Unable to resolve a Lark minute token from the provided value', 'lark_runtime_invalid_response');
    }

    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: `/open-apis/minutes/v1/minutes/${encodeURIComponent(minuteToken)}`,
    });

    const minute = normalizeMinute(data.minute ?? data.item ?? data);
    if (!minute) {
      throw new LarkRuntimeClientError('Lark minute lookup returned no minute payload', 'lark_runtime_invalid_response');
    }
    return minute;
  }
}

export const larkMinutesService = new LarkMinutesService();
export const extractLarkMinuteToken = normalizeMinuteToken;
