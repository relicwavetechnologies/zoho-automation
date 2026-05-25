import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LarkTaskClient } from '../../src/infrastructure/channels/lark/clients/lark-task.client.ts';
import { LarkApiError } from '../../src/infrastructure/channels/lark/clients/lark-http.client.ts';
import { TOKEN_RESPONSE, buildMockFetch, errorMock } from '../helpers/mock-fetch.ts';

const DEPS = { appId: 'app1', appSecret: 'secret1' };

const TOKEN_HANDLER = {
  match: (url: string) => url.includes('tenant_access_token'),
  response: TOKEN_RESPONSE,
};

describe('LarkTaskClient', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // ── createTask ─────────────────────────────────────────────────────────────

  describe('createTask', () => {
    it('POSTs to /task/v2/tasks and returns taskId + title', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/task/v2/tasks'),
          response: { code: 0, data: { task: { guid: 'guid-abc', summary: 'Fix bug' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      const result = await client.createTask({ title: 'Fix bug' });

      assert.equal(result.taskId, 'guid-abc');
      assert.equal(result.title, 'Fix bug');
    });

    it('sends dueDate as millisecond timestamp in request body', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/task/v2/tasks'),
          response: { code: 0, data: { task: { guid: 'g1', summary: 'T' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      await client.createTask({ title: 'T', dueDate: '2025-12-31T00:00:00.000Z' });

      const apiCall = calls.find(c => c.method === 'POST' && (c.url as string).includes('/task/v2/tasks'));
      const body = apiCall?.body as Record<string, unknown>;
      assert.ok(body?.['due'], 'should include due field');
      const due = body['due'] as Record<string, unknown>;
      assert.equal(due['timestamp'], String(new Date('2025-12-31T00:00:00.000Z').getTime()));
      assert.equal(typeof due['timestamp'], 'string', 'timestamp should be a string');
    });

    it('omits due when dueDate is invalid', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/task/v2/tasks'),
          response: { code: 0, data: { task: { guid: 'g1', summary: 'T' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      await client.createTask({ title: 'T', dueDate: 'next Friday' });

      const apiCall = calls.find(c => c.method === 'POST' && (c.url as string).includes('/task/v2/tasks'));
      const body = apiCall?.body as Record<string, unknown>;
      assert.equal('due' in body, false);
    });

    it('sends assigneeIds as members array', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/task/v2/tasks'),
          response: { code: 0, data: { task: { guid: 'g1', summary: 'T' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      await client.createTask({ title: 'T', assigneeIds: ['uid1', 'uid2'] });

      const apiCall = calls.find(c => c.method === 'POST' && (c.url as string).includes('/task/v2/tasks'));
      const body = apiCall?.body as Record<string, unknown>;
      const members = body?.['members'] as unknown[];
      assert.equal(members?.length, 2);
    });

    it('throws LarkApiError on API error', async () => {
      globalThis.fetch = errorMock('task quota exceeded', 1234567);
      const client = new LarkTaskClient(DEPS);
      await assert.rejects(() => client.createTask({ title: 'T' }), LarkApiError);
    });
  });

  // ── updateTask ────────────────────────────────────────────────────────────

  describe('updateTask', () => {
    it('PATCHes the task and sends update_fields query param', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'PATCH' && url.includes('/task/v2/tasks/'),
          response: { code: 0, data: { task: { guid: 'task-1', summary: 'Updated' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      await client.updateTask('task-1', { title: 'Updated', notes: 'New notes' });

      const apiCall = calls.find(c => c.method === 'PATCH');
      assert.ok(apiCall?.url.includes('task-1'), 'URL should contain taskId');
      assert.ok(apiCall?.url.includes('update_fields'), 'should include update_fields param');
      const body = apiCall?.body as Record<string, unknown>;
      assert.equal(body?.['summary'], 'Updated');
      assert.ok(body?.['description'], 'should include description');
    });

    it('only sends fields that are provided', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'PATCH',
          response: { code: 0, data: { task: { guid: 't1' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      await client.updateTask('t1', { title: 'Only title' });

      const apiCall = calls.find(c => c.method === 'PATCH');
      const body = apiCall?.body as Record<string, unknown>;
      assert.ok('summary' in body, 'should have summary');
      assert.ok(!('description' in body), 'should NOT have description');
      assert.ok(!('due' in body), 'should NOT have due');
    });

    it('does not call update when only dueDate is invalid', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'PATCH',
          response: { code: 0, data: { task: { guid: 't1' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      await client.updateTask('t1', { dueDate: 'not an iso date' });

      const apiCall = calls.find(c => c.method === 'PATCH');
      assert.equal(apiCall, undefined);
    });
  });

  // ── completeTask ──────────────────────────────────────────────────────────

  describe('completeTask', () => {
    it('POSTs to /complete endpoint', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/complete'),
          response: { code: 0, data: {} },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      await client.completeTask('task-abc');

      const apiCall = calls.find(c => c.method === 'POST' && c.url.includes('/complete'));
      assert.ok(apiCall?.url.includes('task-abc'), 'should include taskId in URL');
    });

    it('throws on API error', async () => {
      globalThis.fetch = errorMock('task not found', 1470401);
      const client = new LarkTaskClient(DEPS);
      await assert.rejects(() => client.completeTask('missing'), LarkApiError);
    });
  });

  // ── deleteTask ────────────────────────────────────────────────────────────

  describe('deleteTask', () => {
    it('sends DELETE to /task/v2/tasks/{id}', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: (url, m) => m === 'DELETE', response: { code: 0, data: {} } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      await client.deleteTask('task-del');

      const apiCall = calls.find(c => c.method === 'DELETE');
      assert.ok(apiCall?.url.includes('task-del'));
    });
  });

  // ── listTasks ─────────────────────────────────────────────────────────────

  describe('listTasks', () => {
    it('GETs tasks and maps to simplified shape', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes('/task/v2/tasks') && !url.includes('/tasks/'),
          response: {
            code: 0,
            data: {
              items: [
                { task_id: 't1', guid: 'g1', summary: 'Task one', completed: false },
                { task_id: 't2', guid: 'g2', summary: 'Task two', completed: true },
              ],
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      const tasks = await client.listTasks({ limit: 10 });

      assert.equal(tasks.length, 2);
      assert.equal(tasks[0]?.title, 'Task one');
      assert.equal(tasks[0]?.completed, false);
      assert.equal(tasks[1]?.title, 'Task two');
      assert.equal(tasks[1]?.completed, true);
    });

    it('passes page_size query param', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes('/task/v2/tasks'),
          response: { code: 0, data: { items: [] } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      await client.listTasks({ limit: 42 });

      const apiCall = calls.find(c => c.url.includes('page_size=42'));
      assert.ok(apiCall, 'should pass page_size=42');
    });

    it('passes tasklist_id when provided', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: { items: [] } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      await client.listTasks({ tasklist: 'tl-xyz' });

      const apiCall = calls.find(c => c.url.includes('tasklist_id=tl-xyz'));
      assert.ok(apiCall, 'should include tasklist_id param');
    });

    it('returns empty array when no items', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: {} } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      const tasks = await client.listTasks({});
      assert.deepEqual(tasks, []);
    });
  });

  // ── getTask ───────────────────────────────────────────────────────────────

  describe('getTask', () => {
    it('GETs /task/v2/tasks/{id} and returns normalized task', async () => {
      const dueTimestamp = new Date('2025-06-01').getTime();
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes('/task/v2/tasks/task-99'),
          response: {
            code: 0,
            data: {
              task: {
                guid: 'task-99',
                summary: 'Big task',
                completed: false,
                due: { timestamp: String(dueTimestamp), is_all_day: false },
              },
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      const task = await client.getTask('task-99');

      assert.equal(task.taskId, 'task-99');
      assert.equal(task.title, 'Big task');
      assert.equal(task.completed, false);
      assert.ok(task.dueDate?.startsWith('2025-06'), 'dueDate should be ISO string for June 2025');
    });

    it('returns no dueDate when due timestamp is invalid', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes('/task/v2/tasks/task-99'),
          response: {
            code: 0,
            data: {
              task: {
                guid: 'task-99',
                summary: 'Big task',
                completed: false,
                due: { timestamp: 'NaN', is_all_day: false },
              },
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      const task = await client.getTask('task-99');

      assert.equal(task.dueDate, undefined);
    });

    it('returns no dueDate when due is absent', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: () => true,
          response: { code: 0, data: { task: { guid: 'g1', summary: 'S', completed: false } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      const task = await client.getTask('g1');
      assert.equal(task.dueDate, undefined);
    });

    it('URL-encodes taskId in path', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: { task: { guid: 'id/slash', summary: '' } } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkTaskClient(DEPS);
      await client.getTask('id/slash');

      const apiCall = calls.find(c => c.url.includes('task/v2/tasks'));
      assert.ok(apiCall?.url.includes('id%2Fslash'), 'should URL-encode taskId');
    });
  });
});
