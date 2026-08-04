import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  KNOWLEDGE_DOCUMENT_SEARCH_MAX_RESULTS,
  KnowledgeDocumentSearchService,
} from '../../src/application/knowledge/knowledge-document-search.service.ts';
import type {
  KnowledgeDocumentSemanticCandidate,
  KnowledgeDocumentSemanticIndex,
} from '../../src/application/knowledge/knowledge-document.port.ts';
import type {
  CanonicalKnowledgeDocumentChunk,
  KnowledgeDocumentRepository,
} from '../../src/application/knowledge/knowledge-document.repository.ts';
import { ok } from '../../src/shared/result.ts';

const identity = {
  query: 'rollback owners',
  companyId: 'company-1',
  userId: 'user-1',
  companyRole: 'MEMBER',
  channel: 'lark' as const,
};

const candidate = (
  resourceId: string,
  chunkOrdinal: number,
  scope: 'personal' | 'department' | 'company' = 'company',
): KnowledgeDocumentSemanticCandidate => ({
  resourceId,
  resourceVersion: 1,
  chunkOrdinal,
  scope,
  score: 1,
});

const canonical = (
  item: KnowledgeDocumentSemanticCandidate,
  text = `Approved excerpt for ${item.resourceId}`,
): CanonicalKnowledgeDocumentChunk => ({
  ...item,
  fileName: `${item.resourceId}.pdf`,
  text,
  pageStart: 2,
  pageEnd: 2,
  sectionPath: ['Rollback'],
});

class FakeDocuments implements KnowledgeDocumentRepository {
  keyword: KnowledgeDocumentSemanticCandidate[] = [];
  keywordError: Error | null = null;
  hydrated: CanonicalKnowledgeDocumentChunk[] | null = null;
  keywordInput: Parameters<KnowledgeDocumentRepository['keywordSearch']>[0] | undefined;
  hydrateInput: Parameters<KnowledgeDocumentRepository['hydrateAuthorized']>[0] | undefined;
  async beginIndex(): Promise<never> { throw new Error('not used'); }
  async replaceChunks() {}
  async markReady() {}
  async markFailed() {}
  async listOtherVersions() { return []; }
  async listByResource() { return []; }
  async markSuperseded() {}
  async markDeleted() {}
  async keywordSearch(input: Parameters<KnowledgeDocumentRepository['keywordSearch']>[0]) {
    this.keywordInput = input;
    if (this.keywordError) throw this.keywordError;
    return this.keyword;
  }
  async hydrateAuthorized(input: Parameters<KnowledgeDocumentRepository['hydrateAuthorized']>[0]) {
    this.hydrateInput = input;
    return this.hydrated ?? input.candidates.map(item => canonical(item));
  }
}

class FakeSemantic implements KnowledgeDocumentSemanticIndex {
  results: KnowledgeDocumentSemanticCandidate[] = [];
  status: 'available' | 'partial' | 'unavailable' = 'available';
  error: Error | null = null;
  input: Parameters<KnowledgeDocumentSemanticIndex['searchDocuments']>[0] | undefined;
  async projectDocument() {}
  async removeDocument() {}
  async searchDocuments(input: Parameters<KnowledgeDocumentSemanticIndex['searchDocuments']>[0]) {
    this.input = input;
    if (this.error) throw this.error;
    return { candidates: this.results, status: this.status };
  }
}

function build(options: {
  documents?: FakeDocuments;
  semantic?: FakeSemantic | null;
  allowed?: boolean;
  departments?: readonly { departmentId: string; departmentName: string }[];
} = {}) {
  const documents = options.documents ?? new FakeDocuments();
  const semantic = options.semantic === undefined ? new FakeSemantic() : options.semantic;
  const memberships = options.departments ?? [
    { departmentId: 'department-tech', departmentName: 'Tech Testing' },
  ];
  return {
    documents,
    semantic,
    service: new KnowledgeDocumentSearchService({
      documents,
      semantic,
      departments: { listActiveMemberships: async () => ok([...memberships]) },
      permissions: {
        canInvoke: async () => options.allowed === false
          ? ({ ok: false as const, error: new Error('permission denied') } as never)
          : ok(true as const),
      },
    }),
  };
}

describe('KnowledgeDocumentSearchService', () => {
  it('derives authorized scopes server-side, fuses keyword and semantic ranks, then hydrates canonically', async () => {
    const { service, documents, semantic } = build();
    documents.keyword = [candidate('keyword-only', 0), candidate('both', 1, 'department')];
    semantic!.results = [candidate('both', 1, 'department'), candidate('semantic-only', 2, 'personal')];
    documents.hydrated = [canonical(candidate('both', 1, 'department'))];

    const result = await service.search(identity);

    assert.equal(result.status, 'available');
    assert.deepEqual(documents.keywordInput?.departmentIds, ['department-tech']);
    assert.deepEqual(semantic!.input?.departments, [{ id: 'department-tech', name: 'Tech Testing' }]);
    assert.equal(documents.hydrateInput?.candidates[0]?.resourceId, 'both');
    assert.deepEqual(result.results, [{
      resourceId: 'both',
      scope: 'department',
      fileName: 'both.pdf',
      excerpt: 'Approved excerpt for both',
      pageStart: 2,
      pageEnd: 2,
      sectionPath: ['Rollback'],
    }]);
  });

  it('never returns a stale or unauthorized semantic hit rejected by canonical hydration', async () => {
    const { service, documents, semantic } = build({ departments: [] });
    semantic!.results = [candidate('other-user-private', 0, 'personal')];
    documents.hydrated = [];
    const result = await service.search(identity);
    assert.deepEqual(documents.hydrateInput?.departmentIds, []);
    assert.deepEqual(result.results, []);
  });

  it('degrades to either retrieval engine without falsely reporting full availability', async () => {
    const keywordDown = build();
    keywordDown.documents.keywordError = new Error('postgres search unavailable');
    keywordDown.semantic!.results = [candidate('semantic', 0)];
    assert.equal((await keywordDown.service.search(identity)).status, 'partial');

    const semanticDown = build();
    semanticDown.documents.keyword = [candidate('keyword', 0)];
    semanticDown.semantic!.error = new Error('hindsight unavailable');
    assert.equal((await semanticDown.service.search(identity)).status, 'partial');

    const bothDown = build();
    bothDown.documents.keywordError = new Error('postgres unavailable');
    bothDown.semantic!.error = new Error('hindsight unavailable');
    const unavailable = await bothDown.service.search(identity);
    assert.equal(unavailable.status, 'unavailable');
    assert.deepEqual(unavailable.results, []);
  });

  it('reports canonical hydration failure explicitly and returns no unverified text', async () => {
    const { service, documents } = build();
    documents.keyword = [candidate('keyword', 0)];
    documents.hydrateAuthorized = async () => {
      throw new Error('canonical document store unavailable');
    };

    const result = await service.search(identity);

    assert.equal(result.status, 'unavailable');
    assert.equal(result.degradation, 'canonical_hydration_failed');
    assert.deepEqual(result.results, []);
  });

  it('uses scope precedence only when reciprocal relevance ties and preserves provenance', async () => {
    const { service, documents, semantic } = build();
    documents.keyword = [candidate('personal', 0, 'personal')];
    semantic!.results = [candidate('company', 0, 'company')];

    const result = await service.search(identity);

    assert.deepEqual(result.results.map(item => ({ resourceId: item.resourceId, scope: item.scope })), [
      { resourceId: 'company', scope: 'company' },
      { resourceId: 'personal', scope: 'personal' },
    ]);
  });

  it('honors cancellation while document retrieval is pending', async () => {
    const controller = new AbortController();
    const documents = new FakeDocuments();
    documents.keywordSearch = async () => new Promise<never>(() => {});
    const { service } = build({ documents, semantic: null });

    const pending = service.search({ ...identity, abortSignal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError');
  });

  it('fails before membership or retrieval when the central permission authority denies read', async () => {
    const { service, documents, semantic } = build({ allowed: false });
    await assert.rejects(service.search(identity), /permission denied/);
    assert.equal(documents.keywordInput, undefined);
    assert.equal(semantic!.input, undefined);
  });

  it('bounds excerpts and result count before returning any text to the agent', async () => {
    const { service, documents } = build({ semantic: null });
    documents.keyword = Array.from({ length: 20 }, (_, index) => candidate(`resource-${index}`, index));
    documents.hydrated = documents.keyword.map(item => canonical(item, 'x'.repeat(1_600)));
    const result = await service.search(identity);
    assert.ok(result.results.length <= KNOWLEDGE_DOCUMENT_SEARCH_MAX_RESULTS);
    assert.ok(result.results.reduce((sum, item) => sum + item.excerpt.length, 0) <= 7_000);
    assert.ok(result.results.every(item => item.excerpt.length <= 1_600));
  });

  it('rejects empty and oversized queries before touching infrastructure', async () => {
    const { service, documents } = build();
    await assert.rejects(service.search({ ...identity, query: '   ' }), /empty or too long/);
    await assert.rejects(service.search({ ...identity, query: 'x'.repeat(801) }), /empty or too long/);
    assert.equal(documents.keywordInput, undefined);
  });
});
