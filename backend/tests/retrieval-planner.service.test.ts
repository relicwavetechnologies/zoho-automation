import test from 'node:test';
import assert from 'node:assert/strict';

import { retrievalPlannerService } from '../src/company/retrieval/retrieval-planner.service';
import { retrievalOrchestratorService } from '../src/company/retrieval/retrieval-orchestrator.service';

test('retrieval planner prefers full-document strategy for exact policy wording requests', () => {
  const plan = retrievalPlannerService.buildPlan({
    messageText: 'What is the exact refund policy clause in the employee handbook? Quote the wording.',
    domains: ['docs'],
    freshnessNeed: 'none',
    retrievalMode: 'vector',
  });

  assert.ok(plan.knowledgeNeeds.includes('company_docs'));
  assert.equal(plan.preferredStrategy, 'doc_full_read');
  assert.ok(plan.steps.some((step) => step.need === 'company_docs' && step.strategy === 'doc_full_read'));
});

test('retrieval planner routes workflow-like requests through skill search first', () => {
  const plan = retrievalPlannerService.buildPlan({
    messageText: 'What is the process for onboarding a new support agent?',
    freshnessNeed: 'none',
    retrievalMode: 'vector',
  });

  assert.ok(plan.knowledgeNeeds.includes('workflow_skill'));
  assert.equal(plan.preferredStrategy, 'skill_db_search');
  assert.ok(plan.steps.some((step) => step.need === 'workflow_skill' && step.strategy === 'skill_db_search'));
});

test('retrieval orchestrator prioritizes attachments and structured finance for uploaded statement questions', () => {
  const execution = retrievalOrchestratorService.planExecution({
    messageText: 'From this attached bank statement, what is the closing balance and which vendors were paid?',
    domains: ['docs'],
    freshnessNeed: 'none',
    retrievalMode: 'vector',
    hasAttachments: true,
  });

  assert.equal(execution.plan.preferredStrategy, 'attachment_first');
  assert.ok(execution.plan.knowledgeNeeds.includes('attachment_exact'));
  assert.ok(execution.plan.knowledgeNeeds.includes('structured_finance'));
  assert.ok(execution.toolFamilies.includes('statementParser'));
  assert.ok(execution.toolFamilies.includes('documentOcrRead'));
  assert.ok(execution.systemDirectives.some((line) => /Attachment-aware retrieval/.test(line)));
});
