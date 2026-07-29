import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createLlmProxyRoutes } from '../../src/http/llm/llm-proxy.routes.ts';
import type { Logger } from '../../src/shared/logger.ts';

const silent: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => silent,
};

/**
 * Run one chat-completions request and return the body that reached DeepSeek.
 *
 * The upstream call is stubbed at `fetch` — this route forwards with `fetch`
 * directly rather than through the AI SDK, so the request body is observable.
 */
async function forwardedBody(
  clientModel: unknown,
  options: {
    locals?: Record<string, unknown>;
    calls?: Array<{ method: string; input: Record<string, unknown> }>;
  } = {},
): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  let captured: Record<string, unknown> = {};

  globalThis.fetch = (async (_url: unknown, init: any) => {
    captured = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({
      id: 'chatcmpl-1',
      model: 'deepseek-v4-pro',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;

  try {
    const router = createLlmProxyRoutes({
      logger: silent,
      store: {
        resolve: async () => ({ key: 'sk-test', source: 'platform' }),
        touch: async () => {},
      } as any,
      service: {
        gate: async () => ({ allow: true }),
        ensureRun: async (input: Record<string, unknown>) => {
          options.calls?.push({ method: 'ensureRun', input });
          return 'run-1';
        },
        recordToolResults: async () => {},
        recordModelCall: async (input: Record<string, unknown>) => {
          options.calls?.push({ method: 'recordModelCall', input });
        },
        recordAudit: async (input: Record<string, unknown>) => {
          options.calls?.push({ method: 'recordAudit', input });
        },
      } as any,
      baseUrl: 'https://api.deepseek.example',
    });

    const handler = (router as any).stack.find(
      (layer: any) => layer.route?.path === '/v1/chat/completions',
    ).route.stack[0].handle;

    const req = {
      body: { model: clientModel, messages: [{ role: 'user', content: 'hi' }], stream: false },
      on: () => {},
      header: () => undefined,
      get: () => undefined,
    } as unknown as Request;

    let settle: () => void = () => {};
    const finished = new Promise<void>(resolve => { settle = resolve; });
    const res = {
      locals: options.locals ?? { companyId: 'co-1', userId: 'user-1' },
      status: () => res,
      json: () => { settle(); return res; },
      send: () => { settle(); return res; },
      setHeader: () => res,
      write: () => true,
      end: () => { settle(); return res; },
      on: () => res,
      headersSent: false,
    } as unknown as Response & { locals: Record<string, unknown> };

    await Promise.resolve(handler(req, res, () => {}));
    return captured;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('LLM proxy model forwarding', () => {
  it('forwards the canonical model, not the name the client sent', async () => {
    // `deepseek-reasoner` is a legacy alias the proxy still accepts from older
    // desktop builds. It is canonicalised for the allow-list, the budget check
    // and pricing — so it must be canonicalised for the upstream call too.
    // Forwarding the raw name authorises one model and then calls another, and
    // DeepSeek has since retired the alias and rejects it outright.
    const body = await forwardedBody('deepseek-reasoner');

    assert.equal(body['model'], 'deepseek-v4-pro');
  });

  it('leaves an already-canonical model unchanged', async () => {
    const body = await forwardedBody('deepseek-v4-flash');

    assert.equal(body['model'], 'deepseek-v4-flash');
  });

  it('substitutes a default when the client names no model at all', async () => {
    const body = await forwardedBody(undefined);

    // Never forwards `undefined`: DeepSeek rejects a request with no model, and
    // the gate has already priced this call as the default.
    assert.equal(body['model'], 'deepseek-v4-flash');
  });

  it('attributes a runtime lease request to Lark through run, usage, and audit', async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    await forwardedBody('deepseek-v4-flash', {
      locals: {
        companyId: 'co-1',
        userId: 'user-1',
        sessionId: 'session-1',
        channel: 'lark',
        runtimeThreadId: 'lark:chat-1',
      },
      calls,
    });

    assert.equal(calls.find(call => call.method === 'ensureRun')?.input['channel'], 'lark');
    assert.equal(calls.find(call => call.method === 'recordModelCall')?.input['channel'], 'lark');
    assert.equal(calls.find(call => call.method === 'recordModelCall')?.input['threadId'], 'lark:chat-1');
    assert.equal(calls.find(call => call.method === 'recordAudit')?.input['channel'], 'lark');
  });
});
