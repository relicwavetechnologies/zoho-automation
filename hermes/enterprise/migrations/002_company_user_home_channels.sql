CREATE TABLE IF NOT EXISTS "CompanyUserHomeChannel" (
    "id" TEXT PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "companyUserId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "chatName" TEXT,
    "threadId" TEXT,
    "channelIdentityId" TEXT,
    "metadataJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "CompanyUserHomeChannel_company_user_platform_key"
        UNIQUE ("companyId", "companyUserId", "platform"),
    CONSTRAINT "CompanyUserHomeChannel_company_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE,
    CONSTRAINT "CompanyUserHomeChannel_company_user_fkey"
        FOREIGN KEY ("companyUserId") REFERENCES "CompanyUser" ("id") ON DELETE CASCADE,
    CONSTRAINT "CompanyUserHomeChannel_channel_identity_fkey"
        FOREIGN KEY ("channelIdentityId") REFERENCES "ChannelIdentity" ("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "CompanyUserHomeChannel_company_user_idx"
    ON "CompanyUserHomeChannel" ("companyId", "companyUserId");
