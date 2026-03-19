const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RuntimeLoopGuards,
  createEmptyRuntimeDiagnostics,
  stableSerialize,
} = require('../dist/company/orchestration/langgraph/runtime.loop-guards');

test('stableSerialize is deterministic for object key order', () => {
  const left = stableSerialize({ b: 2, a: 1, nested: { z: 1, y: 2 } });
  const right = stableSerialize({ nested: { y: 2, z: 1 }, a: 1, b: 2 });
  assert.equal(left, right);
});

test('runtime loop guards block repeated tool calls past threshold', () => {
  const guards = new RuntimeLoopGuards({
    repeatedToolCall: 2,
    repeatedValidationFailure: 2,
    repeatedPlanHash: 2,
    repeatedDeliveryKey: 2,
  });
  const diagnostics = createEmptyRuntimeDiagnostics();

  const first = guards.registerToolCall(diagnostics, 'search-read', { q: 'langgraph' });
  const second = guards.registerToolCall(diagnostics, 'search-read', { q: 'langgraph' });
  const third = guards.registerToolCall(diagnostics, 'search-read', { q: 'langgraph' });

  assert.equal(first.blocked, false);
  assert.equal(second.blocked, false);
  assert.equal(third.blocked, true);
  assert.equal(third.reason, 'repeat_tool_call_limit');
});

