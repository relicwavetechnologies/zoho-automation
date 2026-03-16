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
  fieldNames?: string[];
  sort?: string;
  filter?: string;
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

export type LarkBaseTable = {
  tableId: string;
  name?: string;
  revision?: number;
  raw: Record<string, unknown>;
};

export type LarkBaseView = {
  viewId: string;
  name?: string;
  type?: string;
  raw: Record<string, unknown>;
};

export type LarkBaseField = {
  fieldId: string;
  fieldName?: string;
  type?: number;
  raw: Record<string, unknown>;
};

export type LarkBaseApp = {
  appToken: string;
  name?: string;
  revision?: number;
  raw: Record<string, unknown>;
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

const normalizeApp = (value: unknown): LarkBaseApp | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }
  const appToken = readLarkString(record.app_token)
    ?? readLarkString(record.appToken)
    ?? readLarkString(record.id);
  if (!appToken) {
    return null;
  }
  return {
    appToken,
    name: readLarkString(record.name),
    revision: readLarkNumber(record.revision),
    raw: record,
  };
};

const normalizeTable = (value: unknown): LarkBaseTable | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }
  const tableId = readLarkString(record.table_id)
    ?? readLarkString(record.tableId)
    ?? readLarkString(record.id);
  if (!tableId) {
    return null;
  }
  return {
    tableId,
    name: readLarkString(record.name),
    revision: readLarkNumber(record.revision),
    raw: record,
  };
};

const normalizeView = (value: unknown): LarkBaseView | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }
  const viewId = readLarkString(record.view_id)
    ?? readLarkString(record.viewId)
    ?? readLarkString(record.id);
  if (!viewId) {
    return null;
  }
  return {
    viewId,
    name: readLarkString(record.view_name) ?? readLarkString(record.name),
    type: readLarkString(record.view_type) ?? readLarkString(record.type),
    raw: record,
  };
};

const normalizeField = (value: unknown): LarkBaseField | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }
  const fieldId = readLarkString(record.field_id)
    ?? readLarkString(record.fieldId)
    ?? readLarkString(record.id);
  if (!fieldId) {
    return null;
  }
  return {
    fieldId,
    fieldName: readLarkString(record.field_name) ?? readLarkString(record.name),
    type: readLarkNumber(record.type),
    raw: record,
  };
};

class LarkBaseService {
  async listApps(input: LarkBaseAuthInput & { pageSize?: number; pageToken?: string }): Promise<{
    items: LarkBaseApp[];
    pageToken?: string;
    hasMore: boolean;
  }> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: '/open-apis/bitable/v1/apps',
      query: {
        page_size: input.pageSize,
        page_token: input.pageToken,
      },
    });

    const itemsSource = readLarkArray(data.items).length > 0 ? readLarkArray(data.items) : readLarkArray(data.apps);
    return {
      items: itemsSource.map((item) => normalizeApp(item)).filter((item): item is LarkBaseApp => Boolean(item)),
      pageToken: readLarkString(data.page_token),
      hasMore: readLarkBoolean(data.has_more) ?? false,
    };
  }

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
        field_names: input.fieldNames?.join(','),
        sort: input.sort,
        filter: input.filter,
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

  async getRecord(input: LarkBaseAuthInput & { appToken: string; tableId: string; recordId: string }): Promise<LarkBaseRecord> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records/${encodeURIComponent(input.recordId)}`,
    });

    const record = normalizeRecord(data.record ?? data.item ?? data);
    if (!record) {
      throw new LarkRuntimeClientError('Lark Base record lookup returned no record payload', 'lark_runtime_invalid_response');
    }
    return record;
  }

  async listTables(input: LarkBaseAuthInput & { appToken: string; pageSize?: number; pageToken?: string }): Promise<{
    items: LarkBaseTable[];
    pageToken?: string;
    hasMore: boolean;
  }> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables`,
      query: {
        page_size: input.pageSize,
        page_token: input.pageToken,
      },
    });

    const itemsSource = readLarkArray(data.items).length > 0 ? readLarkArray(data.items) : readLarkArray(data.tables);
    return {
      items: itemsSource.map((item) => normalizeTable(item)).filter((item): item is LarkBaseTable => Boolean(item)),
      pageToken: readLarkString(data.page_token),
      hasMore: readLarkBoolean(data.has_more) ?? false,
    };
  }

  async listViews(input: LarkBaseAuthInput & { appToken: string; tableId: string; pageSize?: number; pageToken?: string }): Promise<{
    items: LarkBaseView[];
    pageToken?: string;
    hasMore: boolean;
  }> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/views`,
      query: {
        page_size: input.pageSize,
        page_token: input.pageToken,
      },
    });

    const itemsSource = readLarkArray(data.items).length > 0 ? readLarkArray(data.items) : readLarkArray(data.views);
    return {
      items: itemsSource.map((item) => normalizeView(item)).filter((item): item is LarkBaseView => Boolean(item)),
      pageToken: readLarkString(data.page_token),
      hasMore: readLarkBoolean(data.has_more) ?? false,
    };
  }

  async listFields(input: LarkBaseAuthInput & { appToken: string; tableId: string; pageSize?: number; pageToken?: string }): Promise<{
    items: LarkBaseField[];
    pageToken?: string;
    hasMore: boolean;
  }> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/fields`,
      query: {
        page_size: input.pageSize,
        page_token: input.pageToken,
      },
    });

    const itemsSource = readLarkArray(data.items).length > 0 ? readLarkArray(data.items) : readLarkArray(data.fields);
    return {
      items: itemsSource.map((item) => normalizeField(item)).filter((item): item is LarkBaseField => Boolean(item)),
      pageToken: readLarkString(data.page_token),
      hasMore: readLarkBoolean(data.has_more) ?? false,
    };
  }

  async deleteRecord(input: LarkBaseAuthInput & { appToken: string; tableId: string; recordId: string }): Promise<void> {
    await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'DELETE',
      path: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records/${encodeURIComponent(input.recordId)}`,
    });
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
