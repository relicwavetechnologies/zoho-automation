import type { LarkTaskClientPort } from '../../../../application/orchestration/tools/families/lark-task.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type TaskRecord = Record<string, unknown>;

const normalizeTask = (r: TaskRecord): { taskId: string; title: string; completed: boolean } => ({
  taskId:    (r['task_id'] ?? r['guid'] ?? r['id'] ?? '') as string,
  title:     (r['summary'] ?? r['title'] ?? '') as string,
  completed: (r['completed_at'] ? true : (r['status'] === 'completed')) || ((r['completed'] ?? r['done'] ?? false) as boolean),
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
    const body: Record<string, unknown> = {
      summary: params.title,
      ...(params.notes    ? { description: params.notes } : {}),
      ...(due             ? { due } : {}),
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
    if (params.title     !== undefined) { body['summary']     = params.title;                      update_fields.push('summary'); }
    if (params.notes     !== undefined) { body['description'] = params.notes;                      update_fields.push('description'); }
    if (params.dueDate !== undefined) {
      const due = toTimestamp(params.dueDate);
      if (due) {
        body['due'] = due;
        update_fields.push('due');
      }
    }
    if (params.assigneeIds !== undefined) {
      body['members'] = params.assigneeIds.map(id => ({ id, type: 'user', role: 'assignee' }));
      update_fields.push('members');
    }
    if (update_fields.length === 0) return;
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

  async listTasks(params: {
    limit?: number;
    tasklist?: string;
    assigneeOpenId?: string;
    completed?: boolean;
  }): Promise<Array<{ taskId: string; title: string; completed: boolean; dueDate?: string }>> {
    type ListResponse = { items?: TaskRecord[] };
    const pageSize = Math.min(params.limit ?? 50, 100);
    const data = await this.http.request<ListResponse>('GET', '/open-apis/task/v2/tasks', {
      query: {
        page_size: pageSize,
        ...(params.tasklist ? { tasklist_id: params.tasklist } : {}),
      },
    });

    let tasks = (data.items ?? []);

    if (params.completed !== undefined) {
      tasks = tasks.filter(t => {
        const done = (t['completed_at'] as string | undefined)
          ? true
          : (t['status'] as string | undefined) === 'completed';
        return params.completed ? done : !done;
      });
    }

    if (params.assigneeOpenId) {
      const uid = params.assigneeOpenId.toLowerCase();
      tasks = tasks.filter(t => taskHasMember(t, uid));
    }

    return tasks.map(t => {
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
      completed: (task['completed'] ?? false) as boolean,
      ...(dueDateStr !== undefined ? { dueDate: dueDateStr } : {}),
    };
  }

  async listTasklists(): Promise<Array<{ guid: string; name: string }>> {
    type ListResponse = { items?: Array<Record<string, unknown>> };
    const data = await this.http.request<ListResponse>('GET', '/open-apis/task/v2/tasklists');
    return (data.items ?? []).map(t => ({
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
      `/open-apis/task/v2/tasklists/${encodeURIComponent(tasklistGuid)}/tasks/add`,
      { body: { tasks: [{ guid: taskGuid }] } },
    );
  }

  async removeTaskFromTasklist(tasklistGuid: string, taskGuid: string): Promise<void> {
    await this.http.request(
      'POST',
      `/open-apis/task/v2/tasklists/${encodeURIComponent(tasklistGuid)}/tasks/remove`,
      { body: { tasks: [{ guid: taskGuid }] } },
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
