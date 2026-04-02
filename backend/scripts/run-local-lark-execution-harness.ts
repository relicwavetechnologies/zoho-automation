import 'dotenv/config';

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { PrismaClient } from '../src/generated/prisma';
import { buildTaskWithConfiguredEngine, executeTaskWithConfiguredEngine } from '../src/company/orchestration/engine';
import { LarkChannelAdapter } from '../src/company/channels/lark/lark.adapter';
import { larkChatContextService } from '../src/company/channels/lark/lark-chat-context.service';
import { desktopThreadsService } from '../src/modules/desktop-threads/desktop-threads.service';
import type { NormalizedIncomingMessageDTO } from '../src/company/contracts';

const prisma = new PrismaClient();
const args = process.argv.slice(2);

type SeedMessage = {
  role: 'user' | 'assistant';
  content: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
};

type HarnessContext = {
  companyId: string;
  linkedUserId?: string;
  larkTenantKey: string;
  larkOpenId: string;
  larkUserId?: string;
  requesterEmail?: string;
  requesterName?: string;
  channelIdentityId?: string;
  chatId: string;
};

const readArg = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const hasFlag = (name: string): boolean => args.includes(name);

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const resolveLinkedLarkIdentity = async (input: {
  companyId: string;
  linkedUserId?: string;
  larkOpenId?: string;
  larkUserId?: string;
}): Promise<Partial<HarnessContext>> => {
  const authOrClauses = [
    ...(input.larkOpenId ? [{ larkOpenId: input.larkOpenId }] : []),
    ...(input.larkUserId ? [{ larkUserId: input.larkUserId }] : []),
    ...(input.linkedUserId ? [{ userId: input.linkedUserId }] : []),
  ];

  const matchingLink = authOrClauses.length > 0
    ? await prisma.larkUserAuthLink.findFirst({
        where: {
          revokedAt: null,
          companyId: input.companyId,
          OR: authOrClauses,
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
      })
    : null;

  const identityOrClauses = [
    ...(matchingLink?.larkOpenId ? [{ larkOpenId: matchingLink.larkOpenId }] : []),
    ...(matchingLink?.larkUserId ? [{ larkUserId: matchingLink.larkUserId }] : []),
    ...(input.larkOpenId ? [{ larkOpenId: input.larkOpenId }] : []),
    ...(input.larkUserId ? [{ larkUserId: input.larkUserId }] : []),
  ];

  const channelIdentity = identityOrClauses.length > 0
    ? await prisma.channelIdentity.findFirst({
        where: {
          companyId: input.companyId,
          channel: 'lark',
          OR: identityOrClauses,
        },
        orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        email: true,
        displayName: true,
        externalUserId: true,
        larkOpenId: true,
        larkUserId: true,
      },
      })
    : null;

  return {
    linkedUserId: matchingLink?.userId,
    larkTenantKey: matchingLink?.larkTenantKey,
    larkOpenId: matchingLink?.larkOpenId ?? channelIdentity?.larkOpenId ?? channelIdentity?.externalUserId ?? undefined,
    larkUserId: matchingLink?.larkUserId ?? channelIdentity?.larkUserId ?? undefined,
    requesterEmail: matchingLink?.larkEmail ?? channelIdentity?.email ?? undefined,
    requesterName: channelIdentity?.displayName ?? undefined,
    channelIdentityId: channelIdentity?.id ?? undefined,
  };
};

const resolveLatestLarkContext = async (companyId?: string): Promise<HarnessContext> => {
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
      metadata: true,
      thread: {
        select: {
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

    const identity = await resolveLinkedLarkIdentity({
      companyId: matchingLink?.companyId ?? recentMessage.thread.companyId,
      linkedUserId: matchingLink?.userId ?? recentMessage.thread.userId,
      larkOpenId: matchingLink?.larkOpenId ?? larkOpenId,
      larkUserId: matchingLink?.larkUserId ?? larkUserId,
    });

    return {
      companyId: matchingLink?.companyId ?? recentMessage.thread.companyId,
      linkedUserId: matchingLink?.userId ?? recentMessage.thread.userId,
      larkTenantKey: matchingLink?.larkTenantKey ?? tenantKey,
      larkOpenId: matchingLink?.larkOpenId ?? larkOpenId,
      larkUserId: matchingLink?.larkUserId ?? larkUserId ?? larkOpenId,
      requesterEmail: identity.requesterEmail,
      requesterName: identity.requesterName,
      channelIdentityId: identity.channelIdentityId,
      chatId,
    };
  }

  throw new Error('Could not resolve recent Lark context. Pass explicit ids.');
};

const resolveExplicitHarnessContext = async (): Promise<HarnessContext | null> => {
  const companyId = asString(readArg('--company-id'));
  const chatId = asString(readArg('--chat-id'));
  const larkOpenId = asString(readArg('--open-id'));
  const larkTenantKey = asString(readArg('--tenant-key'));
  if (!companyId || !larkOpenId || !larkTenantKey) {
    return null;
  }

  const linkedUserId = asString(readArg('--linked-user-id'));
  const larkUserId = asString(readArg('--lark-user-id')) ?? larkOpenId;
  const requesterEmail = asString(readArg('--requester-email'));
  const requesterName = asString(readArg('--requester-name'));
  const channelIdentityId = asString(readArg('--channel-identity-id'));
  const resolvedIdentity = await resolveLinkedLarkIdentity({
    companyId,
    linkedUserId,
    larkOpenId,
    larkUserId,
  });

  return {
    companyId,
    linkedUserId: linkedUserId ?? resolvedIdentity.linkedUserId,
    larkTenantKey,
    larkOpenId,
    larkUserId: larkUserId ?? resolvedIdentity.larkUserId ?? resolvedIdentity.larkOpenId ?? larkOpenId,
    requesterEmail: requesterEmail ?? resolvedIdentity.requesterEmail,
    requesterName: requesterName ?? resolvedIdentity.requesterName,
    channelIdentityId: channelIdentityId ?? resolvedIdentity.channelIdentityId,
    chatId: chatId ?? `oc_harness_${Date.now()}`,
  };
};

const loadSeedMessages = (): SeedMessage[] => {
  const historyFile = asString(readArg('--history-file'));
  const historyJson = asString(readArg('--history-json'));
  const raw = historyFile
    ? fs.readFileSync(path.resolve(historyFile), 'utf8')
    : historyJson;
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('History input must be a JSON array.');
  }
  return parsed.flatMap((entry, index) => {
    if (typeof entry === 'string') {
      return [{ role: 'user' as const, content: entry }];
    }
    const record = asRecord(entry);
    const role = asString(record?.role);
    const content = asString(record?.content);
    if (!content || (role !== 'user' && role !== 'assistant')) {
      throw new Error(`Invalid history entry at index ${index}. Expected { role, content }.`);
    }
    return [{
      role,
      content,
      messageId: asString(record?.messageId),
      metadata: asRecord(record?.metadata) ?? undefined,
    }];
  });
};

const installStubLarkEgress = () => {
  const outboundLog: Array<Record<string, unknown>> = [];
  const sendOriginal = LarkChannelAdapter.prototype.sendMessage;
  const updateOriginal = LarkChannelAdapter.prototype.updateMessage;

  LarkChannelAdapter.prototype.sendMessage = async function sendMessageStub(input) {
    const fakeMessageId = `om_stub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    outboundLog.push({
      kind: 'send',
      input,
      fakeMessageId,
      at: new Date().toISOString(),
    });
    return {
      channel: 'lark',
      status: 'sent' as const,
      chatId: input.chatId,
      messageId: fakeMessageId,
      providerResponse: { stubbed: true },
    };
  };

  LarkChannelAdapter.prototype.updateMessage = async function updateMessageStub(input) {
    outboundLog.push({
      kind: 'update',
      input,
      at: new Date().toISOString(),
    });
    return {
      channel: 'lark',
      status: 'updated' as const,
      messageId: input.messageId,
      providerResponse: { stubbed: true },
    };
  };

  return {
    outboundLog,
    restore: () => {
      LarkChannelAdapter.prototype.sendMessage = sendOriginal;
      LarkChannelAdapter.prototype.updateMessage = updateOriginal;
    },
  };
};

const seedGroupHistory = async (input: {
  companyId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  messages: SeedMessage[];
  clearFirst: boolean;
}) => {
  if (input.clearFirst) {
    await larkChatContextService.clear({
      companyId: input.companyId,
      chatId: input.chatId,
    });
  }
  for (const entry of input.messages) {
    await larkChatContextService.appendMessage({
      companyId: input.companyId,
      chatId: input.chatId,
      chatType: input.chatType,
      messageId: entry.messageId,
      role: entry.role,
      content: entry.content,
      metadata: entry.metadata,
    });
  }
};

const seedP2PHistory = async (input: {
  companyId: string;
  linkedUserId: string;
  messages: SeedMessage[];
  clearFirst: boolean;
}) => {
  const thread = input.clearFirst
    ? (await desktopThreadsService.clearLarkLifetimeThreadContext(input.linkedUserId, input.companyId)).current
    : await desktopThreadsService.findOrCreateLarkLifetimeThread(input.linkedUserId, input.companyId);

  for (const entry of input.messages) {
    await desktopThreadsService.addOwnedThreadMessage(
      thread.id,
      input.linkedUserId,
      entry.role,
      entry.content,
      entry.metadata,
      {
        requiredChannel: 'lark',
        existingMessageId: entry.messageId,
      },
    );
  }

  return thread.id;
};

const buildHarnessMessage = (input: {
  taskId: string;
  context: HarnessContext;
  chatType: 'p2p' | 'group';
  messageText: string;
  messageId: string;
  timestamp: string;
  replyToMessageId?: string;
}): NormalizedIncomingMessageDTO => ({
  channel: 'lark',
  userId: input.context.larkOpenId,
  chatId: input.context.chatId,
  chatType: input.chatType,
  messageId: input.messageId,
  timestamp: input.timestamp,
  text: input.messageText,
  rawEvent: {
    source: 'run-local-lark-execution-harness',
    harness: true,
  },
  trace: {
    requestId: input.taskId,
    eventId: `evt_${input.taskId}`,
    receivedAt: input.timestamp,
    larkTenantKey: input.context.larkTenantKey,
    larkOpenId: input.context.larkOpenId,
    larkUserId: input.context.larkUserId,
    companyId: input.context.companyId,
    linkedUserId: input.context.linkedUserId,
    requesterEmail: input.context.requesterEmail,
    requesterName: input.context.requesterName,
    channelIdentityId: input.context.channelIdentityId,
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
  },
});

const loadStoredContextSnapshot = async (input: {
  companyId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  linkedUserId?: string;
}) => {
  if (input.chatType === 'group') {
    const context = await larkChatContextService.load({
      companyId: input.companyId,
      chatId: input.chatId,
      chatType: input.chatType,
    });
    return {
      storage: 'larkChatContext',
      summary: context.summary,
      taskState: context.taskState,
      recentMessages: context.recentMessages.slice(-12),
    };
  }

  if (!input.linkedUserId) {
    return {
      storage: 'desktopThread',
      error: 'linkedUserId is required to inspect p2p Lark history.',
    };
  }

  const thread = await desktopThreadsService.findOrCreateLarkLifetimeThread(input.linkedUserId, input.companyId);
  const context = await desktopThreadsService.getOwnedThreadContext(thread.id, input.linkedUserId, 80);
  return {
    storage: 'desktopThread',
    threadId: thread.id,
    summaryJson: context.thread.summaryJson,
    taskStateJson: context.thread.taskStateJson,
    messages: context.messages.slice(-12).map((entry) => ({
      id: entry.id,
      role: entry.role,
      content: entry.content,
      createdAt: entry.createdAt.toISOString(),
      metadata: entry.metadata,
    })),
  };
};

const main = async (): Promise<void> => {
  const messageText = asString(readArg('--message') || readArg('-m'));
  if (!messageText) {
    throw new Error('Pass --message "<text>"');
  }

  const chatType = readArg('--chat-type') === 'group' ? 'group' : 'p2p';
  const seedMessages = loadSeedMessages();
  const clearHistory = hasFlag('--clear-history') || hasFlag('--fresh-thread') || hasFlag('--fresh-chat');
  const resolved = (await resolveExplicitHarnessContext())
    ?? (await resolveLatestLarkContext(asString(readArg('--company-id'))));

  if (chatType === 'group' && hasFlag('--fresh-chat')) {
    resolved.chatId = `oc_harness_${Date.now()}`;
  }

  if (chatType === 'p2p' && !resolved.linkedUserId) {
    throw new Error('p2p harness runs require a linkedUserId. Resolve one from a linked Lark account or pass --linked-user-id.');
  }

  if (seedMessages.length > 0 || clearHistory) {
    if (chatType === 'group') {
      await seedGroupHistory({
        companyId: resolved.companyId,
        chatId: resolved.chatId,
        chatType,
        messages: seedMessages,
        clearFirst: clearHistory,
      });
    } else {
      await seedP2PHistory({
        companyId: resolved.companyId,
        linkedUserId: resolved.linkedUserId!,
        messages: seedMessages,
        clearFirst: clearHistory,
      });
    }
  }

  const stubbedEgress = hasFlag('--real-lark-egress') ? null : installStubLarkEgress();

  try {
    const taskId = randomUUID();
    const messageId = `om_harness_${Date.now()}`;
    const timestamp = new Date().toISOString();
    const replyToMessageId = asString(readArg('--reply-to-message-id'));
    const message = buildHarnessMessage({
      taskId,
      context: resolved,
      chatType,
      messageText,
      messageId,
      timestamp,
      replyToMessageId,
    });

    const task = await buildTaskWithConfiguredEngine(taskId, message);
    const execution = await executeTaskWithConfiguredEngine({
      task,
      message,
    });
    const storedContext = await loadStoredContextSnapshot({
      companyId: resolved.companyId,
      chatId: resolved.chatId,
      chatType,
      linkedUserId: resolved.linkedUserId,
    });

    console.log(JSON.stringify({
      harness: 'local-lark-execution',
      stubbedLarkEgress: !hasFlag('--real-lark-egress'),
      taskId,
      messageId,
      chatType,
      resolvedContext: resolved,
      seededHistoryCount: seedMessages.length,
      task,
      execution: {
        configuredEngine: execution.configuredEngine,
        engineUsed: execution.engineUsed,
        status: execution.result.status,
        currentStep: execution.result.currentStep ?? null,
        latestSynthesis: execution.result.latestSynthesis ?? null,
        runtimeMeta: execution.result.runtimeMeta ?? null,
        errors: execution.result.errors ?? [],
      },
      outboundLark: stubbedEgress?.outboundLog ?? [],
      storedContext,
    }, null, 2));
  } finally {
    stubbedEgress?.restore();
  }
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
