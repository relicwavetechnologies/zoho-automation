const assert = require('node:assert/strict');
const test = require('node:test');

const { zohoSyncProducer } = require('../dist/company/queue/producer/zoho-sync.producer');
const { prisma } = require('../dist/utils/prisma');

const withPatchedProducerDeps = async (patches, fn) => {
  const original = {
    deltaUpsert: prisma.zohoDeltaEvent.upsert,
    jobFindFirst: prisma.zohoSyncJob.findFirst,
    jobCreate: prisma.zohoSyncJob.create,
  };

  prisma.zohoDeltaEvent.upsert = patches.deltaUpsert || original.deltaUpsert;
  prisma.zohoSyncJob.findFirst = patches.jobFindFirst || original.jobFindFirst;
  prisma.zohoSyncJob.create = patches.jobCreate || original.jobCreate;

  try {
    await fn();
  } finally {
    prisma.zohoDeltaEvent.upsert = original.deltaUpsert;
    prisma.zohoSyncJob.findFirst = original.jobFindFirst;
    prisma.zohoSyncJob.create = original.jobCreate;
  }
};

const baseInput = {
  companyId: 'cmp-1',
  connectionId: 'conn-1',
  sourceType: 'zoho_contact',
  sourceId: 'src-1',
  operation: 'update',
  changedAt: new Date().toISOString(),
  eventKey: 'evt-123456',
  payload: { id: 'src-1' },
};

test('enqueueDeltaSyncEvent returns already_processed when event already processed', async () => {
  await withPatchedProducerDeps(
    {
      deltaUpsert: async () => ({ status: 'processed' }),
      jobFindFirst: async () => null,
      jobCreate: async () => {
        throw new Error('should not create job');
      },
    },
    async () => {
      const result = await zohoSyncProducer.enqueueDeltaSyncEvent(baseInput);
      assert.equal(result.enqueued, false);
      assert.equal(result.eventStatus, 'already_processed');
      assert.equal(result.jobId, undefined);
    },
  );
});

test('enqueueDeltaSyncEvent dedupes when completed job exists for correlation id', async () => {
  await withPatchedProducerDeps(
    {
      deltaUpsert: async () => ({ status: 'queued' }),
      jobFindFirst: async () => ({
        id: 'job-1',
        status: 'completed',
      }),
      jobCreate: async () => {
        throw new Error('should not create new job');
      },
    },
    async () => {
      const result = await zohoSyncProducer.enqueueDeltaSyncEvent(baseInput);
      assert.equal(result.enqueued, false);
      assert.equal(result.eventStatus, 'already_processed');
      assert.equal(result.jobId, 'job-1');
    },
  );
});
