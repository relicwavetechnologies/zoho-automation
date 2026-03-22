export const KNOWLEDGE_NEEDS = [
  'crm_entity',
  'company_docs',
  'workflow_skill',
  'conversation_memory',
  'hybrid_web',
  'structured_finance',
  'attachment_exact',
  'relationship',
] as const;

export type KnowledgeNeed = (typeof KNOWLEDGE_NEEDS)[number];

export const RETRIEVAL_STRATEGIES = [
  'zoho_vector_plus_live',
  'doc_chunk_search',
  'doc_full_read',
  'skill_db_search',
  'chat_memory',
  'internal_plus_web',
  'structured_parser_plus_doc',
  'attachment_first',
] as const;

export type RetrievalStrategy = (typeof RETRIEVAL_STRATEGIES)[number];

export type PlannedRetrievalStep = {
  need: KnowledgeNeed;
  strategy: RetrievalStrategy;
  required: boolean;
  topK?: number;
  freshness?: 'none' | 'maybe' | 'required';
};

export type RetrievalPlan = {
  knowledgeNeeds: KnowledgeNeed[];
  preferredStrategy?: RetrievalStrategy;
  steps: PlannedRetrievalStep[];
  rationale: string[];
};

export const GROUNDED_EVIDENCE_SOURCE_FAMILIES = [
  'zoho',
  'file',
  'chat',
  'skill',
  'web',
  'parser',
] as const;

export type GroundedEvidenceSourceFamily = (typeof GROUNDED_EVIDENCE_SOURCE_FAMILIES)[number];

export type GroundedEvidence = {
  sourceFamily: GroundedEvidenceSourceFamily;
  sourceId: string;
  title?: string;
  excerpt: string;
  confidence?: number;
  staleRisk?: 'low' | 'medium' | 'high';
  citation: Record<string, unknown>;
};
