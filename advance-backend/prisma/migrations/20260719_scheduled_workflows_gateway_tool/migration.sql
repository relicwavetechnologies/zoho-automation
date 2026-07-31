-- Expose the existing backend scheduler as one governed gateway capability.
INSERT INTO "RegisteredTool" (
  "id", "toolId", "name", "description", "category", "domain",
  "hitlRequired", "guardrails", "deprecated", "engines", "createdAt", "updatedAt"
)
SELECT
  'scheduled-workflows',
  'scheduledWorkflows',
  'Scheduled Workflows',
  'Create and manage durable one-time or recurring Divo work with results delivered back to the originating conversation.',
  'automation',
  'scheduling',
  FALSE,
  ARRAY[
    'Schedules are scoped to the authenticated company and creator',
    'The backend stores the originating department and conversation',
    'Every scheduled execution re-enters normal permission and approval enforcement'
  ]::TEXT[],
  FALSE,
  ARRAY[]::TEXT[],
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "RegisteredTool" WHERE "toolId" = 'scheduledWorkflows'
);

-- Existing department matrices are sparse and deny missing rows. Grant the
-- new member-default capability to every current role without modifying any
-- existing administrator decision.
INSERT INTO "DepartmentToolPermission" (
  "id", "departmentId", "roleId", "toolId", "actionGroup", "allowed", "updatedBy", "updatedAt"
)
SELECT
  gen_random_uuid(),
  role."departmentId",
  role."id",
  'scheduledWorkflows',
  action."actionGroup",
  TRUE,
  config."updatedBy",
  NOW()
FROM "DepartmentRole" role
JOIN "DepartmentAgentConfig" config ON config."departmentId" = role."departmentId"
CROSS JOIN (
  VALUES ('read'), ('create'), ('update'), ('delete'), ('execute')
) AS action("actionGroup")
ON CONFLICT ("departmentId", "roleId", "toolId", "actionGroup") DO NOTHING;
