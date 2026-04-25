import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra } from '../../shared/errors';

export interface VectorDocumentUpsertInput {
  companyId:              string;
  fileAssetId:            string;
  sourceType:             string;
  sourceId:               string;
  chunkIndex:             number;
  documentKey:            string;
  contentHash:            string;
  visibility:             'personal' | 'shared' | 'public';
  ownerUserId?:           string;
  chunkText?:             string;
  payload:                Record<string, unknown>;
  embedding:              number[];
  embeddingSchemaVersion: string;
  retrievalProfile:       string;
}

export interface VectorDocumentRow {
  id:                     string;
  companyId:              string;
  fileAssetId:            string | null;
  sourceType:             string;
  sourceId:               string;
  chunkIndex:             number;
  documentKey:            string | null;
  contentHash:            string;
  visibility:             string;
  ownerUserId:            string | null;
  chunkText:              string | null;
  payload:                unknown;
  embedding:              number[];
  embeddingSchemaVersion: string | null;
  retrievalProfile:       string | null;
  createdAt:              Date;
  updatedAt:              Date;
}

export class VectorDocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertMany(inputs: VectorDocumentUpsertInput[]): Promise<Result<void, Error>> {
    try {
      await this.prisma.$transaction(
        inputs.map(input =>
          this.prisma.vectorDocument.upsert({
            where: {
              companyId_sourceType_sourceId_chunkIndex: {
                companyId:  input.companyId,
                sourceType: input.sourceType,
                sourceId:   input.sourceId,
                chunkIndex: input.chunkIndex,
              },
            },
            create: { ...input, payload: input.payload as object },
            update: {
              contentHash:            input.contentHash,
              chunkText:              input.chunkText ?? null,
              payload:                input.payload as object,
              embedding:              input.embedding,
              embeddingSchemaVersion: input.embeddingSchemaVersion,
              updatedAt:              new Date(),
            },
          }),
        ),
      );
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'vectorDocument.upsertMany', e));
    }
  }

  async deleteByFileAsset(fileAssetId: string): Promise<Result<number, Error>> {
    try {
      const result = await this.prisma.vectorDocument.deleteMany({ where: { fileAssetId } });
      return ok(result.count);
    } catch (e) {
      return err(wrapInfra('prisma', 'vectorDocument.deleteByFileAsset', e));
    }
  }

  async findByFileAsset(fileAssetId: string): Promise<Result<VectorDocumentRow[], Error>> {
    try {
      const rows = await this.prisma.vectorDocument.findMany({
        where: { fileAssetId },
        orderBy: { chunkIndex: 'asc' },
      });
      return ok(rows as unknown as VectorDocumentRow[]);
    } catch (e) {
      return err(wrapInfra('prisma', 'vectorDocument.findByFileAsset', e));
    }
  }

  async updateVisibility(
    fileAssetId: string,
    visibility: 'personal' | 'shared' | 'public',
  ): Promise<Result<number, Error>> {
    try {
      const result = await this.prisma.vectorDocument.updateMany({
        where: { fileAssetId },
        data: { visibility },
      });
      return ok(result.count);
    } catch (e) {
      return err(wrapInfra('prisma', 'vectorDocument.updateVisibility', e));
    }
  }
}
