import type { PrismaClient } from '../../generated/prisma';
import type {
  ConversationAttachmentRecord,
  ConversationAttachmentRow,
  ConversationAttachmentStore,
} from '../../application/conversation-attachments/conversation-attachment.service';

export class PrismaConversationAttachmentStore implements ConversationAttachmentStore {
  constructor(private readonly prisma: Pick<PrismaClient, 'conversationAttachment'>) {}

  async record(
    entries: readonly ConversationAttachmentRecord[],
    expiresAt: Date,
  ): Promise<void> {
    await this.prisma.conversationAttachment.createMany({
      data: entries.map(entry => ({
        companyId:       entry.companyId,
        userId:          entry.userId,
        channel:         entry.channel,
        conversationKey: entry.conversationKey,
        chatId:          entry.chatId,
        larkMessageId:   entry.larkMessageId,
        larkFileKey:     entry.larkFileKey,
        fileName:        entry.fileName,
        mimeType:        entry.mimeType,
        ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
        expiresAt,
      })),
      // The same message can be delivered twice; a repeat is the same file.
      skipDuplicates: true,
    });
  }

  async listLive(input: {
    companyId:       string;
    userId:          string;
    channel:         string;
    conversationKey: string;
    now:             Date;
  }): Promise<readonly ConversationAttachmentRow[]> {
    const rows = await this.prisma.conversationAttachment.findMany({
      where: {
        companyId:       input.companyId,
        userId:          input.userId,
        channel:         input.channel,
        conversationKey: input.conversationKey,
        expiresAt:       { gt: input.now },
      },
      orderBy: { receivedAt: 'desc' },
      take: 50,
    });

    return rows.map(row => ({
      companyId:       row.companyId,
      userId:          row.userId,
      channel:         row.channel,
      conversationKey: row.conversationKey,
      chatId:          row.chatId,
      larkMessageId:   row.larkMessageId,
      larkFileKey:     row.larkFileKey,
      fileName:        row.fileName,
      mimeType:        row.mimeType,
      ...(row.sizeBytes === null ? {} : { sizeBytes: row.sizeBytes }),
      receivedAt:      row.receivedAt,
    }));
  }
}
