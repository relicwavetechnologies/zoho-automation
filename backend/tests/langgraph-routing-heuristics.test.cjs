const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPlanFromIntent,
  classifyComplexityLevel,
  detectRouteIntent,
  requiresHumanConfirmation,
} = require('../dist/company/orchestration/routing-heuristics');

test('detectRouteIntent classifies zoho reads and write intents', () => {
  assert.equal(detectRouteIntent('show zoho deals for this month'), 'zoho_read');
  assert.equal(detectRouteIntent('please delete this workspace'), 'write_intent');
  assert.equal(detectRouteIntent('summarize team updates'), 'general');
});

test('classifyComplexityLevel escalates write and workflow requests', () => {
  assert.equal(classifyComplexityLevel('delete this'), 4);
  assert.equal(classifyComplexityLevel('create onboarding workflow for sales'), 3);
  assert.equal(classifyComplexityLevel('hi'), 1);
});

test('buildPlanFromIntent returns deterministic fallback plans', () => {
  assert.deepEqual(buildPlanFromIntent('zoho_read', 2, 'read zoho contacts'), [
    'route.classify',
    'agent.invoke.zoho-read',
    'agent.invoke.lark-response',
    'synthesis.compose',
  ]);
  assert.deepEqual(buildPlanFromIntent('general', 2, 'force unknown_agent now'), [
    'route.classify',
    'agent.invoke.unknown',
    'synthesis.compose',
  ]);
  assert.deepEqual(buildPlanFromIntent('write_intent', 4, 'delete this zoho ticket'), [
    'route.classify',
    'agent.invoke.risk-check',
    'agent.invoke.zoho-action',
    'agent.invoke.lark-response',
    'synthesis.compose',
  ]);
  assert.deepEqual(buildPlanFromIntent('general', 2, 'search example.com pricing and latest updates'), [
    'route.classify',
    'agent.invoke.search-read',
    'agent.invoke.lark-response',
    'synthesis.compose',
  ]);
});

test('requiresHumanConfirmation protects destructive operations', () => {
  assert.equal(requiresHumanConfirmation('remove this deal now'), true);
  assert.equal(requiresHumanConfirmation('show last five deals'), false);
});
