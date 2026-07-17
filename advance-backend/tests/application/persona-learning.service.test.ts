import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PersonaLearningService } from '../../src/application/persona-learning/persona-learning.service';
import type { PersonaLearningExtractor } from '../../src/application/persona-learning/persona-learning.extractor';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLogger,
};

const extractor: PersonaLearningExtractor = {
  provider: 'deepseek',
  modelId: 'deepseek-v4-flash',
  extract: async () => ({
    schemaVersion: 1,
    observations: [{
      kind: 'preference',
      scopeKey: 'reporting.weekly',
      claim: 'Use bullet summaries.',
      rationale: 'Manager explicitly requested bullets.',
      evidenceStrength: 'explicit',
    }],
  }),
};

describe('PersonaLearningService', () => {
  it('captures only a completed run from the manager of the selected department and enqueues one idempotent job', async () => {
    const enqueued: unknown[] = [];
    const evidenceWrites: any[] = [];
    const jobWrites: any[] = [];
    const prisma = {
      desktopThread: { findFirst: async () => ({ departmentId: 'dept-1' }) },
      departmentMembership: { findFirst: async () => ({ departmentId: 'dept-1' }) },
      personaLearningEvidence: { findUnique: async () => null },
      personaLearningJob: {
        updateMany: async (input: unknown) => { jobWrites.push(input); },
      },
      $transaction: async (fn: any) => fn({
        personaLearningEvidence: {
          create: async ({ data }: any) => {
            evidenceWrites.push(data);
            return { id: 'evidence-1', ...data };
          },
        },
        personaLearningJob: {
          create: async ({ data }: any) => ({ id: 'job-1', ...data }),
        },
      }),
    };
    const service = new PersonaLearningService({
      prisma: prisma as never,
      queue: { enqueue: async (payload: unknown) => { enqueued.push(payload); return 'bull-job-1'; } } as never,
      extractor,
      logger: noopLogger,
    });

    await service.captureCompletedManagerRun({
      executionRunId: 'run-1',
      companyId: 'company-1',
      managerId: 'manager-1',
      threadId: 'thread-1',
      context: {
        userMessages: ['Always send reports as bullets. api_key=should-not-persist'],
        assistantResponse: 'I will send a bullet report.',
      },
      tools: [{ toolName: 'googleSheets', isError: false }],
    });

    assert.equal(evidenceWrites.length, 1);
    assert.equal(evidenceWrites[0].status, 'eligible');
    assert.equal(evidenceWrites[0].contextJson.userMessages[0].includes('should-not-persist'), false);
    assert.deepEqual(enqueued, [{ personaLearningJobId: 'job-1' }]);
    assert.equal(jobWrites.length, 1);
  });

  it('does not create evidence for a department member who is not that department manager', async () => {
    const enqueued: unknown[] = [];
    const prisma = {
      desktopThread: { findFirst: async () => ({ departmentId: 'dept-1' }) },
      // The real query scopes this lookup to the thread's department and MANAGER role.
      departmentMembership: { findFirst: async () => null },
    };
    const service = new PersonaLearningService({
      prisma: prisma as never,
      queue: { enqueue: async (payload: unknown) => { enqueued.push(payload); return 'unused'; } } as never,
      extractor,
      logger: noopLogger,
    });

    await service.captureCompletedManagerRun({
      executionRunId: 'run-1',
      companyId: 'company-1',
      managerId: 'member-1',
      threadId: 'thread-1',
      context: { userMessages: ['Use bullets.'], assistantResponse: 'Done.' },
      tools: [],
    });

    assert.deepEqual(enqueued, []);
  });

  it('writes only shadow candidates and marks a successful no-prompt execution as complete', async () => {
    const updates: any[] = [];
    const candidateWrites: any[] = [];
    const prisma = {
      personaLearningJob: {
        findUnique: async () => ({
          id: 'job-1',
          status: 'queued',
          evidence: {
            id: 'evidence-1', companyId: 'company-1', managerId: 'manager-1', departmentId: 'dept-1',
            contextJson: { userMessages: ['Always use bullets.'], assistantResponse: 'Done.' },
            toolSummaryJson: [], runSummary: null,
          },
        }),
        update: async ({ data }: any) => { updates.push(data); },
      },
      personaLearningCandidate: { findMany: async () => [] },
      $transaction: async (fn: any) => fn({
        personaLearningCandidate: {
          upsert: async ({ create }: any) => { candidateWrites.push(create); },
        },
        personaLearningJob: {
          update: async ({ data }: any) => { updates.push(data); },
        },
      }),
    };
    const service = new PersonaLearningService({
      prisma: prisma as never,
      queue: {} as never,
      extractor,
      logger: noopLogger,
    });

    await service.processShadowExtraction('job-1');

    assert.equal(candidateWrites.length, 1);
    assert.equal(candidateWrites[0].status, 'shadow');
    assert.equal(candidateWrites[0].claim, 'Use bullet summaries.');
    assert.equal(updates.at(-1).status, 'shadow_complete');
  });
});
