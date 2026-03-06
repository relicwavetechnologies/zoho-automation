const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('../dist/config').default;
const { HttpException } = require('../dist/core/http-exception');
const { MastraClient } = require('../dist/company/integrations/mastra/mastra.client');

const withMastraConfig = async (patch, fn) => {
  const previous = {
    MASTRA_BASE_URL: config.MASTRA_BASE_URL,
    MASTRA_AGENT_ID: config.MASTRA_AGENT_ID,
    MASTRA_API_KEY: config.MASTRA_API_KEY,
    MASTRA_TIMEOUT_MS: config.MASTRA_TIMEOUT_MS,
  };
  Object.assign(config, patch);
  try {
    await fn();
  } finally {
    Object.assign(config, previous);
  }
};

const baseInput = {
  taskId: 'task-mastra-1',
  messageId: 'om_mastra_1',
  userId: 'ou_1',
  chatId: 'oc_1',
  text: 'hello from test',
  channel: 'lark',
  companyId: 'company_1',
  requestId: 'req_1',
};

test('MastraClient.generate parses direct text payload', async () => {
  await withMastraConfig(
    {
      MASTRA_BASE_URL: 'http://127.0.0.1:4111',
      MASTRA_AGENT_ID: 'supervisorAgent',
      MASTRA_TIMEOUT_MS: 500,
    },
    async () => {
      const client = new MastraClient({
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              text: 'Mastra says hi',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const result = await client.generate(baseInput);
      assert.equal(result.text, 'Mastra says hi');
    },
  );
});

test('MastraClient.generate parses OpenAI-style choices payload', async () => {
  await withMastraConfig(
    {
      MASTRA_BASE_URL: 'http://127.0.0.1:4111',
      MASTRA_AGENT_ID: 'supervisorAgent',
      MASTRA_TIMEOUT_MS: 500,
    },
    async () => {
      const client = new MastraClient({
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'Choice output text' } }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const result = await client.generate(baseInput);
      assert.equal(result.text, 'Choice output text');
    },
  );
});

test('MastraClient.generate maps non-2xx response to HttpException 502', async () => {
  await withMastraConfig(
    {
      MASTRA_BASE_URL: 'http://127.0.0.1:4111',
      MASTRA_AGENT_ID: 'supervisorAgent',
      MASTRA_TIMEOUT_MS: 500,
    },
    async () => {
      const client = new MastraClient({
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: 'bad request' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
      });

      await assert.rejects(
        () => client.generate(baseInput),
        (error) => error instanceof HttpException && error.status === 502,
      );
    },
  );
});

test('MastraClient.generate maps network failure to HttpException 502', async () => {
  await withMastraConfig(
    {
      MASTRA_BASE_URL: 'http://127.0.0.1:4111',
      MASTRA_AGENT_ID: 'supervisorAgent',
      MASTRA_TIMEOUT_MS: 500,
    },
    async () => {
      const client = new MastraClient({
        fetchImpl: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      });

      await assert.rejects(
        () => client.generate(baseInput),
        (error) => error instanceof HttpException && error.status === 502,
      );
    },
  );
});
