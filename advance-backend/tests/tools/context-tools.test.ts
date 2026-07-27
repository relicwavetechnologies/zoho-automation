/**
 * Unit tests for context-search and web-search tools.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeAllowedPerm, makeDeniedPerm, makeCtx } from './tool-test.helpers.ts';

import { createContextSearchTool } from '../../src/application/orchestration/tools/families/context-search.tool.ts';
import { createWebSearchTool }      from '../../src/application/orchestration/tools/families/web-search.tool.ts';
import type { ContextSearchBrokerPort } from '../../src/application/orchestration/tools/families/context-search.tool.ts';

// ─── context-search ───────────────────────────────────────────────────────────

describe('contextSearch tool', () => {
  const fakeOutput = {
    results: [
      {
        scope: 'company',
        sourceType: 'vector',
        sourceLabel: 'Policy Doc',
        excerpt: 'The PTO policy is...',
        score: 0.92,
        chunkRef: 'chunk-001',
      },
    ],
    searchSummary: 'Found 1 result',
    resolvedEntities: {},
    citations: [
      {
        index: 0,
        chunkRef: 'chunk-001',
        sourceLabel: 'Policy Doc',
        excerpt: 'The PTO policy is...',
        score: 0.92,
      },
    ],
    nextFetchRefs: [],
  };

  const fakeBroker: ContextSearchBrokerPort = {
    search: async () => fakeOutput,
  };

  const throwingBroker: ContextSearchBrokerPort = {
    search: async () => { throw new Error('vector db down'); },
  };

  describe('permissionCheck', () => {
    it('denies when contextSearch not in allowedActionsByTool', () => {
      const tool = createContextSearchTool({ broker: fakeBroker });
      const r = tool.permissionCheck({ query: 'PTO policy' }, makeDeniedPerm());
      assert.equal(r.ok, false);
      assert.equal((r as any).error.kind, 'permission');
    });

    it('returns "read" when contextSearch:read is allowed', () => {
      const tool = createContextSearchTool({ broker: fakeBroker });
      const r = tool.permissionCheck({ query: 'PTO policy' }, makeAllowedPerm('contextSearch', ['read']));
      assert.equal(r.ok, true);
      assert.equal((r as any).value, 'read');
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('contextSearch', ['read']);

    it('returns ok with structured result on success', async () => {
      const tool = createContextSearchTool({ broker: fakeBroker });
      const r = await tool.execute({ query: 'PTO policy' }, ctx);
      assert.equal(r.ok, true);
      const v = (r as any).value;
      assert.equal(v.success, true);
      assert.equal(v.resultCount, 1);
      assert.ok(Array.isArray(v.results));
      assert.ok(Array.isArray(v.citations));
      assert.equal(v.citations.length, 1);
    });

    it('success=false when broker returns no results', async () => {
      const emptyBroker: ContextSearchBrokerPort = {
        search: async () => ({ results: [], searchSummary: 'no results', resolvedEntities: {}, citations: [], nextFetchRefs: [] }),
      };
      const tool = createContextSearchTool({ broker: emptyBroker });
      const r = await tool.execute({ query: 'xyz' }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.success, false);
      assert.equal((r as any).value.resultCount, 0);
    });

    it('passes sources, dateFrom, dateTo, fileAssetId to broker', async () => {
      let capturedInput: any;
      const captureBroker: ContextSearchBrokerPort = {
        search: async (input) => { capturedInput = input; return fakeOutput; },
      };
      const tool = createContextSearchTool({ broker: captureBroker });
      await tool.execute({
        query: 'invoices',
        sources: { zohoBooksLive: true },
        dateFrom: '2025-01-01',
        dateTo: '2025-12-31',
        fileAssetId: 'fa-123',
      }, ctx);
      assert.equal(capturedInput.sources?.zohoBooksLive, true);
      assert.equal(capturedInput.dateFrom, '2025-01-01');
      assert.equal(capturedInput.fileAssetId, 'fa-123');
    });

    it('rejects a web source rather than silently ignoring it', () => {
      // The public internet is the webSearch tool's job. A model that asks for
      // web here must be told, not quietly handed company-only results it will
      // then present as current external facts.
      const parsed = createContextSearchTool({ broker: fakeBroker })
        .argsSchema.safeParse({ query: 'news', sources: { web: true } });

      assert.equal(parsed.success, true, 'unknown keys are stripped, not fatal');
      assert.equal(
        (parsed as any).data.sources?.web, undefined,
        'and web never reaches the broker',
      );
    });

    it('takes the chat scope from the run, not from the model', async () => {
      // A file uploaded into a Lark room is readable from that room. If the
      // model could name the chat, it could name someone else's and read their
      // documents — so this value comes from the run context only.
      let capturedInput: any;
      const captureBroker: ContextSearchBrokerPort = {
        search: async (input) => { capturedInput = input; return fakeOutput; },
      };
      const tool = createContextSearchTool({ broker: captureBroker });
      await tool.execute(
        { query: 'what does the contract say', larkChatId: 'oc_someone_else' } as never,
        makeCtx('contextSearch', ['read'], { chatId: 'oc_mine', channel: 'lark' }),
      );

      assert.equal(capturedInput.larkChatId, 'oc_mine');
    });

    it('leaves the chat scope unset outside Lark', async () => {
      // Desktop runs carry a chatId too. Passing it as a Lark chat scope would
      // be a filter on a value that never matches, silently hiding nothing —
      // until two id spaces happened to collide.
      let capturedInput: any;
      const captureBroker: ContextSearchBrokerPort = {
        search: async (input) => { capturedInput = input; return fakeOutput; },
      };
      const tool = createContextSearchTool({ broker: captureBroker });
      await tool.execute(
        { query: 'anything' },
        makeCtx('contextSearch', ['read'], { chatId: 'desktop-session', channel: 'desktop' }),
      );

      assert.equal(capturedInput.larkChatId, undefined);
    });

    it('broker throws → upstream_failure, never throws', async () => {
      const tool = createContextSearchTool({ broker: throwingBroker });
      const r = await tool.execute({ query: 'anything' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});

// ─── web-search ───────────────────────────────────────────────────────────────

describe('webSearch tool', () => {
  const fakeResults = [
    { title: 'OpenAI blog', url: 'https://openai.com/blog', snippet: 'Latest news...' },
    { title: 'Hacker News',  url: 'https://news.ycombinator.com', snippet: 'HN frontpage' },
  ];

  const fakeClient = { search: async () => fakeResults };
  const throwingClient = { search: async () => { throw new Error('search down'); } };

  describe('permissionCheck', () => {
    it('denies when webSearch not allowed', () => {
      const tool = createWebSearchTool({ client: fakeClient });
      const r = tool.permissionCheck({ query: 'GPT-5' }, makeDeniedPerm());
      assert.equal(r.ok, false);
    });

    it('returns "read" when allowed', () => {
      const tool = createWebSearchTool({ client: fakeClient });
      const r = tool.permissionCheck({ query: 'GPT-5' }, makeAllowedPerm('webSearch', ['read']));
      assert.equal(r.ok, true);
      assert.equal((r as any).value, 'read');
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('webSearch', ['read']);

    it('returns ok with results on success', async () => {
      const tool = createWebSearchTool({ client: fakeClient });
      const r = await tool.execute({ query: 'GPT-5' }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.success, true);
      assert.equal((r as any).value.results?.length, 2);
    });

    it('passes limit to client', async () => {
      let capturedLimit: number | undefined;
      const cap = { search: async (_companyId: string, _q: string, limit?: number) => { capturedLimit = limit; return fakeResults; } };
      const tool = createWebSearchTool({ client: cap });
      await tool.execute({ query: 'test', limit: 3 }, ctx);
      assert.equal(capturedLimit, 3);
    });

    it('defaults limit to 5 when not provided', async () => {
      let capturedLimit: number | undefined;
      const cap = { search: async (_companyId: string, _q: string, limit?: number) => { capturedLimit = limit; return []; } };
      const tool = createWebSearchTool({ client: cap });
      await tool.execute({ query: 'test' }, ctx);
      assert.equal(capturedLimit, 5);
    });

    it('client throws → upstream_failure, never throws', async () => {
      const tool = createWebSearchTool({ client: throwingClient });
      const r = await tool.execute({ query: 'anything' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});
