import type { Prisma, PrismaClient } from '../../generated/prisma';
import type {
  KnowledgeFileAssetRepository,
  ReadableKnowledgeFile,
  StagedKnowledgeFile,
} from '../../application/knowledge/knowledge-file.service';
import type { KnowledgeFileAssetSnapshot } from '../../application/knowledge/knowledge-content-validator';

export class PrismaKnowledgeFileAssetRepository implements KnowledgeFileAssetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    input: Omit<StagedKnowledgeFile, 'knowledgeResourceId' | 'status'>,
  ): Promise<StagedKnowledgeFile> {
    const row = await this.prisma.knowledgeFileAsset.create({
      data: {
        ...input,
        status: 'staged',
        knowledgeResourceId: null,
      },
    });
    return toAsset(row);
  }

  async getForValidation(input: {
    assetId: string;
    companyId: string;
  }): Promise<KnowledgeFileAssetSnapshot | null> {
    const row = await this.prisma.knowledgeFileAsset.findFirst({
      where: { id: input.assetId, companyId: input.companyId },
    });
    return row ? toAsset(row) : null;
  }

  async getForAccess(input: {
    assetId: string;
    companyId: string;
  }): Promise<ReadableKnowledgeFile | null> {
    const row = await this.prisma.knowledgeFileAsset.findFirst({
      where: { id: input.assetId, companyId: input.companyId },
      include: {
        knowledgeResource: {
          select: {
            companyId: true,
            scope: true,
            ownerUserId: true,
            departmentId: true,
            status: true,
            currentVersion: true,
            versions: {
              orderBy: { version: 'desc' },
              take: 1,
              select: { version: true, contentJson: true },
            },
          },
        },
      },
    });
    if (!row) return null;
    const resource = row.knowledgeResource;
    const liveVersion = resource?.versions[0];
    return {
      ...toAsset(row),
      isCurrentVersion: Boolean(
        resource
        && liveVersion
        && liveVersion.version === resource.currentVersion
        && fileAssetId(liveVersion.contentJson) === row.id,
      ),
      resource: resource ? {
        companyId: resource.companyId,
        scope: resource.scope,
        ownerUserId: resource.ownerUserId,
        departmentId: resource.departmentId,
        status: resource.status,
      } : null,
    };
  }

  async isActiveDepartmentMember(input: {
    companyId: string;
    departmentId: string;
    userId: string;
  }): Promise<boolean> {
    const count = await this.prisma.departmentMembership.count({
      where: {
        departmentId: input.departmentId,
        userId: input.userId,
        status: 'active',
        department: { companyId: input.companyId, status: 'active' },
      },
    });
    return count > 0;
  }

  async claimStagedDeletion(input: {
    assetId: string;
    companyId: string;
    uploadedById: string;
  }): Promise<StagedKnowledgeFile | null> {
    return this.prisma.$transaction(async tx => {
      const updated = await tx.knowledgeFileAsset.updateMany({
        where: {
          id: input.assetId,
          companyId: input.companyId,
          uploadedById: input.uploadedById,
          status: 'staged',
          knowledgeResourceId: null,
        },
        data: { status: 'deleting' },
      });
      if (updated.count !== 1) return null;
      const row = await tx.knowledgeFileAsset.findUnique({ where: { id: input.assetId } });
      return row ? toAsset(row) : null;
    });
  }

  async completeStagedDeletion(input: { assetId: string; companyId: string }): Promise<boolean> {
    const updated = await this.prisma.knowledgeFileAsset.updateMany({
      where: { id: input.assetId, companyId: input.companyId, status: 'deleting' },
      data: { status: 'deleted', deletedAt: new Date() },
    });
    return updated.count === 1;
  }

  async releaseStagedDeletion(input: { assetId: string; companyId: string }): Promise<boolean> {
    const updated = await this.prisma.knowledgeFileAsset.updateMany({
      where: { id: input.assetId, companyId: input.companyId, status: 'deleting' },
      data: { status: 'staged', deletedAt: null },
    });
    return updated.count === 1;
  }

  async claimExpired(input: {
    limit: number;
    now: Date;
    staleDeletionBefore: Date;
  }): Promise<readonly StagedKnowledgeFile[]> {
    return this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "KnowledgeFileAsset"
        WHERE "knowledgeResourceId" IS NULL
          AND (
            ("status" = 'staged' AND "expiresAt" <= ${input.now})
            OR ("status" = 'deleting' AND "updatedAt" <= ${input.staleDeletionBefore})
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "KnowledgeMutation" mutation
            WHERE mutation."fileAssetId" = "KnowledgeFileAsset"."id"
              AND mutation."status" IN (
                'awaiting_requester_review',
                'awaiting_approval',
                'approved',
                'applying'
              )
          )
        ORDER BY "expiresAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${Math.max(1, Math.min(input.limit, 500))}
      `;
      if (rows.length === 0) return [];
      const ids = rows.map(row => row.id);
      await tx.knowledgeFileAsset.updateMany({
        where: { id: { in: ids }, status: { in: ['staged', 'deleting'] }, knowledgeResourceId: null },
        data: { status: 'deleting' },
      });
      const claimed = await tx.knowledgeFileAsset.findMany({ where: { id: { in: ids } } });
      return claimed.map(toAsset);
    });
  }


  async listDeletableForResource(input: {
    companyId: string;
    resourceId: string;
  }): Promise<readonly StagedKnowledgeFile[]> {
    const rows = await this.prisma.knowledgeFileAsset.findMany({
      where: {
        companyId: input.companyId,
        knowledgeResourceId: input.resourceId,
        status: { in: ['attached', 'deleting'] },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toAsset);
  }

  async claimAttachedDeletion(input: {
    companyId: string;
    assetId: string;
    resourceId: string;
  }): Promise<StagedKnowledgeFile | null> {
    return this.prisma.$transaction(async tx => {
      await tx.knowledgeFileAsset.updateMany({
        where: {
          id: input.assetId,
          companyId: input.companyId,
          knowledgeResourceId: input.resourceId,
          status: 'attached',
        },
        data: { status: 'deleting' },
      });
      const row = await tx.knowledgeFileAsset.findFirst({
        where: {
          id: input.assetId,
          companyId: input.companyId,
          knowledgeResourceId: input.resourceId,
          status: 'deleting',
        },
      });
      return row ? toAsset(row) : null;
    });
  }

  async completeAttachedDeletion(input: {
    companyId: string;
    assetId: string;
    resourceId: string;
  }): Promise<boolean> {
    const updated = await this.prisma.knowledgeFileAsset.updateMany({
      where: {
        id: input.assetId,
        companyId: input.companyId,
        knowledgeResourceId: input.resourceId,
        status: 'deleting',
      },
      data: { status: 'deleted', deletedAt: new Date() },
    });
    return updated.count === 1;
  }

  async releaseAttachedDeletion(input: {
    companyId: string;
    assetId: string;
    resourceId: string;
  }): Promise<boolean> {
    const updated = await this.prisma.knowledgeFileAsset.updateMany({
      where: {
        id: input.assetId,
        companyId: input.companyId,
        knowledgeResourceId: input.resourceId,
        status: 'deleting',
      },
      data: { status: 'attached', deletedAt: null },
    });
    return updated.count === 1;
  }
}

type AssetRow = Prisma.KnowledgeFileAssetGetPayload<object>;

function toAsset(row: AssetRow): StagedKnowledgeFile {
  return {
    id: row.id,
    companyId: row.companyId,
    uploadedById: row.uploadedById,
    knowledgeResourceId: row.knowledgeResourceId,
    provider: row.provider,
    storageKey: row.storageKey,
    resourceType: row.resourceType,
    deliveryType: parseDeliveryType(row.deliveryType),
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    threatScanProvider: row.threatScanProvider,
    threatScanVersion: row.threatScanVersion,
    threatScannedAt: row.threatScannedAt,
    status: row.status,
    expiresAt: row.expiresAt,
  };
}

function parseDeliveryType(value: string): 'private' | 'authenticated' {
  if (value === 'private' || value === 'authenticated') return value;
  throw new Error('Knowledge file has an unsupported delivery type.');
}

function fileAssetId(content: Prisma.JsonValue): string | null {
  if (!content || Array.isArray(content) || typeof content !== 'object') return null;
  const value = content['assetId'];
  return typeof value === 'string' ? value : null;
}
