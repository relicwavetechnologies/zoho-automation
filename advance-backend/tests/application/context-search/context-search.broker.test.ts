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

function makeDeps(overrides: Partial<ContextSearchBrokerDeps> = {}): ContextSearchBrokerDeps {
  return {
    vectorStore:  emptyVectorStore,
    embedding:    nullEmbedding,
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

  it('has no web source at all, not merely a disabled one', async () => {
    // Context search answers from what the company knows; the public internet
    // is the separate webSearch tool. A disabled-by-default flag was not
    // enough — the model could set it, which made the authority of an answer
    // depend on a boolean it chose for itself.
    const result = await makeBroker().search({
      ...BASE_INPUT,
      sources: { web: true } as never,
    });

    assert.equal(
      (result.sourceCoverage as Record<string, unknown>)['web'], undefined,
      'web is not a source key',
    );
    assert.deepEqual(
      result.results.filter(r => r.scope === 'web'), [],
      'and nothing can arrive under a web scope',
    );
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
    // Only skills requested — larkContacts should be disabled
    await broker.search({ ...BASE_INPUT, sources: { skills: true, larkContacts: false } });
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
      skills: {
        search:   async () => [{
          id: 'sk1', slug: 'onboarding', name: 'Onboarding', markdown: 'How we onboard new hires.',
        }],
        readById: async () => null,
      },
    });

    const result = await broker.search({ ...BASE_INPUT, sources: { larkContacts: true, skills: true, personalHistory: false, files: false, zohoCrmContext: false } });
    const scopes = result.results.map(r => r.scope);
    assert.ok(scopes.includes('lark_contacts'), 'should include lark result');
    assert.ok(scopes.includes('skills'), 'should include skill result');
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
      larkContacts: {
        searchContacts: async () => [{ larkOpenId: 'ou_auth', displayName: 'Dana', email: 'dana@x.com' }],
      },
    });
    const result = await broker.search({
      ...BASE_INPUT,
      sources: { larkContacts: true, personalHistory: false, files: false, zohoCrmContext: false },
    });
    assert.equal(result.results[0]?.authorityLevel, 'contextual');
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

  it('cannot fetch a web chunkRef any more', async () => {
    // Old citations may still carry web refs. Returning null is the honest
    // answer — the broker has no way to fetch that page, and pretending
    // otherwise would surface an empty excerpt as if it were content.
    const encodedUrl = Buffer.from('https://example.com/page', 'utf8').toString('base64url');
    const result = await makeBroker().fetch({
      companyId: 'c1', userId: 'u1', chunkRef: `web:web_result:${encodedUrl}:0`,
    });
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

// ─── H. Scoping a file search to one document ─────────────────────────────────

describe('ContextSearchBroker — fileAssetId scoping', () => {
  /** Captures what the vector store was asked for, and returns one chunk. */
  function captureVectorStore(captured: { query?: any }): VectorStoreAdapter {
    return {
      ...emptyVectorStore,
      search: async (query: any) => {
        captured.query = query;
        return [{
          hits: [{
            sourceId: 'fa-1', chunkIndex: 0, score: 0.9,
            payload: { _chunk: 'Clause 7 covers termination.', fileName: 'contract.pdf' },
          }],
        }];
      },
    } as VectorStoreAdapter;
  }

  it('passes the file id straight to the vector store', async () => {
    const captured: { query?: any } = {};
    const broker = makeBroker({
      vectorStore: captureVectorStore(captured),
      fileAssetRepo: {
        searchByFilename: async () => { throw new Error('filename resolution must not run'); },
      } as never,
    });

    const result = await broker.search({
      ...BASE_INPUT,
      fileAssetId: 'fa-1',
      sources: { files: true, personalHistory: false, larkContacts: false, zohoCrmContext: false },
    });

    assert.equal(captured.query?.fileAssetId, 'fa-1');
    assert.equal(result.results[0]?.sourceId, 'fa-1');
  });

  it('skips filename guessing entirely when the id is known', async () => {
    // The open path scores every filename in the company by trigram and can
    // hand the tie-break to an LLM. Both can pick the wrong document; the
    // repo stub above throws to prove neither runs.
    const captured: { query?: any } = {};
    const broker = makeBroker({
      vectorStore: captureVectorStore(captured),
      fileAssetRepo: {
        searchByFilename: async () => { throw new Error('filename resolution must not run'); },
      } as never,
      groqApiKey: 'gsk-test',
    });

    const result = await broker.search({
      ...BASE_INPUT,
      query: 'contract.pdf',
      fileAssetId: 'fa-1',
      sources: { files: true, personalHistory: false, larkContacts: false, zohoCrmContext: false },
    });

    assert.equal(result.results.length, 1, 'the scoped search still returned its chunk');
  });

  it('still applies the access filters — an id is not authorisation', async () => {
    // Quoting a fileAssetId out of someone else's conversation must not read
    // their document. The store decides that, so what matters here is that
    // the requester's identity and chat scope are still handed to it.
    const captured: { query?: any } = {};
    const broker = makeBroker({ vectorStore: captureVectorStore(captured) });

    await broker.search({
      ...BASE_INPUT,
      fileAssetId: 'fa-1',
      requesterAiRole: 'MEMBER',
      larkChatId: 'oc_room',
      sources: { files: true, personalHistory: false, larkContacts: false, zohoCrmContext: false },
    });

    assert.equal(captured.query?.companyId, 'company-1');
    assert.equal(captured.query?.requesterUserId, 'user-1');
    assert.equal(captured.query?.requesterAiRole, 'MEMBER');
    assert.equal(captured.query?.larkChatId, 'oc_room');
  });

  it('does not group by documentKey, which would cap one file\'s chunks', async () => {
    // Grouping exists to spread results across documents. Inside a single
    // file it does the opposite of what "tell me about this document" wants.
    const captured: { query?: any } = {};
    const broker = makeBroker({ vectorStore: captureVectorStore(captured) });

    await broker.search({
      ...BASE_INPUT,
      fileAssetId: 'fa-1',
      sources: { files: true, personalHistory: false, larkContacts: false, zohoCrmContext: false },
    });

    assert.equal(captured.query?.groupByField, undefined);
  });

  it('carries the chat scope into an open file search too', async () => {
    const captured: { query?: any } = {};
    const broker = makeBroker({ vectorStore: captureVectorStore(captured) });

    await broker.search({
      ...BASE_INPUT,
      larkChatId: 'oc_room',
      sources: { files: true, personalHistory: false, larkContacts: false, zohoCrmContext: false },
    });

    assert.equal(captured.query?.larkChatId, 'oc_room');
  });
});

// ─── I. The filename shortcut must not bypass the scope filters ───────────────

describe('ContextSearchBroker — filename fast-path scope', () => {
  /**
   * `searchByFilename` is company-wide by design: its `ingestionStatus: 'done'`
   * branch matches every indexed file, whoever uploaded it. The fast path that
   * consumes it returns file *content* without ever touching the vector store,
   * so it never passes through the visibility / owner / chat-scope filters.
   */
  const foreignFile = {
    id: 'fa-secret', fileName: 'Salary-Structure-2026.pdf', mimeType: 'application/pdf',
    ingestionStatus: 'done', cloudinaryUrl: 'https://cdn/secret.pdf',
    createdAt: new Date('2026-01-01'), uploaderUserId: 'u-insider',
  };

  function brokerFor(uploaderUserId: string, onRead: () => void) {
    return makeBroker({
      fileAssetRepo: {
        searchByFilename: async () => ({ ok: true, value: [{ ...foreignFile, uploaderUserId }] }),
      } as never,
      vectorDocRepo: {
        findByFileAsset: async () => {
          onRead();
          return { ok: true, value: [{ chunkIndex: 0, chunkText: 'CEO base salary 90,00,000 INR', payload: {} }] };
        },
      } as never,
      groqApiKey: 'gsk-test',
    });
  }

  const query = {
    ...BASE_INPUT,
    query: 'Salary Structure 2026',
    sources: { files: true, personalHistory: false, larkContacts: false, zohoCrmContext: false },
  };

  it('does not serve a colleague\'s document through the filename shortcut', async () => {
    // The concrete leak: a document posted into a private Lark room was
    // returned in full to someone who was never in that room, simply because
    // they typed its name into a DM.
    let contentRead = false;
    const result = await brokerFor('u-insider', () => { contentRead = true; }).search({
      ...query,
      userId: 'user-1',
      larkChatId: 'oc_unrelated_dm',
    });

    assert.deepEqual(result.results, [], 'nothing is returned to an outsider');
    assert.equal(contentRead, false, 'and the document was never even read');
  });

  it('still serves the requester their own file', async () => {
    // Failing closed must not mean failing empty: the shortcut exists so that
    // naming your own file finds it, and that has to keep working.
    let contentRead = false;
    const result = await brokerFor('user-1', () => { contentRead = true; }).search({
      ...query,
      userId: 'user-1',
    });

    assert.equal(contentRead, true);
    assert.equal(result.results.length, 1);
    assert.match(result.results[0]!.excerpt, /CEO base salary/);
  });

  it('does not leak a colleague\'s filename or CDN link through the fallback', async () => {
    // Stage 3 returns less than Stage 0 — a name and a URL rather than the
    // text — but "Redundancies-March.pdf" plus a publicly deliverable link is
    // itself the disclosure.
    const result = await makeBroker({
      fileAssetRepo: {
        searchByFilename: async () => ({ ok: true, value: [foreignFile] }),
      } as never,
      // No repo to read content with, so Stage 0 cannot answer and Stage 3 runs.
    }).search({ ...query, userId: 'user-1' });

    assert.deepEqual(result.results, []);
  });
});
