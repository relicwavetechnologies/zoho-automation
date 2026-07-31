-- Hard cutover from the three custom Google clients to the backend-owned
-- Workspace MCP product catalogue. Existing administrator policy rows remain
-- intact; this migration only refreshes provider descriptions and creates the
-- newly available product entries.
UPDATE "RegisteredTool"
SET "description" = CASE "toolId"
  WHEN 'googleGmail' THEN 'Search, read, send, draft, organize, and manage Gmail messages, threads, labels, filters, and attachments.'
  WHEN 'googleDrive' THEN 'Search, read, create, download, organize, import, and share Google Drive files and folders.'
  WHEN 'googleCalendar' THEN 'List calendars, manage events, check availability, and manage out-of-office and focus time.'
END,
"updatedAt" = NOW()
WHERE "toolId" IN ('googleGmail', 'googleDrive', 'googleCalendar');

INSERT INTO "RegisteredTool" (
  "id", "toolId", "name", "description", "category", "domain",
  "hitlRequired", "guardrails", "deprecated", "engines", "createdAt", "updatedAt"
)
VALUES
  ('google-docs-mcp', 'googleDocs', 'Google Docs', 'Create, read, format, edit, export, structure, and comment on Google Docs.', 'documents', 'google', FALSE, ARRAY['Uses a Divo OAuth connection selected by connection ID', 'Google credentials remain server-side', 'Every operation is authorized by Divo before the private Workspace MCP is called']::TEXT[], FALSE, ARRAY[]::TEXT[], NOW(), NOW()),
  ('google-sheets-mcp', 'googleSheets', 'Google Sheets', 'Create, read, write, format, resize, comment on, and manage Google Sheets and tables.', 'data', 'google', FALSE, ARRAY['Uses a Divo OAuth connection selected by connection ID', 'Google credentials remain server-side', 'Every operation is authorized by Divo before the private Workspace MCP is called']::TEXT[], FALSE, ARRAY[]::TEXT[], NOW(), NOW()),
  ('google-slides-mcp', 'googleSlides', 'Google Slides', 'Create, inspect, update, render, and comment on Google Slides presentations.', 'presentations', 'google', FALSE, ARRAY['Uses a Divo OAuth connection selected by connection ID', 'Google credentials remain server-side', 'Every operation is authorized by Divo before the private Workspace MCP is called']::TEXT[], FALSE, ARRAY[]::TEXT[], NOW(), NOW()),
  ('google-forms-mcp', 'googleForms', 'Google Forms', 'Create, read, publish, update, and inspect responses for Google Forms.', 'forms', 'google', FALSE, ARRAY['Uses a Divo OAuth connection selected by connection ID', 'Google credentials remain server-side', 'Every operation is authorized by Divo before the private Workspace MCP is called']::TEXT[], FALSE, ARRAY[]::TEXT[], NOW(), NOW()),
  ('google-tasks-mcp', 'googleTasks', 'Google Tasks', 'List and manage Google Tasks, task lists, due dates, status, and task movement.', 'productivity', 'google', FALSE, ARRAY['Uses a Divo OAuth connection selected by connection ID', 'Google credentials remain server-side', 'Every operation is authorized by Divo before the private Workspace MCP is called']::TEXT[], FALSE, ARRAY[]::TEXT[], NOW(), NOW()),
  ('google-contacts-mcp', 'googleContacts', 'Google Contacts', 'Search, read, create, update, delete, and group Google Contacts.', 'directory', 'google', FALSE, ARRAY['Uses a Divo OAuth connection selected by connection ID', 'Google credentials remain server-side', 'Every operation is authorized by Divo before the private Workspace MCP is called']::TEXT[], FALSE, ARRAY[]::TEXT[], NOW(), NOW()),
  ('google-chat-mcp', 'googleChat', 'Google Chat', 'List Google Chat spaces, search and read messages, send messages, react, and download attachments.', 'communication', 'google', FALSE, ARRAY['Uses a Divo OAuth connection selected by connection ID', 'Google credentials remain server-side', 'Every operation is authorized by Divo before the private Workspace MCP is called']::TEXT[], FALSE, ARRAY[]::TEXT[], NOW(), NOW()),
  ('google-appscript-mcp', 'googleAppsScript', 'Google Apps Script', 'Create, inspect, update, deploy, execute, version, and monitor Google Apps Script projects.', 'development', 'google', FALSE, ARRAY['Uses a Divo OAuth connection selected by connection ID', 'Google credentials remain server-side', 'Every operation is authorized by Divo before the private Workspace MCP is called']::TEXT[], FALSE, ARRAY[]::TEXT[], NOW(), NOW())
ON CONFLICT ("toolId") DO NOTHING;
