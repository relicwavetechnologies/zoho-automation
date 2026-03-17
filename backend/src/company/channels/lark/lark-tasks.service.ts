import type { LarkCredentialMode } from './lark-runtime-client';
import {
  larkRuntimeClient,
  LarkRuntimeClientError,
  readLarkArray,
  readLarkBoolean,
  readLarkRecord,
  readLarkString,
} from './lark-runtime-client';

type LarkTasksAuthInput = {
  companyId?: string;
  larkTenantKey?: string;
  appUserId?: string;
  credentialMode?: LarkCredentialMode;
};

type ListTasksInput = LarkTasksAuthInput & {
  pageSize?: number;
  pageToken?: string;
  tasklistId?: string;
};

type MutateTaskInput = LarkTasksAuthInput & {
  taskId?: string;
  body: Record<string, unknown>;
};

type GetTaskInput = LarkTasksAuthInput & {
  taskGuid: string;
};

type ListTasklistsInput = LarkTasksAuthInput & {
  pageSize?: number;
  pageToken?: string;
};

export type LarkTaskItem = {
  taskId: string;
  taskGuid?: string;
  summary?: string;
  completed?: boolean;
  status?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  raw: Record<string, unknown>;
};

export type LarkListTasksResult = {
  items: LarkTaskItem[];
  pageToken?: string;
  hasMore: boolean;
};

export type LarkTasklist = {
  tasklistId: string;
  summary?: string;
  raw: Record<string, unknown>;
};

export type LarkListTasklistsResult = {
  items: LarkTasklist[];
  pageToken?: string;
  hasMore: boolean;
};

const normalizeTask = (value: unknown): LarkTaskItem | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }

  const taskId = readLarkString(record.task_id)
    ?? readLarkString(record.taskId)
    ?? readLarkString(record.guid)
    ?? readLarkString(record.id);
  if (!taskId) {
    return null;
  }

  return {
    taskId,
    taskGuid: readLarkString(record.guid) ?? readLarkString(record.task_guid) ?? readLarkString(record.taskGuid),
    summary: readLarkString(record.summary) ?? readLarkString(record.title),
    completed: readLarkBoolean(record.completed)
      ?? readLarkBoolean(record.done)
      ?? readLarkBoolean(record.is_completed),
    status: readLarkString(record.status),
    url: readLarkString(record.url) ?? readLarkString(record.link),
    createdAt: readLarkString(record.created_at) ?? readLarkString(record.createdAt),
    updatedAt: readLarkString(record.updated_at) ?? readLarkString(record.updatedAt),
    raw: record,
  };
};

const normalizeTasklist = (value: unknown): LarkTasklist | null => {
  const record = readLarkRecord(value);
  if (!record) {
    return null;
  }

  const tasklistId = readLarkString(record.tasklist_id)
    ?? readLarkString(record.tasklistId)
    ?? readLarkString(record.guid)
    ?? readLarkString(record.id);
  if (!tasklistId) {
    return null;
  }

  return {
    tasklistId,
    summary: readLarkString(record.summary) ?? readLarkString(record.name) ?? readLarkString(record.title),
    raw: record,
  };
};

class LarkTasksService {
  async listTasklists(input: ListTasklistsInput): Promise<LarkListTasklistsResult> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: '/open-apis/task/v2/tasklists',
      query: {
        page_size: input.pageSize,
        page_token: input.pageToken,
      },
    });

    const itemsSource = readLarkArray(data.items).length > 0
      ? readLarkArray(data.items)
      : readLarkArray(data.tasklists);

    return {
      items: itemsSource
        .map((item) => normalizeTasklist(item))
        .filter((item): item is LarkTasklist => Boolean(item)),
      pageToken: readLarkString(data.page_token),
      hasMore: readLarkBoolean(data.has_more) ?? false,
    };
  }

  async listTasks(input: ListTasksInput): Promise<LarkListTasksResult> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: '/open-apis/task/v2/tasks',
      query: {
        page_size: input.pageSize,
        page_token: input.pageToken,
        tasklist_id: input.tasklistId,
      },
    });

    const itemsSource = readLarkArray(data.items).length > 0
      ? readLarkArray(data.items)
      : readLarkArray(data.tasks);

    return {
      items: itemsSource
        .map((item) => normalizeTask(item))
        .filter((item): item is LarkTaskItem => Boolean(item)),
      pageToken: readLarkString(data.page_token),
      hasMore: readLarkBoolean(data.has_more) ?? false,
    };
  }

  async createTask(input: MutateTaskInput): Promise<LarkTaskItem> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'POST',
      path: '/open-apis/task/v2/tasks',
      body: input.body,
    });

    const task = normalizeTask(data.task ?? data.item ?? data);
    if (!task) {
      throw new LarkRuntimeClientError('Lark task create returned no task payload', 'lark_runtime_invalid_response');
    }
    return task;
  }

  async getTask(input: GetTaskInput): Promise<LarkTaskItem> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'GET',
      path: `/open-apis/task/v2/tasks/${encodeURIComponent(input.taskGuid)}`,
    });

    const task = normalizeTask(data.task ?? data.item ?? data);
    if (!task) {
      throw new LarkRuntimeClientError('Lark task lookup returned no task payload', 'lark_runtime_invalid_response');
    }
    return task;
  }

  async updateTask(input: MutateTaskInput & { taskGuid: string }): Promise<LarkTaskItem> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'PATCH',
      path: `/open-apis/task/v2/tasks/${encodeURIComponent(input.taskGuid)}`,
      body: input.body,
    });

    const task = normalizeTask(data.task ?? data.item ?? data);
    if (!task) {
      throw new LarkRuntimeClientError('Lark task update returned no task payload', 'lark_runtime_invalid_response');
    }
    return task;
  }

  async deleteTask(input: GetTaskInput): Promise<void> {
    await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'DELETE',
      path: `/open-apis/task/v2/tasks/${encodeURIComponent(input.taskGuid)}`,
    });
  }
}

export const larkTasksService = new LarkTasksService();
