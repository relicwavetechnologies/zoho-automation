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

export type LarkTaskItem = {
  taskId: string;
  summary?: string;
  completed?: boolean;
  status?: string;
  url?: string;
  raw: Record<string, unknown>;
};

export type LarkListTasksResult = {
  items: LarkTaskItem[];
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
    summary: readLarkString(record.summary) ?? readLarkString(record.title),
    completed: readLarkBoolean(record.completed)
      ?? readLarkBoolean(record.done)
      ?? readLarkBoolean(record.is_completed),
    status: readLarkString(record.status),
    url: readLarkString(record.url) ?? readLarkString(record.link),
    raw: record,
  };
};

class LarkTasksService {
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

  async updateTask(input: MutateTaskInput & { taskId: string }): Promise<LarkTaskItem> {
    const { data } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'PATCH',
      path: `/open-apis/task/v2/tasks/${encodeURIComponent(input.taskId)}`,
      body: input.body,
    });

    const task = normalizeTask(data.task ?? data.item ?? data);
    if (!task) {
      throw new LarkRuntimeClientError('Lark task update returned no task payload', 'lark_runtime_invalid_response');
    }
    return task;
  }
}

export const larkTasksService = new LarkTasksService();
