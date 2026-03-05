export type VectorSourceType = 'zoho_contact' | 'zoho_deal' | 'zoho_ticket';

export type VectorPayload = Record<string, unknown>;

export type VectorPointUpsert = {
  id: string;
  companyId: string;
  sourceType: VectorSourceType;
  sourceId: string;
  chunkIndex: number;
  contentHash: string;
  payload: VectorPayload;
  vector: number[];
};

export type VectorSearchQuery = {
  companyId: string;
  vector: number[];
  limit: number;
};

export type VectorSearchResult = {
  id: string;
  score: number;
  sourceType: VectorSourceType;
  sourceId: string;
  chunkIndex: number;
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
