-- Protected-data classification is a durable, server-owned monotonic latch.
-- Application code only promotes this value to true; later trace batches may
-- omit their client observation but cannot make the run eligible for learning.
ALTER TABLE "ExecutionRun"
ADD COLUMN "protectedDataObserved" BOOLEAN NOT NULL DEFAULT false;
