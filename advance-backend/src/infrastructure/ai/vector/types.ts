/**
 * Vector store types for the advance-backend.
 *
 * These are ported verbatim from the old backend's retrieval-contract + vector-store.adapter,
 * then adapted to the clean DI style (no global config references).
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Named vector in Qdrant used for text embedding (dense). */
export const PRIMARY_TEXT_VECTOR_NAME  = 'dense_text_v2'   as const;
/** Named vector in Qdrant used for multimodal embedding (image/video caption). */
export const MULTIMODAL_VECTOR_NAME    = 'dense_mm_v1'     as const;
/** Current schema version stamped on every indexed point. Used to invalidate stale embeddings. */
export const ACTIVE_EMBEDDING_SCHEMA_VERSION = 'retrieval-v3' as const;

// ─── Domain enums ─────────────────────────────────────────────────────────────

export type VectorSourceType =
  | 'zoho_lead'
  | 'zoho_contact'
  | 'zoho_account'
  | 'zoho_deal'
  | 'zoho_ticket'
  | 'chat_turn'
  | 'file_document';

export type VectorVisibility = 'personal' | 'shared' | 'public';

export type RetrievalProfile = 'zoho' | 'file' | 'chat';
export type QueryMode = 'text' | 'multimodal' | 'hybrid_text_mm';
export type FusionAlgorithm = 'dbsf' | 'rrf';

// ─── Point upsert ─────────────────────────────────────────────────────────────

export type VectorPayload = Record<string, unknown>;

export interface VectorPointUpsert {
  /** Deterministic UUID v5-style ID derived from companyId|sourceType|sourceId|chunkIndex. */
  readonly id: string;
  readonly companyId: string;
  readonly sourceType: VectorSourceType;
  readonly sourceId: string;
  readonly chunkIndex: number;
  readonly documentKey: string;
  readonly contentHash: string;
  readonly visibility: VectorVisibility;
  readonly ownerUserId?: string;
  readonly conversationKey?: string;
  readonly payload: VectorPayload;
  /** Dense text embedding vector. */
  readonly denseVector: number[];
  /** Optional multimodal embedding vector (images / video captions). */
  readonly multimodalVector?: number[];
}

// ─── Higher-level upsert input (used by upsertVectors) ───────────────────────

export interface VectorUpsertInput {
  readonly companyId: string;
  readonly sourceType: VectorSourceType;
  readonly sourceId: string;
  readonly chunkIndex: number;
  readonly contentHash: string;
  readonly visibility?: VectorVisibility;
  readonly ownerUserId?: string;
  readonly conversationKey?: string;
  readonly connectionId?: string;
  readonly fileAssetId?: string;
  readonly referenceEmails?: string[];
  readonly allowedRoles?: string[];
  readonly documentKey?: string;
  readonly title?: string;
  readonly content?: string;
  readonly sourceUpdatedAt?: string;
  readonly embeddingSchemaVersion?: string;
  readonly retrievalProfile?: RetrievalProfile;
  readonly denseEmbedding: number[];
  readonly multimodalEmbedding?: number[];
  readonly payload: VectorPayload;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface VectorSearchQuery {
  readonly companyId: string;
  readonly requesterUserId?: string;
  readonly requesterEmail?: string;
  readonly requesterAiRole?: string;
  readonly dateFrom?: string;   // ISO-8601 datetime for range filter on sourceUpdatedAt
  readonly dateTo?: string;
  readonly conversationKey?: string;
  readonly enforceEmailMatch?: boolean;
  readonly denseVector: number[];
  readonly limit: number;
  readonly candidateLimit?: number;
  readonly schemaVersion?: string;
  readonly retrievalProfile?: RetrievalProfile;
  readonly queryMode?: QueryMode;
  readonly lexicalQueryText?: string;
  readonly fileAssetId?: string;
  readonly useMultimodal?: boolean;
  readonly fusion?: FusionAlgorithm;
  readonly groupByField?: string;
  readonly groupSize?: number;
  readonly scoreThreshold?: number;
  readonly sourceTypes?: VectorSourceType[];
  readonly includePersonal?: boolean;
  readonly includeShared?: boolean;
  readonly includePublic?: boolean;
}

export interface VectorSearchResult {
  readonly id: string;
  readonly score: number;
  readonly sourceType: VectorSourceType;
  readonly sourceId: string;
  readonly chunkIndex: number;
  readonly documentKey?: string;
  readonly visibility: VectorVisibility;
  readonly ownerUserId?: string;
  readonly conversationKey?: string;
  readonly allowedRoles?: string[];
  readonly payload: VectorPayload;
}

export interface VectorSearchGroup {
  /** The value of the field being grouped by (e.g. documentKey). */
  readonly groupValue: string;
  readonly hits: VectorSearchResult[];
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export interface VectorDeleteBySourceInput {
  readonly companyId: string;
  readonly sourceType: VectorSourceType;
  readonly sourceId: string;
}

// ─── Health ───────────────────────────────────────────────────────────────────

export interface VectorStoreHealth {
  readonly ok: boolean;
  readonly backend: 'qdrant';
  readonly collection: string;
  readonly latencyMs?: number;
  readonly error?: string;
}

// ─── Adapter interface ────────────────────────────────────────────────────────

export interface VectorStoreAdapter {
  upsert(points: VectorPointUpsert[]): Promise<void>;
  upsertVectors(records: VectorUpsertInput[]): Promise<void>;
  search(query: VectorSearchQuery): Promise<VectorSearchGroup[]>;
  deleteBySource(input: VectorDeleteBySourceInput): Promise<void>;
  deleteOwnedChatTurns(input: { companyId: string; ownerUserId: string }): Promise<void>;
  countByCompany(companyId: string): Promise<number>;
  health(): Promise<VectorStoreHealth>;
}

// ─── Profile config (used by context search) ──────────────────────────────────

export interface RetrievalProfileConfig {
  readonly branchLimit: number;
  readonly groupLimit: number;
  readonly groupSize: number;
  readonly rerankTopN: number;
  readonly finalTopK: number;
  readonly rerankRequired: boolean;
  readonly useMultimodal: boolean;
}

export const RETRIEVAL_PROFILE_CONFIG: Record<RetrievalProfile, RetrievalProfileConfig> = {
  zoho: {
    branchLimit: 24,
    groupLimit:  8,
    groupSize:   3,
    rerankTopN:  24,
    finalTopK:   6,
    rerankRequired: true,
    useMultimodal:  false,
  },
  file: {
    branchLimit: 24,
    groupLimit:  6,
    groupSize:   3,
    rerankTopN:  24,
    finalTopK:   6,
    rerankRequired: true,
    useMultimodal:  true,
  },
  chat: {
    branchLimit: 12,
    groupLimit:  6,
    groupSize:   3,
    rerankTopN:  12,
    finalTopK:   4,
    rerankRequired: false,
    useMultimodal:  false,
  },
};
