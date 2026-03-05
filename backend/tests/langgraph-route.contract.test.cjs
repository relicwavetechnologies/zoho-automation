const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveRouteContract } = require('../dist/company/orchestration/langgraph/route-contract');

const assertValidTuple = (route) => {
  assert.ok(['zoho_read', 'write_intent', 'general'].includes(route.intent));
  assert.ok([1, 2, 3, 4, 5].includes(route.complexityLevel));
  assert.ok(['sequential', 'parallel', 'mixed'].includes(route.executionMode));
};

test('route contract accepts valid JSON output', () => {
  const result = resolveRouteContract({
    rawLlmOutput: JSON.stringify({
      intent: 'zoho_read',
      complexityLevel: 3,
      executionMode: 'sequential',
    }),
    messageText: 'show zoho deals',
  });

  assert.equal(result.source, 'llm');
  assert.equal(result.route.source, 'llm');
  assert.equal(result.route.intent, 'zoho_read');
  assert.equal(result.route.complexityLevel, 3);
  assert.equal(result.route.executionMode, 'sequential');
});

test('route contract falls back for non-json output', () => {
  const result = resolveRouteContract({
    rawLlmOutput: 'not-json',
    messageText: 'please delete this',
  });

  assert.equal(result.source, 'heuristic_fallback');
  assert.equal(result.fallbackReasonCode, 'llm_non_json');
  assert.equal(result.route.source, 'heuristic_fallback');
  assert.equal(result.route.intent, 'write_intent');
  assertValidTuple(result.route);
});

test('route contract falls back for invalid enum values', () => {
  const result = resolveRouteContract({
    rawLlmOutput: JSON.stringify({
      intent: 'invalid_intent',
      complexityLevel: 2,
      executionMode: 'sequential',
    }),
    messageText: 'help me summarize notes',
  });

  assert.equal(result.source, 'heuristic_fallback');
  assert.equal(result.fallbackReasonCode, 'llm_invalid_enum');
  assertValidTuple(result.route);
});

test('route contract falls back for invalid complexity range', () => {
  const result = resolveRouteContract({
    rawLlmOutput: JSON.stringify({
      intent: 'general',
      complexityLevel: 9,
      executionMode: 'sequential',
    }),
    messageText: 'hello team',
  });

  assert.equal(result.source, 'heuristic_fallback');
  assert.equal(result.fallbackReasonCode, 'llm_invalid_range');
  assertValidTuple(result.route);
});

test('route contract falls back for empty model output and always returns valid tuple', () => {
  const result = resolveRouteContract({
    rawLlmOutput: '   ',
    messageText: 'show contacts in zoho',
  });

  assert.equal(result.source, 'heuristic_fallback');
  assert.equal(result.fallbackReasonCode, 'llm_empty');
  assert.equal(result.route.intent, 'zoho_read');
  assertValidTuple(result.route);
});
