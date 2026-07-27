/**
 * DocumentRagBroker — implements DocumentRagBrokerPort.
 * Handles semantic search with Groq reranking and full-doc read.
 */
import type { QdrantAdapter } from '../../infrastructure/ai/vector/qdrant.adapter';
import type { EmbeddingService } from '../../infrastructure/ai/embedding/embedding.service';
import type { FileAssetRepository } from '../../infrastructure/persistence/file-asset.repository';
import type { VectorDocumentRepository } from '../../infrastructure/persistence/vector-document.repository';
import type { LlmRerankerService } from './llm-reranker.service';
import type { DocumentRagBrokerPort } from '../orchestration/tools/families/document-rag.tool';
import type { Logger } from '../../shared/logger';
import { buildDocumentSearchQueries, broadenDocumentSearchQuery } from './query-rewriter';
import { readFullDocFromVectorStore } from './full-doc-reader';
import type { TypedEnv } from '../../config/env';
import { ACTIVE_EMBEDDING_SCHEMA_VERSION } from '../../infrastructure/ai/vector/types';
import type { VectorSearchResult } from '../../infrastructure/ai/vector/types';

export class DocumentRagBroker implements DocumentRagBrokerPort {
  private readonly log: Logger;

  constructor(
    private readonly env:           TypedEnv,
    private readonly qdrant:        QdrantAdapter,
    private readonly embedding:     EmbeddingService,
    private readonly reranker:      LlmRerankerService,
    private readonly fileAssetRepo: FileAssetRepository,
    private readonly vectorDocRepo: VectorDocumentRepository,
    logger: Logger,
  ) {
    this.log = logger.child({ service: 'document-rag-broker' });
  }

  async search(input: {
    query:           string;
    companyId:       string;
    requesterUserId: string;
    requesterAiRole: string;
    fileAssetId?:    string;
    larkChatId?:     string;
    limit?:          number;
  }): Promise<Array<{
    text: string; fileName: string; fileAssetId: string;
    sectionPath: string | undefined; cloudinaryUrl: string | undefined;
    score: number; citation: string;
  }>> {
    const limit = input.limit ?? 6;
    const queries = this.env.FILE_RAG_REWRITE_ENABLED
      ? buildDocumentSearchQueries(input.query)
      : [input.query];

    const scope = {
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      requesterAiRole: input.requesterAiRole,
      ...(input.fileAssetId ? { fileAssetId: input.fileAssetId } : {}),
      ...(input.larkChatId ? { larkChatId: input.larkChatId } : {}),
    };
    const results = await this.runSearch(queries, scope, limit * 4);

    // Rerank
    const ranked = this.env.FILE_RAG_GRADING_ENABLED
      ? await this.reranker.rerank(input.query, results, { companyId: input.companyId })
      : results.map(r => ({ chunk: r, rerankerScore: r.score * 10 }));

    // If insufficient results after grading, try a broadened query (≤1 retry)
    if (ranked.length < 2 && this.env.FILE_RAG_GRADING_ENABLED) {
      const broadened = broadenDocumentSearchQuery(input.query);
      if (broadened !== input.query) {
        const retryResults = await this.runSearch([broadened], scope, limit * 4);
        const retryRanked = await this.reranker.rerank(broadened, retryResults, { companyId: input.companyId });
        ranked.push(...retryRanked.filter(r => !ranked.find(e => e.chunk.id === r.chunk.id)));
      }
    }

    return ranked.slice(0, limit).map(r => {
      const p = r.chunk.payload as Record<string, unknown>;
      return {
        text:          (p['rawChunkText'] ?? p['text'] ?? '') as string,
        fileName:      (p['fileName'] ?? p['title'] ?? '') as string,
        fileAssetId:   (p['fileAssetId'] ?? '') as string,
        sectionPath:   (p['sectionPath'] as string[] | undefined)?.join(' > '),
        cloudinaryUrl: (p['cloudinaryUrl'] as string | undefined),
        score:         r.rerankerScore,
        citation:      this.buildCitation(p),
      };
    });
  }

  async readFull(input: {
    fileAssetId:     string;
    companyId:       string;
    requesterUserId: string;
    larkChatId?:     string;
  }): Promise<{ text: string; fileName: string; cloudinaryUrl: string; truncated: boolean } | null> {
    // Ownership is checked before a single byte is read.
    //
    // This path resolves a document by id alone, and ids travel: they are
    // written into chat transcripts as retrieval hints, so anyone who has seen
    // one can quote it back later from another company or after leaving the
    // room it came from. Without this check that read succeeds.
    const assetResult = await this.fileAssetRepo.findById(input.fileAssetId);
    if (!assetResult.ok || !assetResult.value) return null;
    const asset = assetResult.value;
    if (asset.companyId !== input.companyId) {
      this.log.warn('document_rag.read_full.cross_company_denied', {
        fileAssetId: input.fileAssetId,
        requesterCompanyId: input.companyId,
      });
      return null;
    }

    // Company ownership is not the whole rule. A document posted into a Lark
    // room is readable by that room, so a colleague who was never in it — or
    // who has since left — must not get the full text just by holding the id.
    // The uploader keeps access from anywhere.
    if (asset.uploaderUserId !== input.requesterUserId) {
      const reachable = await this.isReachableFromChat(input.fileAssetId, input.larkChatId);
      if (!reachable) {
        this.log.warn('document_rag.read_full.out_of_scope_denied', {
          fileAssetId: input.fileAssetId,
          requesterUserId: input.requesterUserId,
        });
        return null;
      }
    }

    const result = await readFullDocFromVectorStore(input.fileAssetId, {
      vectorDocRepo: this.vectorDocRepo,
      logger:        this.log,
      maxChars:      this.env.RAG_FULL_READ_MAX_CHARS,
    });

    if (result) return result;

    const { readFullDocFromCloudinary } = await import('./full-doc-reader');
    const text = await readFullDocFromCloudinary(
      asset.cloudinaryUrl, asset.fileName, asset.mimeType,
      this.env.OPENAI_API_KEY, this.env.RAG_FULL_READ_MAX_CHARS, this.log,
    );

    return {
      text,
      fileName:     asset.fileName,
      cloudinaryUrl: asset.cloudinaryUrl,
      truncated:    text.length >= this.env.RAG_FULL_READ_MAX_CHARS,
    };
  }

  async listFiles(input: {
    companyId:       string;
    requesterUserId: string;
    requesterAiRole: string;
    isAdmin:         boolean;
  }): Promise<Array<{ fileAssetId: string; fileName: string; status: string; createdAt: string }>> {
    const result = await this.fileAssetRepo.listVisible({
      companyId:   input.companyId,
      aiRole:      input.requesterAiRole,
      isAdmin:     input.isAdmin,
      ownerUserId: input.requesterUserId,
    });
    if (!result.ok) return [];
    return result.value.map(f => ({
      fileAssetId: f.id,
      fileName:    f.fileName,
      status:      f.ingestionStatus,
      createdAt:   f.createdAt.toISOString(),
    }));
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Whether this document was posted into the chat the caller is asking from.
   *
   * The scope key lives on the chunk payload rather than on `FileAsset`, which
   * is what let chat scoping ship without a migration. The cost is that
   * answering this question means reading a chunk.
   *
   * A document with no scope key at all is not chat-scoped — it came from the
   * desktop uploader — so it is refused here and left to the ordinary
   * visibility rules, which this method deliberately does not try to restate.
   */
  private async isReachableFromChat(
    fileAssetId: string,
    larkChatId: string | undefined,
  ): Promise<boolean> {
    if (!larkChatId) return false;
    const chunks = await this.vectorDocRepo.findByFileAsset(fileAssetId);
    if (!chunks.ok || !chunks.value) return false;
    return chunks.value.some(row => {
      const payload = row.payload as Record<string, unknown> | null;
      return payload?.['larkChatId'] === larkChatId;
    });
  }

  private async runSearch(
    queries: string[],
    scope: {
      companyId: string;
      requesterUserId: string;
      requesterAiRole: string;
      fileAssetId?: string;
      larkChatId?: string;
    },
    candidateLimit: number,
  ): Promise<VectorSearchResult[]> {
    const seen = new Set<string>();
    const allResults: VectorSearchResult[] = [];

    for (const q of queries) {
      const [embedding] = await this.embedding.embedQueries([q], { companyId: scope.companyId });
      if (!embedding) continue;

      const groups = await this.qdrant.search({
        companyId:        scope.companyId,
        // `includePersonal` is inert without a requester: `buildScopeShould`
        // drops the personal branch when `requesterUserId` is absent, so
        // omitting it here silently hid every personal file — including every
        // document uploaded through Lark.
        requesterUserId:  scope.requesterUserId,
        requesterAiRole:  scope.requesterAiRole,
        denseVector:      embedding,
        limit:            candidateLimit,
        retrievalProfile: 'file',
        sourceTypes:      ['file_document'],
        schemaVersion:    ACTIVE_EMBEDDING_SCHEMA_VERSION,
        includePersonal:  true,
        includeShared:    true,
        ...(scope.fileAssetId ? { fileAssetId: scope.fileAssetId } : {}),
        ...(scope.larkChatId ? { larkChatId: scope.larkChatId } : {}),
      });

      // Flatten groups → individual results
      const results: VectorSearchResult[] = groups.flatMap(g => g.hits);

      for (const r of results) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          allResults.push(r);
        }
      }
    }

    return allResults.sort((a, b) => b.score - a.score).slice(0, candidateLimit);
  }

  private buildCitation(payload: Record<string, unknown>): string {
    const fileName    = (payload['fileName'] as string | undefined) ?? 'document';
    const sectionPath = (payload['sectionPath'] as string[] | undefined);
    const section     = sectionPath?.join(' > ');
    return section ? `[${fileName} § ${section}]` : `[${fileName}]`;
  }
}
