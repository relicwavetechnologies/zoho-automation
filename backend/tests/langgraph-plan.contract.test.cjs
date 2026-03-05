const assert = require('node:assert/strict');
const test = require('node:test');

const { resolvePlanContract } = require('../dist/company/orchestration/langgraph/plan-contract');

const baseRoute = {
  intent: 'general',
  complexityLevel: 2,
  executionMode: 'sequential',
};

test('plan contract accepts valid executable plan', () => {
  const result = resolvePlanContract({
    rawLlmOutput: JSON.stringify({
      plan: ['route.classify', 'agent.invoke.response', 'synthesis.compose'],
    }),
    route: baseRoute,
    messageText: 'summarize updates',
  });

  assert.equal(result.source, 'llm');
  assert.deepEqual(result.validationErrors, []);
  assert.deepEqual(result.plan, ['route.classify', 'agent.invoke.response', 'synthesis.compose']);
});

test('plan contract falls back when unknown step is present', () => {
  const result = resolvePlanContract({
    rawLlmOutput: JSON.stringify({
      plan: ['route.classify', 'custom.step', 'synthesis.compose'],
    }),
    route: baseRoute,
    messageText: 'summarize updates',
  });

  assert.equal(result.source, 'fallback');
  assert.ok(result.validationErrors.some((entry) => entry.includes('unknown step')));
});

test('plan contract falls back when ordering is invalid', () => {
  const result = resolvePlanContract({
    rawLlmOutput: JSON.stringify({
      plan: ['agent.invoke.response', 'route.classify', 'synthesis.compose'],
    }),
    route: baseRoute,
    messageText: 'summarize updates',
  });

  assert.equal(result.source, 'fallback');
  assert.ok(result.validationErrors.some((entry) => entry.includes('must start')));
});

test('plan contract falls back when no agent step exists', () => {
  const result = resolvePlanContract({
    rawLlmOutput: JSON.stringify({
      plan: ['route.classify', 'synthesis.compose'],
    }),
    route: baseRoute,
    messageText: 'summarize updates',
  });

  assert.equal(result.source, 'fallback');
  assert.ok(result.validationErrors.some((entry) => entry.includes('at least one agent.invoke')));
});

test('plan contract fallback for write intent includes risk-check safety agent', () => {
  const result = resolvePlanContract({
    rawLlmOutput: JSON.stringify({
      plan: ['route.classify', 'agent.invoke.response', 'synthesis.compose'],
    }),
    route: {
      intent: 'write_intent',
      complexityLevel: 4,
      executionMode: 'sequential',
    },
    messageText: 'delete this record',
  });

  assert.equal(result.source, 'fallback');
  assert.ok(result.plan.includes('agent.invoke.risk-check'));
  assert.ok(result.validationErrors.some((entry) => entry.includes('risk-check')));
});
