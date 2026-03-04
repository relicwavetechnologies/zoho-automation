import type { VectorUpsertDTO } from '../../contracts';
import type { Prisma } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';

export type QdrantUpsertInput = VectorUpsertDTO & {
  connectionId: string;
  embedding: number[];
};

export class QdrantAdapter {
  async upsertVectors(records: QdrantUpsertInput[]): Promise<void> {
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
          sourceType: record.sourceType,
          sourceId: record.sourceId,
          chunkIndex: record.chunkIndex,
          contentHash: record.contentHash,
          payload: record.payload as Prisma.InputJsonValue,
          embedding: record.embedding,
        },
        update: {
          connectionId: record.connectionId,
          contentHash: record.contentHash,
          payload: record.payload as Prisma.InputJsonValue,
          embedding: record.embedding,
        },
      });
    }
  }

  async deleteVectorsBySource(input: {
    companyId: string;
    sourceType: VectorUpsertDTO['sourceType'];
    sourceId: string;
  }): Promise<void> {
    await prisma.vectorDocument.deleteMany({
      where: {
        companyId: input.companyId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      },
    });
  }
}

export const qdrantAdapter = new QdrantAdapter();
