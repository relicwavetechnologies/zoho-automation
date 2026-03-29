import type { QueryMode, RetrievalProfile } from './retrieval-contract';

export type VectorSourceType =
  | 'zoho_lead'
  | 'zoho_contact'
  | 'zoho_account'
  | 'zoho_deal'
  | 'zoho_ticket'
  | 'chat_turn'
  | 'file_document';
export type VectorVisibility = 'personal' | 'shared' | 'public';

export type VectorPayload = Record<string, unknown>;

export type VectorPointUpsert = {
  id: string;
  companyId: string;
  sourceType: VectorSourceType;
  sourceId: string;
  chunkIndex: number;
  documentKey: string;
  contentHash: string;
  visibility: VectorVisibility;
  ownerUserId?: string;
  conversationKey?: string;
  payload: VectorPayload;
  denseVector: number[];
  multimodalVector?: number[];
};

export type VectorSearchQuery = {
  companyId: string;
  requesterUserId?: string;
  requesterEmail?: string;
  requesterAiRole?: string;
  conversationKey?: string;
  enforceEmailMatch?: boolean;
  denseVector: number[];
  limit: number;
  candidateLimit?: number;
  schemaVersion?: string;
  retrievalProfile?: RetrievalProfile;
  queryMode?: QueryMode;
  lexicalQueryText?: string;
  fileAssetId?: string;
  useMultimodal?: boolean;
  fusion?: 'dbsf' | 'rrf';
  groupByField?: string;
  groupSize?: number;
  rerankTopK?: number;
  rerankRequired?: boolean;
  scoreThreshold?: number;
  sourceTypes?: VectorSourceType[];
  includePersonal?: boolean;
  includeShared?: boolean;
  includePublic?: boolean;
};

export type VectorSearchResult = {
  id: string;
  score: number;
  sourceType: VectorSourceType;
  sourceId: string;
  chunkIndex: number;
  documentKey?: string;
  visibility: VectorVisibility;
  ownerUserId?: string;
  conversationKey?: string;
  allowedRoles?: string[];
  payload: VectorPayload;
};

export type VectorSearchGroup = {
  groupValue: string;
  hits: VectorSearchResult[];
};

export type VectorDeleteBySourceInput = {
  companyId: string;
  sourceType: VectorSourceType;
  sourceId: string;
};

export type VectorStoreHealth = {
  ok: boolean;
  backend: 'qdrant';
  collection: string;
  latencyMs?: number;
  error?: string;
};

export interface VectorStoreAdapter {
  upsert(points: VectorPointUpsert[]): Promise<void>;
  search(query: VectorSearchQuery): Promise<VectorSearchGroup[]>;
  deleteBySource(input: VectorDeleteBySourceInput): Promise<void>;
  countByCompany(companyId: string): Promise<number>;
  health(): Promise<VectorStoreHealth>;
}
