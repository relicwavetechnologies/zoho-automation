import { randomUUID } from 'crypto';

import { Prisma } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';
import { logger } from '../../../utils/logger';
import {
  buildDeterministicThreadSummary,
  createEmptyTaskState,
  filterThreadMessagesForContext,
  parseDesktopTaskState,
  parseDesktopThreadSummary,
  type DesktopTaskState,
  type DesktopThreadSummary,
} from '../../../modules/desktop-chat/desktop-thread-memory';

const LARK_CHAT_SUMMARY_THRESHOLD = 40;
const LARK_CHAT_RECENT_MESSAGE_LIMIT = 20;

type StoredChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const parseStoredChatMessages = (value: unknown): StoredChatMessage[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const id = asString(record?.id);
    const role = asString(record?.role);
    const content = asString(record?.content);
    const createdAt = asString(record?.createdAt);
    if (!id || !content || !createdAt || (role !== 'user' && role !== 'assistant')) {
      return [];
    }
    return [{
      id,
      role,
      content,
      createdAt,
      metadata: asRecord(record?.metadata),
    }];
  });
};

const toThreadMessages = (messages: StoredChatMessage[]) =>
  messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

export class LarkChatContextService {
  async getOrCreate(input: {
    companyId: string;
    chatId: string;
    chatType?: string;
  }) {
    return prisma.larkChatContext.upsert({
      where: {
        companyId_channel_chatId: {
          companyId: input.companyId,
          channel: 'lark',
          chatId: input.chatId,
        },
      },
      update: {
        ...(input.chatType ? { chatType: input.chatType } : {}),
      },
      create: {
        companyId: input.companyId,
        channel: 'lark',
        chatId: input.chatId,
        chatType: input.chatType,
      },
    });
  }

  async load(input: {
    companyId: string;
    chatId: string;
    chatType?: string;
  }): Promise<{
    id: string;
    chatId: string;
    summary: DesktopThreadSummary;
    taskState: DesktopTaskState;
    recentMessages: StoredChatMessage[];
  }> {
    const context = await this.getOrCreate(input);
    const summary = parseDesktopThreadSummary(context.summaryJson);
    const taskState = parseDesktopTaskState(context.taskStateJson);
    const recentMessages = parseStoredChatMessages(context.recentMessagesJson);
    return {
      id: context.id,
      chatId: context.chatId,
      summary: {
        ...summary,
        sourceMessageCount: context.sourceMessageCount,
      },
      taskState,
      recentMessages,
    };
  }

  async appendMessage(input: {
    companyId: string;
    chatId: string;
    chatType?: string;
    messageId?: string;
    role: 'user' | 'assistant';
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<StoredChatMessage | null> {
    const content = input.content.trim();
    if (!content) {
      return null;
    }

    const context = await this.getOrCreate(input);
    const nowIso = new Date().toISOString();
    const currentSummary = parseDesktopThreadSummary(context.summaryJson);
    const currentTaskState = parseDesktopTaskState(context.taskStateJson);
    const existingMessages = parseStoredChatMessages(context.recentMessagesJson);
    const nextMessage: StoredChatMessage = {
      id: input.messageId?.trim() || randomUUID(),
      role: input.role,
      content,
      createdAt: nowIso,
      metadata: input.metadata,
    };
    const nextMessages = [...existingMessages, nextMessage];
    let compactedSummary = currentSummary;
    let retainedMessages = nextMessages;

    if (nextMessages.length > LARK_CHAT_SUMMARY_THRESHOLD) {
      const compactedChunk = nextMessages.slice(0, nextMessages.length - LARK_CHAT_RECENT_MESSAGE_LIMIT);
      retainedMessages = nextMessages.slice(-LARK_CHAT_RECENT_MESSAGE_LIMIT);
      compactedSummary = buildDeterministicThreadSummary({
        messages: [
          ...toThreadMessages(compactedChunk),
          ...(currentSummary.summary ? [{ role: 'assistant' as const, content: currentSummary.summary }] : []),
        ],
        taskState: currentTaskState,
        currentSummary,
      });
    }

    await prisma.larkChatContext.update({
      where: { id: context.id },
      data: {
        chatType: input.chatType ?? context.chatType,
        summaryJson: compactedSummary.summary
          ? JSON.parse(JSON.stringify({
            ...compactedSummary,
            sourceMessageCount: undefined,
          }))
          : context.summaryJson ?? undefined,
        summaryUpdatedAt: compactedSummary.updatedAt !== currentSummary.updatedAt ? new Date() : context.summaryUpdatedAt,
        recentMessagesJson: JSON.parse(JSON.stringify(retainedMessages)),
        sourceMessageCount: context.sourceMessageCount + 1,
        lastMessageAt: new Date(),
      },
    });

    logger.debug('lark.chat_context.message_appended', {
      companyId: input.companyId,
      chatId: input.chatId,
      role: input.role,
      sourceMessageCount: context.sourceMessageCount + 1,
      retainedMessageCount: retainedMessages.length,
    });

    return nextMessage;
  }

  async updateMemory(input: {
    companyId: string;
    chatId: string;
    chatType?: string;
    summary?: DesktopThreadSummary | null;
    taskState?: DesktopTaskState | null;
  }) {
    const context = await this.getOrCreate(input);
    await prisma.larkChatContext.update({
      where: { id: context.id },
      data: {
        ...(input.chatType ? { chatType: input.chatType } : {}),
        ...(input.summary !== undefined
          ? {
            summaryJson: input.summary ? JSON.parse(JSON.stringify({
              ...input.summary,
              sourceMessageCount: undefined,
            })) : Prisma.DbNull,
            summaryUpdatedAt: input.summary ? new Date() : null,
          }
          : {}),
        ...(input.taskState !== undefined
          ? {
            taskStateJson: input.taskState ? JSON.parse(JSON.stringify(input.taskState)) : Prisma.DbNull,
            taskStateUpdatedAt: input.taskState ? new Date() : null,
          }
          : {}),
      },
    });
  }

  async clear(input: {
    companyId: string;
    chatId: string;
  }) {
    const context = await this.getOrCreate({
      companyId: input.companyId,
      chatId: input.chatId,
    });
    await prisma.larkChatContext.update({
      where: { id: context.id },
      data: {
        summaryJson: Prisma.DbNull,
        summaryUpdatedAt: null,
        taskStateJson: Prisma.DbNull,
        taskStateUpdatedAt: null,
        recentMessagesJson: JSON.parse(JSON.stringify([])),
        sourceMessageCount: 0,
        lastMessageAt: new Date(),
      },
    });
  }

  async getContextMessages(input: {
    companyId: string;
    chatId: string;
    limit?: number;
  }): Promise<StoredChatMessage[]> {
    const context = await this.load(input);
    const filtered = filterThreadMessagesForContext(toThreadMessages(context.recentMessages));
    const filteredContents = new Set(filtered.map((message) => `${message.role}:${message.content}`));
    const recentMessages = context.recentMessages.filter((message) =>
      filteredContents.has(`${message.role}:${message.content}`));
    return recentMessages.slice(-(input.limit ?? LARK_CHAT_RECENT_MESSAGE_LIMIT));
  }
}

export const larkChatContextService = new LarkChatContextService();
