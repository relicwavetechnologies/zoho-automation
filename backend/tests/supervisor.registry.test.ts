import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveEligibleSupervisorAgents,
  getSupervisorAgentToolIds,
  SUPERVISOR_AGENT_TOOL_IDS,
} from '../src/company/orchestration/supervisor';

test('eligible supervisor agents are derived from available tool families', () => {
  const eligible = deriveEligibleSupervisorAgents({
    allowedToolIds: [
      'zoho-books-read',
      'zoho-books-write',
      'google-gmail',
      'context-search',
    ],
    runExposedToolIds: ['zoho-books-read', 'zoho-books-write'],
    plannerChosenOperationClass: 'send',
    latestUserMessage: 'email invoices to Archit',
  });

  assert.deepEqual(eligible, ['zoho-ops-agent']);
});

test('supervisor tool families stay scoped to their declared domains', () => {
  const zohoTools = getSupervisorAgentToolIds('zoho-ops-agent', [
    ...SUPERVISOR_AGENT_TOOL_IDS['zoho-ops-agent'],
    'google-gmail',
  ]);
  const googleTools = getSupervisorAgentToolIds('google-workspace-agent', [
    ...SUPERVISOR_AGENT_TOOL_IDS['google-workspace-agent'],
    'zoho-books-read',
  ]);

  assert.ok(zohoTools.includes('zoho-books-read'));
  assert.ok(zohoTools.includes('zoho-books-write'));
  assert.equal(zohoTools.includes('google-gmail'), false);
  assert.ok(googleTools.includes('google-gmail'));
  assert.equal(googleTools.includes('zoho-books-read'), false);
});
