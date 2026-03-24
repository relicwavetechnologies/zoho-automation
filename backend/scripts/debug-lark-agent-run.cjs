#!/usr/bin/env node

const path = require('path');
const dotenv = require('dotenv');
const { PrismaClient } = require('../src/generated/prisma');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const prisma = new PrismaClient();
const args = process.argv.slice(2);

const readArg = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const hasFlag = (name) => args.includes(name);

const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

const log = (message, details) => {
  console.log(`[debug-lark-agent-run] ${message}`);
  if (details !== undefined) {
    console.log(JSON.stringify(details, null, 2));
  }
};

const fail = async (message, details) => {
  console.error(`[debug-lark-agent-run] ${message}`);
  if (details !== undefined) {
    console.error(JSON.stringify(details, null, 2));
  }
  await prisma.$disconnect();
  process.exit(1);
};

const warn = (message, details) => {
  console.warn(`[debug-lark-agent-run] ${message}`);
  if (details !== undefined) {
    console.warn(JSON.stringify(details, null, 2));
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveLatestLarkContext = async (companyId) => {
  const effectiveCompanyId = asString(companyId);

  let recentMessages;
  try {
    recentMessages = await prisma.desktopMessage.findMany({
      where: {
        thread: {
          channel: 'lark',
          ...(effectiveCompanyId ? { companyId: effectiveCompanyId } : {}),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        createdAt: true,
        metadata: true,
        thread: {
          select: {
            id: true,
            companyId: true,
            userId: true,
            channel: true,
          },
        },
      },
    });
  } catch (error) {
    warn('Could not auto-resolve recent Lark context from Prisma. Pass explicit ids if needed.', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  for (const recentMessage of recentMessages) {
    const larkMeta = asRecord(asRecord(recentMessage.metadata)?.lark);
    const chatId = asString(larkMeta?.chatId);
    const larkOpenId = asString(larkMeta?.larkOpenId) || asString(larkMeta?.openId);
    const tenantKey = asString(larkMeta?.larkTenantKey) || asString(larkMeta?.tenantKey);
    const larkUserIdFromMessage = asString(larkMeta?.larkUserId) || asString(larkMeta?.userId);
    if (!chatId || !larkOpenId || !tenantKey) {
      continue;
    }

    const matchingLink = await prisma.larkUserAuthLink.findFirst({
      where: {
        revokedAt: null,
        companyId: recentMessage.thread.companyId,
        OR: [
          { larkOpenId },
          { userId: recentMessage.thread.userId },
        ],
      },
      orderBy: [
        { lastUsedAt: 'desc' },
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        companyId: true,
        userId: true,
        larkTenantKey: true,
        larkOpenId: true,
        larkUserId: true,
        larkEmail: true,
      },
    });

    return {
      companyId: matchingLink?.companyId ?? recentMessage.thread.companyId,
      userId: matchingLink?.userId ?? recentMessage.thread.userId,
      larkTenantKey: matchingLink?.larkTenantKey ?? tenantKey,
      larkOpenId: matchingLink?.larkOpenId ?? larkOpenId,
      larkUserId: matchingLink?.larkUserId ?? larkUserIdFromMessage ?? larkOpenId,
      larkEmail: matchingLink?.larkEmail,
      chatId,
      messageIdSource: recentMessage.id,
    };
  }

  let latestLink;
  try {
    latestLink = await prisma.larkUserAuthLink.findFirst({
      where: {
        revokedAt: null,
        ...(effectiveCompanyId ? { companyId: effectiveCompanyId } : {}),
      },
      orderBy: [
        { lastUsedAt: 'desc' },
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        companyId: true,
        userId: true,
        larkTenantKey: true,
        larkOpenId: true,
        larkUserId: true,
        larkEmail: true,
      },
    });
  } catch (error) {
    warn('Could not fall back to recent Lark auth link lookup. Pass explicit ids if needed.', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  return latestLink
    ? {
      companyId: latestLink.companyId,
      userId: latestLink.userId,
      larkTenantKey: latestLink.larkTenantKey,
      larkOpenId: latestLink.larkOpenId,
      larkUserId: latestLink.larkUserId,
      larkEmail: latestLink.larkEmail,
      chatId: undefined,
      messageIdSource: null,
    }
    : null;
};

const buildPayload = (input) => ({
  schema: '2.0',
  header: {
    event_id: `debug_lark_event_${Date.now()}`,
    token: input.verificationToken,
    create_time: String(Date.now()),
    event_type: 'im.message.receive_v1',
    tenant_key: input.tenantKey,
    app_id: input.appId,
  },
  event: {
    sender: {
      sender_id: {
        user_id: input.larkUserId,
        open_id: input.larkOpenId,
      },
      sender_type: 'user',
      tenant_key: input.tenantKey,
    },
    message: {
      message_id: `om_debug_${Date.now()}`,
      root_id: '',
      parent_id: '',
      create_time: String(Date.now()),
      chat_id: input.chatId,
      chat_type: input.chatType,
      message_type: 'text',
      content: JSON.stringify({ text: input.message }),
      mentions: [],
    },
  },
});

const main = async () => {
  const message = asString(readArg('--message') || readArg('-m'));
  if (!message) {
    await fail('Pass --message "<text>"');
  }

  const endpoint = asString(readArg('--url')) || 'http://127.0.0.1:8000/webhooks/lark/events';
  const waitMs = Number.parseInt(readArg('--wait-ms') || '4000', 10);
  const verificationToken = asString(process.env.LARK_VERIFICATION_TOKEN);
  const envAppId = asString(process.env.LARK_APP_ID);

  if (!verificationToken) {
    await fail('LARK_VERIFICATION_TOKEN is missing from backend/.env');
  }

  const resolved = await resolveLatestLarkContext(readArg('--company-id'));
  const companyId = asString(readArg('--company-id')) || resolved?.companyId;
  const chatId = asString(readArg('--chat-id')) || resolved?.chatId;
  const larkOpenId = asString(readArg('--open-id')) || resolved?.larkOpenId;
  const larkUserId = asString(readArg('--user-id')) || resolved?.larkUserId || larkOpenId;
  const tenantKey = asString(readArg('--tenant-key')) || resolved?.larkTenantKey;
  const appId = asString(readArg('--app-id')) || envAppId;
  const chatType = asString(readArg('--chat-type')) || 'p2p';

  if (!chatId) {
    await fail('Could not resolve a recent Lark chatId. Pass --chat-id explicitly.');
  }
  if (!larkOpenId) {
    await fail('Could not resolve larkOpenId. Pass --open-id explicitly.');
  }
  if (!tenantKey) {
    await fail('Could not resolve lark tenant key. Pass --tenant-key explicitly.');
  }
  if (!appId) {
    await fail('Could not resolve Lark app id. Set LARK_APP_ID or pass --app-id.');
  }

  const payload = buildPayload({
    verificationToken,
    tenantKey,
    appId,
    larkOpenId,
    larkUserId,
    chatId,
    chatType,
    message,
  });

  log('Resolved Lark debug context', {
    endpoint,
    companyId: companyId ?? null,
    chatId,
    larkOpenId,
    larkUserId,
    tenantKey,
    appId,
    waitMs,
    usedRecentContext: Boolean(resolved),
    recentContextSourceMessageId: resolved?.messageIdSource ?? null,
  });

  if (hasFlag('--dry-run')) {
    log('Dry run payload', payload);
    await prisma.$disconnect();
    return;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  log('Webhook response', {
    statusCode: response.status,
    ok: response.ok,
    body: bodyText,
  });

  if (!response.ok) {
    await fail('Local Lark webhook call failed', {
      statusCode: response.status,
      body: bodyText,
    });
  }

  if (waitMs > 0) {
    log(`Waiting ${waitMs}ms for runtime/log flush`);
    await sleep(waitMs);
  }

  const latestLogPath = path.resolve(__dirname, '../latest-agent-run.log');
  console.log('');
  console.log(`LATEST_AGENT_RUN_LOG=${latestLogPath}`);
  console.log('');

  await prisma.$disconnect();
};

main().catch(async (error) => {
  await fail(error instanceof Error ? error.message : String(error));
});
