-- Make the backend-owned Canva capability visible in the desktop tool catalogue.
-- This is create-only so existing administrator curation is never overwritten.
INSERT INTO "RegisteredTool" (
  "id", "toolId", "name", "description", "category", "domain",
  "hitlRequired", "guardrails", "deprecated", "engines", "createdAt", "updatedAt"
)
SELECT
  'canva-design',
  'canvaDesign',
  'Canva',
  'Search, create, and update Canva designs through a connected Canva account.',
  'design',
  'canva',
  FALSE,
  ARRAY[
    'Uses an OAuth connection selected by its connection ID',
    'Canva credentials remain server-side',
    'Each operation is authorized by the backend before the Canva MCP is called'
  ]::TEXT[],
  FALSE,
  ARRAY[]::TEXT[],
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "RegisteredTool" WHERE "toolId" = 'canvaDesign'
);
