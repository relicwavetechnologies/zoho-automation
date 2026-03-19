import type { Prisma, RuntimeConversation, RuntimeConversationMessage } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';
import type {
  RuntimeChannel,
  RuntimeConversationStatus,
  RuntimeMessageKind,
  RuntimeMessageRole,
} from './runtime.types';

const toJsonValue = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;

export class RuntimeConversationRepository {
  getById(id: string): Promise<RuntimeConversation | null> {
    return prisma.runtimeConversation.findUnique({ where: { id } });
  }

  findByChannelKey(input: {
    companyId: string;
    channel: RuntimeChannel;
    channelConversationKey: string;
  }): Promise<RuntimeConversation | null> {
    return prisma.runtimeConversation.findUnique({
      where: {
        companyId_channel_channelConversationKey: {
          companyId: input.companyId,
          channel: input.channel,
          channelConversationKey: input.channelConversationKey,
        },
      },
    });
  }

  async getOrCreate(input: {
    companyId: string;
    departmentId?: string | null;
    channel: RuntimeChannel;
    channelConversationKey: string;
    rawChannelKey: string;
    createdByUserId?: string | null;
    createdByEmail?: string | null;
    title?: string | null;
    status?: RuntimeConversationStatus;
  }): Promise<RuntimeConversation> {
    const existing = await this.findByChannelKey(input);
    if (existing) {
      return prisma.runtimeConversation.update({
        where: { id: existing.id },
        data: {
          departmentId: input.departmentId ?? existing.departmentId ?? null,
          rawChannelKey: input.rawChannelKey,
          ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
          ...(input.createdByEmail ? { createdByEmail: input.createdByEmail } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
      });
    }

    try {
      return await prisma.runtimeConversation.create({
        data: {
          companyId: input.companyId,
          departmentId: input.departmentId ?? null,
          channel: input.channel,
          channelConversationKey: input.channelConversationKey,
          rawChannelKey: input.rawChannelKey,
          createdByUserId: input.createdByUserId ?? null,
          createdByEmail: input.createdByEmail ?? null,
          title: input.title ?? null,
          status: input.status ?? 'active',
        },
      });
    } catch {
      const resolved = await this.findByChannelKey(input);
      if (!resolved) {
        throw new Error('Failed to create or resolve runtime conversation.');
      }
      return resolved;
    }
  }

  listMessages(conversationId: string, limit = 30): Promise<RuntimeConversationMessage[]> {
    return prisma.runtimeConversationMessage.findMany({
      where: { conversationId },
      orderBy: [
        { sequence: 'desc' },
        { createdAt: 'desc' },
      ],
      take: limit,
    }).then((rows) => rows.reverse());
  }

  async appendMessage(input: {
    conversationId: string;
    runId?: string | null;
    role: RuntimeMessageRole;
    messageKind: RuntimeMessageKind;
    sourceChannel: RuntimeChannel;
    sourceMessageId?: string | null;
    dedupeKey?: string | null;
    contentText?: string | null;
    contentJson?: Record<string, unknown> | null;
    attachmentsJson?: Record<string, unknown> | Array<Record<string, unknown>> | null;
    toolCallJson?: Record<string, unknown> | null;
    toolResultJson?: Record<string, unknown> | null;
    visibility?: string;
  }): Promise<RuntimeConversationMessage> {
    return prisma.$transaction(async (tx) => {
      if (input.dedupeKey) {
        const existing = await tx.runtimeConversationMessage.findFirst({
          where: {
            conversationId: input.conversationId,
            dedupeKey: input.dedupeKey,
          },
        });
        if (existing) {
          return existing;
        }
      }

      const updatedConversation = await tx.runtimeConversation.update({
        where: { id: input.conversationId },
        data: {
          lastMessageSequence: {
            increment: 1,
          },
        },
        select: {
          id: true,
          lastMessageSequence: true,
        },
      });

      return tx.runtimeConversationMessage.create({
        data: {
          conversationId: updatedConversation.id,
          runId: input.runId ?? null,
          sequence: updatedConversation.lastMessageSequence,
          role: input.role,
          messageKind: input.messageKind,
          sourceChannel: input.sourceChannel,
          sourceMessageId: input.sourceMessageId ?? null,
          dedupeKey: input.dedupeKey ?? null,
          contentText: input.contentText ?? null,
          contentJson: input.contentJson ? toJsonValue(input.contentJson) : undefined,
          attachmentsJson: input.attachmentsJson ? toJsonValue(input.attachmentsJson) : undefined,
          toolCallJson: input.toolCallJson ? toJsonValue(input.toolCallJson) : undefined,
          toolResultJson: input.toolResultJson ? toJsonValue(input.toolResultJson) : undefined,
          visibility: input.visibility ?? 'internal',
        },
      });
    });
  }

  updateStatus(conversationId: string, status: RuntimeConversationStatus): Promise<RuntimeConversation> {
    return prisma.runtimeConversation.update({
      where: { id: conversationId },
      data: { status },
    });
  }

  updateRefs(conversationId: string, refs: Record<string, unknown>): Promise<RuntimeConversation> {
    return prisma.runtimeConversation.update({
      where: { id: conversationId },
      data: {
        refsJson: toJsonValue(refs),
      },
    });
  }
}

export const runtimeConversationRepository = new RuntimeConversationRepository();

