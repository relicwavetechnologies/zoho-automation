import 'dotenv/config';

import path from 'path';
import { randomUUID } from 'crypto';

import { PrismaClient } from '../src/generated/prisma';
import { vercelOrchestrationEngine } from '../src/company/orchestration/engine/vercel-orchestration.engine';

const prisma = new PrismaClient();
const args = process.argv.slice(2);

const readArg = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const resolveLatestLarkContext = async (companyId?: string) => {
  const recentMessages = await prisma.desktopMessage.findMany({
    where: {
      thread: {
        channel: 'lark',
        ...(companyId ? { companyId } : {}),
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: {
      id: true,
      metadata: true,
      thread: {
        select: {
          id: true,
          companyId: true,
          userId: true,
        },
      },
    },
  });

  for (const recentMessage of recentMessages) {
    const larkMeta = asRecord(asRecord(recentMessage.metadata)?.lark);
    const chatId = asString(larkMeta?.chatId);
    const larkOpenId = asString(larkMeta?.larkOpenId) || asString(larkMeta?.openId);
    const tenantKey = asString(larkMeta?.larkTenantKey) || asString(larkMeta?.tenantKey);
    const larkUserId = asString(larkMeta?.larkUserId) || asString(larkMeta?.userId);
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
      linkedUserId: matchingLink?.userId ?? recentMessage.thread.userId,
      larkTenantKey: matchingLink?.larkTenantKey ?? tenantKey,
      larkOpenId: matchingLink?.larkOpenId ?? larkOpenId,
      larkUserId: matchingLink?.larkUserId ?? larkUserId ?? larkOpenId,
      requesterEmail: matchingLink?.larkEmail,
      chatId,
    };
  }

  throw new Error('Could not resolve recent Lark context. Pass a company with recent Lark activity first.');
};

const resolveReplyAnchorMessageId = async (input: {
  chatId: string;
  companyId: string;
}): Promise<string | null> => {
  const recentMessages = await prisma.desktopMessage.findMany({
    where: {
      thread: {
        channel: 'lark',
        companyId: input.companyId,
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      metadata: true,
    },
  });

  for (const recentMessage of recentMessages) {
    const larkMeta = asRecord(asRecord(recentMessage.metadata)?.lark);
    const chatId = asString(larkMeta?.chatId);
    const inboundMessageId = asString(larkMeta?.inboundMessageId);
    if (chatId !== input.chatId || !inboundMessageId) {
      continue;
    }
    if (inboundMessageId.startsWith('om_harness_')) {
      continue;
    }
    return inboundMessageId;
  }

  return null;
};

const main = async (): Promise<void> => {
  const messageText = asString(readArg('--message') || readArg('-m'));
  if (!messageText) {
    throw new Error('Pass --message "<text>"');
  }

  const resolved = await resolveLatestLarkContext(asString(readArg('--company-id')));
  const taskId = randomUUID();
  const messageId = `om_harness_${Date.now()}`;
  const timestamp = new Date().toISOString();
  const replyAnchorMessageId = await resolveReplyAnchorMessageId({
    chatId: resolved.chatId,
    companyId: resolved.companyId,
  });

  const message = {
    channel: 'lark' as const,
    userId: resolved.larkOpenId,
    chatId: resolved.chatId,
    chatType: 'p2p' as const,
    messageId,
    timestamp,
    text: messageText,
    rawEvent: {
      source: 'run-lark-routing-harness',
      file: path.basename(__filename),
    },
    trace: {
      requestId: taskId,
      eventId: `evt_${taskId}`,
      receivedAt: timestamp,
      larkTenantKey: resolved.larkTenantKey,
      larkOpenId: resolved.larkOpenId,
      larkUserId: resolved.larkUserId,
      companyId: resolved.companyId,
      linkedUserId: resolved.linkedUserId,
      requesterEmail: resolved.requesterEmail,
      ...(replyAnchorMessageId ? { replyToMessageId: replyAnchorMessageId } : {}),
    },
  };

  const task = await vercelOrchestrationEngine.buildTask(taskId, message);
  const result = await vercelOrchestrationEngine.executeTask({
    task,
    message,
  });

  console.log(JSON.stringify({
    taskId,
    messageId,
    companyId: resolved.companyId,
    linkedUserId: resolved.linkedUserId,
    chatId: resolved.chatId,
    replyAnchorMessageId,
    text: messageText,
    result: {
      status: result.status,
      currentStep: result.currentStep ?? null,
      latestSynthesis: result.latestSynthesis ?? null,
      runtimeMeta: result.runtimeMeta ?? null,
      errors: result.errors ?? [],
    },
  }, null, 2));
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
