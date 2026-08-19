import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  readOpenTasks,
  type OpenTasksDeps,
} from '../../src/application/work/open-tasks';

type Task = { taskId: string; title: string; completed: boolean; dueDate?: string };

/** A member with a Lark account, a working token, and these tasks. */
function deps(tasks: Task[], over: Partial<OpenTasksDeps> = {}): OpenTasksDeps {
  return {
    accounts: { openIdFor: async () => 'ou_abc' },
    tokens: { resolve: async () => 'user-token' },
    createClient: () => ({ listTasks: async () => tasks }),
    ...over,
  };
}

const NOW = new Date('2026-08-16T09:00:00Z');

describe('what is waiting on a member', () => {
  test('tells apart having no tasks from having no Lark account', async () => {
    /* The distinction the whole return type exists for. Both are an empty list
       to a caller that only gets an array, and only one of them is worth saying
       out loud — the other is somebody who is simply up to date. */
    const none = await readOpenTasks(deps([]), { userId: 'u1', companyId: 'c1', now: NOW });
    assert.deepEqual(none, { status: 'ok', tasks: [] });

    const unlinked = await readOpenTasks(
      deps([], { accounts: { openIdFor: async () => null } }),
      { userId: 'u1', companyId: 'c1', now: NOW },
    );
    assert.deepEqual(unlinked, { status: 'no_lark_identity' });

    const unauthorized = await readOpenTasks(
      deps([], { tokens: { resolve: async () => null } }),
      { userId: 'u1', companyId: 'c1', now: NOW },
    );
    assert.deepEqual(unauthorized, { status: 'not_connected' });
  });

  test('never reads tasks with more than read access', async () => {
    /* A panel that lists your work must not hold a credential that could
       finish it. The access level is fixed here rather than passed in, so no
       caller can widen it. */
    const asked: string[] = [];
    await readOpenTasks(
      deps([], { tokens: { resolve: async (input) => { asked.push(input.minimumAccess); return 't'; } } }),
      { userId: 'u1', companyId: 'c1', now: NOW },
    );
    assert.deepEqual(asked, ['read_only']);
  });

  test('asks Lark for this member only, and only for open work', async () => {
    let seen: { assigneeOpenId?: string; completed?: boolean; limit?: number } = {};
    await readOpenTasks(
      deps([], {
        createClient: () => ({
          listTasks: async (params) => { seen = params; return []; },
        }),
      }),
      { userId: 'u1', companyId: 'c1', now: NOW },
    );
    assert.equal(seen.assigneeOpenId, 'ou_abc');
    assert.equal(seen.completed, false);
  });

  test('orders by what is actually pressing', async () => {
    /* Lark answers in creation order, which puts a task due tomorrow underneath
       one with no date at all. Undated work sorts last: an absent deadline is
       the weakest claim on someone's attention, not the strongest. */
    const reading = await readOpenTasks(
      deps([
        { taskId: '1', title: 'Undated', completed: false },
        { taskId: '2', title: 'Next week', completed: false, dueDate: '2026-08-23' },
        { taskId: '3', title: 'Was due Friday', completed: false, dueDate: '2026-08-14' },
        { taskId: '4', title: 'Due today', completed: false, dueDate: '2026-08-16' },
      ]),
      { userId: 'u1', companyId: 'c1', now: NOW },
    );

    assert.equal(reading.status, 'ok');
    if (reading.status !== 'ok') return;
    assert.deepEqual(reading.tasks.map((t) => t.title), [
      'Was due Friday', 'Due today', 'Next week', 'Undated',
    ]);
  });

  test('does not call a task overdue on the day it is due', async () => {
    /* It is nine in the morning. Comparing an ISO date against a timestamp
       would mark today's work late for all but the first instant of the day. */
    const reading = await readOpenTasks(
      deps([
        { taskId: '1', title: 'Due today', completed: false, dueDate: '2026-08-16' },
        { taskId: '2', title: 'Due yesterday', completed: false, dueDate: '2026-08-15' },
        { taskId: '3', title: 'Undated', completed: false },
      ]),
      { userId: 'u1', companyId: 'c1', now: NOW },
    );

    assert.equal(reading.status, 'ok');
    if (reading.status !== 'ok') return;
    assert.deepEqual(
      reading.tasks.map((t) => [t.title, t.overdue]),
      [['Due yesterday', true], ['Due today', false], ['Undated', false]],
    );
  });

  test('drops anything already finished, whatever Lark returned', async () => {
    // The client is asked for open tasks, but the panel must not show a
    // completed one if that filter ever stops holding upstream.
    const reading = await readOpenTasks(
      deps([
        { taskId: '1', title: 'Done', completed: true },
        { taskId: '2', title: 'Open', completed: false },
      ]),
      { userId: 'u1', companyId: 'c1', now: NOW },
    );
    assert.equal(reading.status, 'ok');
    if (reading.status !== 'ok') return;
    assert.deepEqual(reading.tasks.map((t) => t.title), ['Open']);
  });

  test('caps the list however much is asked for', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      taskId: String(i), title: `Task ${String(i).padStart(2, '0')}`, completed: false,
    }));
    const reading = await readOpenTasks(deps(many), {
      userId: 'u1', companyId: 'c1', limit: 500, now: NOW,
    });
    assert.equal(reading.status, 'ok');
    if (reading.status !== 'ok') return;
    assert.equal(reading.tasks.length, 25);
  });
});
