import 'dotenv/config';

import { PrismaClient } from '../src/generated/prisma';
import { encryptZohoSecret } from '../src/company/integrations/zoho/zoho-token.crypto';

const prisma = new PrismaClient();

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const toNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

async function main() {
  const companyId = required('TARGET_COMPANY_ID');
  const updatedBy = required('TARGET_UPDATED_BY');
  const clientId = required('ZOHO_NEW_CLIENT_ID');
  const clientSecret = required('ZOHO_NEW_CLIENT_SECRET');
  const authorizationCode = required('ZOHO_AUTHORIZATION_CODE');

  const profile = await prisma.zohoConnectionProfile.findFirst({
    where: {
      companyId,
      isActive: true,
      disabledAt: null,
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      profileName: true,
      scopes: true,
      redirectUri: true,
      accountsBaseUrl: true,
      apiBaseUrl: true,
      tokenMetadata: true,
    },
  });

  const connection = await prisma.zohoConnection.findUnique({
    where: {
      companyId_environment: {
        companyId,
        environment: 'prod',
      },
    },
    select: {
      id: true,
      scopes: true,
      tokenMetadata: true,
    },
  });

  if (!profile) {
    throw new Error(`No active Zoho connection profile found for company ${companyId}`);
  }

  if (!connection) {
    throw new Error(`No Zoho connection found for company ${companyId}`);
  }

  const response = await fetch(`${profile.accountsBaseUrl.replace(/\/$/, '')}/oauth/v2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: profile.redirectUri,
      code: authorizationCode,
    }),
  });

  const payload = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number | string;
    refresh_token_expires_in?: number | string;
    scope?: string;
    api_domain?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(
      `Zoho exchange failed: ${payload.error_description ?? payload.error ?? JSON.stringify(payload)}`,
    );
  }

  if (!payload.refresh_token) {
    throw new Error('Zoho exchange did not return a refresh token.');
  }

  const now = Date.now();
  const accessTokenExpiresAt = new Date(now + (toNumber(payload.expires_in) ?? 3600) * 1000);
  const refreshLifetimeSeconds = toNumber(payload.refresh_token_expires_in);
  const refreshTokenExpiresAt = refreshLifetimeSeconds !== null
    ? new Date(now + refreshLifetimeSeconds * 1000)
    : null;
  const encryptedSecret = encryptZohoSecret(clientSecret);
  const encryptedAccess = encryptZohoSecret(payload.access_token);
  const encryptedRefresh = encryptZohoSecret(payload.refresh_token);
  const scopes = String(payload.scope ?? '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const resolvedScopes = scopes.length > 0 ? scopes : profile.scopes;
  const tokenMetadata = {
    ...(typeof connection.tokenMetadata === 'object' && connection.tokenMetadata ? connection.tokenMetadata : {}),
    ...(typeof profile.tokenMetadata === 'object' && profile.tokenMetadata ? profile.tokenMetadata : {}),
    apiDomain: payload.api_domain ?? profile.apiBaseUrl,
    tokenType: payload.token_type ?? null,
  };

  await prisma.$transaction([
    prisma.zohoOAuthConfig.upsert({
      where: { companyId },
      create: {
        companyId,
        clientId,
        clientSecretEncrypted: encryptedSecret.cipherText,
        redirectUri: profile.redirectUri,
        accountsBaseUrl: profile.accountsBaseUrl,
        apiBaseUrl: profile.apiBaseUrl,
      },
      update: {
        clientId,
        clientSecretEncrypted: encryptedSecret.cipherText,
        redirectUri: profile.redirectUri,
        accountsBaseUrl: profile.accountsBaseUrl,
        apiBaseUrl: profile.apiBaseUrl,
      },
    }),
    prisma.zohoConnectionProfile.update({
      where: { id: profile.id },
      data: {
        clientId,
        clientSecretEncrypted: encryptedSecret.cipherText,
        redirectUri: profile.redirectUri,
        accountsBaseUrl: profile.accountsBaseUrl,
        apiBaseUrl: profile.apiBaseUrl,
        accessTokenEncrypted: encryptedAccess.cipherText,
        refreshTokenEncrypted: encryptedRefresh.cipherText,
        tokenCipherVersion: encryptedAccess.version,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        tokenMetadata,
        scopes: resolvedScopes,
        status: 'CONNECTED',
        isActive: true,
        disabledAt: null,
        connectedAt: new Date(now),
        updatedBy,
      },
    }),
    prisma.zohoConnection.update({
      where: { id: connection.id },
      data: {
        providerMode: 'rest',
        status: 'CONNECTED',
        connectedAt: new Date(now),
        scopes: resolvedScopes,
        accessTokenEncrypted: encryptedAccess.cipherText,
        refreshTokenEncrypted: encryptedRefresh.cipherText,
        tokenCipherVersion: encryptedAccess.version,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        tokenFailureCode: null,
        lastTokenRefreshAt: new Date(now),
        tokenMetadata,
      },
    }),
  ]);

  console.log(JSON.stringify({
    companyId,
    profileId: profile.id,
    connectionId: connection.id,
    redirectUri: profile.redirectUri,
    accountsBaseUrl: profile.accountsBaseUrl,
    apiBaseUrl: profile.apiBaseUrl,
    scopes: resolvedScopes,
    apiDomain: payload.api_domain ?? null,
    tokenType: payload.token_type ?? null,
    accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
    refreshTokenExpiresAt: refreshTokenExpiresAt?.toISOString() ?? null,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
