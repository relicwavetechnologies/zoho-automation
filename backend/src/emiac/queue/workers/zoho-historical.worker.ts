import { createHash } from 'crypto';

import type { Prisma } from '../../../generated/prisma';
import type { VectorUpsertDTO } from '../../contracts';
import { zohoHistoricalAdapter } from '../../integrations/zoho/zoho-historical.adapter';
import { qdrantAdapter } from '../../integrations/vector';
import { prisma } from '../../../utils/prisma';

const HISTORICAL_BATCH_SIZE = 2;

const createChunks = (record: Record<string, unknown>): string[] => {
  const raw = JSON.stringify(record);
  const chunkSize = 240;
  const chunks: string[] = [];

  for (let index = 0; index < raw.length; index += chunkSize) {
    chunks.push(raw.slice(index, index + chunkSize));
  }

  return chunks.length > 0 ? chunks : ['{}'];
};

const hashContent = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

const createPseudoEmbedding = (content: string): number[] => {
  const hash = hashContent(content);
  const embedding: number[] = [];

  for (let index = 0; index < 24; index += 1) {
    const slice = hash.slice(index * 2, index * 2 + 2);
    embedding.push(parseInt(slice, 16) / 255);
  }

  return embedding;
};

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
    orderBy: [
      { status: 'asc' },
      { queuedAt: 'asc' },
    ],
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

const mapToVectorRecords = (input: {
  companyId: string;
  connectionId: string;
  sourceType: VectorUpsertDTO['sourceType'];
  sourceId: string;
  payload: Record<string, unknown>;
}): (VectorUpsertDTO & { embedding: number[]; connectionId: string })[] => {
  const chunks = createChunks(input.payload);

  return chunks.map((chunk, index) => ({
    companyId: input.companyId,
    connectionId: input.connectionId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    chunkIndex: index,
    contentHash: hashContent(chunk),
    payload: {
      ...input.payload,
      _chunk: chunk,
    },
    embedding: createPseudoEmbedding(chunk),
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

    const vectorRecords = batch.records.flatMap((record) =>
      mapToVectorRecords({
        companyId: snapshot.companyId,
        connectionId: snapshot.connectionId,
        sourceType: record.sourceType,
        sourceId: record.sourceId,
        payload: record.payload,
      }),
    );

    await qdrantAdapter.upsertVectors(vectorRecords);

    const processedBatches = snapshot.processedBatches + 1;
    const totalBatches = Math.max(1, Math.ceil(batch.total / HISTORICAL_BATCH_SIZE));
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
        error: error instanceof Error ? error.message : 'Unknown worker failure',
      },
    });
  }
};
