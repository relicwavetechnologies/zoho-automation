import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ok } from '../../src/shared/result.ts';
import type { CachePort } from '../../src/shared/cache.ts';
import {
  GoogleDriveXlsxConversionCheckpointStore,
  GOOGLE_DRIVE_XLSX_CONVERSION_COMPLETION_TTL_SECONDS,
  GOOGLE_DRIVE_XLSX_CONVERSION_LEASE_TTL_SECONDS,
} from '../../src/application/data-export/google-drive-xlsx-conversion.checkpoint.store.ts';
import {
  GoogleDriveXlsxConversionConsumer,
  WorkbookConversionLeaseHeldError,
} from '../../src/application/data-export/google-drive-xlsx-conversion.consumer.ts';
import type {
  GoogleDriveXlsxConversionCompletion,
  GoogleDriveXlsxConversionJob,
} from '../../src/application/data-export/google-drive-xlsx-conversion.worker.ts';
import type { WorkbookConversionJobPayload } from '../../src/application/data-export/workbook-conversion.queue.ts';

const job: GoogleDriveXlsxConversionJob = {
  jobKey: 'offer_123',
  companyId: 'company-1',
  userId: 'user-1',
  sourceConnectionId: '11111111-1111-4111-8111-111111111111',
  sourceFileId: 'source_xlsx_123',
  sourceTitle: 'Budget.xlsx',
};

const completion: GoogleDriveXlsxConversionCompletion = {
  jobKey: job.jobKey,
  sourceFileId: job.sourceFileId,
  spreadsheetId: 'converted_sheet_456',
  artifactUrl: 'https://docs.google.com/spreadsheets/d/converted_sheet_456/edit',
  ownerEmail: 'person@example.com',
  verified: true,
};

function cache() {
  const values = new Map<string, unknown>();
  const ttls: number[] = [];
  const value: CachePort = {
    get: async key => ok(values.get(key) ?? null),
    set: async (key, entry, ttl) => {
      values.set(key, entry);
      ttls.push(ttl ?? 300);
      return ok(undefined);
    },
    setNx: async (key, entry, ttl) => {
      ttls.push(ttl);
      if (values.has(key)) return ok(false);
      values.set(key, entry);
      return ok(true);
    },
    del: async key => { values.delete(key); return ok(undefined); },
    scanDel: async () => ok(0),
  };
  return { value, ttls };
}

const logger = {
  child: () => logger,
  info: () => undefined,
  warn: () => undefined,
} as any;

describe('Google Drive XLSX conversion queue/checkpoint adapters', () => {
  it('uses Redis lease then durable completion as the only retry authority', async () => {
    const fake = cache();
    const first = new GoogleDriveXlsxConversionCheckpointStore(fake.value);
    const second = new GoogleDriveXlsxConversionCheckpointStore(fake.value);

    assert.deepEqual(await first.claim(job), { status: 'claimed' });
    assert.deepEqual(await second.claim(job), { status: 'in_progress' });
    assert.deepEqual(await first.complete(completion), completion);
    assert.deepEqual(await second.claim(job), { status: 'completed', completion });
    assert.deepEqual(fake.ttls, [
      GOOGLE_DRIVE_XLSX_CONVERSION_LEASE_TTL_SECONDS,
      GOOGLE_DRIVE_XLSX_CONVERSION_COMPLETION_TTL_SECONDS,
    ]);

    await assert.rejects(
      second.claim({ ...job, sourceFileId: 'different_source' }),
      /already bound|checkpoint is invalid/,
    );
  });

  it('maps the authoritative deterministic queue job into the core and retries a held lease instead of completing it', async () => {
    const finalAttempts: boolean[] = [];
    const coreJobs: GoogleDriveXlsxConversionJob[] = [];
    const queued: WorkbookConversionJobPayload = {
      version: 1,
      offerId: 'offer_123',
      companyId: job.companyId,
      userId: job.userId,
      chatId: 'oc_123',
      sourceMessageId: 'om_123',
      replyInThread: false,
      connectionId: job.sourceConnectionId,
      fileId: job.sourceFileId,
      fileName: job.sourceTitle,
    };
    const consumer = new GoogleDriveXlsxConversionConsumer({
      redisUrl: 'redis://unused',
      logger,
      core: {
        process: async (coreJob, options) => {
          coreJobs.push(coreJob);
          finalAttempts.push(options.finalAttempt);
          return { disposition: 'completed', completion };
        },
      },
    });
    await consumer.processJob({ id: 'wbc_offer_123', data: queued, attemptsMade: 2, opts: { attempts: 3 } } as any);
    assert.deepEqual(finalAttempts, [true]);
    assert.deepEqual(coreJobs, [{ ...job, jobKey: 'wbc_offer_123' }]);

    const held = new GoogleDriveXlsxConversionConsumer({
      redisUrl: 'redis://unused',
      logger,
      core: { process: async () => ({ disposition: 'in_progress' }) },
    });
    await assert.rejects(
      held.processJob({ id: 'wbc_offer_123', data: queued, attemptsMade: 0, opts: { attempts: 3 } } as any),
      WorkbookConversionLeaseHeldError,
    );
  });
});
