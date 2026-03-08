import type { Prisma } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';

export type EnqueueZohoHistoricalSyncInput = {
  companyId: string;
  connectionId: string;
  trigger?: string;
};

export type EnqueueZohoHistoricalSyncResult = {
  enqueued: boolean;
  jobId: string;
};

export type EnqueueZohoDeltaSyncInput = {
  companyId: string;
  connectionId: string;
  sourceType: 'zoho_lead' | 'zoho_contact' | 'zoho_deal' | 'zoho_ticket';
  sourceId: string;
  operation: 'create' | 'update' | 'delete';
  changedAt: string;
  eventKey: string;
  payload?: Record<string, unknown>;
};

export type EnqueueZohoDeltaSyncResult = {
  enqueued: boolean;
  jobId?: string;
  eventStatus: 'queued' | 'already_processed';
};

export class ZohoSyncProducer {
  async enqueueInitialHistoricalSync(
    input: EnqueueZohoHistoricalSyncInput,
  ): Promise<EnqueueZohoHistoricalSyncResult> {
    const existing = await prisma.zohoSyncJob.findFirst({
      where: {
        companyId: input.companyId,
        connectionId: input.connectionId,
        jobType: 'historical',
        status: {
          in: ['queued', 'running'],
        },
      },
      orderBy: {
        queuedAt: 'desc',
      },
    });

    if (existing) {
      return {
        enqueued: false,
        jobId: existing.id,
      };
    }

    const job = await prisma.zohoSyncJob.create({
      data: {
        companyId: input.companyId,
        connectionId: input.connectionId,
        jobType: 'historical',
        status: 'queued',
        payload: {
          trigger: input.trigger ?? 'onboarding_zoho_connect',
        },
        events: {
          create: {
            toStatus: 'queued',
            message: 'Historical sync job enqueued from onboarding connect',
          },
        },
      },
    });

    return {
      enqueued: true,
      jobId: job.id,
    };
  }

  async enqueueDeltaSyncEvent(input: EnqueueZohoDeltaSyncInput): Promise<EnqueueZohoDeltaSyncResult> {
    const deltaEvent = await prisma.zohoDeltaEvent.upsert({
      where: {
        eventKey: input.eventKey,
      },
      create: {
        companyId: input.companyId,
        eventKey: input.eventKey,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        operation: input.operation,
        changedAt: new Date(input.changedAt),
        payload: input.payload as Prisma.InputJsonValue | undefined,
        status: 'queued',
      },
      update: {},
    });

    if (deltaEvent.status === 'processed') {
      return {
        enqueued: false,
        eventStatus: 'already_processed',
      };
    }

    const existingJob = await prisma.zohoSyncJob.findFirst({
      where: {
        companyId: input.companyId,
        connectionId: input.connectionId,
        jobType: 'delta',
        correlationId: input.eventKey,
        status: {
          in: ['queued', 'running', 'completed'],
        },
      },
      orderBy: {
        queuedAt: 'desc',
      },
    });

    if (existingJob) {
      return {
        enqueued: false,
        jobId: existingJob.id,
        eventStatus: existingJob.status === 'completed' ? 'already_processed' : 'queued',
      };
    }

    const job = await prisma.zohoSyncJob.create({
      data: {
        companyId: input.companyId,
        connectionId: input.connectionId,
        jobType: 'delta',
        status: 'queued',
        correlationId: input.eventKey,
        payload: {
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          operation: input.operation,
          changedAt: input.changedAt,
          eventKey: input.eventKey,
          payload: input.payload,
        } as Prisma.InputJsonValue,
        events: {
          create: {
            toStatus: 'queued',
            message: 'Delta sync job enqueued from event',
          },
        },
      },
    });

    return {
      enqueued: true,
      jobId: job.id,
      eventStatus: 'queued',
    };
  }
}

export const zohoSyncProducer = new ZohoSyncProducer();
