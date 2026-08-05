import type { KnowledgeDocumentChunkInput, KnowledgeDocumentSemanticCandidate } from './knowledge-document.port';

export interface KnowledgeFileDocumentSnapshot {
  readonly id: string;
  /** Opaque lease owner token. Non-null only while status is processing. */
  readonly leaseToken: string | null;
  readonly companyId: string;
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly fileAssetId: string;
  readonly sourceSha256: string;
  readonly mimeType: string;
  readonly status: 'processing' | 'ready' | 'failed' | 'superseded' | 'deleted';
  readonly chunkCount: number;
  readonly scope: 'personal' | 'department' | 'company';
  readonly ownerUserId: string | null;
  readonly departmentId: string | null;
}

export interface CanonicalKnowledgeDocumentChunk {
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly chunkOrdinal: number;
  readonly scope: 'personal' | 'department' | 'company';
  readonly departmentName?: string;
  readonly fileName: string;
  readonly text: string;
  readonly pageStart?: number;
  readonly pageEnd?: number;
  readonly sectionPath: readonly string[];
  readonly score: number;
}

export interface KnowledgeDocumentRepository {
  beginIndex(input: {
    readonly companyId: string;
    readonly resourceId: string;
    readonly resourceVersion: number;
    readonly fileAssetId: string;
    readonly sourceSha256: string;
    readonly mimeType: string;
    readonly parserVersion: string;
  }): Promise<KnowledgeFileDocumentSnapshot>;

  replaceChunks(input: {
    readonly documentId: string;
    readonly leaseToken: string;
    readonly pageCount?: number;
    readonly parserVersion: string;
    readonly warnings: readonly string[];
    readonly chunks: readonly KnowledgeDocumentChunkInput[];
  }): Promise<void>;

  markReady(documentId: string, leaseToken: string): Promise<void>;
  markFailed(documentId: string, leaseToken: string, error: { readonly code: string; readonly message: string }): Promise<void>;
  listOtherVersions(resourceId: string, currentVersion: number): Promise<readonly KnowledgeFileDocumentSnapshot[]>;
  listByResource(resourceId: string): Promise<readonly KnowledgeFileDocumentSnapshot[]>;
  markSuperseded(documentId: string): Promise<void>;
  markDeleted(documentId: string): Promise<void>;

  keywordSearch(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly departmentIds: readonly string[];
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly KnowledgeDocumentSemanticCandidate[]>;

  hydrateAuthorized(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly departmentIds: readonly string[];
    readonly candidates: readonly KnowledgeDocumentSemanticCandidate[];
  }): Promise<readonly CanonicalKnowledgeDocumentChunk[]>;
}
