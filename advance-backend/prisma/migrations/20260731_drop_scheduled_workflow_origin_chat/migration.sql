-- Every scheduled workflow now delivers its result to the creator's own Lark DM,
-- so the chat a schedule was created in is no longer read for delivery, or for
-- anything else. Dropping the column keeps the schema honest about that.
--
-- Destructive: production must run this before, or with, the deploy carrying the
-- matching schema change. The deploy runs `prisma db push` without
-- --accept-data-loss, so it will refuse the drop while non-null rows remain.
ALTER TABLE "ScheduledWorkflow"
  DROP COLUMN IF EXISTS "originChatId";
