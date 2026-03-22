import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRouteContract } from '../src/company/orchestration/langgraph/route-contract';

test('route contract infers crm_entity with zoho live-plus-vector strategy', () => {
  const resolved = resolveRouteContract({
    rawLlmOutput: null,
    messageText: 'What is the current stage and owner for the Zoho deal with Acme Corp?',
  });

  assert.equal(resolved.route.intent, 'zoho_read');
  assert.equal(resolved.route.retrievalMode, 'vector');
  assert.ok(resolved.route.knowledgeNeeds.includes('crm_entity'));
  assert.equal(resolved.route.preferredStrategy, 'zoho_vector_plus_live');
});

test('route contract infers hybrid_web when freshness and internal documents are both required', () => {
  const resolved = resolveRouteContract({
    rawLlmOutput: null,
    messageText: 'Compare our internal policy document with the latest public regulations on the government website today.',
  });

  assert.equal(resolved.route.retrievalMode, 'both');
  assert.ok(resolved.route.knowledgeNeeds.includes('company_docs'));
  assert.ok(resolved.route.knowledgeNeeds.includes('hybrid_web'));
  assert.equal(resolved.route.preferredStrategy, 'internal_plus_web');
});
