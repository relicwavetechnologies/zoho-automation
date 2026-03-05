const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isHitlTerminalStatus,
  resolveHitlTransition,
} = require('../dist/company/orchestration/langgraph/hitl-state-machine');

test('hitl transition pending -> confirmed is allowed and terminal', () => {
  const result = resolveHitlTransition('pending', 'confirmed');
  assert.equal(result.allowed, true);
  assert.equal(result.terminal, true);
});

test('hitl transition pending -> cancelled is allowed and terminal', () => {
  const result = resolveHitlTransition('pending', 'cancelled');
  assert.equal(result.allowed, true);
  assert.equal(result.terminal, true);
});

test('hitl transition pending -> expired is allowed and terminal', () => {
  const result = resolveHitlTransition('pending', 'expired');
  assert.equal(result.allowed, true);
  assert.equal(result.terminal, true);
});

test('terminal status cannot transition again', () => {
  const result = resolveHitlTransition('confirmed', 'cancelled');
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'already_terminal');
});

test('terminal status helper marks cancelled and expired correctly', () => {
  assert.equal(isHitlTerminalStatus('cancelled'), true);
  assert.equal(isHitlTerminalStatus('expired'), true);
  assert.equal(isHitlTerminalStatus('pending'), false);
});
