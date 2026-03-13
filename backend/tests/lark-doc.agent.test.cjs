const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/app';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { LarkDocAgent } = require('../dist/company/agents/implementations/lark-doc.agent');
const larkDocsModule = require('../dist/company/channels/lark/lark-docs.service');

const baseInput = {
  taskId: 'task-lark-1',
  agentKey: 'lark-doc',
  objective: 'create a lark doc for weekly report',
  constraints: ['v1'],
  contextPacket: {
    markdown: '# Weekly report\n\nSummary text',
  },
  correlationId: 'corr-lark-1',
};

const withPatchedMethod = async (target, methodName, replacement, fn) => {
  const original = target[methodName];
  target[methodName] = replacement;
  try {
    await fn();
  } finally {
    target[methodName] = original;
  }
};

test('LarkDocAgent returns terse create status with url', async () => {
  const agent = new LarkDocAgent();
  await withPatchedMethod(larkDocsModule.larkDocsService, 'createMarkdownDoc', async () => ({
    title: 'Weekly report',
    documentId: 'doc_123',
    url: 'https://lark.example/doc_123',
    blockCount: 4,
  }), async () => {
    const result = await agent.invoke(baseInput);
    assert.equal(result.status, 'success');
    assert.equal(result.message, 'Created Lark Doc: https://lark.example/doc_123');
  });
});

test('LarkDocAgent returns terse edit status with url', async () => {
  const agent = new LarkDocAgent();
  await withPatchedMethod(larkDocsModule.larkDocsService, 'editMarkdownDoc', async () => ({
    documentId: 'doc_456',
    url: 'https://lark.example/doc_456',
    blocksAffected: 2,
  }), async () => {
    const result = await agent.invoke({
      ...baseInput,
      objective: 'update this lark doc',
      contextPacket: {
        markdown: '## Updated section\n\nNew text',
        documentId: 'doc_456',
      },
    });
    assert.equal(result.status, 'success');
    assert.equal(result.message, 'Updated Lark Doc: https://lark.example/doc_456');
  });
});

test('LarkDocAgent returns terse failure status', async () => {
  const agent = new LarkDocAgent();
  await withPatchedMethod(larkDocsModule.larkDocsService, 'createMarkdownDoc', async () => {
    throw new Error('service unavailable');
  }, async () => {
    const result = await agent.invoke(baseInput);
    assert.equal(result.status, 'failed');
    assert.equal(result.message, 'Lark Doc failed: service unavailable');
  });
});
