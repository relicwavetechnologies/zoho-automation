-- Where a document lives once the container that wrote it is gone.
--
-- The agent writes an ordinary markdown file in its workspace and badges it with
-- `divo_artifact`; the tool lifts the body out and files it here. Without this
-- table the badge names a path that stops existing when the run ends, which is
-- why the web could not be given artifacts before.
--
-- Unique on (companyId, userId, artifactId): `artifactId` is the runtime's own
-- key for the file, so revising the same document is an update in place and a
-- version bump, not a ninth row nobody can tell apart from the eighth.
CREATE TABLE "Artifact" (
  "id"             TEXT NOT NULL,
  "companyId"      TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "artifactId"     TEXT NOT NULL,
  "threadId"       TEXT,
  "executionRunId" TEXT,
  "title"          TEXT NOT NULL,
  "mime"           TEXT NOT NULL DEFAULT 'text/markdown',
  "body"           TEXT NOT NULL,
  "version"        INTEGER NOT NULL DEFAULT 1,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Artifact_companyId_userId_artifactId_key"
  ON "Artifact"("companyId", "userId", "artifactId");

-- The panel's two reads: everything this member has, and everything one
-- conversation produced.
CREATE INDEX "Artifact_companyId_userId_updatedAt_idx"
  ON "Artifact"("companyId", "userId", "updatedAt");
CREATE INDEX "Artifact_companyId_userId_threadId_updatedAt_idx"
  ON "Artifact"("companyId", "userId", "threadId", "updatedAt");
