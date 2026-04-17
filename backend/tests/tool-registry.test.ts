import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALIAS_TO_CANONICAL_ID,
  DOMAIN_ALIASES,
  DOMAIN_TO_TOOL_IDS,
  TOOL_REGISTRY_MAP,
} from '../src/company/tools/tool-registry';

test('tool registry resolves executor-style aliases to canonical permission ids', () => {
  assert.equal(ALIAS_TO_CANONICAL_ID.workflowList, 'workflow-authoring');
  assert.equal(ALIAS_TO_CANONICAL_ID.workflowlist, 'workflow-authoring');
  assert.equal(ALIAS_TO_CANONICAL_ID['workflow-list'], 'workflow-authoring');
  assert.equal(ALIAS_TO_CANONICAL_ID.skillSearch, 'skill-search');
  assert.equal(ALIAS_TO_CANONICAL_ID.googleCalendar, 'google-calendar');
});

test('tool registry builds routing-domain expansion and aliases', () => {
  assert.ok(DOMAIN_TO_TOOL_IDS.workflow.includes('workflow-authoring'));
  assert.ok(DOMAIN_TO_TOOL_IDS.lark_task.includes('lark-task-read'));
  assert.equal(DOMAIN_ALIASES.workflowPlan, 'workflow');
  assert.equal(DOMAIN_ALIASES.larkTask, 'lark_task');
});

test('google mail contracts use approval flow instead of pre-send reconfirmation', () => {
  const gmailTool = TOOL_REGISTRY_MAP.get('google-gmail');
  const workspaceTool = TOOL_REGISTRY_MAP.get('googleWorkspace');

  assert.equal(gmailTool?.hitlRequired, true);
  assert.match(gmailTool?.promptSnippet ?? '', /approval flow/i);
  assert.match(gmailTool?.guardrails?.join(' ') ?? '', /materially ambiguous/i);

  assert.equal(workspaceTool?.hitlRequired, true);
  assert.match(workspaceTool?.promptSnippet ?? '', /approval flow/i);
});
