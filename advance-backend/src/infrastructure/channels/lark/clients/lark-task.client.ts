import type { LarkTaskClientPort } from '../../../../application/orchestration/tools/families/lark-task.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type TaskRecord = Record<string, unknown>;

const normalizeTask = (r: TaskRecord) => ({
  taskId: (r['task_id'] ?? r['guid'] ?? r['id'] ?? '') as string,
  title: (r['summary'] ?? r['title'] ?? '') as string,
  completed: (r['completed'] ?? r['done'] ?? false) as boolean,
  dueDate: r['due'] as string | undefined,
});

export class LarkTaskClient implements LarkTaskClientPort {
  private readonly http: LarkHttpClient;

  constructor(deps: LarkHttpClientDeps) {
    this.http = new LarkHttpClient(deps);
  }

  async createTask(params: {
    title: string;
    dueDate?: string;
    assigneeIds?: string[];
    followerIds?: string[];
    notes?: string;
    tasklist?: string;
  }): Promise<{ taskId: string; title: string }> {
    const body: Record<string, unknown> = {
      summary: params.title,
      ...(params.notes ? { description: params.notes } : {}),
      ...(params.dueDate ? { due: { timestamp: String(Math.floor(new Date(params.dueDate).getTime() / 1000)), is_all_day: false } } : {}),
      ...(params.assigneeIds?.length
        ? { members: params.assigneeIds.map(id => ({ id, type: 'user', role: 'assignee' })) }
        : {}),
    };

    type CreateTaskResponse = { task: TaskRecord };
    const data = await this.http.request<CreateTaskResponse>('POST', '/open-apis/task/v2/tasks', { body });
    const task = data.task;
    return { taskId: (task['guid'] ?? task['task_id'] ?? '') as string, title: params.title };
  }

  async updateTask(taskId: string, params: {
    title?: string;
    dueDate?: string;
    assigneeIds?: string[];
    notes?: string;
  }): Promise<void> {
    const body: Record<string, unknown> = {};
    const update_fields: string[] = [];

    if (params.title !== undefined) { body['summary'] = params.title; update_fields.push('summary'); }
    if (params.notes !== undefined) { body['description'] = params.notes; update_fields.push('description'); }
    if (params.dueDate !== undefined) { body['due'] = { timestamp: String(Math.floor(new Date(params.dueDate).getTime() / 1000)), is_all_day: false }; update_fields.push('due'); }

    await this.http.request('PATCH', `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}`, {
      query: { update_fields: update_fields.join(',') },
      body,
    });
  }

  async completeTask(taskId: string): Promise<void> {
    await this.http.request('POST', `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}/complete`);
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.http.request('DELETE', `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}`);
  }

  async listTasks(params: { limit?: number; tasklist?: string }): Promise<Array<{ taskId: string; title: string; completed: boolean }>> {
    type ListResponse = { items?: TaskRecord[] };
    const data = await this.http.request<ListResponse>('GET', '/open-apis/task/v2/tasks', {
      query: {
        page_size: params.limit ?? 20,
        ...(params.tasklist ? { tasklist_id: params.tasklist } : {}),
      },
    });
    return (data.items ?? []).map(normalizeTask);
  }

  async getTask(taskId: string): Promise<{ taskId: string; title: string; completed: boolean; dueDate?: string }> {
    type GetResponse = { task: TaskRecord };
    const data = await this.http.request<GetResponse>('GET', `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}`);
    const task = data.task;
    const due = task['due'] as Record<string, unknown> | undefined;
    const dueDateStr = due ? new Date(Number(due['timestamp']) * 1000).toISOString() : undefined;
    return {
      taskId: (task['guid'] ?? task['task_id'] ?? taskId) as string,
      title: (task['summary'] ?? '') as string,
      completed: (task['completed'] ?? false) as boolean,
      ...(dueDateStr !== undefined ? { dueDate: dueDateStr } : {}),
    };
  }
}
