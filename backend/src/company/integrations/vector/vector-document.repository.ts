import type { Prisma, VectorDocument } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';
import type { VectorUpsertDTO } from '../../contracts';

export type VectorDocumentUpsertInput = VectorUpsertDTO & {
  connectionId?: string;
  fileAssetId?: string;
  allowedRoles?: string[];
  embedding: number[];
};

class VectorDocumentRepository {
  async upsertMany(records: VectorDocumentUpsertInput[]): Promise<void> {
    for (const record of records) {
      await prisma.vectorDocument.upsert({
        where: {
          companyId_sourceType_sourceId_chunkIndex: {
            companyId: record.companyId,
            sourceType: record.sourceType,
            sourceId: record.sourceId,
            chunkIndex: record.chunkIndex,
          },
        },
        create: {
          companyId: record.companyId,
          connectionId: record.connectionId,
          fileAssetId: record.fileAssetId,
          sourceType: record.sourceType,
          sourceId: record.sourceId,
          chunkIndex: record.chunkIndex,
          contentHash: record.contentHash,
          visibility: record.visibility ?? 'shared',
          ownerUserId: record.ownerUserId,
          conversationKey: record.conversationKey,
          payload: record.payload as Prisma.InputJsonValue,
          embedding: record.embedding,
        },
        update: {
          connectionId: record.connectionId,
          fileAssetId: record.fileAssetId,
          contentHash: record.contentHash,
          visibility: record.visibility ?? 'shared',
          ownerUserId: record.ownerUserId,
          conversationKey: record.conversationKey,
          payload: record.payload as Prisma.InputJsonValue,
          embedding: record.embedding,
        },
      });
    }
  }

  deleteBySource(input: { companyId: string; sourceType: string; sourceId: string }): Promise<Prisma.BatchPayload> {
    return prisma.vectorDocument.deleteMany({
      where: {
        companyId: input.companyId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      },
    });
  }

  findByConversation(input: {
    companyId: string;
    requesterUserId: string;
    conversationKey: string;
  }): Promise<VectorDocument[]> {
    return prisma.vectorDocument.findMany({
      where: {
        companyId: input.companyId,
        ownerUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
        visibility: 'personal',
      },
      orderBy: [{ createdAt: 'asc' }, { chunkIndex: 'asc' }],
    });
  }

  reassignConversationVisibility(input: {
    companyId: string;
    requesterUserId: string;
    conversationKey: string;
    visibility: 'personal' | 'shared' | 'public';
  }): Promise<Prisma.BatchPayload> {
    return prisma.vectorDocument.updateMany({
      where: {
        companyId: input.companyId,
        ownerUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
      },
      data: {
        visibility: input.visibility,
      },
    });
  }
}

export const vectorDocumentRepository = new VectorDocumentRepository();
