import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { decryptToken, encryptToken } from '../src/infrastructure/shared/token.crypto';

/**
 * One-way cutover from the retired LarkUserAuthLink table to Divo's generic
 * IntegrationConnection registry. It is idempotent and leaves legacy rows as
 * revoked archive records; the application never reads them after cutover.
 *
 * Usage:
 *   pnpm tsx scripts/migrate-lark-user-auth-links.ts --dry-run
 *   pnpm tsx scripts/migrate-lark-user-auth-links.ts --apply
 *   pnpm tsx scripts/migrate-lark-user-auth-links.ts --apply --company <id>
 */

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const companyIndex = process.argv.indexOf('--company');
const companyId = companyIndex >= 0 ? process.argv[companyIndex + 1] : undefined;
const key = process.env.ZOHO_TOKEN_ENCRYPTION_KEY?.trim();

function connectionKey(userId: string, email: string | null, openId: string): string {
  const account = (email?.trim().toLowerCase() || openId.trim().toLowerCase() || 'unknown');
  return `lark:user:${userId}:${account}`;
}

function scopes(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const value = (metadata as Record<string, unknown>)['scope'];
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

async function main(): Promise<void> {
  if (!key) throw new Error('ZOHO_TOKEN_ENCRYPTION_KEY is required to migrate encrypted Lark tokens');
  const links = await prisma.larkUserAuthLink.findMany({
    where: {
      revokedAt: null,
      ...(companyId ? { companyId } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`${apply ? 'Applying' : 'Dry run'}: ${links.length} active Lark auth link(s)`);
  let migrated = 0;
  let failed = 0;

  for (const link of links) {
    const openId = link.larkOpenId || link.larkUserId;
    if (!openId) {
      failed += 1;
      console.error(`SKIP ${link.id}: no Lark open_id or user_id`);
      continue;
    }

    try {
      const accessToken = decryptToken(link.accessTokenEncrypted, key);
      const refreshToken = link.refreshTokenEncrypted
        ? decryptToken(link.refreshTokenEncrypted, key)
        : null;
      const dedupeKey = connectionKey(link.userId, link.larkEmail || null, openId);
      const metadata = {
        larkOpenId: openId,
        ...(link.larkUserId ? { larkUserId: link.larkUserId } : {}),
        ...(link.larkTenantKey ? { larkTenantKey: link.larkTenantKey } : {}),
        migratedFrom: 'LarkUserAuthLink',
        migratedAt: new Date().toISOString(),
      };

      if (apply) {
        await prisma.$transaction(async tx => {
          const connection = await tx.integrationConnection.upsert({
            where: { companyId_dedupeKey: { companyId: link.companyId, dedupeKey } },
            create: {
              companyId: link.companyId,
              provider: 'lark',
              ownerType: 'user',
              ownerUserId: link.userId,
              label: `${link.larkName || link.larkEmail || 'Lark'} connection`,
              accountEmail: link.larkEmail || null,
              accountName: link.larkName || link.larkEmail || null,
              externalAccountId: openId,
              dedupeKey,
              status: 'connected',
              scopes: scopes(link.tokenMetadata),
              accessTokenEncrypted: encryptToken(accessToken, key).cipherText,
              refreshTokenEncrypted: refreshToken ? encryptToken(refreshToken, key).cipherText : null,
              tokenType: link.tokenType,
              accessTokenExpiresAt: link.accessTokenExpiresAt,
              refreshTokenExpiresAt: link.refreshTokenExpiresAt,
              tokenMetadata: metadata,
              connectedAt: link.linkedAt,
              lastUsedAt: link.lastUsedAt,
              createdBy: link.userId,
            },
            update: {
              status: 'connected',
              accountEmail: link.larkEmail || null,
              accountName: link.larkName || link.larkEmail || null,
              externalAccountId: openId,
              scopes: scopes(link.tokenMetadata),
              accessTokenEncrypted: encryptToken(accessToken, key).cipherText,
              refreshTokenEncrypted: refreshToken ? encryptToken(refreshToken, key).cipherText : null,
              tokenType: link.tokenType,
              accessTokenExpiresAt: link.accessTokenExpiresAt,
              refreshTokenExpiresAt: link.refreshTokenExpiresAt,
              tokenMetadata: metadata,
              revokedAt: null,
              updatedAt: new Date(),
            },
          });

          await tx.integrationConnectionGrant.upsert({
            where: {
              connectionId_granteeType_granteeId: {
                connectionId: connection.id,
                granteeType: 'user',
                granteeId: link.userId,
              },
            },
            create: {
              companyId: link.companyId,
              connectionId: connection.id,
              granteeType: 'user',
              granteeId: link.userId,
              access: 'admin',
              grantedBy: link.userId,
            },
            update: { access: 'admin', revokedAt: null, grantedAt: new Date() },
          });

          const existingIdentity = await tx.channelIdentity.findFirst({
            where: { companyId: link.companyId, channel: 'lark', larkOpenId: openId },
            select: { id: true },
          });
          const identityData = {
            larkOpenId: openId,
            ...(link.larkUserId ? { larkUserId: link.larkUserId } : {}),
            ...(link.larkEmail ? { email: link.larkEmail } : {}),
            ...(link.larkName ? { displayName: link.larkName } : {}),
          };
          if (existingIdentity) {
            await tx.channelIdentity.update({ where: { id: existingIdentity.id }, data: identityData });
          } else {
            await tx.channelIdentity.create({
              data: {
                companyId: link.companyId,
                channel: 'lark',
                externalUserId: openId,
                externalTenantId: link.larkTenantKey,
                aiRole: 'MEMBER',
                ...identityData,
              },
            });
          }
          await tx.larkUserAuthLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
        });
      }
      migrated += 1;
      console.log(`OK ${link.companyId}/${link.userId}: ${openId}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${link.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`Result: migrated=${migrated} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
