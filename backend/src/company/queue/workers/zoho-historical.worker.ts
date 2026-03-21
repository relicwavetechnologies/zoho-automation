import { createHash } from 'crypto';

import type { Prisma } from '../../../generated/prisma';
import type { VectorUpsertDTO } from '../../contracts';
import { zohoHistoricalAdapter } from '../../integrations/zoho/zoho-historical.adapter';
import { ZohoIntegrationError } from '../../integrations/zoho/zoho.errors';
import { extractNormalizedEmails } from '../../integrations/zoho/zoho-email-scope';
import { embeddingService } from '../../integrations/embedding';
import {
  buildCanonicalZohoChunks,
  type QdrantUpsertInput,
  qdrantAdapter,
  vectorDocumentRepository,
} from '../../integrations/vector';
import { prisma } from '../../../utils/prisma';
import { logger } from '../../../utils/logger';

const HISTORICAL_BATCH_SIZE = 2;

const hashContent = (content: string): string => createHash('sha256').update(content).digest('hex');

const recordEvent = async (input: {
  jobId: string;
  fromStatus?: string;
  toStatus: string;
  message: string;
  payload?: Record<string, unknown>;
}): Promise<void> => {
  await prisma.zohoSyncJobEvent.create({
    data: {
      jobId: input.jobId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      message: input.message,
      payload: input.payload as Prisma.InputJsonValue | undefined,
    },
  });
};

const pickHistoricalJob = async (companyId?: string) =>
  prisma.zohoSyncJob.findFirst({
    where: {
      jobType: 'historical',
      ...(companyId ? { companyId } : {}),
      status: {
        in: ['queued', 'running'],
      },
    },
    orderBy: [{ status: 'asc' }, { queuedAt: 'asc' }],
  });

const markRunningIfNeeded = async (jobId: string): Promise<void> => {
  const job = await prisma.zohoSyncJob.findUnique({ where: { id: jobId } });
  if (!job || job.status === 'running') {
    return;
  }

  await prisma.zohoSyncJob.update({
    where: { id: jobId },
    data: {
      status: 'running',
      startedAt: job.startedAt ?? new Date(),
    },
  });

  await recordEvent({
    jobId,
    fromStatus: job.status,
    toStatus: 'running',
    message: 'Historical sync worker started',
  });
};

const mapToVectorRecords = async (input: {
  companyId: string;
  connectionId: string;
  sourceType: Extract<
    VectorUpsertDTO['sourceType'],
    'zoho_lead' | 'zoho_contact' | 'zoho_account' | 'zoho_deal' | 'zoho_ticket'
  >;
  sourceId: string;
  payload: Record<string, unknown>;
}): Promise<Array<QdrantUpsertInput & { embedding: number[] }>> => {
  const referenceEmails = extractNormalizedEmails(input.payload);
  const chunks = buildCanonicalZohoChunks({
    companyId: input.companyId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    referenceEmails,
    connectionId: input.connectionId,
    payload: input.payload,
  });
  const embeddings = await embeddingService.embedDocuments(
    chunks.map((chunk) => ({
      title: chunk.title,
      text: chunk.chunkText,
    })),
  );

  return chunks.map((chunk, index) => ({
    companyId: input.companyId,
    connectionId: input.connectionId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    chunkIndex: chunk.chunkIndex,
    documentKey: chunk.documentKey,
    chunkText: chunk.chunkText,
    contentHash: hashContent(chunk.chunkText),
    visibility: chunk.visibility,
    referenceEmails,
    payload: {
      ...chunk.payload,
      _chunk: chunk.chunkText,
    },
    embedding: embeddings[index],
    denseEmbedding: embeddings[index],
    updatedAt: chunk.sourceUpdatedAt,
    embeddingSchemaVersion: chunk.embeddingSchemaVersion,
    retrievalProfile: chunk.retrievalProfile,
    sourceUpdatedAt: chunk.sourceUpdatedAt,
    title: chunk.title,
    content: chunk.chunkText,
  }));
};

export const runZohoHistoricalSyncWorker = async (companyId?: string): Promise<void> => {
  const job = await pickHistoricalJob(companyId);
  if (!job) {
    return;
  }

  try {
    await markRunningIfNeeded(job.id);

    const snapshot = await prisma.zohoSyncJob.findUnique({ where: { id: job.id } });
    if (!snapshot) {
      return;
    }

    const batch = await zohoHistoricalAdapter.fetchHistoricalBatch({
      companyId: snapshot.companyId,
      cursor: snapshot.checkpoint ?? undefined,
      pageSize: HISTORICAL_BATCH_SIZE,
      environment:
        (
          await prisma.zohoConnection.findUnique({
            where: { id: snapshot.connectionId },
            select: { environment: true },
          })
        )?.environment ?? 'prod',
    });

    if (batch.records.length === 0 && !batch.nextCursor) {
      await prisma.$transaction([
        prisma.zohoSyncJob.update({
          where: { id: snapshot.id },
          data: {
            status: 'completed',
            progressPercent: 100,
            finishedAt: new Date(),
          },
        }),
        prisma.zohoConnection.update({
          where: { id: snapshot.connectionId },
          data: {
            lastSyncAt: new Date(),
          },
        }),
      ]);

      await recordEvent({
        jobId: snapshot.id,
        fromStatus: 'running',
        toStatus: 'completed',
        message: 'Historical sync completed with no pending records',
      });

      return;
    }

    const vectorRecords = (
      await Promise.all(
        batch.records.map((record) =>
          mapToVectorRecords({
            companyId: snapshot.companyId,
            connectionId: snapshot.connectionId,
            sourceType: record.sourceType,
            sourceId: record.sourceId,
            payload: record.payload,
          }),
        ),
      )
    ).flat();

    await vectorDocumentRepository.upsertMany(vectorRecords);
    await qdrantAdapter.upsertVectors(vectorRecords);

    const processedBatches = snapshot.processedBatches + 1;
    const estimatedTotalBatches =
      batch.total > 0
        ? Math.max(1, Math.ceil(batch.total / HISTORICAL_BATCH_SIZE))
        : processedBatches + (batch.nextCursor ? 2 : 1);
    const totalBatches = Math.max(snapshot.totalBatches ?? 0, estimatedTotalBatches);
    const isDone = !batch.nextCursor;
    const progressPercent = isDone
      ? 100
      : Math.min(99, Math.floor((processedBatches / totalBatches) * 100));

    await prisma.zohoSyncJob.update({
      where: { id: snapshot.id },
      data: {
        status: isDone ? 'completed' : 'running',
        checkpoint: batch.nextCursor,
        totalBatches,
        processedBatches,
        progressPercent,
        finishedAt: isDone ? new Date() : null,
      },
    });

    if (isDone) {
      await prisma.zohoConnection.update({
        where: { id: snapshot.connectionId },
        data: {
          lastSyncAt: new Date(),
        },
      });

      await recordEvent({
        jobId: snapshot.id,
        fromStatus: 'running',
        toStatus: 'completed',
        message: 'Historical sync completed successfully',
        payload: {
          totalBatches,
          processedBatches,
        },
      });
    } else {
      await recordEvent({
        jobId: snapshot.id,
        fromStatus: 'running',
        toStatus: 'running',
        message: 'Historical sync checkpoint advanced',
        payload: {
          checkpoint: batch.nextCursor,
          progressPercent,
        },
      });

      await runZohoHistoricalSyncWorker(snapshot.companyId);
    }
  } catch (error) {
    logger.error('zoho.historical.failed', {
      jobId: job.id,
      companyId: job.companyId,
      connectionId: job.connectionId,
      error,
      reason: error instanceof Error ? error.message : 'Unknown worker failure',
      failureCode: error instanceof ZohoIntegrationError ? error.code : 'unknown',
    });

    await prisma.zohoSyncJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown worker failure',
      },
    });

    await recordEvent({
      jobId: job.id,
      fromStatus: 'running',
      toStatus: 'failed',
      message: 'Historical sync failed',
      payload: {
        failureCode: error instanceof ZohoIntegrationError ? error.code : 'unknown',
        error: error instanceof Error ? error.message : 'Unknown worker failure',
      },
    });
  }
};
