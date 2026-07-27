import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageModel } from 'ai';
import {
  LarkInferenceService,
  LARK_MODEL_ID,
  LARK_MODEL_IDS,
  LARK_MODEL_PREFERENCE,
} from '../../src/application/proxy/lark-inference.service.ts';
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
  it('uses Pro when the account holds it, and records channel-attributed usage and audit data', async () => {
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
        allowedModelsFor: async () => [LARK_MODEL_ID],
        gate: async (input: any) => { calls.push({ name: 'gate', input }); return { allow: true }; },
        recordModelCall: async (input: any) => calls.push({ name: 'usage', input }),
        recordAudit: async (input: any) => calls.push({ name: 'audit', input }),
      } as any,
      logger,
      baseUrl: 'https://api.deepseek.test',
      createUpstreamModel: (apiKey) => { receivedKey = apiKey; return upstream; },
    });

    const model = await service.createModel({ runContext, executionRunId: 'run-1', threadId: 'chat-1' });
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
        allowedModelsFor: async () => [LARK_MODEL_ID],
        gate: async () => ({ allow: false, status: 403, reason: 'blocked by admin' }),
        recordAudit: async (input: any) => audits.push(input),
      } as any,
      logger,
      baseUrl: 'https://api.deepseek.test',
      createUpstreamModel: () => { created = true; return {} as LanguageModel as any; },
    });

    const model = await service.createModel({ runContext, executionRunId: 'run-2' });
    await assert.rejects(() => (model as any).doGenerate({}), /blocked by admin/);
    assert.equal(resolved, false);
    assert.equal(created, false);
    assert.equal(audits[0]?.channel, 'lark');
    assert.equal(audits[0]?.decision, 'denied');
    assert.equal(audits[0]?.httpStatus, 403);
  });

  /** A service whose policy grants exactly `allowed`. */
  function serviceWithAllowed(allowed: string[]) {
    const calls: Array<{ name: string; input: any }> = [];
    const service = new LarkInferenceService({
      store: { resolve: async () => ({ key: 'k', source: 'company' }), touch: async () => {} } as any,
      policy: {
        allowedModelsFor: async () => allowed,
        gate: async (input: any) => {
          calls.push({ name: 'gate', input });
          return allowed.includes(input.model)
            ? { allow: true }
            : { allow: false, status: 403, reason: `Model ${input.model} is not enabled for this account.` };
        },
        recordModelCall: async (input: any) => calls.push({ name: 'usage', input }),
        recordAudit: async (input: any) => calls.push({ name: 'audit', input }),
      } as any,
      logger,
      baseUrl: 'https://api.deepseek.test',
      createUpstreamModel: () => ({
        specificationVersion: 'v3', provider: 'deepseek', modelId: 'stub', supportedUrls: {},
        doGenerate: async () => generatedResult(),
        doStream: async () => { throw new Error('not used'); },
      }) as any,
    });
    return { service, calls };
  }

  it('falls back to Flash when the account does not hold Pro', async () => {
    // The proxy policy defaults to Flash-only and Pro must be granted
    // deliberately, so pinning Pro meant most members were refused before
    // inference started.
    const { service, calls } = serviceWithAllowed(['deepseek-v4-flash']);

    const model = await service.createModel({ runContext, executionRunId: 'run-3' });
    await (model as any).doGenerate({});

    assert.equal((model as any).modelId, 'deepseek-v4-flash');
    assert.equal(calls.find(c => c.name === 'gate')?.input.model, 'deepseek-v4-flash');
  });

  it('prefers Pro when the account holds both', async () => {
    const { service } = serviceWithAllowed(['deepseek-v4-flash', 'deepseek-v4-pro']);

    const model = await service.createModel({ runContext, executionRunId: 'run-4' });

    assert.equal((model as any).modelId, LARK_MODEL_PREFERENCE[0]);
  });

  it('honors an explicit Flash run even when the account also holds Pro', async () => {
    const { service, calls } = serviceWithAllowed([
      LARK_MODEL_IDS.flash,
      LARK_MODEL_IDS.pro,
    ]);

    const model = await service.createModel({
      runContext,
      executionRunId: 'run-explicit-flash',
      requestedModelId: LARK_MODEL_IDS.flash,
    });
    await (model as any).doGenerate({});

    assert.equal((model as any).modelId, LARK_MODEL_IDS.flash);
    assert.equal(calls.find(c => c.name === 'gate')?.input.model, LARK_MODEL_IDS.flash);
  });

  it('does not bypass policy when Pro is explicitly requested', async () => {
    const { service } = serviceWithAllowed([LARK_MODEL_IDS.flash]);

    const model = await service.createModel({
      runContext,
      executionRunId: 'run-explicit-pro',
      requestedModelId: LARK_MODEL_IDS.pro,
    });

    await assert.rejects(
      () => (model as any).doGenerate({}),
      /is not enabled for this account/,
    );
  });

  it('bills and traces the model it actually ran, not the preferred one', async () => {
    const { service, calls } = serviceWithAllowed(['deepseek-v4-flash']);

    const model = await service.createModel({ runContext, executionRunId: 'run-5' });
    await (model as any).doGenerate({});

    // Charging a Flash run at Pro rates would be a billing defect, not a
    // cosmetic one.
    assert.equal(calls.find(c => c.name === 'usage')?.input.model, 'deepseek-v4-flash');
    assert.equal(calls.find(c => c.name === 'audit')?.input.model, 'deepseek-v4-flash');
  });

  it('still refuses, with a readable reason, when the account holds nothing', async () => {
    const { service } = serviceWithAllowed([]);

    const model = await service.createModel({ runContext, executionRunId: 'run-6' });

    // A blocked account resolves to the least-privileged preference and is
    // denied by `gate` — one place that audits and phrases the refusal.
    await assert.rejects(() => (model as any).doGenerate({}), /is not enabled for this account/);
  });

  it('runs on Flash rather than failing when the policy lookup errors', async () => {
    const service = new LarkInferenceService({
      store: { resolve: async () => ({ key: 'k', source: 'company' }), touch: async () => {} } as any,
      policy: {
        allowedModelsFor: async () => { throw new Error('policy store down'); },
        gate: async () => ({ allow: true }),
        recordModelCall: async () => {},
        recordAudit: async () => {},
      } as any,
      logger,
      baseUrl: 'https://api.deepseek.test',
      createUpstreamModel: () => ({
        specificationVersion: 'v3', provider: 'deepseek', modelId: 'stub', supportedUrls: {},
        doGenerate: async () => generatedResult(),
        doStream: async () => { throw new Error('not used'); },
      }) as any,
    });

    // Degrading to the cheaper model beats refusing to answer at all.
    const model = await service.createModel({ runContext, executionRunId: 'run-7' });
    assert.equal((model as any).modelId, 'deepseek-v4-flash');
  });
});
