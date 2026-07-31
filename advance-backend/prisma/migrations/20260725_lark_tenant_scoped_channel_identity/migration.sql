CREATE UNIQUE INDEX IF NOT EXISTS "ChannelIdentity_channel_externalTenantId_externalUserId_com_key"
ON "ChannelIdentity"("channel", "externalTenantId", "externalUserId", "companyId");

DROP INDEX IF EXISTS "ChannelIdentity_channel_externalUserId_companyId_key";
