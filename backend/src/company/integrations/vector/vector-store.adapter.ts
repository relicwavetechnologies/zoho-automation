export type VectorSourceType = 'zoho_lead' | 'zoho_contact' | 'zoho_deal' | 'zoho_ticket' | 'chat_turn' | 'file_document';
export type VectorVisibility = 'personal' | 'shared' | 'public';

export type VectorPayload = Record<string, unknown>;

export type VectorPointUpsert = {
  id: string;
  companyId: string;
  sourceType: VectorSourceType;
  sourceId: string;
  chunkIndex: number;
  contentHash: string;
  visibility: VectorVisibility;
  ownerUserId?: string;
  conversationKey?: string;
  payload: VectorPayload;
  vector: number[];
};

export type VectorSearchQuery = {
  companyId: string;
  requesterUserId?: string;
  requesterEmail?: string;
  requesterAiRole?: string;
  enforceEmailMatch?: boolean;
  vector: number[];
  limit: number;
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
  visibility: VectorVisibility;
  ownerUserId?: string;
  conversationKey?: string;
  allowedRoles?: string[];
  payload: VectorPayload;
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
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>;
  deleteBySource(input: VectorDeleteBySourceInput): Promise<void>;
  countByCompany(companyId: string): Promise<number>;
  health(): Promise<VectorStoreHealth>;
}
