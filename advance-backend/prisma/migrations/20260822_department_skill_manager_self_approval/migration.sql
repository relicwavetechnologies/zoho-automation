BEGIN;

ALTER TABLE "KnowledgeMutation"
  DROP CONSTRAINT IF EXISTS "KnowledgeMutation_scope_policy";
ALTER TABLE "KnowledgePolicy"
  DROP CONSTRAINT IF EXISTS "KnowledgePolicy_scope_policy";

ALTER TABLE "KnowledgeMutation"
  ADD CONSTRAINT "KnowledgeMutation_scope_policy" CHECK (
    ("scope" = 'personal' AND "requiredAuthority" = 'none') OR
    (
      "scope" = 'department'
      AND "requiredAuthority" = 'department_manager'
      AND "requesterReviewRequired"
      AND ("distinctApprover" OR "kind" = 'skill')
    ) OR
    (
      "scope" = 'company'
      AND "requiredAuthority" = 'company_admin'
      AND "requesterReviewRequired"
      AND "distinctApprover"
    )
  );

ALTER TABLE "KnowledgePolicy"
  ADD CONSTRAINT "KnowledgePolicy_scope_policy" CHECK (
    ("scope" = 'personal' AND "requiredAuthority" = 'none') OR
    (
      "scope" = 'department'
      AND "requiredAuthority" = 'department_manager'
      AND "requesterReviewRequired"
      AND ("distinctApprover" OR "kind" = 'skill')
    ) OR
    (
      "scope" = 'company'
      AND "requiredAuthority" = 'company_admin'
      AND "requesterReviewRequired"
      AND "distinctApprover"
    )
  );

UPDATE "KnowledgePolicy"
SET
  "distinctApprover" = false,
  "version" = GREATEST("version", 2),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "tenantKey" = 'global'
  AND "kind" = 'skill'
  AND "scope" = 'department';

COMMIT;
