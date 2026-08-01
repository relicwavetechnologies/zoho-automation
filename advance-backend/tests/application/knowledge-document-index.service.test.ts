import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { KnowledgeDocumentIndexService } from '../../src/application/knowledge/knowledge-document-index.service.ts';
import type {
  KnowledgeDocumentChunkInput,
  KnowledgeDocumentParser,
  KnowledgeDocumentSemanticIndex,
} from '../../src/application/knowledge/knowledge-document.port.ts';
import type {
  KnowledgeDocumentRepository,
  KnowledgeFileDocumentSnapshot,
} from '../../src/application/knowledge/knowledge-document.repository.ts';
import type {
  KnowledgePrivateObjectStore,
  ReadableKnowledgeFile,
} from '../../src/application/knowledge/knowledge-file.service.ts';
import type { Logger } from '../../src/shared/logger.ts';

const logger: Logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};

const body = Buffer.from('Rollback\n\nRestore the previous release before notifying the owners.');

function file(overrides: Partial<ReadableKnowledgeFile> = {}): ReadableKnowledgeFile {
  return {
    id: 'asset-1',
    companyId: 'company-1',
    uploadedById: 'user-1',
    knowledgeResourceId: 'resource-1',
    provider: 'fake',
    storageKey: 'private/resource-1.pdf',
    resourceType: 'raw',
    deliveryType: 'authenticated',
    fileName: 'release.pdf',
    mimeType: 'application/pdf',
    sizeBytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    status: 'attached',
    expiresAt: new Date(Date.now() + 60_000),
    isCurrentVersion: true,
    resource: {
      companyId: 'company-1',
      scope: 'department',
      ownerUserId: null,
      departmentId: 'department-1',
      status: 'active',
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<KnowledgeFileDocumentSnapshot> = {}): KnowledgeFileDocumentSnapshot {
  return {
    id: 'document-1',
    companyId: 'company-1',
    resourceId: 'resource-1',
    resourceVersion: 2,
    fileAssetId: 'asset-1',
    sourceSha256: file().sha256,
    mimeType: 'application/pdf',
    status: 'processing',
    chunkCount: 0,
    scope: 'department',
    ownerUserId: null,
    departmentId: 'department-1',
    ...overrides,
  };
}

class FakeDocuments implements KnowledgeDocumentRepository {
  readonly events: string[] = [];
  readonly failures: Array<{ id: string; code: string; message: string }> = [];
  replacement: Parameters<KnowledgeDocumentRepository['replaceChunks']>[0] | undefined;
  previous: KnowledgeFileDocumentSnapshot[] = [];
  all: KnowledgeFileDocumentSnapshot[] = [];

  async beginIndex() { this.events.push('begin'); return snapshot(); }
  async replaceChunks(input: Parameters<KnowledgeDocumentRepository['replaceChunks']>[0]) {
    this.events.push('replace'); this.replacement = input;
  }
  async markReady(id: string) { this.events.push(`ready:${id}`); }
  async markFailed(id: string, error: { code: string; message: string }) {
    this.events.push(`failed:${id}`); this.failures.push({ id, ...error });
  }
  async listOtherVersions() { this.events.push('previous'); return this.previous; }
  async listByResource() { return this.all; }
  async markSuperseded(id: string) { this.events.push(`superseded:${id}`); }
  async markDeleted(id: string) { this.events.push(`deleted:${id}`); }
  async keywordSearch() { return []; }
  async hydrateAuthorized() { return []; }
}

class FakeObjects implements KnowledgePrivateObjectStore {
  readonly provider = 'fake';
  readonly isAvailable = true;
  reads = 0;
  value = body;
  async upload(): Promise<never> { throw new Error('not used'); }
  signedDownloadUrl() { return ''; }
  async read() { this.reads += 1; return this.value; }
  async delete() {}
}

class FakeSemantic implements KnowledgeDocumentSemanticIndex {
  readonly events: string[];
  constructor(events: string[]) { this.events = events; }
  async projectDocument(input: { chunks: readonly KnowledgeDocumentChunkInput[] }) {
    this.events.push(`semantic:${input.chunks.length}`);
  }
  async removeDocument(input: { resourceVersion: number }) {
    this.events.push(`remove:${input.resourceVersion}`);
  }
  async searchDocuments() { return { candidates: [], status: 'available' as const }; }
}

function build(options: {
  parser?: KnowledgeDocumentParser;
  semantic?: KnowledgeDocumentSemanticIndex | null;
  maxConcurrency?: number;
} = {}) {
  const documents = new FakeDocuments();
  const objects = new FakeObjects();
  let parses = 0;
  const parser: KnowledgeDocumentParser = options.parser ?? {
    async parse() {
      parses += 1;
      return {
        parserVersion: 'test-v1',
        pageCount: 1,
        warnings: [],
        units: [{ pageNumber: 1, text: '# Rollback\n\nRestore the previous release.' }],
      };
    },
  };
  const semantic = options.semantic === undefined ? new FakeSemantic(documents.events) : options.semantic;
  return {
    documents,
    objects,
    parses: () => parses,
    service: new KnowledgeDocumentIndexService({
      documents,
      objects,
      parser,
      semantic,
      logger,
      maxBytes: 1_024 * 1_024,
      parseTimeoutMs: 10_000,
      maxConcurrency: options.maxConcurrency ?? 2,
      chunking: { targetChars: 200, maxChars: 400, overlapChars: 40, maxChunks: 20 },
    }),
  };
}

describe('KnowledgeDocumentIndexService', () => {
  it('verifies approved bytes, projects the new version, and retires only older versions', async () => {
    const { service, documents, objects } = build();
    documents.previous = [snapshot({
      id: 'document-old',
      resourceVersion: 1,
      status: 'ready',
      chunkCount: 3,
      fileAssetId: 'asset-old',
    })];

    await service.index({
      resource: {
        id: 'resource-1', companyId: 'company-1', scope: 'department',
        ownerUserId: null, departmentId: 'department-1',
      },
      version: 2,
      file: file(),
    });

    assert.equal(objects.reads, 1);
    assert.equal(documents.replacement?.parserVersion, 'test-v1');
    assert.equal(documents.replacement?.chunks.length, 1);
    assert.deepEqual(documents.events, [
      'begin', 'replace', 'semantic:1', 'previous', 'remove:1',
      'superseded:document-old', 'ready:document-1',
    ]);
    assert.equal(documents.failures.length, 0);
  });

  it('fails closed on changed private bytes and never parses or reports ready', async () => {
    const { service, documents, objects, parses } = build();
    objects.value = Buffer.from('tampered');

    await assert.rejects(service.index({
      resource: {
        id: 'resource-1', companyId: 'company-1', scope: 'department',
        ownerUserId: null, departmentId: 'department-1',
      },
      version: 2,
      file: file(),
    }), /size no longer matches|hash no longer matches/);

    assert.equal(parses(), 0);
    assert.equal(documents.events.includes('ready:document-1'), false);
    assert.equal(documents.failures[0]?.code, 'parse_failed');
  });

  it('rejects a stale or cross-resource asset before creating an index lease', async () => {
    const { service, documents, objects } = build();
    await assert.rejects(service.index({
      resource: {
        id: 'resource-1', companyId: 'company-1', scope: 'personal',
        ownerUserId: 'user-1', departmentId: null,
      },
      version: 2,
      file: file({ isCurrentVersion: false }),
    }), /not the current asset/);
    assert.deepEqual(documents.events, []);
    assert.equal(objects.reads, 0);
  });

  it('marks every derived version deleted and removes only its scoped semantic documents', async () => {
    const { service, documents } = build();
    documents.all = [
      snapshot({ id: 'document-1', resourceVersion: 1, chunkCount: 2, status: 'superseded' }),
      snapshot({ id: 'document-2', resourceVersion: 2, chunkCount: 1, status: 'ready' }),
    ];
    await service.removeResource('resource-1');
    assert.deepEqual(documents.events, [
      'remove:1', 'deleted:document-1', 'remove:2', 'deleted:document-2',
    ]);
  });

  it('bounds heavy parsing concurrency per backend replica', async () => {
    let calls = 0;
    let active = 0;
    let peak = 0;
    let releaseFirst!: () => void;
    let notifyFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>(resolve => { notifyFirst = resolve; });
    const parser: KnowledgeDocumentParser = {
      async parse() {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        if (calls === 1) {
          notifyFirst();
          await firstGate;
        }
        active -= 1;
        return { parserVersion: 'test-v1', warnings: [], units: [{ text: 'Approved searchable text.' }] };
      },
    };
    const { service } = build({ parser, semantic: null, maxConcurrency: 1 });
    const input = {
      resource: {
        id: 'resource-1', companyId: 'company-1', scope: 'department' as const,
        ownerUserId: null, departmentId: 'department-1',
      },
      version: 2,
      file: file(),
    };
    const first = service.index(input);
    await firstStarted;
    const second = service.index(input);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(calls, 2);
    assert.equal(peak, 1);
  });
});
