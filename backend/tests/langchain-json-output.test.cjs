const assert = require('node:assert/strict');
const test = require('node:test');

const { extractJsonObject } = require('../dist/company/orchestration/langchain/json-output');

test('extractJsonObject parses direct JSON object strings', () => {
  const parsed = extractJsonObject('{"intent":"general","complexityLevel":2}');
  assert.deepEqual(parsed, { intent: 'general', complexityLevel: 2 });
});

test('extractJsonObject parses fenced markdown JSON', () => {
  const parsed = extractJsonObject('```json\n{"plan":["route.classify","synthesis.compose"]}\n```');
  assert.deepEqual(parsed, { plan: ['route.classify', 'synthesis.compose'] });
});

test('extractJsonObject returns null on invalid/non-object payloads', () => {
  assert.equal(extractJsonObject('not json at all'), null);
  assert.equal(extractJsonObject('["array"]'), null);
});
