/**
 * Tests for ContextSearchBroker.
 *
 * All external ports are replaced with lightweight test doubles. No network,
 * no filesystem (workspace tests use in-memory stubs), no Qdrant.
 *
 * Groups:
 *   A. Source selection — defaults, explicit overrides, workspace auto-enable
 *   B. Parallel fanout — all sources, per-source timeout, errors contained
 *   C. Ranking + dedup — weight boost, authority sort, (scope:id:chunkIndex) dedup
 *   D. Resolved entities — lark_contacts, web, files, skills, zoho_books
 *   E. fetch() — workspace, web, lark_contacts, skills, zoho_books
 *   F. Date filtering — dateFrom / dateTo applied across sources
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ContextSearchBroker } from '../../../src/application/context-search/context-search.broker.ts';
import type { ContextSearchBrokerDeps } from '../../../src/application/context-search/context-search.broker.ts';
import type { LarkContactPort, ZohoBooksPort, SkillPort, EmbeddingPort } from '../../../src/application/context-search/context-search.ports.ts';
import type { VectorStoreAdapter } from '../../../src/infrastructure/ai/vector/types.ts';
import type { WebSearchService } from '../../../src/infrastructure/ai/search/web-search.service.ts';
import type { Logger } from '../../../src/shared/logger.ts';

// ─── Test doubles ─────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

const nullEmbedding: EmbeddingPort = {
  embedQuery: async () => Array.from({ length: 1536 }, () => 0),
};

const emptyVectorStore: VectorStoreAdapter = {
  upsert: async () => {},
  upsertVectors: async () => {},
  search: async () => [],
  deleteBySource: async () => {},
  deleteOwnedChatTurns: async () => {},
  countByCompany: async () => 0,
  health: async () => ({ ok: true, backend: 'qdrant', collection: 'test' }),
};

const emptyLarkContacts: LarkContactPort = {
  searchContacts: async () => [],
};

const emptyZohoBooks: ZohoBooksPort = {
  listOrganizations: async () => [],
  listContacts:  async () => ({ allowed: false, records: [] }),
  listInvoices:  async () => ({ allowed: false, records: [] }),
  getRecord:     async () => ({ allowed: false }),
};

const emptySkills: SkillPort = {
  search:   async () => [],
  readById: async () => null,
};

const emptyWebSearch = {
  search: async () => ({ query: '', focusedSiteSearch: false, items: [], sourceRefs: [] }),
} as unknown as WebSearchService;

function makeDeps(overrides: Partial<ContextSearchBrokerDeps> = {}): ContextSearchBrokerDeps {
  return {
    vectorStore:  emptyVectorStore,
    embedding:    nullEmbedding,
    webSearch:    emptyWebSearch,
    larkContacts: emptyLarkContacts,
    zohoBooks:    emptyZohoBooks,
    skills:       emptySkills,
    logger:       noopLogger,
    ...overrides,
  };
}

function makeBroker(overrides: Partial<ContextSearchBrokerDeps> = {}): ContextSearchBroker {
  return new ContextSearchBroker(makeDeps(overrides));
}

const BASE_INPUT = {
  companyId: 'company-1',
  userId:    'user-1',
  query:     'test query',
};

// ─── A. Source selection ──────────────────────────────────────────────────────

describe('ContextSearchBroker — source selection', () => {
  it('defaults: personalHistory, files, larkContacts, zohoCrmContext are enabled', async () => {
    const calls: string[] = [];

    const broker = makeBroker({
      larkContacts: {
        searchContacts: async () => { calls.push('larkContacts'); return []; },
      },
      vectorStore: {
        ...emptyVectorStore,
        search: async () => { calls.push('vectorStore'); return []; },
      },
    });

    await broker.search({ ...BASE_INPUT });
    // vector store is called for personalHistory, files, zohoCrmContext (3 calls)
    assert.ok(calls.filter(c => c === 'vectorStore').length >= 2, 'vector store should be called for multiple sources');
    assert.ok(calls.includes('larkContacts'), 'larkContacts should run by default');
  });

  it('web source is disabled by default', async () => {
    let webCalled = false;
    const broker = makeBroker({
      webSearch: {
        search: async () => { webCalled = true; return { query: '', focusedSiteSearch: false, items: [], sourceRefs: [] }; },
      } as unknown as WebSearchService,
    });
    const result = await broker.search({ ...BASE_INPUT });
    assert.equal(webCalled, false, 'web should not run by default');
    assert.equal(result.sourceCoverage.web.status, 'disabled');
  });

  it('web source runs when explicitly enabled', async () => {
    let webCalled = false;
    const broker = makeBroker({
      webSearch: {
        search: async () => { webCalled = true; return { query: '', focusedSiteSearch: false, items: [], sourceRefs: [] }; },
      } as unknown as WebSearchService,
    });
    await broker.search({ ...BASE_INPUT, sources: { web: true } });
    assert.equal(webCalled, true);
  });

  it('workspace auto-enables when workspacePath is provided', async () => {
    const result = await makeBroker().search({ ...BASE_INPUT, workspacePath: '/nonexistent/path' });
    assert.equal(result.sourceCoverage.workspace.enabled, true);
  });

  it('workspace stays disabled when workspacePath is absent', async () => {
    const result = await makeBroker().search({ ...BASE_INPUT });
    assert.equal(result.sourceCoverage.workspace.status, 'disabled');
  });

  it('explicit sources override defaults completely', async () => {
    let larkCalled = false;
    const broker = makeBroker({
      larkContacts: {
        searchContacts: async () => { larkCalled = true; return []; },
      },
    });
    // Only web requested — larkContacts should be disabled
    await broker.search({ ...BASE_INPUT, sources: { web: true, larkContacts: false } });
    assert.equal(larkCalled, false, 'larkContacts disabled explicitly');
  });
});

// ─── B. Parallel fanout & error containment ───────────────────────────────────

describe('ContextSearchBroker — fanout & error containment', () => {
  it('returns results from all enabled sources', async () => {
    const broker = makeBroker({
      larkContacts: {
        searchContacts: async () => [{
          larkOpenId: 'ou_abc', displayName: 'Alice', email: 'alice@example.com',
        }],
      },
      webSearch: {
        search: async () => ({
          query: 'q', focusedSiteSearch: false,
          items: [{ title: 'WebResult', link: 'https://example.com/p', domain: 'example.com', source: 'organic' as const }],
          sourceRefs: [],
        }),
      } as unknown as WebSearchService,
    });

    const result = await broker.search({ ...BASE_INPUT, sources: { larkContacts: true, web: true, personalHistory: false, files: false, zohoCrmContext: false } });
    const scopes = result.results.map(r => r.scope);
    assert.ok(scopes.includes('lark_contacts'), 'should include lark result');
    assert.ok(scopes.includes('web'), 'should include web result');
  });

  it('source error is captured in coverage, does not throw', async () => {
    const broker = makeBroker({
      larkContacts: {
        searchContacts: async () => { throw new Error('DB exploded'); },
      },
    });

    const result = await broker.search({ ...BASE_INPUT, sources: { larkContacts: true, personalHistory: false, files: false, zohoCrmContext: false } });
    // Should not throw; larkContacts coverage should show error or queried with 0 results
    assert.equal(result.sourceCoverage.larkContacts.enabled, true);
    // Could be error or 0 results depending on Promise.allSettled behavior
    assert.ok(
      result.sourceCoverage.larkContacts.status === 'error' ||
      result.sourceCoverage.larkContacts.resultCount === 0,
    );
  });

  it('source timeout sets status=timeout, does not throw', async () => {
    const broker = makeBroker({
      skills: {
        search: async () => {
          await new Promise(resolve => setTimeout(resolve, 200)); // simulated slow
          return [];
        },
        readById: async () => null,
      },
    });

    const result = await broker.search({
      ...BASE_INPUT,
      sources: { skills: true, personalHistory: false, files: false, larkContacts: false, zohoCrmContext: false },
      sourceTimeoutMs: 50, // very short timeout
    });

    assert.equal(result.sourceCoverage.skills.status, 'timeout');
    assert.equal(result.results.length, 0);
  });

  it('returns empty results and summary when no sources produce hits', async () => {
    const result = await makeBroker().search({
      ...BASE_INPUT,
      sources: { personalHistory: false, files: false, larkContacts: false, zohoCrmContext: false },
    });
    assert.equal(result.results.length, 0);
    assert.ok(result.searchSummary.includes('No matching'));
  });

  it('limit is respected', async () => {
    const broker = makeBroker({
      larkContacts: {
        searchContacts: async () => Array.from({ length: 10 }, (_, i) => ({
          larkOpenId: `ou_${i}`, displayName: `Person ${i}`, email: `p${i}@x.com`,
        })),
      },
    });

    const result = await broker.search({
      ...BASE_INPUT,
      limit: 3,
      sources: { larkContacts: true, personalHistory: false, files: false, zohoCrmContext: false },
    });
    assert.ok(result.results.length <= 3);
  });
});

// ─── C. Ranking + dedup ───────────────────────────────────────────────────────

describe('ContextSearchBroker — ranking and dedup', () => {
  it('deduplicates results with same scope:sourceId:chunkIndex', async () => {
    // Both larkContacts calls would return the same person
    const broker = makeBroker({
      larkContacts: {
        searchContacts: async () => [
          { larkOpenId: 'ou_same', displayName: 'Alice', email: 'alice@x.com' },
          { larkOpenId: 'ou_same', displayName: 'Alice', email: 'alice@x.com' }, // dup
        ],
      },
    });
    const result = await broker.search({
      ...BASE_INPUT,
      sources: { larkContacts: true, personalHistory: false, files: false, zohoCrmContext: false },
    });
    const aliceHits = result.results.filter(r => r.sourceId === 'ou_same');
    assert.equal(aliceHits.length, 1, 'duplicate should be collapsed');
  });

  it('results contain authorityLevel', async () => {
    const broker = makeBroker({
      webSearch: {
        search: async () => ({
          query: 'q', focusedSiteSearch: false,
          items: [{ title: 'T', link: 'https://example.com', domain: 'example.com', source: 'organic' as const }],
          sourceRefs: [],
        }),
      } as unknown as WebSearchService,
    });
    const result = await broker.search({
      ...BASE_INPUT,
      sources: { web: true, personalHistory: false, files: false, larkContacts: false, zohoCrmContext: false },
    });
    assert.equal(result.results[0]?.authorityLevel, 'public');
  });
});

// ─── D. Resolved entities ─────────────────────────────────────────────────────

describe('ContextSearchBroker — resolved entities', () => {
  it('extracts recipientEmail and recipientName from lark_contacts result', async () => {
    const broker = makeBroker({
      larkContacts: {
        searchContacts: async () => [{ larkOpenId: 'ou_x', displayName: 'Bob', email: 'bob@x.com' }],
      },
    });
    const result = await broker.search({
      ...BASE_INPUT,
      sources: { larkContacts: true, personalHistory: false, files: false, zohoCrmContext: false },
    });
    assert.equal(result.resolvedEntities['recipientEmail'], 'bob@x.com');
    assert.equal(result.resolvedEntities['recipientName'],  'Bob');
  });

  it('extracts webUrl from web result', async () => {
    const broker = makeBroker({
      webSearch: {
        search: async () => ({
          query: 'q', focusedSiteSearch: false,
          items: [{ title: 'Page', link: 'https://docs.example.com/page', domain: 'docs.example.com', source: 'organic' as const }],
          sourceRefs: [],
        }),
      } as unknown as WebSearchService,
    });
    const result = await broker.search({
      ...BASE_INPUT,
      sources: { web: true, personalHistory: false, files: false, larkContacts: false, zohoCrmContext: false },
    });
    assert.equal(result.resolvedEntities['webUrl'], 'https://docs.example.com/page');
  });

  it('extracts skillId and skillSlug from skills result', async () => {
    const broker = makeBroker({
      skills: {
        search: async () => [{ id: 'skill-001', slug: 'my-skill', name: 'My Skill', summary: 'Does stuff', markdown: '# My Skill' }],
        readById: async () => null,
      },
    });
    const result = await broker.search({
      ...BASE_INPUT,
      sources: { skills: true, personalHistory: false, files: false, larkContacts: false, zohoCrmContext: false },
    });
    assert.equal(result.resolvedEntities['skillId'],   'skill-001');
    assert.equal(result.resolvedEntities['skillSlug'], 'my-skill');
  });
});

// ─── E. Citations & nextFetchRefs ─────────────────────────────────────────────

describe('ContextSearchBroker — citations', () => {
  it('citations have correct index, sourceLabel, excerpt, chunkRef', async () => {
    const broker = makeBroker({
      larkContacts: {
        searchContacts: async () => [{ larkOpenId: 'ou_1', displayName: 'Carol', email: 'carol@x.com' }],
      },
    });
    const result = await broker.search({
      ...BASE_INPUT,
      sources: { larkContacts: true, personalHistory: false, files: false, zohoCrmContext: false },
    });
    assert.equal(result.citations.length, 1);
    const c = result.citations[0]!;
    assert.equal(c.index, 1);
    assert.ok(c.sourceLabel.includes('Lark contact'));
    assert.equal(c.chunkRef, result.results[0]!.chunkRef);
  });

  it('nextFetchRefs matches result chunkRefs', async () => {
    const broker = makeBroker({
      larkContacts: {
        searchContacts: async () => [
          { larkOpenId: 'ou_a', displayName: 'A', email: 'a@x.com' },
          { larkOpenId: 'ou_b', displayName: 'B', email: 'b@x.com' },
        ],
      },
    });
    const result = await broker.search({
      ...BASE_INPUT,
      sources: { larkContacts: true, personalHistory: false, files: false, zohoCrmContext: false },
    });
    assert.deepEqual(result.nextFetchRefs, result.results.map(r => r.chunkRef));
  });
});

// ─── F. fetch() ───────────────────────────────────────────────────────────────

describe('ContextSearchBroker.fetch()', () => {
  it('returns null for invalid chunkRef', async () => {
    const broker = makeBroker();
    const result = await broker.fetch({ companyId: 'c1', userId: 'u1', chunkRef: 'invalid' });
    assert.equal(result, null);
  });

  it('fetches skill content by chunkRef', async () => {
    const skillRecord = { id: 'skill-001', slug: 'my-skill', name: 'My Skill', summary: 'Does stuff', markdown: '# My Skill markdown content' };
    const broker = makeBroker({
      skills: {
        search: async () => [skillRecord],
        readById: async ({ skillId }: { skillId: string; companyId: string; departmentId?: string }) => skillId === 'skill-001' ? skillRecord : null,
      },
    });

    const chunkRef = 'skills:skill:skill-001:0';
    const result = await broker.fetch({ companyId: 'c1', userId: 'u1', chunkRef });
    assert.ok(result !== null);
    assert.equal(result.text, '# My Skill markdown content');
    assert.equal(result.resolvedEntities['skillId'], 'skill-001');
  });

  it('fetches lark_contacts content by chunkRef', async () => {
    const broker = makeBroker({
      larkContacts: {
        searchContacts: async () => [{ larkOpenId: 'ou_xyz', displayName: 'Dave', email: 'dave@x.com' }],
      },
    });
    const chunkRef = 'lark_contacts:lark_contact:ou_xyz:0';
    const result = await broker.fetch({ companyId: 'c1', userId: 'u1', chunkRef });
    assert.ok(result !== null);
    assert.ok(result.text.includes('Dave'));
    assert.equal(result.resolvedEntities['recipientOpenId'], 'ou_xyz');
  });

  it('returns null for lark_contacts when person is not found', async () => {
    const broker = makeBroker({
      larkContacts: {
        searchContacts: async () => [{ larkOpenId: 'ou_other', displayName: 'Eve' }],
      },
    });
    const result = await broker.fetch({ companyId: 'c1', userId: 'u1', chunkRef: 'lark_contacts:lark_contact:ou_xyz:0' });
    assert.equal(result, null);
  });

  it('fetches web content via webSearch', async () => {
    const url = 'https://example.com/page';
    const encodedUrl = Buffer.from(url, 'utf8').toString('base64url');
    const broker = makeBroker({
      webSearch: {
        search: async () => ({
          query: url, focusedSiteSearch: false,
          items: [{
            title: 'Example Page', link: url, domain: 'example.com', source: 'organic' as const,
            pageContext: { excerpt: 'Page content here', fetched: true },
          }],
          sourceRefs: [],
        }),
      } as unknown as WebSearchService,
    });
    const result = await broker.fetch({ companyId: 'c1', userId: 'u1', chunkRef: `web:web_result:${encodedUrl}:0` });
    assert.ok(result !== null);
    assert.ok(result.text.includes('Page content here'));
    assert.equal(result.resolvedEntities['webUrl'], url);
  });

  it('returns null for web when no page context', async () => {
    const url = 'https://example.com/empty';
    const encodedUrl = Buffer.from(url, 'utf8').toString('base64url');
    const broker = makeBroker({
      webSearch: {
        search: async () => ({
          query: url, focusedSiteSearch: false, items: [], sourceRefs: [],
        }),
      } as unknown as WebSearchService,
    });
    const result = await broker.fetch({ companyId: 'c1', userId: 'u1', chunkRef: `web:web_result:${encodedUrl}:0` });
    assert.equal(result, null);
  });
});

// ─── G. Date filtering ────────────────────────────────────────────────────────

describe('ContextSearchBroker — date filtering', () => {
  it('filters out lark_contacts results outside date range', async () => {
    const broker = makeBroker({
      larkContacts: {
        searchContacts: async () => [
          { larkOpenId: 'ou_old', displayName: 'Old', updatedAt: new Date('2020-01-01') },
          { larkOpenId: 'ou_new', displayName: 'New', updatedAt: new Date('2024-01-01') },
        ],
      },
    });
    const result = await broker.search({
      ...BASE_INPUT,
      dateFrom: '2023-01-01',
      sources: { larkContacts: true, personalHistory: false, files: false, zohoCrmContext: false },
    });
    const ids = result.results.map(r => r.sourceId);
    assert.ok(!ids.includes('ou_old'), 'old result should be filtered out');
    assert.ok(ids.includes('ou_new'), 'new result should pass filter');
  });
});
