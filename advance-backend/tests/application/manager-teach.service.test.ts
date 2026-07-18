import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ManagerTeachError,
  ManagerTeachService,
} from '../../src/application/persona-learning/manager-teach.service';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLogger,
};

describe('ManagerTeachService', () => {
  it('allows only an active manager of the selected department to create a session', async () => {
    const prisma = {
      departmentMembership: { findFirst: async () => null },
    };
    const service = new ManagerTeachService({
      prisma: prisma as never,
      queue: {} as never,
      logger: noopLogger,
      maxVideoBytes: 100,
      rawRetentionHours: 24,
    });

    await assert.rejects(
      service.createSession({
        companyId: 'company-1', managerId: 'member-1', departmentId: 'department-1', source: 'recording',
      }),
      (error: unknown) => error instanceof ManagerTeachError && error.code === 'not_manager',
    );
  });

  it('moves a streamed artifact through queued ingestion exactly once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'divo-teach-test-'));
    const videoPath = join(dir, 'raw.mov');
    await writeFile(videoPath, Buffer.from('video-bytes'));

    const enqueued: unknown[] = [];
    const session: any = {
      id: 'teach-1', companyId: 'company-1', managerId: 'manager-1', departmentId: 'department-1',
      source: 'recording', status: 'awaiting_upload', progress: 0, originalFileName: 'recording.mov',
      mimeType: 'video/quicktime', fileSize: 11, queueJobId: null, attempts: 0,
      cancelRequestedAt: null, startedAt: null, completedAt: null, failedAt: null, lastError: null,
      createdAt: new Date('2026-07-18T00:00:00.000Z'), updatedAt: new Date('2026-07-18T00:00:00.000Z'),
    };
    let artifact: any = null;
    const updateSession = (data: any) => {
      if (data.attempts?.increment) session.attempts += data.attempts.increment;
      Object.assign(session, Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value !== 'object' || value instanceof Date || value === null)));
      session.updatedAt = new Date();
      return { ...session };
    };
    const tx = {
      managerTeachSession: {
        findFirst: async () => ({ ...session }),
        update: async ({ data }: any) => updateSession(data),
      },
      managerTeachArtifact: {
        create: async ({ data }: any) => { artifact = { id: 'artifact-1', status: 'available', ...data }; return artifact; },
      },
    };
    const prisma = {
      departmentMembership: { findFirst: async () => ({ id: 'membership-1' }) },
      managerTeachSession: {
        create: async ({ data }: any) => ({ ...session, ...data }),
        updateMany: async ({ where, data }: any) => {
          const statusMatches = typeof where.status === 'string'
            ? session.status === where.status
            : !where.status?.in || where.status.in.includes(session.status);
          if (!statusMatches) return { count: 0 };
          updateSession(data);
          return { count: 1 };
        },
        findUnique: async () => ({ ...session, artifacts: artifact ? [artifact] : [] }),
      },
      managerTeachArtifact: { updateMany: async () => ({ count: 1 }) },
      $transaction: async (fn: any) => fn(tx),
    };
    const service = new ManagerTeachService({
      prisma: prisma as never,
      queue: { enqueue: async (payload: unknown) => { enqueued.push(payload); return 'queue-1'; } } as never,
      logger: noopLogger,
      maxVideoBytes: 100,
      rawRetentionHours: 24,
    });

    const queued = await service.completeUpload({
      companyId: 'company-1', managerId: 'manager-1', sessionId: 'teach-1',
      storageKey: videoPath, mimeType: 'video/quicktime', sizeBytes: 11,
    });
    assert.equal(queued.status, 'queued');
    assert.deepEqual(enqueued, [{ teachSessionId: 'teach-1' }]);

    await service.processIngestion('teach-1');
    assert.equal(session.status, 'ready_for_processing');
    assert.equal(session.progress, 100);

    await service.processIngestion('teach-1');
    assert.equal(session.attempts, 1, 'terminal ingestion must be idempotent');

    session.status = 'queued';
    await rm(videoPath, { force: true });
    await assert.rejects(service.processIngestion('teach-1'));
    assert.equal(session.status, 'queued', 'a retryable worker failure must remain durable');
    await service.markFailed('teach-1', new Error('retry budget exhausted'));
    assert.equal(session.status, 'failed');
    await rm(dir, { recursive: true, force: true });
  });
});
