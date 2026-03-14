const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseDirectCreateTaskIntent,
  parseDirectReassignTaskIntent,
  parseDirectTaskStatusIntent,
} = require('../dist/company/integrations/mastra/tools/lark-task-agent-intent');

test('parseDirectCreateTaskIntent extracts summary and short assignee name', () => {
  const result = parseDirectCreateTaskIntent('Create a Lark task called "prepare CRM handoff" and assign it to Anish');

  assert.deepEqual(result, {
    summary: 'prepare CRM handoff',
    assigneeNames: ['Anish'],
    assignToMe: false,
  });
});

test('parseDirectCreateTaskIntent maps self-assignment to assignToMe', () => {
  const result = parseDirectCreateTaskIntent('Create a task called "review onboarding flow" and assign it to me');

  assert.deepEqual(result, {
    summary: 'review onboarding flow',
    assigneeNames: [],
    assignToMe: true,
  });
});

test('parseDirectCreateTaskIntent supports multiple assignees', () => {
  const result = parseDirectCreateTaskIntent('Create a new task called "test assignment flow" and assign it to Anish and me');

  assert.deepEqual(result, {
    summary: 'test assignment flow',
    assigneeNames: ['Anish'],
    assignToMe: true,
  });
});

test('parseDirectReassignTaskIntent extracts task id and assignee', () => {
  const result = parseDirectReassignTaskIntent('Assign task t114863 to Anish again');

  assert.deepEqual(result, {
    taskRef: 't114863',
    assigneeNames: ['Anish'],
    assignToMe: false,
  });
});

test('parseDirectReassignTaskIntent extracts quoted task name', () => {
  const result = parseDirectReassignTaskIntent('Assign task "improve orchestration" to Anish');

  assert.deepEqual(result, {
    taskRef: 'improve orchestration',
    assigneeNames: ['Anish'],
    assignToMe: false,
  });
});

test('parseDirectTaskStatusIntent resolves follow-up completion without explicit task id', () => {
  const result = parseDirectTaskStatusIntent('Now mark this task done.');

  assert.deepEqual(result, {
    completed: true,
  });
});

test('parseDirectTaskStatusIntent extracts explicit task id for completion', () => {
  const result = parseDirectTaskStatusIntent('Mark task t114863 done');

  assert.deepEqual(result, {
    taskRef: 't114863',
    completed: true,
  });
});
