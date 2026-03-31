import { hotContextStore } from '../src/company/orchestration/hot-context.store';
import {
  buildDelegatedAgentSystemPrompt,
  buildDelegatedLarkStepPrompt,
} from '../src/company/orchestration/engine/vercel-orchestration.engine';
import type { SearchIntent } from '../src/company/orchestration/search-intent-classifier';
import { enrichStepObjective } from '../src/company/orchestration/supervisor/planner';
import type { SupervisorStep } from '../src/company/orchestration/supervisor/types';

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const baseIntent: SearchIntent = {
  queryType: 'company_entity',
  extractedEntity: 'Human AI LLC',
  extractedEntityType: 'company',
  sourceHint: 'books',
  language: 'en',
  dateRange: null,
  isBareMention: false,
  isContinuation: false,
  inheritEntityFromThread: false,
  confidence: 0.97,
};

const main = async () => {
  const step = enrichStepObjective({
    stepId: 'step_1',
    agentId: 'zoho-ops-agent',
    objective: 'Search for Human AI LLC in Zoho and retrieve the record',
    dependsOn: [],
    inputRefs: [],
  } satisfies SupervisorStep, baseIntent);

  const delegatedPrompt = buildDelegatedLarkStepPrompt({
    step,
    originalUserMessage: 'search for human ai llc',
    scopedContext: [],
    upstreamResults: [],
    resolvedContext: {},
  });

  assert(delegatedPrompt.includes('[Structured Task Context]'), 'structured task block should be present');
  assert(delegatedPrompt.includes('Entity: Human AI LLC'), 'targetEntity should be present');
  assert(delegatedPrompt.includes('Primary source: books'), 'targetSource should be present');
  assert(delegatedPrompt.includes('Authority required:'), 'authorityRequired should be present');
  console.log('PASS structured objective block present in delegated step prompt');

  const contextPrompt = buildDelegatedAgentSystemPrompt('BASE', 'context-agent');
  assert(contextPrompt.includes('not confirmed internally'), 'context-agent should reject contextual/public proof when authority required');
  assert(contextPrompt.includes('personal_history results are conversation context only'), 'context-agent should treat personal history as non-proof');
  console.log('PASS context-agent capability profile guards entity proof');

  const zohoPrompt = buildDelegatedAgentSystemPrompt('BASE', 'zoho-ops-agent');
  assert(zohoPrompt.includes('check Zoho Books first, then Zoho CRM'), 'zoho-ops-agent should prefer Books before CRM');
  console.log('PASS zoho-ops-agent capability profile enforces Books-before-CRM');

  const taskId = `p3-hot-context-${Date.now()}`;
  hotContextStore.init(taskId);
  hotContextStore.push(taskId, {
    toolName: 'first',
    success: true,
    summary: 'first',
    resolvedIds: { customerId: 'old-value' },
    fullPayload: {},
    completedAt: Date.now(),
  });
  hotContextStore.push(taskId, {
    toolName: 'second',
    success: true,
    summary: 'second',
    resolvedIds: { customerId: 'new-value' },
    fullPayload: {},
    completedAt: Date.now() + 1,
  });
  const warm = hotContextStore.toWarmSummary(taskId);
  assert(warm.resolvedIds.customerId === 'new-value', 'toWarmSummary should use latest value semantics');
  assert(hotContextStore.getResolvedId(taskId, 'customerId') === 'new-value', 'getResolvedId should return latest value');
  hotContextStore.clear(taskId);
  console.log('PASS hot context warm summary uses latest-value semantics');

  console.log('All 4 P3 structured supervisor harness cases passed.');
};

void main();
