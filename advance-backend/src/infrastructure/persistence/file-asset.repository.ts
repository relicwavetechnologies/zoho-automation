import type { PrismaClient } from '../../generated/prisma';
import type { IngestionStatus } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra } from '../../shared/errors';

export interface CreateFileAssetInput {
  companyId:              string;
  uploaderUserId:         string;
  uploaderChannel:        string;
  fileName:               string;
  mimeType:               string;
  sizeBytes:              number;
  cloudinaryPublicId:     string;
  cloudinaryUrl:          string;
  cloudinaryResourceType: string;
}

export interface FileAssetRow {
  id:                     string;
  companyId:              string;
  uploaderUserId:         string;
  uploaderChannel:        string;
  fileName:               string;
  mimeType:               string;
  sizeBytes:              number;
  cloudinaryPublicId:     string;
  cloudinaryUrl:          string;
  cloudinaryResourceType: string;
  ingestionStatus:        IngestionStatus;
  ingestionError:         string | null;
  createdAt:              Date;
  updatedAt:              Date;
}

export interface ListVisibleFilesInput {
  companyId:    string;
  aiRole:       string;
  isAdmin:      boolean;
  ownerUserId?: string;
}

export class FileAssetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateFileAssetInput): Promise<Result<FileAssetRow, Error>> {
    try {
      const row = await this.prisma.fileAsset.create({ data: input });
      return ok(row as FileAssetRow);
    } catch (e) {
      return err(wrapInfra('prisma', 'fileAsset.create', e));
    }
  }

  async findById(id: string): Promise<Result<FileAssetRow | null, Error>> {
    try {
      const row = await this.prisma.fileAsset.findUnique({ where: { id } });
      return ok(row as FileAssetRow | null);
    } catch (e) {
      return err(wrapInfra('prisma', 'fileAsset.findById', e));
    }
  }

  async setStatus(
    id: string,
    status: IngestionStatus,
    ingestionError?: string | null,
  ): Promise<Result<void, Error>> {
    try {
      await this.prisma.fileAsset.update({
        where: { id },
        data: {
          ingestionStatus: status,
          ...(ingestionError !== undefined ? { ingestionError } : {}),
        },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'fileAsset.setStatus', e));
    }
  }

  async delete(id: string): Promise<Result<void, Error>> {
    try {
      await this.prisma.fileAsset.delete({ where: { id } });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'fileAsset.delete', e));
    }
  }

  /** Lists files visible to a user. Admins see everything; others see own + role-granted. */
  async findLatestPersonalByUser(companyId: string, uploaderUserId: string): Promise<Result<FileAssetRow | null, Error>> {
    try {
      const row = await this.prisma.fileAsset.findFirst({
        where: { companyId, uploaderUserId, ingestionStatus: 'done' },
        orderBy: { createdAt: 'desc' },
      });
      return ok(row as FileAssetRow | null);
    } catch (e) {
      return err(wrapInfra('prisma', 'fileAsset.findLatestPersonalByUser', e));
    }
  }

  async listVisible(input: ListVisibleFilesInput): Promise<Result<FileAssetRow[], Error>> {
    try {
      const { companyId, aiRole, isAdmin, ownerUserId } = input;

      if (isAdmin) {
        const rows = await this.prisma.fileAsset.findMany({
          where: { companyId },
          orderBy: { createdAt: 'desc' },
        });
        return ok(rows as FileAssetRow[]);
      }

      // Non-admin: own files OR files with a matching access policy
      const policyFiles = await this.prisma.fileAccessPolicy.findMany({
        where: { companyId, aiRole, canRead: true },
        select: { fileAssetId: true },
      });
      const policyIds = policyFiles.map((p: { fileAssetId: string }) => p.fileAssetId);

      const rows = await this.prisma.fileAsset.findMany({
        where: {
          companyId,
          OR: [
            ...(ownerUserId ? [{ uploaderUserId: ownerUserId }] : []),
            { id: { in: policyIds } },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
      return ok(rows as FileAssetRow[]);
    } catch (e) {
      return err(wrapInfra('prisma', 'fileAsset.listVisible', e));
    }
  }
}
