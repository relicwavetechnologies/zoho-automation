-- These are retired catalogue aliases/agent labels, not executable canonical
-- desktop tools. Preserve them for history while excluding them from inventory.
UPDATE "RegisteredTool"
SET "deprecated" = TRUE,
    "updatedAt" = NOW()
WHERE "deprecated" = FALSE
  AND "toolId" IN (
    'devTools',
    'documentRead',
    'googleWorkspace',
    'lark-response',
    'larkMeeting',
    'larkMessage',
    'outreach',
    'response',
    'risk-check',
    'search-agent',
    'search-read',
    'share_chat_vectors',
    'workflow'
  );
