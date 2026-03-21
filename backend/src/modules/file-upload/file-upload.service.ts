import { randomUUID } from 'crypto';

import { prisma } from '../../utils/prisma';
import config from '../../config';
import { logger } from '../../utils/logger';
import { orangeDebug } from '../../utils/orange-debug';
import { cloudinaryAdapter } from './cloudinary.adapter';
import { documentIngestionPipeline } from './document-ingestion.pipeline';
import { resolveSupportedUploadMimeType } from './file-type-support';

export type FileUploadInput = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  companyId: string;
  uploaderUserId: string;
  uploaderChannel: 'lark' | 'desktop';
  /** Initial allowed AI roles for this file (e.g. ['HR', 'ADMIN']) */
  allowedRoles: string[];
};

export type FileUploadOutput = {
  fileAssetId: string;
  fileName: string;
  cloudinaryUrl: string;
  ingestionStatus: string;
};

export class FileUploadService {
  async upload(input: FileUploadInput): Promise<FileUploadOutput> {
    const maxBytes = config.DOC_UPLOAD_MAX_MB * 1024 * 1024;
    if (input.sizeBytes > maxBytes) {
      throw new Error(`File exceeds maximum size of ${config.DOC_UPLOAD_MAX_MB}MB`);
    }
    const resolvedMimeType = resolveSupportedUploadMimeType({
      mimeType: input.mimeType,
      fileName: input.fileName,
    });
    if (!resolvedMimeType) {
      throw new Error(`Unsupported file type: ${input.mimeType || input.fileName}`);
    }

    const fileAssetId = randomUUID();

    // 1. Upload to Cloudinary
    const cloudResult = await cloudinaryAdapter.uploadBuffer({
      buffer: input.buffer,
      mimeType: resolvedMimeType,
      fileName: input.fileName,
      folder: config.CLOUDINARY_FOLDER,
      companyId: input.companyId,
      assetId: fileAssetId,
    });

    // 2. Create FileAsset record in Postgres
    const fileAsset = await prisma.fileAsset.create({
      data: {
        id: fileAssetId,
        companyId: input.companyId,
        uploaderUserId: input.uploaderUserId,
        uploaderChannel: input.uploaderChannel,
        fileName: input.fileName,
        mimeType: resolvedMimeType,
        sizeBytes: input.sizeBytes,
        cloudinaryPublicId: cloudResult.publicId,
        cloudinaryUrl: cloudResult.secureUrl,
        cloudinaryResourceType: cloudResult.resourceType,
        ingestionStatus: 'pending',
      },
    });

    // 3. Create FileAccessPolicy rows for each allowed role
    if (input.allowedRoles.length > 0) {
      await prisma.fileAccessPolicy.createMany({
        data: input.allowedRoles.map((role) => ({
          fileAssetId: fileAsset.id,
          companyId: input.companyId,
          aiRole: role,
          canRead: true,
          grantedBy: input.uploaderUserId,
        })),
        skipDuplicates: true,
      });
    }

    logger.info('file.upload.created', {
      fileAssetId: fileAsset.id,
      companyId: input.companyId,
      mimeType: resolvedMimeType,
      allowedRoles: input.allowedRoles,
    });
    orangeDebug('file.upload.created', {
      fileAssetId: fileAsset.id,
      companyId: input.companyId,
      uploaderUserId: input.uploaderUserId,
      uploaderChannel: input.uploaderChannel,
      mimeType: resolvedMimeType,
      fileName: input.fileName,
      allowedRoles: input.allowedRoles,
    });

    // 4. Kick off ingestion asynchronously (non-blocking)
    setImmediate(() => {
      documentIngestionPipeline
        .ingest({
          fileAssetId: fileAsset.id,
          companyId: input.companyId,
          buffer: input.buffer,
          mimeType: resolvedMimeType,
          fileName: input.fileName,
          sourceUrl: fileAsset.cloudinaryUrl,
          uploaderUserId: input.uploaderUserId,
          allowedRoles: input.allowedRoles,
        })
        .catch((err: any) => {
          logger.error('file.ingestion.failed_async', {
            fileAssetId: fileAsset.id,
            fileName: input.fileName,
            mimeType: resolvedMimeType,
            companyId: input.companyId,
            error: err instanceof Error ? err.message : 'unknown',
          });
        });
    });

    return {
      fileAssetId: fileAsset.id,
      fileName: fileAsset.fileName,
      cloudinaryUrl: fileAsset.cloudinaryUrl,
      ingestionStatus: fileAsset.ingestionStatus,
    };
  }

  async listFiles(companyId: string) {
    return prisma.fileAsset.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: { accessPolicies: true },
    });
  }

  async listVisibleFiles(input: {
    companyId: string;
    requesterUserId: string;
    requesterAiRole: string;
    isAdmin?: boolean;
  }) {
    orangeDebug('file.drawer.query.start', {
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      requesterAiRole: input.requesterAiRole,
      isAdmin: !!input.isAdmin,
    });
    const files = await prisma.fileAsset.findMany({
      where: {
        companyId: input.companyId,
        ...(input.isAdmin
          ? {}
          : {
            OR: [
              { uploaderUserId: input.requesterUserId },
              { accessPolicies: { some: { aiRole: input.requesterAiRole, canRead: true } } },
            ],
          }),
      },
      orderBy: { createdAt: 'desc' },
      include: { accessPolicies: true },
    });

    orangeDebug('file.drawer.query.result', {
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      requesterAiRole: input.requesterAiRole,
      visibleCount: files.length,
      fileAssetIds: files.map((file) => file.id),
    });
    return files;
  }

  async updateAccessPolicy(input: {
    fileAssetId: string;
    companyId: string;
    allowedRoles: string[];
    updatedBy: string;
  }): Promise<void> {
    // Delete existing policies for this file
    await prisma.fileAccessPolicy.deleteMany({
      where: {
        fileAssetId: input.fileAssetId,
        companyId: input.companyId,
      },
    });

    // Re-create with new roles
    if (input.allowedRoles.length > 0) {
      await prisma.fileAccessPolicy.createMany({
        data: input.allowedRoles.map((role) => ({
          fileAssetId: input.fileAssetId,
          companyId: input.companyId,
          aiRole: role,
          canRead: true,
          grantedBy: input.updatedBy,
        })),
      });
    }

    logger.info('file.access_policy.updated', {
      fileAssetId: input.fileAssetId,
      allowedRoles: input.allowedRoles,
    });
  }

  async deleteFile(fileAssetId: string, companyId: string): Promise<void> {
    const asset = await prisma.fileAsset.findFirst({
      where: { id: fileAssetId, companyId },
    });
    if (!asset) return;

    // Delete from Cloudinary
    await cloudinaryAdapter.deleteAsset(
      asset.cloudinaryPublicId,
      asset.cloudinaryResourceType as 'image' | 'video' | 'raw',
    );

    // Cascade deletes FileAccessPolicy and VectorDocument rows via Prisma relations
    await prisma.fileAsset.delete({ where: { id: fileAssetId } });

    logger.info('file.asset.deleted', { fileAssetId, companyId });
  }

  async retryIngestion(fileAssetId: string, companyId: string): Promise<{ alreadyDone: boolean }> {
    const asset = await prisma.fileAsset.findFirst({
      where: { id: fileAssetId, companyId },
      include: { accessPolicies: true },
    });
    if (!asset) throw new Error('File asset not found');
    if (asset.ingestionStatus === 'done') {
      logger.info('file.ingestion.retry.skipped_already_done', {
        fileAssetId: asset.id,
        fileName: asset.fileName,
        companyId: asset.companyId,
      });
      return { alreadyDone: true };
    }

    // Fetch the raw buffer from Cloudinary seamlessly
    const res = await fetch(asset.cloudinaryUrl);
    if (!res.ok) throw new Error(`Failed to fetch file from Cloudinary: ${res.statusText}`);
    const arrayBuffer = await res.arrayBuffer();

    // Reset status to pending
    await prisma.fileAsset.update({
      where: { id: fileAssetId },
      data: { ingestionStatus: 'pending', ingestionError: null },
    });

    const allowedRoles = asset.accessPolicies.map(p => p.aiRole);

    setImmediate(() => {
      documentIngestionPipeline
        .ingest({
          fileAssetId: asset.id,
          companyId: asset.companyId,
          buffer: Buffer.from(arrayBuffer),
          mimeType: asset.mimeType,
          fileName: asset.fileName,
          sourceUrl: asset.cloudinaryUrl,
          uploaderUserId: asset.uploaderUserId,
          allowedRoles,
        })
        .catch((err: any) => {
          logger.error('file.ingestion.retry_failed', {
            fileAssetId: asset.id,
            fileName: asset.fileName,
            mimeType: asset.mimeType,
            companyId: asset.companyId,
            error: err instanceof Error ? err.message : 'unknown',
          });
        });
    });

    return { alreadyDone: false };
  }

  async backfillVectorsFromSource(fileAssetId: string, companyId: string): Promise<void> {
    const asset = await prisma.fileAsset.findFirst({
      where: { id: fileAssetId, companyId },
      include: { accessPolicies: true },
    });
    if (!asset) {
      throw new Error('File asset not found');
    }

    const response = await fetch(asset.cloudinaryUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch file from Cloudinary: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const allowedRoles = asset.accessPolicies.map((policy) => policy.aiRole);

    await documentIngestionPipeline.ingest({
      fileAssetId: asset.id,
      companyId: asset.companyId,
      buffer: Buffer.from(arrayBuffer),
      mimeType: asset.mimeType,
      fileName: asset.fileName,
      sourceUrl: asset.cloudinaryUrl,
      uploaderUserId: asset.uploaderUserId,
      allowedRoles,
    });
  }
}

export const fileUploadService = new FileUploadService();
