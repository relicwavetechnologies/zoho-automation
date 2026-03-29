import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlanFromIntent,
  classifyComplexityLevel,
  detectRouteIntent,
  requiresHumanConfirmation,
} from '../src/company/orchestration/routing-heuristics';

test('invoice email requests route through the books action path', () => {
  const text = 'email me all my invoices';
  const intent = detectRouteIntent(text);
  const complexity = classifyComplexityLevel(text);
  const plan = buildPlanFromIntent(intent, complexity, text);

  assert.equal(intent, 'write_intent');
  assert.equal(complexity, 4);
  assert.equal(requiresHumanConfirmation(text), true);
  assert.deepEqual(plan, [
    'route.classify',
    'agent.invoke.risk-check',
    'agent.invoke.zoho-books-action',
    'agent.invoke.lark-response',
    'synthesis.compose',
  ]);
});

test('books lookup requests also route through the books action path', () => {
  const text = 'show me all my invoices';
  const intent = detectRouteIntent(text);
  const complexity = classifyComplexityLevel(text);
  const plan = buildPlanFromIntent(intent, complexity, text);

  assert.equal(intent, 'write_intent');
  assert.equal(complexity, 1);
  assert.equal(requiresHumanConfirmation(text), false);
  assert.deepEqual(plan, [
    'route.classify',
    'agent.invoke.risk-check',
    'agent.invoke.zoho-books-action',
    'agent.invoke.lark-response',
    'synthesis.compose',
  ]);
});

test('crm read requests still route through the zoho read path', () => {
  const text = 'show me the owner for the Zoho deal with Acme';
  const intent = detectRouteIntent(text);
  const complexity = classifyComplexityLevel(text);
  const plan = buildPlanFromIntent(intent, complexity, text);

  assert.equal(intent, 'zoho_read');
  assert.equal(complexity, 2);
  assert.equal(requiresHumanConfirmation(text), false);
  assert.deepEqual(plan, [
    'route.classify',
    'agent.invoke.zoho-read',
    'agent.invoke.lark-response',
    'synthesis.compose',
  ]);
});

test('child-router domain overrides keyword fallback in route intent detection', () => {
  assert.equal(detectRouteIntent('that one again', 'zoho_books'), 'write_intent');
});
