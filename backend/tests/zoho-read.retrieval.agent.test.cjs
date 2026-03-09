const assert = require('node:assert/strict');
const test = require('node:test');

const { ZohoReadAgent } = require('../dist/company/agents/implementations/zoho-read.agent');
const {
  companyContextResolver,
  CompanyContextResolutionError,
  zohoRetrievalService,
} = require('../dist/company/agents/support');
const runtimeControls = require('../dist/company/support/runtime-controls');

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
  objective: 'show me all deals',
  constraints: ['v1'],
  contextPacket: {
    requesterEmail: 'owner@example.com',
    userId: 'user-1',
  },
  correlationId: 'corr-1',
};

test('ZohoReadAgent blocks strict mode when requester email is missing', async () => {
  const agent = new ZohoReadAgent();

  await withPatch(companyContextResolver, 'resolveCompanyId', async () => 'cmp-1', async () => {
    await withPatch(runtimeControls, 'isCompanyControlEnabled', async () => true, async () => {
      const result = await agent.invoke({
        ...baseInput,
        contextPacket: {},
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.error.classifiedReason, 'strict_scope_missing_requester_email');
    });
  });
});

test('ZohoReadAgent returns strict_scope_no_matching_records when strict scope yields nothing', async () => {
  const agent = new ZohoReadAgent();

  await withPatch(companyContextResolver, 'resolveCompanyId', async () => 'cmp-1', async () => {
    await withPatch(runtimeControls, 'isCompanyControlEnabled', async () => true, async () => {
      await withPatch(agent, 'fetchLiveRecords', async () => ({ records: [], sourceRefs: [], fallbackUsed: false }), async () => {
        const result = await agent.invoke(baseInput);
        assert.equal(result.status, 'failed');
        assert.equal(result.error.classifiedReason, 'strict_scope_no_matching_records');
      });
    });
  });
});

test('ZohoReadAgent only keeps vector context that maps to authorized live source IDs', async () => {
  const agent = new ZohoReadAgent();

  await withPatch(companyContextResolver, 'resolveCompanyId', async () => 'cmp-1', async () => {
    await withPatch(runtimeControls, 'isCompanyControlEnabled', async () => true, async () => {
      await withPatch(agent, 'fetchLiveRecords', async () => ({
        records: [
          {
            sourceType: 'zoho_deal',
            sourceId: 'deal-1',
            payload: { Deal_Name: 'Deal One', Amount: '1000' },
          },
        ],
        sourceRefs: [{ source: 'rest', id: 'zoho_deal:deal-1' }],
        fallbackUsed: false,
      }), async () => {
        await withPatch(zohoRetrievalService, 'query', async () => [
          { sourceType: 'zoho_deal', sourceId: 'deal-1', chunkIndex: 0, score: 0.91, payload: {} },
          { sourceType: 'zoho_deal', sourceId: 'deal-2', chunkIndex: 1, score: 0.75, payload: {} },
        ], async () => {
          const result = await agent.invoke(baseInput);
          assert.equal(result.status, 'success');
          assert.equal(result.result.liveRecordCount, 1);
          assert.equal(result.result.vectorRecordCount, 1);
          assert.deepEqual(result.result.sources, ['zoho_deal:deal-1', 'zoho_deal:deal-1#0']);
        });
      });
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
