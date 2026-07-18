import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ManagerTeachError, ManagerTeachService } from '../../src/application/persona-learning/manager-teach.service';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLogger,
};

describe('ManagerTeachService', () => {
  it('allows only an active manager of the selected department to create a session', async () => {
    const service = new ManagerTeachService({
      prisma: { departmentMembership: { findFirst: async () => null } } as never,
      queue: {} as never,
      logger: noopLogger,
      mediaProcessor: {} as never,
      personaProcessor: {} as never,
      maxVideoBytes: 100,
      rawRetentionHours: 24,
      uploadDir: '/tmp/divo-teach-test',
    });
    await assert.rejects(
      service.createSession({
        companyId: 'company-1', managerId: 'member-1', departmentId: 'department-1', source: 'recording',
      }),
      (error: unknown) => error instanceof ManagerTeachError && error.code === 'not_manager',
    );
  });

  it('stops the durable queue at evidence_ready instead of synthesizing persona server-side', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'divo-teach-test-'));
    const videoPath = join(dir, 'raw.mov');
    await writeFile(videoPath, Buffer.from('video-bytes'));
    const enqueued: unknown[] = [];
    const session: any = {
      id: 'teach-1', companyId: 'company-1', managerId: 'manager-1', departmentId: 'department-1',
      source: 'recording', status: 'awaiting_upload', progress: 0, originalFileName: 'recording.mov',
      mimeType: 'video/quicktime', fileSize: 11, attempts: 0, cancelRequestedAt: null,
      lastError: null, parentSessionId: null, managerCorrection: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const artifacts: any[] = [];
    const updateSession = (data: any) => {
      if (data.attempts?.increment) session.attempts += data.attempts.increment;
      Object.assign(session, Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'attempts')));
      return { ...session };
    };
    const tx = {
      managerTeachSession: {
        findFirst: async () => ({ ...session }),
        update: async ({ data }: any) => updateSession(data),
        updateMany: async ({ where, data }: any) => {
          if (session.status !== where.status || session.cancelRequestedAt !== null) return { count: 0 };
          updateSession(data);
          return { count: 1 };
        },
      },
      managerTeachArtifact: {
        create: async ({ data }: any) => { const row = { id: 'raw-1', status: 'available', ...data }; artifacts.push(row); return row; },
        upsert: async ({ create }: any) => { const row = { id: 'evidence-1', status: 'available', ...create }; artifacts.push(row); return row; },
      },
    };
    const prisma: any = {
      managerTeachSession: {
        updateMany: async ({ where, data }: any) => {
          const statuses = typeof where.status === 'string' ? [where.status] : where.status.in;
          if (!statuses.includes(session.status)) return { count: 0 };
          updateSession(data);
          return { count: 1 };
        },
        findUnique: async () => ({ ...session, artifacts: artifacts.filter(row => row.kind === 'raw_video') }),
        findFirst: async ({ where }: any) => session.id === where.id && session.status === where.status ? { id: session.id } : null,
      },
      managerTeachArtifact: { updateMany: async () => ({ count: 1 }) },
      $transaction: async (fn: any) => fn(tx),
    };
    const service = new ManagerTeachService({
      prisma,
      queue: { enqueue: async (payload: unknown) => { enqueued.push(payload); return 'queue-1'; } } as never,
      logger: noopLogger,
      mediaProcessor: {
        process: async (input: any) => {
          await input.assertActive();
          await mkdir(input.evidenceDir, { recursive: true });
          const manifestPath = join(input.evidenceDir, 'evidence-manifest.json');
          await writeFile(manifestPath, '{}');
          return { manifestPath, sizeBytes: 2, frameCount: 3, warningCount: 0 };
        },
      } as never,
      personaProcessor: {} as never,
      maxVideoBytes: 100,
      rawRetentionHours: 24,
      uploadDir: dir,
    });

    await service.completeUpload({
      companyId: 'company-1', managerId: 'manager-1', sessionId: 'teach-1',
      storageKey: videoPath, mimeType: 'video/quicktime', sizeBytes: 11,
    });
    assert.deepEqual(enqueued, [{ teachSessionId: 'teach-1' }]);
    await service.processIngestion('teach-1');
    assert.equal(session.status, 'evidence_ready');
    assert.equal(session.progress, 75);
    assert.deepEqual(enqueued, [{ teachSessionId: 'teach-1' }], 'no server synthesis job is queued');
    await rm(dir, { recursive: true, force: true });
  });

  it('delegates context and persona writes to the governed processor', async () => {
    const calls: string[] = [];
    const service = new ManagerTeachService({
      prisma: { managerTeachArtifact: { findMany: async () => [] } } as never,
      queue: {} as never,
      logger: noopLogger,
      mediaProcessor: {} as never,
      personaProcessor: {
        getContext: async () => { calls.push('context'); return { teachSessionId: 'teach-1' }; },
        apply: async () => {
          calls.push('apply');
          return { sessionId: 'teach-1', status: 'completed', appliedChangeCount: 1 };
        },
      } as never,
      maxVideoBytes: 100,
      rawRetentionHours: 24,
      uploadDir: '/tmp/divo-teach-test',
    });
    await service.getAgentContext({
      companyId: 'company-1', managerId: 'manager-1', departmentId: 'department-1', sessionId: 'teach-1',
    });
    await service.applyAgentPersona({
      companyId: 'company-1', managerId: 'manager-1', departmentId: 'department-1', sessionId: 'teach-1',
      mutationKey: 'teach-1-write', patch: { schemaVersion: 1, baseRevision: 0, understanding: 'Done', changes: [] },
    });
    assert.deepEqual(calls, ['context', 'apply']);
  });
});
