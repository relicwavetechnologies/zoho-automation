-- P4: automatic, evidence-gated promotion into an isolated manager persona tree.
-- No user memory, executable Skill, RBAC, or tool-policy table is modified.

ALTER TYPE "PersonaLearningCandidateStatus" ADD VALUE 'active';
CREATE TYPE "ManagerPersonaNodeStatus" AS ENUM ('active', 'superseded', 'quarantined');

ALTER TABLE "PersonaLearningCandidate"
  ADD COLUMN "ruleKey" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "promotedNodeId" TEXT,
  ADD COLUMN "promotedAt" TIMESTAMP(3);

CREATE TABLE "ManagerPersonaTree" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "managerId" TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ManagerPersonaTree_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ManagerPersonaNode" (
  "id" TEXT NOT NULL,
  "treeId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "managerId" TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "kind" "PersonaLearningCandidateKind" NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "ruleKey" TEXT NOT NULL,
  "instruction" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "evidenceCount" INTEGER NOT NULL,
  "firstEvidenceAt" TIMESTAMP(3) NOT NULL,
  "lastEvidenceAt" TIMESTAMP(3) NOT NULL,
  "status" "ManagerPersonaNodeStatus" NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ManagerPersonaNode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ManagerPersonaTree_companyId_managerId_departmentId_key"
  ON "ManagerPersonaTree"("companyId", "managerId", "departmentId");
CREATE INDEX "ManagerPersonaTree_companyId_departmentId_updatedAt_idx"
  ON "ManagerPersonaTree"("companyId", "departmentId", "updatedAt");
CREATE UNIQUE INDEX "ManagerPersonaNode_treeId_kind_scopeKey_ruleKey_key"
  ON "ManagerPersonaNode"("treeId", "kind", "scopeKey", "ruleKey");
CREATE INDEX "ManagerPersonaNode_companyId_departmentId_managerId_status_scopeKey_idx"
  ON "ManagerPersonaNode"("companyId", "departmentId", "managerId", "status", "scopeKey");
CREATE INDEX "PersonaLearningCandidate_status_ruleKey_createdAt_idx"
  ON "PersonaLearningCandidate"("status", "ruleKey", "createdAt");

ALTER TABLE "ManagerPersonaTree"
  ADD CONSTRAINT "ManagerPersonaTree_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerPersonaTree"
  ADD CONSTRAINT "ManagerPersonaTree_managerId_fkey"
  FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerPersonaTree"
  ADD CONSTRAINT "ManagerPersonaTree_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerPersonaNode"
  ADD CONSTRAINT "ManagerPersonaNode_treeId_fkey"
  FOREIGN KEY ("treeId") REFERENCES "ManagerPersonaTree"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerPersonaNode"
  ADD CONSTRAINT "ManagerPersonaNode_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerPersonaNode"
  ADD CONSTRAINT "ManagerPersonaNode_managerId_fkey"
  FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerPersonaNode"
  ADD CONSTRAINT "ManagerPersonaNode_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonaLearningCandidate"
  ADD CONSTRAINT "PersonaLearningCandidate_promotedNodeId_fkey"
  FOREIGN KEY ("promotedNodeId") REFERENCES "ManagerPersonaNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
