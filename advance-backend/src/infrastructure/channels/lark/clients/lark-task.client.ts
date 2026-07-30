import type { LarkTaskClientPort } from '../../../../application/tools/families/lark-task.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type TaskRecord = Record<string, unknown>;

function isTaskCompleted(r: TaskRecord): boolean {
  const completedAt = String(r['completed_at'] ?? '0');
  if (completedAt !== '0' && completedAt !== '' && completedAt !== 'undefined') return true;
  if (String(r['status']).toLowerCase() === 'completed') return true;
  return (r['completed'] ?? r['done'] ?? false) as boolean;
}

const normalizeTask = (r: TaskRecord): { taskId: string; title: string; completed: boolean } => ({
  taskId:    (r['task_id'] ?? r['guid'] ?? r['id'] ?? '') as string,
  title:     (r['summary'] ?? r['title'] ?? '') as string,
  completed: isTaskCompleted(r),
});

const toTimestamp = (iso: string): { timestamp: string; is_all_day: false } | undefined => {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return undefined;
  return { timestamp: String(ms), is_all_day: false };
};

const normalizeDueDate = (due: Record<string, unknown> | undefined): string | undefined => {
  if (!due) return undefined;
  const ms = Number(due['timestamp']);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
};

function taskHasMember(task: TaskRecord, openIdLower: string): boolean {
  const members = (task['members'] as Array<Record<string, unknown>> | undefined) ?? [];
  for (const m of members) {
    const id = ((m['id'] as string) ?? '').toLowerCase();
    if (id === openIdLower) return true;
  }
  const creator = ((task['creator'] as Record<string, unknown>)?.['id'] as string ?? '').toLowerCase();
  return creator === openIdLower;
}

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
    const due = params.dueDate ? toTimestamp(params.dueDate) : undefined;
    const members = [
      ...(params.assigneeIds ?? []).map(id => ({ id, type: 'user', role: 'assignee' })),
      ...(params.followerIds ?? []).map(id => ({ id, type: 'user', role: 'follower' })),
    ];
    const body: Record<string, unknown> = {
      summary: params.title,
      ...(params.notes    ? { description: params.notes } : {}),
      ...(due             ? { due } : {}),
      ...(members.length ? { members } : {}),
      ...(params.tasklist ? { tasklists: [{ tasklist_guid: params.tasklist }] } : {}),
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
    const task: Record<string, unknown> = {};
    const updateFields: string[] = [];
    if (params.title     !== undefined) { task['summary']     = params.title;                      updateFields.push('summary'); }
    if (params.notes     !== undefined) { task['description'] = params.notes;                      updateFields.push('description'); }
    if (params.dueDate !== undefined) {
      const due = toTimestamp(params.dueDate);
      if (due) {
        task['due'] = due;
        updateFields.push('due');
      }
    }
    if (params.assigneeIds !== undefined) {
      task['members'] = params.assigneeIds.map(id => ({ id, type: 'user', role: 'assignee' }));
      updateFields.push('members');
    }
    if (updateFields.length === 0) return;
    await this.http.request('PATCH', `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}`, {
      body: { task, update_fields: updateFields },
    });
  }

  async completeTask(taskId: string): Promise<void> {
    await this.http.request('PATCH', `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}`, {
      body: {
        task: { completed_at: String(Date.now()) },
        update_fields: ['completed_at'],
      },
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.http.request('DELETE', `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}`);
  }

  async listTasks(params: {
    limit?: number;
    tasklist?: string;
    assigneeOpenId?: string;
    completed?: boolean;
  }): Promise<Array<{ taskId: string; title: string; completed: boolean; dueDate?: string }>> {
    type ListResponse = { items?: TaskRecord[]; page_token?: string; has_more?: boolean };

    // Collect tasks across all tasklists (like legacy), or from a specific one.
    const limit = params.limit ?? 50;
    const seen = new Map<string, TaskRecord>();
    const collect = async (tasklistId?: string) => {
      let pageToken: string | undefined;
      do {
        const data = await this.http.request<ListResponse>(
          'GET',
          tasklistId
            ? `/open-apis/task/v2/tasklists/${encodeURIComponent(tasklistId)}/tasks`
            : '/open-apis/task/v2/tasks',
          {
            query: {
              page_size: Math.min(100, Math.max(1, limit - seen.size)),
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          },
        );
        for (const item of (data.items ?? [])) {
          const key = (item['guid'] ?? item['task_id'] ?? item['id'] ?? '') as string;
          if (key) seen.set(key, item);
        }
        pageToken = data.has_more && seen.size < limit ? data.page_token : undefined;
      } while (pageToken && seen.size < limit);
    };

    if (params.tasklist) {
      await collect(params.tasklist);
    } else {
      // First try without tasklist filter
      await collect();
      // If empty, iterate all tasklists to find tasks
      if (seen.size === 0) {
        type TLResponse = { items?: Array<Record<string, unknown>> };
        const tlData = await this.http.request<TLResponse>('GET', '/open-apis/task/v2/tasklists', {
          query: { page_size: 50 },
        });
        for (const tl of (tlData.items ?? [])) {
          const tlId = tl['guid'] as string;
          if (tlId && seen.size < limit) await collect(tlId);
        }
      }
    }

    let tasks = Array.from(seen.values());

    if (params.completed !== undefined) {
      tasks = tasks.filter(t => {
        const done = isTaskCompleted(t);
        return params.completed ? done : !done;
      });
    }

    if (params.assigneeOpenId) {
      const uid = params.assigneeOpenId.toLowerCase();
      tasks = tasks.filter(t => taskHasMember(t, uid));
    }

    return tasks.slice(0, limit).map(t => {
      const base = normalizeTask(t);
      const due = t['due'] as Record<string, unknown> | undefined;
      const dueDate = normalizeDueDate(due);
      return dueDate ? { ...base, dueDate } : base;
    });
  }

  async getTask(taskId: string): Promise<{ taskId: string; title: string; completed: boolean; dueDate?: string }> {
    type GetResponse = { task: TaskRecord };
    const data = await this.http.request<GetResponse>('GET', `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}`);
    const task = data.task;
    const due = task['due'] as Record<string, unknown> | undefined;
    const dueDateStr = normalizeDueDate(due);
    return {
      taskId:    (task['guid'] ?? task['task_id'] ?? taskId) as string,
      title:     (task['summary'] ?? '') as string,
      completed: isTaskCompleted(task),
      ...(dueDateStr !== undefined ? { dueDate: dueDateStr } : {}),
    };
  }

  async listTasklists(): Promise<Array<{ guid: string; name: string }>> {
    type ListResponse = { items?: Array<Record<string, unknown>>; page_token?: string; has_more?: boolean };
    const items: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;
    do {
      const data = await this.http.request<ListResponse>('GET', '/open-apis/task/v2/tasklists', {
        query: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      });
      items.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return items.map(t => ({
      guid: t['guid'] as string ?? '',
      name: t['name'] as string ?? '',
    }));
  }

  async createTasklist(name: string, memberIds?: string[]): Promise<{ guid: string; name: string }> {
    type CreateResponse = { tasklist: Record<string, unknown> };
    const data = await this.http.request<CreateResponse>('POST', '/open-apis/task/v2/tasklists', {
      body: {
        name,
        ...(memberIds?.length
          ? { members: memberIds.map(id => ({ id, type: 'user', role: 'editor' })) }
          : {}),
      },
    });
    return {
      guid: data.tasklist['guid'] as string ?? '',
      name: data.tasklist['name'] as string ?? name,
    };
  }

  async addTaskToTasklist(tasklistGuid: string, taskGuid: string): Promise<void> {
    await this.http.request(
      'POST',
      `/open-apis/task/v2/tasks/${encodeURIComponent(taskGuid)}/add_tasklist`,
      { body: { tasklist_guid: tasklistGuid } },
    );
  }

  async removeTaskFromTasklist(tasklistGuid: string, taskGuid: string): Promise<void> {
    await this.http.request(
      'POST',
      `/open-apis/task/v2/tasks/${encodeURIComponent(taskGuid)}/remove_tasklist`,
      { body: { tasklist_guid: tasklistGuid } },
    );
  }

  async listSubtasks(taskId: string): Promise<Array<{ taskId: string; title: string; completed: boolean }>> {
    type ListResponse = { items?: TaskRecord[] };
    const data = await this.http.request<ListResponse>(
      'GET',
      `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}/subtasks`,
    );
    return (data.items ?? []).map(normalizeTask);
  }

  async createSubtask(parentTaskId: string, params: {
    title: string;
    assigneeIds?: string[];
    dueDate?: string;
    notes?: string;
  }): Promise<{ taskId: string; title: string }> {
    const due = params.dueDate ? toTimestamp(params.dueDate) : undefined;
    const body: Record<string, unknown> = {
      summary: params.title,
      ...(params.notes   ? { description: params.notes } : {}),
      ...(due            ? { due } : {}),
      ...(params.assigneeIds?.length
        ? { members: params.assigneeIds.map(id => ({ id, type: 'user', role: 'assignee' })) }
        : {}),
    };
    type CreateResponse = { task: TaskRecord };
    const data = await this.http.request<CreateResponse>(
      'POST',
      `/open-apis/task/v2/tasks/${encodeURIComponent(parentTaskId)}/subtasks`,
      { body },
    );
    return {
      taskId: (data.task['guid'] ?? data.task['task_id'] ?? '') as string,
      title:  params.title,
    };
  }
}
