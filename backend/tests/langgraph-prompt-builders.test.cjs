const assert = require('node:assert/strict');
const test = require('node:test');

const { buildTier1Prompt, buildSupervisorPrompt } = require('../dist/company/orchestration/langgraph/supervisor-contract');
const { buildRoutePrompt } = require('../dist/company/orchestration/langgraph/route-contract');
const { buildPlanPrompt } = require('../dist/company/orchestration/langgraph/plan-contract');
const { buildSynthesisPrompt } = require('../dist/company/orchestration/langgraph/synthesis-contract');

test('LangGraph tier1 prompt uses Odin branding and JSON-only examples', () => {
  const prompt = buildTier1Prompt('hello there');
  assert.match(prompt, /Odin AI fast-path triage/i);
  assert.match(prompt, /Valid example:/i);
  assert.match(prompt, /Invalid example to avoid:/i);
  assert.match(prompt, /Return JSON only/i);
});

test('LangGraph supervisor prompt constrains next-agent decisions', () => {
  const prompt = buildSupervisorPrompt({
    messageText: 'find recent deals and summarize them',
    manifest: [{ key: 'response', description: 'general fallback' }],
    priorResults: [{ agentKey: 'response', status: 'success', summary: 'ok' }],
  });

  assert.match(prompt, /Odin AI orchestration supervisor/i);
  assert.match(prompt, /Call exactly one next agent or finish the task/i);
  assert.match(prompt, /Use only listed agent keys/i);
  assert.match(prompt, /Return JSON only/i);
});

test('LangGraph route prompt defines strict routing schema', () => {
  const prompt = buildRoutePrompt('show recent zoho deals');
  assert.match(prompt, /Required shape:/i);
  assert.match(prompt, /zoho_read\|write_intent\|general/i);
  assert.match(prompt, /Invalid example to avoid:/i);
});

test('LangGraph plan prompt defines executable step boundaries', () => {
  const prompt = buildPlanPrompt({
    messageText: 'delete this record',
    route: {
      intent: 'write_intent',
      complexityLevel: 4,
      executionMode: 'sequential',
      source: 'llm',
    },
  });

  assert.match(prompt, /route\.classify/i);
  assert.match(prompt, /agent\.invoke\.risk-check/i);
  assert.match(prompt, /synthesis\.compose/i);
});

test('LangGraph synthesis prompt is short and schema-bound', () => {
  const prompt = buildSynthesisPrompt({
    intent: 'general',
    messageText: 'summarize updates',
    agentResultsJson: '[{"agentKey":"response","status":"success"}]',
  });

  assert.match(prompt, /Required shape:/i);
  assert.match(prompt, /Lead with the answer and keep it concise/i);
  assert.match(prompt, /Invalid example to avoid:/i);
});
