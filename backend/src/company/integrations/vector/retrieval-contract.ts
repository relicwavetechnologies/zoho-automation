export const PRIMARY_TEXT_VECTOR_NAME = 'dense_text_v2';
export const MULTIMODAL_VECTOR_NAME = 'dense_mm_v1';
export const LEXICAL_VECTOR_NAME = 'lexical_bm25_v1';
export const ACTIVE_EMBEDDING_SCHEMA_VERSION = 'retrieval-v3';

export type RetrievalProfile = 'zoho' | 'file' | 'chat';
export type QueryMode = 'text' | 'multimodal' | 'hybrid_text_mm';

export type RetrievalProfileConfig = {
  branchLimit: number;
  groupLimit: number;
  groupSize: number;
  rerankTopN: number;
  finalTopK: number;
  rerankRequired: boolean;
  useMultimodal: boolean;
};

export type CanonicalRetrievalChunk = {
  id: string;
  sourceType:
    | 'zoho_lead'
    | 'zoho_contact'
    | 'zoho_account'
    | 'zoho_deal'
    | 'zoho_ticket'
    | 'chat_turn'
    | 'file_document';
  sourceId: string;
  chunkIndex: number;
  documentKey: string;
  title: string;
  chunkText: string;
  chunkTokenCount: number;
  sectionPath?: string[];
  sourceUpdatedAt?: string;
  visibility: 'personal' | 'shared' | 'public';
  allowedRoles?: string[];
  referenceEmails?: string[];
  conversationKey?: string;
  ownerUserId?: string;
  fileAssetId?: string;
  retrievalProfile: RetrievalProfile;
  embeddingSchemaVersion: string;
  payload: Record<string, unknown>;
};

export const RETRIEVAL_PROFILE_CONFIG: Record<RetrievalProfile, RetrievalProfileConfig> = {
  zoho: {
    branchLimit: 24,
    groupLimit: 8,
    groupSize: 3,
    rerankTopN: 24,
    finalTopK: 6,
    rerankRequired: true,
    useMultimodal: false,
  },
  file: {
    branchLimit: 24,
    groupLimit: 6,
    groupSize: 3,
    rerankTopN: 24,
    finalTopK: 6,
    rerankRequired: true,
    useMultimodal: true,
  },
  chat: {
    branchLimit: 12,
    groupLimit: 6,
    groupSize: 3,
    rerankTopN: 12,
    finalTopK: 4,
    rerankRequired: false,
    useMultimodal: false,
  },
};

export type RerankCandidate = {
  id: string;
  documentKey: string;
  chunkIndex: number;
  title?: string;
  content: string;
  score?: number;
  payload?: Record<string, unknown>;
};

export type RerankResult = RerankCandidate & {
  rerankScore: number;
};
