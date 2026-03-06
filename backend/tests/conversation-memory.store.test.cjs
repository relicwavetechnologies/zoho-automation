const assert = require('node:assert/strict');
const test = require('node:test');

const { conversationMemoryStore: defaultStore } = require('../dist/company/state/conversation/conversation-memory.store');

test('conversation memory keeps user+assistant turns in order', () => {
  const key = `test:chat:${Date.now()}:1`;
  defaultStore.addUserMessage(key, 'msg_1', 'hello');
  defaultStore.addAssistantMessage(key, 'task_1', 'hi there');
  defaultStore.addUserMessage(key, 'msg_2', 'show deals');

  const context = defaultStore.getContextMessages(key, 10);
  assert.equal(context.length, 3);
  assert.deepEqual(
    context.map((entry) => entry.role),
    ['user', 'assistant', 'user'],
  );
});

test('conversation memory dedupes duplicate message/task ids', () => {
  const key = `test:chat:${Date.now()}:2`;
  defaultStore.addUserMessage(key, 'msg_same', 'hello');
  defaultStore.addUserMessage(key, 'msg_same', 'hello');
  defaultStore.addAssistantMessage(key, 'task_same', 'done');
  defaultStore.addAssistantMessage(key, 'task_same', 'done');

  const context = defaultStore.getContextMessages(key, 10);
  assert.equal(context.length, 2);
});
