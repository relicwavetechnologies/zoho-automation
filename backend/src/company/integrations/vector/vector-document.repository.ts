import type { Prisma, VectorDocument } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';
import type { VectorUpsertDTO } from '../../contracts';

export type VectorDocumentUpsertInput = VectorUpsertDTO & {
  connectionId?: string;
  fileAssetId?: string;
  allowedRoles?: string[];
  embedding?: number[];
  documentKey?: string;
  chunkText?: string;
  embeddingSchemaVersion?: string;
  retrievalProfile?: 'zoho' | 'file' | 'chat';
  sourceUpdatedAt?: string;
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
          documentKey: record.documentKey,
          chunkText: record.chunkText,
          payload: record.payload as Prisma.InputJsonValue,
          embedding: record.embedding ?? [],
          embeddingSchemaVersion: record.embeddingSchemaVersion,
          retrievalProfile: record.retrievalProfile,
          sourceUpdatedAt: record.sourceUpdatedAt ? new Date(record.sourceUpdatedAt) : null,
        },
        update: {
          connectionId: record.connectionId,
          fileAssetId: record.fileAssetId,
          contentHash: record.contentHash,
          visibility: record.visibility ?? 'shared',
          ownerUserId: record.ownerUserId,
          conversationKey: record.conversationKey,
          documentKey: record.documentKey,
          chunkText: record.chunkText,
          payload: record.payload as Prisma.InputJsonValue,
          embedding: record.embedding ?? [],
          embeddingSchemaVersion: record.embeddingSchemaVersion,
          retrievalProfile: record.retrievalProfile,
          sourceUpdatedAt: record.sourceUpdatedAt ? new Date(record.sourceUpdatedAt) : null,
        },
      });
    }
  }

  deleteBySource(input: {
    companyId: string;
    sourceType: string;
    sourceId: string;
  }): Promise<Prisma.BatchPayload> {
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
    createdAtLte?: Date;
    visibility?: 'personal' | 'shared' | 'public';
  }): Promise<VectorDocument[]> {
    return prisma.vectorDocument.findMany({
      where: {
        companyId: input.companyId,
        ownerUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
        visibility: input.visibility ?? 'personal',
        ...(input.createdAtLte ? { createdAt: { lte: input.createdAtLte } } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { chunkIndex: 'asc' }],
    });
  }

  reassignConversationVisibility(input: {
    companyId: string;
    requesterUserId: string;
    conversationKey: string;
    visibility: 'personal' | 'shared' | 'public';
    createdAtLte?: Date;
  }): Promise<Prisma.BatchPayload> {
    return prisma.vectorDocument.updateMany({
      where: {
        companyId: input.companyId,
        ownerUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
        ...(input.createdAtLte ? { createdAt: { lte: input.createdAtLte } } : {}),
      },
      data: {
        visibility: input.visibility,
      },
    });
  }

  findByFileAsset(input: { companyId: string; fileAssetId: string }): Promise<VectorDocument[]> {
    return prisma.vectorDocument.findMany({
      where: {
        companyId: input.companyId,
        fileAssetId: input.fileAssetId,
      },
      orderBy: [{ chunkIndex: 'asc' }, { createdAt: 'asc' }],
    });
  }
}

export const vectorDocumentRepository = new VectorDocumentRepository();
