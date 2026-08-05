import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Budget, MemoryItemInput } from '@vectorize-io/hindsight-client';
import {
  companyBankId,
  departmentBankId,
  HindsightMemoryService,
  personalBankId,
  type HindsightMemoryClient,
  type HindsightRecallEntry,
} from '../../src/infrastructure/knowledge/hindsight-memory.service.ts';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
};

const projectionMetadata = (resourceId: string) => ({
  source: 'knowledge_core',
  resource_id: resourceId,
});

class StubHindsightClient implements HindsightMemoryClient {
  readonly ensuredBanks: string[] = [];
  readonly recalls: Array<{
    bankId: string;
    query: string;
    tags?: readonly string[];
    tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict' | 'exact';
  }> = [];
  readonly batches: Array<{ bankId: string; items: readonly MemoryItemInput[] }> = [];
  readonly deletedDocuments: Array<{ bankId: string; documentId: string }> = [];
  readonly deletedBanks: string[] = [];
  recallFailureBank: string | undefined;
  includeRetiredLegacyEntry = false;
  includeDocumentEntries = false;

  async getVersion(_options: { signal: AbortSignal }): Promise<{ readonly version?: string }> {
    return { version: 'test' };
  }

  async ensureBank(bankId: string, _options: { signal: AbortSignal }): Promise<void> {
    this.ensuredBanks.push(bankId);
  }

  async retainBatch(
    bankId: string,
    items: readonly MemoryItemInput[],
    _options: { signal: AbortSignal },
  ): Promise<void> {
    this.batches.push({ bankId, items });
  }

  async recall(
    bankId: string,
    query: string,
    options: {
      maxTokens: number;
      budget: Budget;
      tags?: readonly string[];
      tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict' | 'exact';
      signal: AbortSignal;
    },
  ): Promise<HindsightRecallEntry[]> {
    this.recalls.push({
      bankId,
      query,
      ...(options.tags ? { tags: options.tags } : {}),
      ...(options.tagsMatch ? { tagsMatch: options.tagsMatch } : {}),
    });
    if (bankId === this.recallFailureBank) throw new Error('scope unavailable');
    if (this.includeDocumentEntries) {
      if (bankId === personalBankId('co-1', 'user-1')) {
        return [
          {
            id: 'file-personal',
            text: 'File: personal.pdf\nPersonal document content.',
            score: 0.95,
            metadata: {
              source: 'knowledge_file', resource_id: 'file-user',
              resource_version: '2', chunk_ordinal: '0',
            },
          },
          { id: 'memory-entry', text: 'Not a file.', score: 1, metadata: projectionMetadata('memory-1') },
        ];
      }
      if (bankId === departmentBankId('co-1', 'dept-finance')) {
        return [{
          id: 'file-department', text: 'Finance file.', score: 0.8,
          metadata: {
            source: 'knowledge_file', resource_id: 'file-finance',
            resource_version: '1', chunk_ordinal: '3',
          },
        }];
      }
      if (bankId === companyBankId('co-1')) {
        return [{
          id: 'file-company', text: 'Company file.', score: 0.7,
          metadata: {
            source: 'knowledge_file', resource_id: 'file-company',
            resource_version: '4', chunk_ordinal: '2',
          },
        }];
      }
      return [];
    }
    if (bankId === personalBankId('co-1', 'user-1')) {
      return [
        ...(this.includeRetiredLegacyEntry
          ? [{ id: 'legacy', text: 'Retired local-memory claim.', score: 99 }]
          : []),
        { id: 'u1', text: 'User prefers tables.', score: 0.9, metadata: projectionMetadata('resource-user') },
        { id: 'u2', text: 'x'.repeat(501), score: 1, metadata: projectionMetadata('resource-oversized') },
      ];
    }
    if (bankId === departmentBankId('co-1', 'dept-finance')) {
      return [{ id: 'd1', text: 'Finance closes books on day five.', score: 0.8, metadata: projectionMetadata('resource-finance') }];
    }
    if (bankId === departmentBankId('co-1', 'dept-sales')) {
      return [{ id: 'd2', text: 'Sales reports pipeline weekly.', score: 0.85, metadata: projectionMetadata('resource-sales') }];
    }
    if (bankId === companyBankId('co-1')) {
      return [
        { id: 'c1', text: 'Company fiscal year starts in April.', score: 0.7, metadata: projectionMetadata('resource-company') },
        { id: 'c2', text: 'User prefers tables.', score: 0.6, metadata: projectionMetadata('resource-company-duplicate') },
      ];
    }
    return [];
  }

  async deleteDocument(
    bankId: string,
    documentId: string,
    _options: { signal: AbortSignal },
  ): Promise<void> {
    this.deletedDocuments.push({ bankId, documentId });
  }

  async listDocuments(_bankId: string, _options: {
    limit: number;
    offset: number;
    signal: AbortSignal;
  }): Promise<readonly { readonly id: string; readonly metadata?: Record<string, unknown> }[]> {
    return [];
  }

  async deleteBank(bankId: string, _options: { signal: AbortSignal }): Promise<void> {
    this.deletedBanks.push(bankId);
  }

}

function makeService(client = new StubHindsightClient(), recallConcurrency = 2) {
  return {
    client,
    service: new HindsightMemoryService({
      baseUrl: 'http://127.0.0.1:8888',
      maxResults: 12,
      recallMaxTokens: 1_200,
      recallBudget: 'mid',
      requestTimeoutMs: 10_000,
      recallConcurrency,
      logger: noopLogger,
      client,
    }),
  };
}

describe('HindsightMemoryService', () => {
  it('reports Hindsight readiness through the client health endpoint', async () => {
    const { service } = makeService();
    assert.deepEqual(await service.readiness(), { status: 'ok', version: 'test' });
  });

  it('derives isolated opaque banks for company, department, and personal scope', () => {
    const personal = personalBankId('co-1', 'user-1');
    const department = departmentBankId('co-1', 'dept-finance');
    const company = companyBankId('co-1');

    assert.notEqual(personal, department);
    assert.notEqual(personal, company);
    assert.match(personal, /^divo-v1-company-[a-f0-9]{64}-user-[a-f0-9]{64}$/);
    assert.doesNotMatch(personal, /co-1|user-1/);
    assert.doesNotMatch(department, /dept-finance/);
  });

  it('fans recall across personal, every active department, and company with bounded deduplication', async () => {
    const { service, client } = makeService();
    const result = await service.searchForRecall({
      query: 'reporting conventions',
      userId: 'user-1',
      companyId: 'co-1',
      departments: [
        { id: 'dept-finance', name: 'Finance' },
        { id: 'dept-sales', name: 'Sales' },
      ],
      departmentPreferences: ['Sales'],
      limit: 4,
      maxFactChars: 500,
      maxTotalChars: 1_500,
    });

    assert.deepEqual(result.coverage, {
      personal: 'searched',
      departments: { searched: 2, failed: 0 },
      company: 'searched',
    });
    assert.equal(result.status, 'available');
    assert.deepEqual(result.facts, [
      { scope: 'personal', text: 'User prefers tables.', resourceId: 'resource-user' },
      { scope: 'department', text: 'Sales reports pipeline weekly.', department: { name: 'Sales' }, resourceId: 'resource-sales' },
      { scope: 'company', text: 'Company fiscal year starts in April.', resourceId: 'resource-company' },
      { scope: 'department', text: 'Finance closes books on day five.', department: { name: 'Finance' }, resourceId: 'resource-finance' },
    ]);
    assert.deepEqual(client.recalls.map(call => call.bankId), [
      personalBankId('co-1', 'user-1'),
      departmentBankId('co-1', 'dept-finance'),
      departmentBankId('co-1', 'dept-sales'),
      companyBankId('co-1'),
    ]);
    assert.ok(client.recalls.every(call =>
      call.tagsMatch === 'all_strict'
      && call.tags?.length === 1
      && call.tags[0] === 'source:knowledge_core'));
  });

  it('does not open the personal bank when personal recall is excluded', async () => {
    const { service, client } = makeService();
    const result = await service.searchForRecall({
      query: 'shared policy',
      userId: 'user-1',
      companyId: 'co-1',
      departments: [{ id: 'dept-finance', name: 'Finance' }],
      includePersonal: false,
      limit: 12,
      maxFactChars: 500,
      maxTotalChars: 3_000,
    });

    assert.equal(client.recalls.some(call => call.bankId === personalBankId('co-1', 'user-1')), false);
    assert.equal(result.coverage.personal, 'failed');
    assert.equal(result.status, 'available');
  });

  it('bounds concurrent scope recalls without skipping any authorized department', async () => {
    class ConcurrencyClient extends StubHindsightClient {
      active = 0;
      maxActive = 0;

      override async recall(...args: Parameters<StubHindsightClient['recall']>) {
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);
        try {
          await new Promise(resolve => setTimeout(resolve, 5));
          return await super.recall(...args);
        } finally {
          this.active -= 1;
        }
      }
    }
    const client = new ConcurrencyClient();
    const { service } = makeService(client, 2);
    const departments = Array.from({ length: 8 }, (_, index) => ({
      id: `department-${index}`,
      name: `Department ${index}`,
    }));

    const result = await service.searchForRecall({
      query: 'policy',
      userId: 'user-1',
      companyId: 'co-1',
      departments,
      limit: 12,
      maxFactChars: 500,
      maxTotalChars: 3_000,
    });

    assert.equal(client.maxActive, 2);
    assert.equal(client.recalls.length, departments.length + 2);
    assert.equal(result.coverage.departments.searched, departments.length);
  });

  it('reports partial scope failure without reading an unauthorized bank', async () => {
    const client = new StubHindsightClient();
    client.recallFailureBank = departmentBankId('co-1', 'dept-finance');
    const { service } = makeService(client);

    const result = await service.searchForRecall({
      query: 'closing',
      userId: 'user-1',
      companyId: 'co-1',
      departments: [{ id: 'dept-finance', name: 'Finance' }],
      limit: 12,
      maxFactChars: 500,
      maxTotalChars: 3_000,
    });

    assert.equal(result.status, 'partial');
    assert.deepEqual(result.coverage, {
      personal: 'searched',
      departments: { searched: 0, failed: 1 },
      company: 'searched',
    });
  });

  it('projects only canonical resource versions with stable document ownership', async () => {
    const { service, client } = makeService();
    await service.projectExplicitResource({
      resourceId: 'resource-1',
      facts: ['Finance closes on day five.', 'Use IST in monthly reports.'],
      previousFactCount: 0,
      scope: 'department',
      userId: 'user-1',
      companyId: 'co-1',
      departmentId: 'dept-finance',
    });

    assert.equal(client.batches.length, 1);
    assert.deepEqual(client.ensuredBanks, [departmentBankId('co-1', 'dept-finance')]);
    assert.equal(client.batches[0]?.bankId, departmentBankId('co-1', 'dept-finance'));
    assert.deepEqual(client.batches[0]?.items.map(item => ({
      content: item.content,
      strategy: item.strategy,
      updateMode: item.update_mode,
      source: item.metadata?.['source'],
      resourceId: item.metadata?.['resource_id'],
      documentId: item.document_id,
    })), [
      {
        content: 'Finance closes on day five.',
        strategy: 'exact',
        updateMode: 'replace',
        source: 'knowledge_core',
        resourceId: 'resource-1',
        documentId: client.batches[0]?.items[0]?.document_id,
      },
      {
        content: 'Use IST in monthly reports.',
        strategy: 'exact',
        updateMode: 'replace',
        source: 'knowledge_core',
        resourceId: 'resource-1',
        documentId: client.batches[0]?.items[1]?.document_id,
      },
    ]);
    assert.match(client.batches[0]?.items[0]?.document_id ?? '', /^divo-knowledge-[a-f0-9]{64}$/);
    assert.notEqual(
      client.batches[0]?.items[0]?.document_id,
      client.batches[0]?.items[1]?.document_id,
    );
  });

  it('retains large resources in timeout-bounded idempotent batches', async () => {
    const { service, client } = makeService();
    await service.projectExplicitResource({
      resourceId: 'resource-batched',
      facts: Array.from({ length: 9 }, (_, index) => `Fact ${index}.`),
      previousFactCount: 0,
      scope: 'personal',
      userId: 'user-1',
      companyId: 'co-1',
    });

    assert.deepEqual(client.batches.map(batch => batch.items.length), [4, 4, 1]);
    assert.equal(new Set(client.batches.flatMap(batch =>
      batch.items.map(item => item.document_id))).size, 9);
  });

  it('cleans trailing projected documents discovered from Hindsight metadata', async () => {
    class ListingClient extends StubHindsightClient {
      override async listDocuments() {
        const current = this.batches[0]?.items[0]?.document_id;
        return [
          { id: String(current), metadata: { source: 'knowledge_core', resource_id: 'resource-1' } },
          { id: 'stale-document', metadata: { source: 'knowledge_core', resource_id: 'resource-1' } },
          { id: 'other-resource', metadata: { source: 'knowledge_core', resource_id: 'resource-2' } },
        ];
      }
    }
    const client = new ListingClient();
    const { service } = makeService(client);

    await service.projectExplicitResource({
      resourceId: 'resource-1',
      facts: ['Current fact.'],
      previousFactCount: 0,
      scope: 'company',
      userId: 'user-1',
      companyId: 'co-1',
    });

    assert.deepEqual(client.deletedDocuments.map(item => item.documentId), ['stale-document']);
  });

  it('deletes known trailing IDs even when mixed list metadata is incomplete', async () => {
    class MixedMetadataClient extends StubHindsightClient {
      override async listDocuments() {
        return [
          { id: 'metadata-free' },
          { id: 'other-resource', metadata: { source: 'knowledge_core', resource_id: 'resource-2' } },
        ];
      }
    }
    const client = new MixedMetadataClient();
    const { service } = makeService(client);

    await service.projectExplicitResource({
      resourceId: 'resource-1',
      facts: ['Current fact.'],
      previousFactCount: 3,
      scope: 'company',
      userId: 'user-1',
      companyId: 'co-1',
    });

    assert.equal(client.deletedDocuments.length, 2);
    assert.ok(client.deletedDocuments.every(item =>
      item.bankId === companyBankId('co-1')
      && /^divo-knowledge-[a-f0-9]{64}$/u.test(item.documentId)));
  });

  it('treats SDK-shaped 404 delete errors as idempotently complete', async () => {
    class NotFoundClient extends StubHindsightClient {
      override async deleteDocument(): Promise<void> {
        throw new Error('deleteDocument failed: {"status":404,"detail":"not found"}');
      }
    }
    const { service } = makeService(new NotFoundClient());

    await service.removeProjectedResource({
      resourceId: 'resource-1',
      factCount: 2,
      companyId: 'co-1',
      userId: 'user-1',
      scope: 'company',
    });
  });

  it('treats Hindsight message-only document-not-found deletes as idempotently complete', async () => {
    class MessageOnlyNotFoundClient extends StubHindsightClient {
      override async deleteDocument(): Promise<void> {
        throw new Error('deleteDocument failed: {"detail":"Document not found"}');
      }
    }
    const { service } = makeService(new MessageOnlyNotFoundClient());

    await service.removeProjectedResource({
      resourceId: 'resource-message-only-not-found',
      factCount: 2,
      companyId: 'co-1',
      userId: 'user-1',
      scope: 'company',
    });
  });

  it('returns a bounded personal snapshot for the desktop hot context', async () => {
    const client = new StubHindsightClient();
    client.includeRetiredLegacyEntry = true;
    const { service } = makeService(client);
    const snapshot = await service.getPersonalSnapshot({
      userId: 'user-1',
      companyId: 'co-1',
      limit: 12,
      maxFactChars: 500,
      maxTotalChars: 2_200,
    });

    assert.deepEqual(snapshot, ['User prefers tables.']);
  });

  it('excludes metadata-free facts from the retired memory path', async () => {
    const client = new StubHindsightClient();
    client.includeRetiredLegacyEntry = true;
    const { service } = makeService(client);

    const result = await service.searchForRecall({
      query: 'reporting conventions',
      userId: 'user-1',
      companyId: 'co-1',
      departments: [],
      limit: 12,
      maxFactChars: 500,
      maxTotalChars: 3_000,
    });

    assert.equal(result.facts.some(fact => fact.text.includes('Retired local-memory')), false);
  });

  it('removes only documents owned by the requested canonical resource', async () => {
    const { service, client } = makeService();
    await service.removeProjectedResource({
      resourceId: 'resource-1',
      factCount: 2,
      companyId: 'co-1',
      userId: 'user-1',
      scope: 'company',
    });
    assert.equal(client.deletedDocuments.length, 2);
    assert.ok(client.deletedDocuments.every(entry => entry.bankId === companyBankId('co-1')));
    assert.notEqual(client.deletedDocuments[0]?.documentId, client.deletedDocuments[1]?.documentId);
  });

  it('projects file chunks into only the requested opaque scope with stable versioned ownership', async () => {
    const { service, client } = makeService();
    await service.projectDocument({
      resourceId: 'file-resource-1',
      resourceVersion: 3,
      fileName: 'release.pdf',
      scope: 'personal',
      companyId: 'co-1',
      ownerUserId: 'user-1',
      chunks: [{
        ordinal: 0,
        text: 'Rollback happens before Owners.',
        textHash: 'a'.repeat(64),
        charCount: 31,
        tokenEstimate: 8,
        pageStart: 7,
        pageEnd: 7,
        sectionPath: ['Rollback'],
      }],
    });

    assert.deepEqual(client.ensuredBanks, [personalBankId('co-1', 'user-1')]);
    const batch = client.batches[0];
    assert.equal(batch?.bankId, personalBankId('co-1', 'user-1'));
    assert.deepEqual(batch?.items[0]?.tags, ['source:knowledge_file']);
    assert.equal(batch?.items[0]?.metadata?.['source'], 'knowledge_file');
    assert.equal(batch?.items[0]?.metadata?.['resource_version'], '3');
    assert.equal(batch?.items[0]?.metadata?.['chunk_ordinal'], '0');
    assert.match(batch?.items[0]?.content ?? '', /File: release\.pdf[\s\S]*Page 7[\s\S]*Rollback happens/);
    assert.match(batch?.items[0]?.document_id ?? '', /^divo-file-[a-f0-9]{64}$/);
  });

  it('searches only the caller personal bank, active department banks, and company bank with strict file tags', async () => {
    const client = new StubHindsightClient();
    client.includeDocumentEntries = true;
    const { service } = makeService(client);

    const result = await service.searchDocuments({
      query: 'rollback procedure',
      userId: 'user-1',
      companyId: 'co-1',
      departments: [{ id: 'dept-finance', name: 'Finance' }],
      limit: 10,
    });

    assert.equal(result.status, 'available');
    assert.deepEqual(result.candidates.map(item => item.resourceId), [
      'file-user', 'file-finance', 'file-company',
    ]);
    assert.deepEqual(client.recalls.map(call => call.bankId), [
      personalBankId('co-1', 'user-1'),
      departmentBankId('co-1', 'dept-finance'),
      companyBankId('co-1'),
    ]);
    assert.ok(client.recalls.every(call => call.tagsMatch === 'all_strict'));
    assert.ok(client.recalls.every(call => call.tags?.[0] === 'source:knowledge_file'));
  });

  it('never reads another user personal file bank', async () => {
    const client = new StubHindsightClient();
    client.includeDocumentEntries = true;
    const { service } = makeService(client);
    const result = await service.searchDocuments({
      query: 'private procedure',
      userId: 'user-2',
      companyId: 'co-1',
      departments: [],
      limit: 10,
    });

    assert.equal(client.recalls.some(call => call.bankId === personalBankId('co-1', 'user-1')), false);
    assert.equal(result.candidates.some(item => item.resourceId === 'file-user'), false);
    assert.equal(result.candidates.some(item => item.resourceId === 'file-company'), true);
  });

  it('deletes the exact versioned file chunk documents from their original bank', async () => {
    const { service, client } = makeService();
    await service.removeDocument({
      resourceId: 'file-resource-1',
      resourceVersion: 3,
      chunkCount: 2,
      scope: 'department',
      companyId: 'co-1',
      departmentId: 'dept-finance',
    });
    assert.equal(client.deletedDocuments.length, 2);
    assert.ok(client.deletedDocuments.every(item => item.bankId === departmentBankId('co-1', 'dept-finance')));
    assert.notEqual(client.deletedDocuments[0]?.documentId, client.deletedDocuments[1]?.documentId);
  });
});
