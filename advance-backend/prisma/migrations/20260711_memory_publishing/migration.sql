INSERT INTO "RegisteredTool" (
  "id", "toolId", "name", "description", "category", "domain",
  "hitlRequired", "guardrails", "deprecated", "engines", "createdAt", "updatedAt"
)
SELECT
  'memory-publishing',
  'memoryPublishing',
  'Memory Publishing',
  'Check available memory targets and publish explicitly reviewed durable facts.',
  'knowledge',
  'memory',
  TRUE,
  ARRAY[
    'Only explicitly reviewed durable facts may be published',
    'Backend authorization is re-evaluated before every publish',
    'Denied shared scopes are never downgraded to personal memory'
  ]::TEXT[],
  FALSE,
  ARRAY[]::TEXT[],
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "RegisteredTool" WHERE "toolId" = 'memoryPublishing'
);

INSERT INTO "Skill" (
  "id", "companyId", "departmentId", "scope", "name", "slug", "summary", "markdown",
  "toolIds", "tags", "status", "isSystem", "sortOrder", "createdAt", "updatedAt"
)
SELECT
  LOWER(CONCAT(
    SUBSTRING(MD5(company."id" || ':share-memory') FROM 1 FOR 8), '-',
    SUBSTRING(MD5(company."id" || ':share-memory') FROM 9 FOR 4), '-',
    SUBSTRING(MD5(company."id" || ':share-memory') FROM 13 FOR 4), '-',
    SUBSTRING(MD5(company."id" || ':share-memory') FROM 17 FOR 4), '-',
    SUBSTRING(MD5(company."id" || ':share-memory') FROM 21 FOR 12)
  )),
  company."id",
  NULL,
  'global',
  'Share Memory',
  'share-memory',
  'Review durable facts from the current conversation and explicitly publish the selected facts to an available backend memory target.',
  $skill$
# Share Memory

Use this skill only when the member explicitly asks to share or save durable conversation memory.

## Review Flow

1. Call `memoryPublishing` with `operation: "check_authority"` before proposing a review. Read `availability`, exact `targets`, and `scopeOutcomes`.
2. If availability is `storage_unavailable`, or there are no targets, tell the member memory sharing is unavailable and do not open a review. If a requested scope is `not_authorized`, state that scope is unavailable and do not retry it or downgrade it.
3. Propose only durable, user-confirmed facts, decisions, and preferences. Exclude secrets, raw tool output, transient task state, and unconfirmed assistant inference.
4. Call the local `divo_memory_review` tool with only `proposalId` and the proposed `bullets`. Never pass `departmentId` or `allowedTargets` to the local tool.
5. `divo_memory_review` uses the desktop-configured department context to independently obtain the current canonical targets, owns the custom review card, and lets the member edit the facts, choose one exact returned target, approve, revise, or cancel.
6. Do not call `tools.prepare`, `tools.commit`, or `memoryPublishing.publish` directly. After approval, `divo_memory_review` prepares and commits the final reviewed facts and exact selected target through the standard backend gateway flow.
7. Use the local tool result as the source of truth. If publish is denied, report the denial. Never retry in a narrower scope unless the member starts and approves a new review.

## Bounds

- Submit between 1 and 10 facts.
- Each fact must be concise and no longer than 500 characters.
- Do not claim memory was saved until the committed backend tool result confirms it.
$skill$,
  ARRAY['memoryPublishing']::TEXT[],
  ARRAY['memory', 'sharing', 'review']::TEXT[],
  'active',
  TRUE,
  0,
  NOW(),
  NOW()
FROM "Company" company
WHERE NOT EXISTS (
  SELECT 1 FROM "Skill" skill
  WHERE skill."companyId" = company."id"
    AND skill."slug" = 'share-memory'
    AND skill."status" <> 'archived'
);
