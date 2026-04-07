import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { fileUploadService } from './file-upload.service';
import {
  GENERATED_ARTIFACT_FILE_PREFIX,
  GENERATED_ARTIFACT_RETENTION_HOURS,
  GENERATED_ARTIFACT_RETENTION_INTERVAL_MS,
} from './file-asset-retention.constants';

export class FileAssetRetentionService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.cleanupExpiredGeneratedArtifacts().catch((error) => {
        logger.error('file.asset.retention.cleanup.failed', {
          error: error instanceof Error ? error.message : 'unknown_error',
        });
      });
    }, GENERATED_ARTIFACT_RETENTION_INTERVAL_MS);

    void this.cleanupExpiredGeneratedArtifacts().catch((error) => {
      logger.error('file.asset.retention.cleanup.failed', {
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    });

    logger.info('file.asset.retention.scheduler.started', {
      intervalMs: GENERATED_ARTIFACT_RETENTION_INTERVAL_MS,
      olderThanHours: GENERATED_ARTIFACT_RETENTION_HOURS,
      filePrefix: GENERATED_ARTIFACT_FILE_PREFIX,
    });
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async cleanupExpiredGeneratedArtifacts(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const cutoff = new Date(Date.now() - GENERATED_ARTIFACT_RETENTION_HOURS * 60 * 60 * 1000);
      const candidates = await prisma.fileAsset.findMany({
        where: {
          fileName: { startsWith: GENERATED_ARTIFACT_FILE_PREFIX },
          mimeType: 'text/csv',
          createdAt: { lt: cutoff },
        },
        select: {
          id: true,
          companyId: true,
          fileName: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });

      if (candidates.length === 0) {
        logger.info('file.asset.retention.cleanup.completed', {
          deletedCount: 0,
          failedCount: 0,
          cutoff: cutoff.toISOString(),
          filePrefix: GENERATED_ARTIFACT_FILE_PREFIX,
        });
        return;
      }

      let deletedCount = 0;
      let failedCount = 0;
      for (const candidate of candidates) {
        try {
          await fileUploadService.deleteFile(candidate.id, candidate.companyId);
          deletedCount += 1;
        } catch (error) {
          failedCount += 1;
          logger.warn('file.asset.retention.delete_failed', {
            fileAssetId: candidate.id,
            companyId: candidate.companyId,
            fileName: candidate.fileName,
            createdAt: candidate.createdAt.toISOString(),
            error: error instanceof Error ? error.message : 'unknown_error',
          });
        }
      }

      logger.info('file.asset.retention.cleanup.completed', {
        deletedCount,
        failedCount,
        cutoff: cutoff.toISOString(),
        oldestDeletedCreatedAt: candidates[0]?.createdAt.toISOString() ?? null,
        newestDeletedCreatedAt: candidates[candidates.length - 1]?.createdAt.toISOString() ?? null,
        filePrefix: GENERATED_ARTIFACT_FILE_PREFIX,
      });
    } finally {
      this.running = false;
    }
  }
}

export const fileAssetRetentionService = new FileAssetRetentionService();
