-- Keep manager corrections durable and tied to the Teach evidence they refine.
ALTER TABLE "ManagerTeachSession"
  ADD COLUMN "parentSessionId" TEXT,
  ADD COLUMN "managerCorrection" TEXT;

ALTER TABLE "ManagerTeachSession"
  ADD CONSTRAINT "ManagerTeachSession_parentSessionId_fkey"
  FOREIGN KEY ("parentSessionId") REFERENCES "ManagerTeachSession"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ManagerTeachSession_parentSessionId_createdAt_idx"
  ON "ManagerTeachSession"("parentSessionId", "createdAt");
