CREATE TABLE IF NOT EXISTS "HermesConnectorCredential" (
  "id" TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL REFERENCES "Company"("id") ON DELETE CASCADE,
  "companyUserId" TEXT NULL REFERENCES "CompanyUser"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'company',
  "payloadEncrypted" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "revokedAt" TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS "HermesConnectorCredential_company_provider_idx"
  ON "HermesConnectorCredential" ("companyId", "provider", "companyUserId")
  WHERE "revokedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "HermesConnectorCredential_active_lookup_idx"
  ON "HermesConnectorCredential" ("companyId", "companyUserId", "provider", "updatedAt" DESC)
  WHERE "status" = 'active' AND "revokedAt" IS NULL;
