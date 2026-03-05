const assert = require('node:assert/strict');
const test = require('node:test');

const { ZohoReadAgent } = require('../dist/company/agents/implementations/zoho-read.agent');
const {
  companyContextResolver,
  CompanyContextResolutionError,
  zohoRetrievalService,
} = require('../dist/company/agents/support');

const withPatch = async (target, methodName, replacement, fn) => {
  const original = target[methodName];
  target[methodName] = replacement;
  try {
    await fn();
  } finally {
    target[methodName] = original;
  }
};

const baseInput = {
  taskId: 'task-1',
  agentKey: 'zoho-read',
  objective: 'show top deals',
  constraints: ['v1'],
  contextPacket: {},
  correlationId: 'corr-1',
};

test('ZohoReadAgent returns grounded source references on successful retrieval', async () => {
  const agent = new ZohoReadAgent();

  await withPatch(companyContextResolver, 'resolveCompanyId', async () => 'cmp-1', async () => {
    await withPatch(zohoRetrievalService, 'query', async () => [
      { sourceType: 'zoho_deal', sourceId: 'deal-1', chunkIndex: 0, score: 0.91, payload: {} },
      { sourceType: 'zoho_contact', sourceId: 'contact-2', chunkIndex: 1, score: 0.75, payload: {} },
    ], async () => {
      const result = await agent.invoke(baseInput);
      assert.equal(result.status, 'success');
      assert.equal(result.result.companyId, 'cmp-1');
      assert.deepEqual(result.result.sources, ['zoho_deal:deal-1#0', 'zoho_contact:contact-2#1']);
    });
  });
});

test('ZohoReadAgent returns deterministic no-context success when retrieval result is empty', async () => {
  const agent = new ZohoReadAgent();

  await withPatch(companyContextResolver, 'resolveCompanyId', async () => 'cmp-1', async () => {
    await withPatch(zohoRetrievalService, 'query', async () => [], async () => {
      const result = await agent.invoke(baseInput);
      assert.equal(result.status, 'success');
      assert.deepEqual(result.result.sources, []);
    });
  });
});

test('ZohoReadAgent maps ambiguous company context to explicit failure code', async () => {
  const agent = new ZohoReadAgent();

  await withPatch(
    companyContextResolver,
    'resolveCompanyId',
    async () => {
      throw new CompanyContextResolutionError(
        'company_context_ambiguous',
        'Multiple active company Zoho connections found; explicit company context required',
      );
    },
    async () => {
      const result = await agent.invoke(baseInput);
      assert.equal(result.status, 'failed');
      assert.equal(result.error.classifiedReason, 'company_context_ambiguous');
      assert.equal(result.error.retriable, false);
    },
  );
});
