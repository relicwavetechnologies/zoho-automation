import { createHash } from 'node:crypto';
import type { Logger } from '../../shared/logger';
import { chunkKnowledgeDocument, type KnowledgeDocumentChunkingOptions } from './knowledge-document-chunker';
import type { KnowledgeDocumentParser, KnowledgeDocumentSemanticIndex } from './knowledge-document.port';
import type { KnowledgeDocumentRepository, KnowledgeFileDocumentSnapshot } from './knowledge-document.repository';
import type {
  KnowledgePrivateObjectStore,
  ReadableKnowledgeFile,
} from './knowledge-file.service';

export class KnowledgeDocumentIndexService {
  private readonly log: Logger;
  private activeIndexes = 0;
  private readonly indexWaiters: Array<() => void> = [];

  constructor(private readonly deps: {
    readonly documents: KnowledgeDocumentRepository;
    readonly objects: KnowledgePrivateObjectStore;
    readonly parser: KnowledgeDocumentParser;
    readonly semantic: KnowledgeDocumentSemanticIndex | null;
    readonly logger: Logger;
    readonly maxBytes: number;
    readonly parseTimeoutMs: number;
    readonly maxConcurrency: number;
    readonly chunking: Partial<KnowledgeDocumentChunkingOptions>;
  }) {
    this.log = deps.logger.child({ service: 'knowledge-document-index' });
    if (!Number.isInteger(deps.maxConcurrency) || deps.maxConcurrency < 1) {
      throw new Error('Knowledge document index concurrency must be a positive integer.');
    }
  }

  async index(input: {
    readonly resource: {
      readonly id: string;
      readonly companyId: string;
      readonly scope: 'personal' | 'department' | 'company';
      readonly ownerUserId: string | null;
      readonly departmentId: string | null;
    };
    readonly version: number;
    readonly file: ReadableKnowledgeFile;
  }): Promise<void> {
    assertFileBinding(input);
    const release = await this.acquireIndexSlot();
    try {
      await this.indexWithSlot(input);
    } finally {
      release();
    }
  }

  private async indexWithSlot(input: Parameters<KnowledgeDocumentIndexService['index']>[0]): Promise<void> {
    const document = await this.deps.documents.beginIndex({
      companyId: input.resource.companyId,
      resourceId: input.resource.id,
      resourceVersion: input.version,
      fileAssetId: input.file.id,
      sourceSha256: input.file.sha256,
      mimeType: input.file.mimeType,
      parserVersion: 'pending',
    });
    const signal = AbortSignal.timeout(this.deps.parseTimeoutMs);
    try {
      const buffer = await this.deps.objects.read({
        storageKey: input.file.storageKey,
        resourceType: input.file.resourceType,
        deliveryType: input.file.deliveryType,
        maxBytes: this.deps.maxBytes,
        signal,
      });
      verifyPrivateObject(buffer, input.file);
      const parsed = await this.deps.parser.parse({
        buffer,
        fileName: input.file.fileName,
        mimeType: input.file.mimeType,
        signal,
      });
      const chunks = chunkKnowledgeDocument(parsed, this.deps.chunking);
      await this.deps.documents.replaceChunks({
        documentId: document.id,
        ...(parsed.pageCount === undefined ? {} : { pageCount: parsed.pageCount }),
        parserVersion: parsed.parserVersion,
        warnings: parsed.warnings,
        chunks,
      });
      if (this.deps.semantic) {
        await this.deps.semantic.projectDocument({
          resourceId: input.resource.id,
          resourceVersion: input.version,
          fileName: input.file.fileName,
          scope: input.resource.scope,
          companyId: input.resource.companyId,
          ...(input.resource.ownerUserId ? { ownerUserId: input.resource.ownerUserId } : {}),
          ...(input.resource.departmentId ? { departmentId: input.resource.departmentId } : {}),
          chunks,
        });
      }
      await this.retirePreviousVersions(input.resource.id, input.version);
      await this.deps.documents.markReady(document.id);
      this.log.info('knowledge_document.indexed', {
        resourceId: input.resource.id,
        resourceVersion: input.version,
        chunkCount: chunks.length,
        pageCount: parsed.pageCount,
        semantic: Boolean(this.deps.semantic),
      });
    } catch (cause) {
      await this.deps.documents.markFailed(document.id, classifyFailure(cause)).catch(() => undefined);
      throw cause;
    }
  }

  private async acquireIndexSlot(): Promise<() => void> {
    if (this.activeIndexes < this.deps.maxConcurrency) {
      this.activeIndexes += 1;
    } else {
      await new Promise<void>(resolve => this.indexWaiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.indexWaiters.shift();
      if (next) next();
      else this.activeIndexes -= 1;
    };
  }

  async removeResource(resourceId: string): Promise<void> {
    const documents = await this.deps.documents.listByResource(resourceId);
    for (const document of documents) {
      await this.removeSemantic(document);
      await this.deps.documents.markDeleted(document.id);
    }
  }

  private async retirePreviousVersions(resourceId: string, currentVersion: number): Promise<void> {
    const previous = await this.deps.documents.listOtherVersions(resourceId, currentVersion);
    for (const document of previous) {
      await this.removeSemantic(document);
      await this.deps.documents.markSuperseded(document.id);
    }
  }

  private async removeSemantic(document: KnowledgeFileDocumentSnapshot): Promise<void> {
    if (!this.deps.semantic || document.chunkCount < 1) return;
    await this.deps.semantic.removeDocument({
      resourceId: document.resourceId,
      resourceVersion: document.resourceVersion,
      chunkCount: document.chunkCount,
      scope: document.scope,
      companyId: document.companyId,
      ...(document.ownerUserId ? { ownerUserId: document.ownerUserId } : {}),
      ...(document.departmentId ? { departmentId: document.departmentId } : {}),
    });
  }
}

function assertFileBinding(input: Parameters<KnowledgeDocumentIndexService['index']>[0]): void {
  if (
    input.file.companyId !== input.resource.companyId
    || input.file.knowledgeResourceId !== input.resource.id
    || input.file.status !== 'attached'
    || !input.file.isCurrentVersion
  ) throw new Error('The governed file is not the current asset for this resource version.');
}

function verifyPrivateObject(buffer: Buffer, file: ReadableKnowledgeFile): void {
  if (buffer.length !== file.sizeBytes) throw new Error('Private object size no longer matches its approved descriptor.');
  const hash = createHash('sha256').update(buffer).digest('hex');
  if (hash !== file.sha256) throw new Error('Private object hash no longer matches its approved descriptor.');
}

function classifyFailure(cause: unknown): { code: string; message: string } {
  const name = cause instanceof Error ? cause.name : 'Error';
  const code = name === 'TimeoutError' || name === 'AbortError' ? 'parse_timeout' : 'parse_failed';
  const message = cause instanceof Error ? cause.message : String(cause);
  return { code, message: message.slice(0, 2_000) };
}
