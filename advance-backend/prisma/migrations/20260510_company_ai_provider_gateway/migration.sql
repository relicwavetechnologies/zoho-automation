ALTER TABLE "Company"
  ADD COLUMN "gateway_api_key" TEXT,
  ADD COLUMN "gateway_url" TEXT,
  ADD COLUMN "gateway_dedicated_account_id" TEXT,
  ADD COLUMN "default_ai_provider" TEXT NOT NULL DEFAULT 'google',
  ADD COLUMN "default_ai_model" TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite-preview';
