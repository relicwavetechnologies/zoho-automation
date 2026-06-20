-- Divo Follow Ups control layer: lifecycle metadata on top of Lark Tasks.
-- v1 stores delegation state, policy, tracking doc pointers, and audit events.
-- No Lark side effects here — persistence only.

CREATE TABLE IF NOT EXISTS "HermesFollowUp" (
  "id"                      TEXT PRIMARY KEY,
  "companyId"               TEXT NOT NULL REFERENCES "Company"("id") ON DELETE CASCADE,
  "larkTaskGuid"            TEXT NOT NULL,
  "delegatorCompanyUserId"  TEXT NOT NULL REFERENCES "CompanyUser"("id") ON DELETE CASCADE,
  "assigneeCompanyUserId"   TEXT NOT NULL REFERENCES "CompanyUser"("id") ON DELETE CASCADE,
  "sourceSessionId"         TEXT NULL,
  "activeSessionId"         TEXT NULL,
  "trackingDocToken"        TEXT NULL,
  "trackingDocUrl"          TEXT NULL,
  "status"                  TEXT NOT NULL DEFAULT 'assigned',
  "followUpPolicyJson"      JSONB NOT NULL DEFAULT '{}'::jsonb,
  "startedAt"               TIMESTAMPTZ NULL,
  "pausedAt"                TIMESTAMPTZ NULL,
  "completedAt"             TIMESTAMPTZ NULL,
  "summary"                 TEXT NULL,
  "lastDocAppendAt"         TIMESTAMPTZ NULL,
  "createdAt"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "HermesFollowUp_lark_task_idx"
  ON "HermesFollowUp" ("companyId", "larkTaskGuid");

CREATE INDEX IF NOT EXISTS "HermesFollowUp_assignee_status_idx"
  ON "HermesFollowUp" ("companyId", "assigneeCompanyUserId", "status", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "HermesFollowUp_active_idx"
  ON "HermesFollowUp" ("companyId", "assigneeCompanyUserId", "createdAt" DESC)
  WHERE "status" = 'active';

CREATE TABLE IF NOT EXISTS "HermesFollowUpEvent" (
  "id"                  TEXT PRIMARY KEY,
  "followUpId"          TEXT NOT NULL REFERENCES "HermesFollowUp"("id") ON DELETE CASCADE,
  "eventType"           TEXT NOT NULL,
  "actorCompanyUserId"  TEXT NULL,
  "payloadJson"         JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "HermesFollowUpEvent_follow_up_time_idx"
  ON "HermesFollowUpEvent" ("followUpId", "createdAt" ASC);
