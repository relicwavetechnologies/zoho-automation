import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageModel } from 'ai';
import { LarkInferenceService, LARK_MODEL_ID } from '../../src/application/proxy/lark-inference.service.ts';
import { asCompanyId, asUserId } from '../../src/shared/ids.ts';

const logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child() { return this; },
} as any;

const runContext = {
  companyId: asCompanyId('company-1'),
  userId: asUserId('user-1'),
  companyRole: 'MEMBER',
  channel: 'lark',
} as any;

function generatedResult() {
  return {
    content: [{ type: 'text', text: 'hello' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 12, noCache: 8, cacheRead: 4, cacheWrite: 0 },
      outputTokens: { total: 3, text: 3, reasoning: 0 },
    },
    warnings: [],
  } as any;
}

describe('LarkInferenceService', () => {
  it('pins Lark to Pro and records channel-attributed usage and audit data', async () => {
    const calls: Array<{ name: string; input: any }> = [];
    let receivedKey = '';
    const upstream = {
      specificationVersion: 'v3', provider: 'deepseek', modelId: 'deepseek-chat', supportedUrls: {},
      doGenerate: async () => generatedResult(),
      doStream: async () => { throw new Error('not used'); },
    } as any;
    const service = new LarkInferenceService({
      store: {
        resolve: async () => ({ key: 'company-secret', source: 'company' }),
        touch: async (source: string, companyId: string) => calls.push({ name: 'touch', input: { source, companyId } }),
      } as any,
      policy: {
        gate: async (input: any) => { calls.push({ name: 'gate', input }); return { allow: true }; },
        recordModelCall: async (input: any) => calls.push({ name: 'usage', input }),
        recordAudit: async (input: any) => calls.push({ name: 'audit', input }),
      } as any,
      logger,
      baseUrl: 'https://api.deepseek.test',
      createUpstreamModel: (apiKey) => { receivedKey = apiKey; return upstream; },
    });

    const model = service.createModel({ runContext, executionRunId: 'run-1', threadId: 'chat-1' });
    assert.equal((model as any).modelId, LARK_MODEL_ID);
    await (model as any).doGenerate({});

    assert.equal(receivedKey, 'company-secret');
    assert.equal(calls.find(c => c.name === 'gate')?.input.model, LARK_MODEL_ID);
    const usage = calls.find(c => c.name === 'usage')?.input;
    assert.equal(usage.channel, 'lark');
    assert.equal(usage.model, LARK_MODEL_ID);
    assert.equal(usage.usage.prompt_cache_hit_tokens, 4);
    assert.equal(usage.usage.prompt_cache_miss_tokens, 8);
    assert.equal(usage.executionId, 'run-1');
    const audit = calls.find(c => c.name === 'audit')?.input;
    assert.equal(audit.channel, 'lark');
    assert.equal(audit.decision, 'allowed');
    assert.equal(audit.keySource, 'company');
  });

  it('fails closed without resolving or calling an upstream model when policy denies', async () => {
    let resolved = false;
    let created = false;
    const audits: any[] = [];
    const service = new LarkInferenceService({
      store: {
        resolve: async () => { resolved = true; return null; },
      } as any,
      policy: {
        gate: async () => ({ allow: false, status: 403, reason: 'blocked by admin' }),
        recordAudit: async (input: any) => audits.push(input),
      } as any,
      logger,
      baseUrl: 'https://api.deepseek.test',
      createUpstreamModel: () => { created = true; return {} as LanguageModel as any; },
    });

    const model = service.createModel({ runContext, executionRunId: 'run-2' });
    await assert.rejects(() => (model as any).doGenerate({}), /blocked by admin/);
    assert.equal(resolved, false);
    assert.equal(created, false);
    assert.equal(audits[0]?.channel, 'lark');
    assert.equal(audits[0]?.decision, 'denied');
    assert.equal(audits[0]?.httpStatus, 403);
  });
});
