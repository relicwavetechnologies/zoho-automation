CREATE TABLE "DesktopWorkspace" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "lastOpenedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DesktopWorkspace_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DesktopWorkspace_companyId_userId_path_key"
  ON "DesktopWorkspace"("companyId", "userId", "path");

CREATE INDEX "DesktopWorkspace_userId_companyId_updatedAt_idx"
  ON "DesktopWorkspace"("userId", "companyId", "updatedAt");

ALTER TABLE "DesktopWorkspace"
  ADD CONSTRAINT "DesktopWorkspace_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DesktopWorkspace"
  ADD CONSTRAINT "DesktopWorkspace_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DesktopThread"
  ADD COLUMN "workspaceId" TEXT,
  ADD COLUMN "workspacePath" TEXT,
  ADD COLUMN "workspaceName" TEXT;

CREATE INDEX "DesktopThread_workspaceId_updatedAt_idx"
  ON "DesktopThread"("workspaceId", "updatedAt");

ALTER TABLE "DesktopThread"
  ADD CONSTRAINT "DesktopThread_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "DesktopWorkspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
