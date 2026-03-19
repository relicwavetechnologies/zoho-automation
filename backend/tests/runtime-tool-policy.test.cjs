const assert = require('node:assert/strict');
const test = require('node:test');

const { RuntimeToolPolicy } = require('../dist/company/orchestration/langgraph/runtime.tool-policy');

test('runtime tool policy allows read tool when tool and action are permitted', () => {
  const policy = new RuntimeToolPolicy();
  const result = policy.authorize({
    toolId: 'search-read',
    actionGroup: 'read',
    allowedToolIds: ['search-read'],
    allowedActionsByTool: { 'search-read': ['read'] },
    blockedToolIds: [],
    channel: 'lark',
    engineMode: 'primary',
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requiresApproval, false);
});

test('runtime tool policy blocks mutating actions in shadow mode', () => {
  const policy = new RuntimeToolPolicy();
  const result = policy.authorize({
    toolId: 'coding',
    actionGroup: 'execute',
    allowedToolIds: ['coding'],
    allowedActionsByTool: { coding: ['read', 'execute'] },
    blockedToolIds: [],
    channel: 'desktop',
    engineMode: 'shadow',
  });

  assert.equal(result.allowed, false);
  assert.match(result.failureReason, /shadow mode/i);
});

test('runtime tool policy requires approval for mutating primary actions', () => {
  const policy = new RuntimeToolPolicy();
  const result = policy.authorize({
    toolId: 'coding',
    actionGroup: 'update',
    allowedToolIds: ['coding'],
    allowedActionsByTool: { coding: ['read', 'update'] },
    blockedToolIds: [],
    channel: 'desktop',
    engineMode: 'primary',
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requiresApproval, true);
});

