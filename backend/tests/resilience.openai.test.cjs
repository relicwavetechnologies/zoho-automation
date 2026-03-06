const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const {
  openAiOrchestrationModels,
} = require('../dist/company/orchestration/langchain/openai-models');
const {
  resolveRouteContract,
} = require('../dist/company/orchestration/langgraph/route-contract');
const {
  resolveSynthesisContract,
} = require('../dist/company/orchestration/langgraph/synthesis-contract');

test('resilience(openai): invocation failures return null instead of throwing', async () => {
  const originalEnabled = openAiOrchestrationModels.enabled;
  const originalCache = openAiOrchestrationModels.modelCache;

  try {
    openAiOrchestrationModels.enabled = true;
    openAiOrchestrationModels.modelCache = new Map([
      [
        'router',
        {
          invoke: async () => {
            throw new Error('OpenAI service unavailable');
          },
        },
      ],
    ]);

    const output = await openAiOrchestrationModels.invokePrompt('router', 'classify this');
    assert.equal(output, null);
  } finally {
    openAiOrchestrationModels.enabled = originalEnabled;
    openAiOrchestrationModels.modelCache = originalCache;
  }
});

test('resilience(openai): route contract uses deterministic fallback when llm output is missing', () => {
  const result = resolveRouteContract({
    rawLlmOutput: null,
    messageText: 'show my zoho contacts',
  });

  assert.equal(result.source, 'heuristic_fallback');
  assert.equal(result.route.source, 'heuristic_fallback');
  assert.equal(result.route.intent, 'zoho_read');
  assert.equal(result.fallbackReasonCode, 'llm_empty');
});

test('resilience(openai): synthesis contract falls back deterministically when llm output is invalid', () => {
  const result = resolveSynthesisContract({
    rawLlmOutput: '{"text": "", "taskStatus": "done"}',
    deterministicFallback: {
      text: 'Fallback answer from deterministic path.',
      taskStatus: 'done',
    },
  });

  assert.equal(result.source, 'deterministic_fallback');
  assert.equal(result.synthesis.text, 'Fallback answer from deterministic path.');
  assert.equal(result.validationErrors.length > 0, true);
});
