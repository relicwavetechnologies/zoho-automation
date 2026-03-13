import type { LarkCredentialMode } from './lark-runtime-client';
import {
  larkRuntimeClient,
  LarkRuntimeClientError,
  readLarkArray,
  readLarkBoolean,
  readLarkNumber,
  readLarkRecord,
  readLarkString,
} from './lark-runtime-client';

type LarkBaseAuthInput = {
  companyId?: string;
  larkTenantKey?: string;
  appUserId?: string;
  credentialMode?: LarkCredentialMode;
};

type ListBaseRecordsInput = LarkBaseAuthInput & {
  appToken: string;
  tableId: string;
  viewId?: string;
  pageSize?: number;
  pageToken?: string;
};

type MutateBaseRecordInput = LarkBaseAuthInput & {
  appToken: string;
  tableId: string;
  recordId?: string;
  fields: Record<string, unknown>;
};

export type LarkBaseRecord = {
  recordId: string;
  fields: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type LarkBaseListRecordsResult = {
  items: LarkBaseRecord[];
  pageToken?: string;
  hasMore: boolean;
  total?: number;
};

const normalizeRecord = (value: unknown): LarkBaseRecord | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }

  const recordId = readLarkString(record.record_id)
    ?? readLarkString(record.recordId)
    ?? readLarkString(record.id);
  if (!recordId) {
    return null;
  }

  return {
    recordId,
    fields: readLarkRecord(record.fields) ?? {},
    raw: record,
  };
};

class LarkBaseService {
  async listRecords(input: ListBaseRecordsInput): Promise<LarkBaseListRecordsResult> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records`,
      query: {
        view_id: input.viewId,
        page_size: input.pageSize,
        page_token: input.pageToken,
      },
    });

    return {
      items: readLarkArray(data.items)
        .map((item) => normalizeRecord(item))
        .filter((item): item is LarkBaseRecord => Boolean(item)),
      pageToken: readLarkString(data.page_token),
      hasMore: readLarkBoolean(data.has_more) ?? false,
      total: readLarkNumber(data.total),
    };
  }

  async createRecord(input: MutateBaseRecordInput): Promise<LarkBaseRecord> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'POST',
      path: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records`,
      body: {
        fields: input.fields,
      },
    });

    const record = normalizeRecord(data.record ?? data.item ?? data);
    if (!record) {
      throw new LarkRuntimeClientError('Lark Base create record returned no record payload', 'lark_runtime_invalid_response');
    }
    return record;
  }

  async updateRecord(input: MutateBaseRecordInput & { recordId: string }): Promise<LarkBaseRecord> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'PUT',
      path: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records/${encodeURIComponent(input.recordId)}`,
      body: {
        fields: input.fields,
      },
    });

    const record = normalizeRecord(data.record ?? data.item ?? data);
    if (!record) {
      throw new LarkRuntimeClientError('Lark Base update record returned no record payload', 'lark_runtime_invalid_response');
    }
    return record;
  }
}

export const larkBaseService = new LarkBaseService();
