const readBoolean = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return defaultValue;
};

export const retrievalFeatureFlags = {
  advancedFileChunking: readBoolean(process.env.FILE_RAG_ADVANCED_CHUNKING_ENABLED, true),
  contextualEnrichment: readBoolean(process.env.FILE_RAG_CONTEXTUAL_ENRICHMENT_ENABLED, true),
  queryExpansion: readBoolean(process.env.FILE_RAG_QUERY_EXPANSION_ENABLED, true),
  multiQuery: readBoolean(process.env.FILE_RAG_MULTI_QUERY_ENABLED, true),
  correctiveRetry: readBoolean(process.env.FILE_RAG_CORRECTIVE_RETRY_ENABLED, true),
  selfReflectiveRetry: readBoolean(process.env.FILE_RAG_SELF_REFLECTIVE_ENABLED, true),
  relationshipDecomposition: readBoolean(process.env.FILE_RAG_RELATIONSHIP_MODE_ENABLED, true),
};

