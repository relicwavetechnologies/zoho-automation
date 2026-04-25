import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra } from '../../shared/errors';

export interface FileAccessPolicyRow {
  id:          string;
  fileAssetId: string;
  companyId:   string;
  aiRole:      string;
  canRead:     boolean;
  grantedBy:   string;
  createdAt:   Date;
}

export interface CreatePolicyInput {
  fileAssetId: string;
  companyId:   string;
  aiRole:      string;
  canRead:     boolean;
  grantedBy:   string;
}

export class FileAccessPolicyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createMany(inputs: CreatePolicyInput[]): Promise<Result<void, Error>> {
    try {
      await this.prisma.fileAccessPolicy.createMany({
        data: inputs,
        skipDuplicates: true,
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'fileAccessPolicy.createMany', e));
    }
  }

  async findByFileAsset(fileAssetId: string): Promise<Result<FileAccessPolicyRow[], Error>> {
    try {
      const rows = await this.prisma.fileAccessPolicy.findMany({ where: { fileAssetId } });
      return ok(rows as FileAccessPolicyRow[]);
    } catch (e) {
      return err(wrapInfra('prisma', 'fileAccessPolicy.findByFileAsset', e));
    }
  }

  async replaceForFileAsset(
    fileAssetId: string,
    companyId: string,
    grantedBy: string,
    roles: string[],
  ): Promise<Result<void, Error>> {
    try {
      await this.prisma.$transaction([
        this.prisma.fileAccessPolicy.deleteMany({ where: { fileAssetId } }),
        this.prisma.fileAccessPolicy.createMany({
          data: roles.map(aiRole => ({ fileAssetId, companyId, aiRole, canRead: true, grantedBy })),
        }),
      ]);
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'fileAccessPolicy.replaceForFileAsset', e));
    }
  }

  async deleteByFileAsset(fileAssetId: string): Promise<Result<void, Error>> {
    try {
      await this.prisma.fileAccessPolicy.deleteMany({ where: { fileAssetId } });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'fileAccessPolicy.deleteByFileAsset', e));
    }
  }

  async canRoleRead(fileAssetId: string, aiRole: string): Promise<Result<boolean, Error>> {
    try {
      const row = await this.prisma.fileAccessPolicy.findUnique({
        where: { fileAssetId_aiRole: { fileAssetId, aiRole } },
      });
      return ok(row?.canRead ?? false);
    } catch (e) {
      return err(wrapInfra('prisma', 'fileAccessPolicy.canRoleRead', e));
    }
  }
}
