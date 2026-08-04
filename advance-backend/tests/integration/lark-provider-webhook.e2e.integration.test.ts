import 'dotenv/config';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { loadAndValidateEnv } from '../../src/config/env.ts';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { LarkMessagingClient, LarkToolMessagingClient } from '../../src/infrastructure/channels/lark/clients/lark-messaging.client.ts';
import { LarkOAuthService } from '../../src/infrastructure/lark/lark-oauth.service.ts';
import { IntegrationConnectionRepository } from '../../src/infrastructure/persistence/integration-connection.repository.ts';

const enabled = process.env['RUN_LARK_PROVIDER_WEBHOOK_E2E'] === '1';
const db = new PrismaClient();

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};

after(async () => {
  await db.$disconnect();
});

async function waitFor<T>(
  read: () => Promise<T | null>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise<void>(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('real Lark user message traverses provider webhook, durable ingress, cloud Pi, and final delivery', {
  skip: !enabled ? 'Set RUN_LARK_PROVIDER_WEBHOOK_E2E=1 with the development callback deployment online.' : false,
  timeout: 240_000,
}, async () => {
  const env = loadAndValidateEnv(process.env);
  const row = await db.integrationConnection.findFirst({
    where: {
      provider: 'lark',
      status: 'connected',
      revokedAt: null,
      ownerUserId: { not: null },
      externalAccountId: { not: null },
    },
    orderBy: [{ lastUsedAt: 'desc' }, { updatedAt: 'desc' }],
    select: { id: true, companyId: true, ownerUserId: true, externalAccountId: true },
  });
  assert.ok(row?.ownerUserId && row.externalAccountId, 'a connected user-owned Lark account is required');

  const connections = new IntegrationConnectionRepository(db, env);
  const resolved = await connections.findAccessibleLarkConnection({
    companyId: row.companyId,
    userId: row.ownerUserId,
    connectionId: row.id,
    minimumAccess: 'read_write',
  });
  assert.ok(resolved.ok && resolved.value, 'the owner must resolve the encrypted Lark connection');

  let userToken = resolved.value.accessToken;
  const expiresAt = resolved.value.accessTokenExpiresAt?.getTime() ?? 0;
  if (!userToken || expiresAt <= Date.now() + 60_000) {
    assert.ok(resolved.value.refreshToken, 'an expired Lark connection needs a refresh token');
    const oauth = new LarkOAuthService(
      env.LARK_APP_ID,
      env.LARK_APP_SECRET,
      env.LARK_OAUTH_REDIRECT_URI ?? `${env.BACKEND_PUBLIC_URL}/api/lark/auth/callback`,
      env.LARK_API_BASE_URL,
    );
    const refreshed = await oauth.refreshUserToken(resolved.value.refreshToken);
    const persisted = await connections.updateLarkTokens({
      connectionId: row.id,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? resolved.value.refreshToken,
      tokenType: refreshed.tokenType,
      accessTokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1_000),
      refreshTokenExpiresAt: refreshed.refreshTokenExpiresIn
        ? new Date(Date.now() + refreshed.refreshTokenExpiresIn * 1_000)
        : resolved.value.refreshTokenExpiresAt ?? null,
    });
    assert.ok(persisted.ok, 'the refreshed Lark token must be persisted');
    userToken = refreshed.accessToken;
  }
  assert.ok(userToken, 'a live Lark user token is required');

  const bot = new LarkMessagingClient({
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    apiBaseUrl: env.LARK_API_BASE_URL,
    logger,
  });
  const botIdentity = await bot.getBotIdentity();
  const userMessaging = new LarkToolMessagingClient({
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    apiBaseUrl: env.LARK_API_BASE_URL,
    userToken,
  });

  const marker = `DIVO LIVE WEBHOOK E2E ${Date.now()} ${process.pid}`;
  const startedAt = new Date(Date.now() - 2_000);
  const sent = await userMessaging.sendDm(
    botIdentity.openId,
    `${marker}. Reply with exactly: LIVE WEBHOOK OK`,
    { rendering: 'text' },
  );
  assert.ok(sent.messageId, 'Lark must return the provider message ID');

  const receipt = await waitFor(
    () => db.ingressIdempotencyKey.findFirst({
      where: { channel: 'lark', messageId: sent.messageId, acceptedAt: { gte: startedAt } },
      select: { id: true, status: true, payloadJson: true, companyId: true },
    }),
    'the provider-originated webhook receipt',
    45_000,
  );
  assert.equal(receipt.companyId, row.companyId, 'webhook admission must bind the correct tenant');

  const terminal = await waitFor(
    async () => {
      const current = await db.ingressIdempotencyKey.findUnique({
        where: { id: receipt.id },
        select: { status: true, lastError: true },
      });
      return current && ['completed', 'dead'].includes(current.status) ? current : null;
    },
    'durable ingress completion',
    150_000,
  );
  assert.equal(terminal.status, 'completed', `ingress failed: ${terminal.lastError ?? 'unknown'}`);

  const payload = receipt.payloadJson as Record<string, unknown>;
  const event = payload['event'] as Record<string, unknown> | undefined;
  const message = event?.['message'] as Record<string, unknown> | undefined;
  const chatId = typeof message?.['chat_id'] === 'string' ? message['chat_id'] : undefined;
  assert.ok(chatId, 'accepted provider payload must retain the exact chat target');

  const delivery = await waitFor(
    () => db.channelDelivery.findFirst({
      where: {
        channel: 'lark',
        companyId: row.companyId,
        chatId,
        createdAt: { gte: startedAt },
        status: 'delivered',
        providerMessageId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { status: true, providerMessageId: true },
    }),
    'the idempotent final Lark delivery',
    45_000,
  );
  assert.equal(delivery.status, 'delivered');
  assert.ok(delivery.providerMessageId);
});
