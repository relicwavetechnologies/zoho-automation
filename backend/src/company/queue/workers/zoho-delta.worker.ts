import { createHash } from 'crypto';

import type { Prisma } from '../../../generated/prisma';
import { qdrantAdapter, vectorDocumentRepository } from '../../integrations/vector';
import { ZohoIntegrationError } from '../../integrations/zoho/zoho.errors';
import { extractNormalizedEmails } from '../../integrations/zoho/zoho-email-scope';
import { resolveZohoProvider } from '../../integrations/zoho/zoho-provider.resolver';
import { embeddingService } from '../../integrations/embedding';
import { buildCanonicalZohoChunks } from '../../integrations/vector';
import { prisma } from '../../../utils/prisma';
import { logger } from '../../../utils/logger';

const MAX_DELTA_BATCH = 25;

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

const parsePayload = (
  value: Prisma.JsonValue | null,
): {
  sourceType: 'zoho_lead' | 'zoho_contact' | 'zoho_account' | 'zoho_deal' | 'zoho_ticket';
  sourceId: string;
  operation: 'create' | 'update' | 'delete';
  eventKey: string;
  payload?: Record<string, unknown>;
} => {
  const obj = (value ?? {}) as Record<string, unknown>;

  return {
    sourceType:
      (obj.sourceType as
        | 'zoho_lead'
        | 'zoho_contact'
        | 'zoho_account'
        | 'zoho_deal'
        | 'zoho_ticket') ?? 'zoho_contact',
    sourceId: String(obj.sourceId ?? ''),
    operation: (obj.operation as 'create' | 'update' | 'delete') ?? 'update',
    eventKey: String(obj.eventKey ?? ''),
    payload: (obj.payload as Record<string, unknown> | undefined) ?? undefined,
  };
};

const processDeltaJob = async (jobId: string): Promise<void> => {
  const job = await prisma.zohoSyncJob.findUnique({ where: { id: jobId } });
  if (!job) {
    return;
  }

  const parsed = parsePayload(job.payload as Prisma.JsonValue | null);
  if (!parsed.sourceId || !parsed.eventKey) {
    throw new Error('Delta job payload missing sourceId or eventKey');
  }

  await prisma.zohoSyncJob.update({
    where: { id: job.id },
    data: {
      status: 'running',
      startedAt: job.startedAt ?? new Date(),
    },
  });

  await recordEvent({
    jobId: job.id,
    fromStatus: job.status,
    toStatus: 'running',
    message: 'Delta sync worker started',
  });

  if (parsed.operation === 'delete') {
    await vectorDocumentRepository.deleteBySource({
      companyId: job.companyId,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
    });
    await qdrantAdapter.deleteVectorsBySource({
      companyId: job.companyId,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
    });
  } else {
    const provider = await resolveZohoProvider({
      companyId: job.companyId,
    });
    const latestPayload = await provider.adapter.fetchRecordBySource({
      context: {
        companyId: job.companyId,
        environment: provider.environment,
        connectionId: provider.connectionId,
      },
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
    });
    const basePayload = latestPayload ??
      parsed.payload ?? {
        sourceId: parsed.sourceId,
        operation: parsed.operation,
        generated: true,
        reason: 'missing_upstream_payload',
      };

    const referenceEmails = extractNormalizedEmails(basePayload);
    const chunks = buildCanonicalZohoChunks({
      companyId: job.companyId,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
      payload: basePayload,
      referenceEmails,
      connectionId: job.connectionId,
    });
    const embeddings = await embeddingService.embedDocuments(
      chunks.map((chunk) => ({
        title: chunk.title,
        text: chunk.chunkText,
      })),
    );
    const records = chunks.map((chunk, index) => ({
      companyId: job.companyId,
      connectionId: job.connectionId,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
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
    await vectorDocumentRepository.upsertMany(records);
    await qdrantAdapter.upsertVectors(records);
  }

  await prisma.$transaction([
    prisma.zohoSyncJob.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        progressPercent: 100,
        finishedAt: new Date(),
      },
    }),
    prisma.zohoDeltaEvent.update({
      where: { eventKey: parsed.eventKey },
      data: {
        status: 'processed',
      },
    }),
  ]);

  await recordEvent({
    jobId: job.id,
    fromStatus: 'running',
    toStatus: 'completed',
    message: 'Delta sync completed',
    payload: {
      eventKey: parsed.eventKey,
      operation: parsed.operation,
    },
  });
};

const failDeltaJobWithRetry = async (
  jobId: string,
  reason: string,
  failureCode?: string,
): Promise<void> => {
  const job = await prisma.zohoSyncJob.findUnique({ where: { id: jobId } });
  if (!job) {
    return;
  }

  const parsed = parsePayload(job.payload as Prisma.JsonValue | null);
  const nextRetryCount = job.retryCount + 1;
  const shouldRetry = nextRetryCount < job.maxAttempts;

  await prisma.$transaction([
    prisma.zohoSyncJob.update({
      where: { id: job.id },
      data: {
        status: shouldRetry ? 'queued' : 'failed',
        retryCount: nextRetryCount,
        errorMessage: reason,
      },
    }),
    prisma.zohoDeltaEvent.update({
      where: { eventKey: parsed.eventKey },
      data: {
        status: shouldRetry ? 'retry_pending' : 'failed',
        attempts: {
          increment: 1,
        },
        lastError: failureCode ? `${failureCode}:${reason}` : reason,
      },
    }),
  ]);

  await recordEvent({
    jobId,
    fromStatus: 'running',
    toStatus: shouldRetry ? 'queued' : 'failed',
    message: shouldRetry
      ? 'Delta sync failed and queued for retry'
      : 'Delta sync failed after max retries',
    payload: {
      error: reason,
      retryCount: nextRetryCount,
      maxAttempts: job.maxAttempts,
    },
  });

  logger.error('Delta sync job failed', {
    jobId,
    reason,
    retryCount: nextRetryCount,
    maxAttempts: job.maxAttempts,
  });
};

export const runZohoDeltaSyncWorker = async (companyId?: string): Promise<void> => {
  const candidates = await prisma.zohoSyncJob.findMany({
    where: {
      jobType: 'delta',
      ...(companyId ? { companyId } : {}),
      status: {
        in: ['queued', 'running'],
      },
    },
    orderBy: {
      queuedAt: 'asc',
    },
    take: MAX_DELTA_BATCH,
  });

  for (const job of candidates) {
    try {
      await processDeltaJob(job.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown delta worker error';
      const failureCode = error instanceof ZohoIntegrationError ? error.code : undefined;
      await failDeltaJobWithRetry(job.id, reason, failureCode);
    }
  }
};
