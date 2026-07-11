INSERT INTO "RegisteredTool" (
  "id", "toolId", "name", "description", "category", "domain",
  "hitlRequired", "guardrails", "deprecated", "engines", "createdAt", "updatedAt"
)
SELECT
  'memory-recall',
  'memoryRecall',
  'Memory Recall',
  'Recall relevant personal, current-department, and company memory within the authenticated member boundaries.',
  'knowledge',
  'memory',
  FALSE,
  ARRAY[
    'The backend derives member, company, and selected department scope',
    'Read access does not use configurable RBAC or approval within valid organisational boundaries',
    'Returns facts only; no vector IDs, scores, metadata, or embeddings'
  ]::TEXT[],
  FALSE,
  ARRAY[]::TEXT[],
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "RegisteredTool" WHERE "toolId" = 'memoryRecall'
);
