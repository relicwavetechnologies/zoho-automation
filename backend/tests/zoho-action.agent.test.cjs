const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { ZohoActionAgent } = require('../dist/company/agents/implementations/zoho-action.agent');
const {
  companyContextResolver,
  CompanyContextResolutionError,
} = require('../dist/company/agents/support');
const zohoProviderResolver = require('../dist/company/integrations/zoho/zoho-provider.resolver');

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
  taskId: 'task-action-1',
  agentKey: 'zoho-action',
  objective: 'create a follow-up task in zoho',
  constraints: ['v1'],
  contextPacket: {
    companyId: 'cmp-1',
    actionName: 'zoho.tasks.create',
  },
  correlationId: 'corr-action-1',
};

test('ZohoActionAgent fails closed when HITL is not confirmed', async () => {
  const agent = new ZohoActionAgent();

  await withPatch(companyContextResolver, 'resolveCompanyId', async () => 'cmp-1', async () => {
    await withPatch(zohoProviderResolver, 'resolveZohoProvider', async () => ({
      providerMode: 'mcp',
      environment: 'prod',
      connectionId: 'conn-1',
      adapter: {
        executeAction: async (input) => ({
          actionName: input.actionName,
          status: 'failed',
          failureCode: 'mcp_action_requires_hitl',
          message: 'HITL confirmation is required for MCP action execution',
        }),
      },
    }), async () => {
      const result = await agent.invoke(baseInput);
      assert.equal(result.status, 'failed');
      assert.equal(result.error.classifiedReason, 'mcp_action_requires_hitl');
      assert.equal(result.error.retriable, false);
    });
  });
});

test('ZohoActionAgent executes provider action when HITL is confirmed', async () => {
  const agent = new ZohoActionAgent();

  await withPatch(companyContextResolver, 'resolveCompanyId', async () => 'cmp-1', async () => {
    await withPatch(zohoProviderResolver, 'resolveZohoProvider', async () => ({
      providerMode: 'mcp',
      environment: 'prod',
      connectionId: 'conn-1',
      adapter: {
        executeAction: async (input) => ({
          actionName: input.actionName,
          status: 'success',
          receipt: { id: 'receipt-1', ok: input.hitlConfirmed === true },
        }),
      },
    }), async () => {
      const result = await agent.invoke({
        ...baseInput,
        contextPacket: {
          ...baseInput.contextPacket,
          hitlConfirmed: true,
          hitlStatus: 'confirmed',
        },
      });
      assert.equal(result.status, 'success');
      assert.equal(result.result.providerMode, 'mcp');
      assert.deepEqual(result.result.sourceRefs, [{ source: 'mcp', id: 'zoho.tasks.create' }]);
    });
  });
});

test('ZohoActionAgent maps company context failures to explicit codes', async () => {
  const agent = new ZohoActionAgent();

  await withPatch(
    companyContextResolver,
    'resolveCompanyId',
    async () => {
      throw new CompanyContextResolutionError('company_context_missing', 'Missing company scope');
    },
    async () => {
      const result = await agent.invoke(baseInput);
      assert.equal(result.status, 'failed');
      assert.equal(result.error.classifiedReason, 'company_context_missing');
      assert.equal(result.error.retriable, false);
    },
  );
});
