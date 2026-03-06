const assert = require('node:assert/strict');
const test = require('node:test');

const { MastraRuntimeService } = require('../dist/modules/mastra-runtime/mastra-runtime.service');

const buildPayload = (text, requestContext = {}) => ({
  messages: [{ role: 'user', content: text }],
  requestContext,
});

test('supervisorAgent orchestrates search + zoho for zoho intent', async () => {
  const calls = [];
  const service = new MastraRuntimeService({
    registry: {
      invoke: async (input) => {
        calls.push(input.agentKey);
        if (input.agentKey === 'zoho-read') {
          return {
            taskId: input.taskId,
            agentKey: input.agentKey,
            status: 'success',
            message: 'Found grounded Zoho context from 2 source records.',
            result: {
              sourceRefs: [{ id: 'zoho_deal:123#0' }, { id: 'zoho_contact:999#0' }],
            },
          };
        }
        return {
          taskId: input.taskId,
          agentKey: input.agentKey,
          status: 'success',
          message: 'generic response',
        };
      },
    },
    contextResolver: {
      resolveCompanyId: async () => 'company_1',
    },
    retrieval: {
      query: async () => [
        { sourceType: 'zoho_deal', sourceId: '123', chunkIndex: 0, score: 0.91, payload: {} },
      ],
    },
  });

  const result = await service.generate(
    'supervisorAgent',
    buildPayload('show my recent zoho deals', { companyId: 'company_1' }),
    'req_1',
  );

  assert.equal(result.output.route, 'zoho_and_search');
  assert.deepEqual(calls, ['zoho-read']);
  assert.match(result.text, /I found relevant Zoho records/);
  assert.match(result.text, /Sources:/);
});

test('searchAgent returns indexed search summary', async () => {
  const service = new MastraRuntimeService({
    registry: {
      invoke: async () => {
        throw new Error('registry should not be used for searchAgent');
      },
    },
    contextResolver: {
      resolveCompanyId: async () => 'company_1',
    },
    retrieval: {
      query: async () => [
        { sourceType: 'zoho_contact', sourceId: 'abc', chunkIndex: 0, score: 0.88, payload: {} },
      ],
    },
  });

  const result = await service.generate(
    'searchAgent',
    buildPayload('find john doe', { companyId: 'company_1' }),
    'req_2',
  );

  assert.equal(result.output.route, 'search_only');
  assert.equal(result.output.agentResults[0].agentKey, 'search');
  assert.match(result.text, /Found 1 indexed context chunks/);
});

test('supervisorAgent falls back to response agent for general prompt', async () => {
  const service = new MastraRuntimeService({
    registry: {
      invoke: async (input) => ({
        taskId: input.taskId,
        agentKey: input.agentKey,
        status: 'success',
        message: 'Hello from response agent',
      }),
    },
    contextResolver: {
      resolveCompanyId: async () => 'company_1',
    },
    retrieval: {
      query: async () => [],
    },
  });

  const result = await service.generate('supervisorAgent', buildPayload('hello there'), 'req_3');
  assert.equal(result.output.route, 'general');
  assert.equal(result.output.agentResults[0].agentKey, 'response');
  assert.equal(result.text, 'Hello from response agent');
});

test('supervisorAgent treats capability prompt as general capability response', async () => {
  const service = new MastraRuntimeService({
    registry: {
      invoke: async (input) => ({
        taskId: input.taskId,
        agentKey: input.agentKey,
        status: 'success',
        message: 'ok',
      }),
    },
    contextResolver: {
      resolveCompanyId: async () => 'company_1',
    },
    retrieval: {
      query: async () => [],
    },
  });

  const result = await service.generate('supervisorAgent', buildPayload('what can you do?'), 'req_4');
  assert.equal(result.output.route, 'general');
  assert.match(result.text, /I can help with Zoho automation tasks/);
});
