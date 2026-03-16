import type { LarkCredentialMode } from './lark-runtime-client';
import {
  larkRuntimeClient,
  LarkRuntimeClientError,
  readLarkArray,
  readLarkBoolean,
  readLarkRecord,
  readLarkString,
} from './lark-runtime-client';

type LarkApprovalsAuthInput = {
  companyId?: string;
  larkTenantKey?: string;
  appUserId?: string;
  credentialMode?: LarkCredentialMode;
};

type ListApprovalInstancesInput = LarkApprovalsAuthInput & {
  approvalCode?: string;
  status?: string;
  pageSize?: number;
  pageToken?: string;
};

type CreateApprovalInstanceInput = LarkApprovalsAuthInput & {
  body: Record<string, unknown>;
};

type ListApprovalDefinitionsInput = LarkApprovalsAuthInput & {
  pageSize?: number;
  pageToken?: string;
};

export type LarkApprovalInstance = {
  instanceCode: string;
  approvalCode?: string;
  title?: string;
  status?: string;
  url?: string;
  raw: Record<string, unknown>;
};

export type LarkApprovalListResult = {
  items: LarkApprovalInstance[];
  pageToken?: string;
  hasMore: boolean;
};

export type LarkApprovalDefinition = {
  approvalCode: string;
  name?: string;
  description?: string;
  raw: Record<string, unknown>;
};

const normalizeInstance = (value: unknown): LarkApprovalInstance | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }

  const instanceCode = readLarkString(record.instance_code)
    ?? readLarkString(record.instanceCode)
    ?? readLarkString(record.id);
  if (!instanceCode) {
    return null;
  }

  return {
    instanceCode,
    approvalCode: readLarkString(record.approval_code) ?? readLarkString(record.approvalCode),
    title: readLarkString(record.title) ?? readLarkString(record.reason) ?? readLarkString(record.name),
    status: readLarkString(record.status),
    url: readLarkString(record.url) ?? readLarkString(record.link),
    raw: record,
  };
};

const normalizeDefinition = (value: unknown): LarkApprovalDefinition | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }

  const approvalCode = readLarkString(record.approval_code)
    ?? readLarkString(record.approvalCode)
    ?? readLarkString(record.id);
  if (!approvalCode) {
    return null;
  }

  return {
    approvalCode,
    name: readLarkString(record.approval_name) ?? readLarkString(record.name) ?? readLarkString(record.title),
    description: readLarkString(record.description),
    raw: record,
  };
};

class LarkApprovalsService {
  async listDefinitions(input: ListApprovalDefinitionsInput): Promise<{
    items: LarkApprovalDefinition[];
    pageToken?: string;
    hasMore: boolean;
  }> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: '/open-apis/approval/v4/approvals',
      query: {
        page_size: input.pageSize,
        page_token: input.pageToken,
      },
    });

    const itemsSource = readLarkArray(data.items).length > 0
      ? readLarkArray(data.items)
      : readLarkArray(data.approvals);
    return {
      items: itemsSource
        .map((item) => normalizeDefinition(item))
        .filter((item): item is LarkApprovalDefinition => Boolean(item)),
      pageToken: readLarkString(data.page_token),
      hasMore: readLarkBoolean(data.has_more) ?? false,
    };
  }

  async getDefinition(input: LarkApprovalsAuthInput & { approvalCode: string }): Promise<LarkApprovalDefinition> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: `/open-apis/approval/v4/approvals/${encodeURIComponent(input.approvalCode)}`,
    });

    const definition = normalizeDefinition(data.approval ?? data.item ?? data);
    if (!definition) {
      throw new LarkRuntimeClientError('Lark approval definition lookup returned no payload', 'lark_runtime_invalid_response');
    }
    return definition;
  }

  async listInstances(input: ListApprovalInstancesInput): Promise<LarkApprovalListResult> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: '/open-apis/approval/v4/instances',
      query: {
        approval_code: input.approvalCode,
        status: input.status,
        page_size: input.pageSize,
        page_token: input.pageToken,
      },
    });

    const itemsSource = readLarkArray(data.items).length > 0
      ? readLarkArray(data.items)
      : readLarkArray(data.instances);

    return {
      items: itemsSource
        .map((item) => normalizeInstance(item))
        .filter((item): item is LarkApprovalInstance => Boolean(item)),
      pageToken: readLarkString(data.page_token),
      hasMore: readLarkBoolean(data.has_more) ?? false,
    };
  }

  async getInstance(input: LarkApprovalsAuthInput & { instanceCode: string }): Promise<LarkApprovalInstance> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: `/open-apis/approval/v4/instances/${encodeURIComponent(input.instanceCode)}`,
    });

    const instance = normalizeInstance(data.instance ?? data.item ?? data);
    if (!instance) {
      throw new LarkRuntimeClientError('Lark approval lookup returned no instance payload', 'lark_runtime_invalid_response');
    }
    return instance;
  }

  async createInstance(input: CreateApprovalInstanceInput): Promise<LarkApprovalInstance> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'POST',
      path: '/open-apis/approval/v4/instances',
      body: input.body,
    });

    const instance = normalizeInstance(data.instance ?? data.item ?? data);
    if (!instance) {
      throw new LarkRuntimeClientError('Lark approval create returned no instance payload', 'lark_runtime_invalid_response');
    }
    return instance;
  }
}

export const larkApprovalsService = new LarkApprovalsService();
