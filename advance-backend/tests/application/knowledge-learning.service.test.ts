import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrismaClient } from '../../src/generated/prisma';
import type { Logger } from '../../src/shared/logger';
import {
  KnowledgeLearningService,
  evaluateKnowledgeLearningObservation,
  type KnowledgeLearningOptions,
} from '../../src/application/knowledge/knowledge-learning.service';
import {
  compactKnowledgeLearningInput,
  KNOWLEDGE_LEARNING_MAX_EXISTING_INPUT_CHARS,
  KNOWLEDGE_LEARNING_MAX_RECENT_INPUT_CHARS,
  KNOWLEDGE_LEARNING_MAX_USER_INPUT_CHARS,
  type KnowledgeLearningObservation,
} from '../../src/application/knowledge/knowledge-learning.extractor';
import { KnowledgeMutationError } from '../../src/application/knowledge/knowledge-mutation.errors';

const policy: KnowledgeLearningOptions = {
  immediateConfidence: 0.9,
  repeatedConfidence: 0.75,
  repeatedEvidenceCount: 3,
};

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

const observation = (patch: Partial<KnowledgeLearningObservation> = {}): KnowledgeLearningObservation => ({
  operation: 'create',
  subject: 'weekly report format',
  logicalKey: 'reports.weekly.format',
  facts: ['Weekly reports should use a two-column table.'],
  confidence: 0.95,
  evidenceStrength: 'explicit',
  rationale: 'The user directly specified a durable format preference.',
  ...patch,
});

describe('knowledge learning promotion policy', () => {
  it('promotes explicit high-confidence evidence without asking for personal approval', () => {
    assert.deepEqual(evaluateKnowledgeLearningObservation({
      observation: observation(),
      userMessageCount: 1,
      priorMatchingObservations: 0,
      options: policy,
    }), { eligible: true, reason: 'explicit' });
  });

  it('requires multi-message evidence before accepting strong context', () => {
    const candidate = observation({ evidenceStrength: 'strong_context' });
    assert.equal(evaluateKnowledgeLearningObservation({
      observation: candidate,
      userMessageCount: 1,
      priorMatchingObservations: 0,
      options: policy,
    }).eligible, false);
    assert.equal(evaluateKnowledgeLearningObservation({
      observation: candidate,
      userMessageCount: 2,
      priorMatchingObservations: 0,
      options: policy,
    }).eligible, true);
  });

  it('promotes repeated semantic evidence but never infers deletion from repetition', () => {
    assert.deepEqual(evaluateKnowledgeLearningObservation({
      observation: observation({ evidenceStrength: 'weak', confidence: 0.8 }),
      userMessageCount: 1,
      priorMatchingObservations: 2,
      options: policy,
    }), { eligible: true, reason: 'repeated' });
    assert.equal(evaluateKnowledgeLearningObservation({
      observation: observation({ operation: 'delete', facts: [], evidenceStrength: 'weak', confidence: 0.8 }),
      userMessageCount: 1,
      priorMatchingObservations: 10,
      options: policy,
    }).eligible, false);
  });
});

describe('knowledge learning prompt budgets', () => {
  it('keeps newest conversation evidence and bounds every unbounded collection', () => {
    const userMessages = Array.from({ length: 30 }, (_, index) => `${index}: ${'u'.repeat(1_000)}`);
    const existing = Array.from({ length: 100 }, (_, index) => ({
      logicalKey: `memory.${index}`,
      version: 1,
      facts: [`${index}: ${'e'.repeat(500)}`],
    }));
    const recentObservations = Array.from({ length: 100 }, (_, index) => observation({
      logicalKey: `recent.${index}`,
      rationale: `${index}: ${'r'.repeat(400)}`,
    }));

    const compact = compactKnowledgeLearningInput({
      sourceId: 'source',
      channel: 'lark',
      userMessages,
      assistantText: 'a'.repeat(10_000),
      existing,
      recentObservations,
    });

    assert.ok(compact.userMessages.reduce((sum, item) => sum + item.length, 0)
      <= KNOWLEDGE_LEARNING_MAX_USER_INPUT_CHARS);
    assert.match(compact.userMessages.at(-1) ?? '', /^29:/, 'newest user evidence is retained');
    assert.ok(compact.existing.reduce((sum, item) => sum + JSON.stringify(item).length, 0)
      <= KNOWLEDGE_LEARNING_MAX_EXISTING_INPUT_CHARS);
    assert.match(compact.existing[0]?.logicalKey ?? '', /^memory\.0$/, 'existing rows arrive newest-first');
    assert.ok(compact.recentObservations.reduce((sum, item) => sum + JSON.stringify(item).length, 0)
      <= KNOWLEDGE_LEARNING_MAX_RECENT_INPUT_CHARS);
    assert.equal(compact.assistantText?.length, 3_000);
  });
});

describe('KnowledgeLearningService central authority', () => {
  it('runs an eligible observation through RBAC, mutation authority, and projection', async () => {
    const calls: Array<{ name: string; value: unknown }> = [];
    const updates: unknown[] = [];
    const job = makeJob();
    const service = new KnowledgeLearningService({
      prisma: processPrisma(job, updates),
      queue: { enqueue: async () => '' },
      extractor: {
        provider: 'test',
        modelId: 'test-model',
        extract: async () => ({ schemaVersion: 1, observations: [observation()] }),
      },
      personalMemoryCommands: {
        execute: async input => {
          calls.push({ name: 'personal', value: input });
          return {
            action: 'created',
            logicalKey: 'reports.weekly.format',
            resourceId: 'resource-1',
            version: 1,
            projection: 'completed',
          } as const;
        },
      } as never,
      logger: noopLogger,
      options: policy,
    });

    await service.process(job.id);

    assert.deepEqual(calls.map(call => call.name), ['personal']);
    const command = calls[0]!.value as Record<string, unknown>;
    assert.equal(command['sourceType'], 'automatic_learning');
    assert.equal((command['command'] as Record<string, unknown>)['subject'], 'weekly report format');
    const finalUpdate = updates.at(-1) as { data: { status: string; outcomesJson: unknown } };
    assert.equal(finalUpdate.data.status, 'completed');
    assert.match(JSON.stringify(finalUpdate.data.outcomesJson), /"status":"applied"/);
  });

  it('records a rejection when the centralized personal-memory authority denies RBAC', async () => {
    let invoked = false;
    const updates: unknown[] = [];
    const service = new KnowledgeLearningService({
      prisma: processPrisma(makeJob(), updates),
      queue: { enqueue: async () => '' },
      extractor: {
        provider: 'test',
        modelId: 'test-model',
        extract: async () => ({ schemaVersion: 1, observations: [observation()] }),
      },
      personalMemoryCommands: {
        execute: async () => {
          invoked = true;
          throw new KnowledgeMutationError('permission_denied', 'denied');
        },
      } as never,
      logger: noopLogger,
      options: policy,
    });

    await service.process('job-1');
    assert.equal(invoked, true);
    assert.match(JSON.stringify((updates.at(-1) as { data: unknown }).data), /rbac_denied/);
  });
});

function makeJob() {
  return {
    id: 'job-1',
    companyId: 'company-1',
    userId: 'user-1',
    sourceId: 'desktop:run-1',
    channel: 'desktop',
    companyRole: 'MEMBER',
    userMessages: ['Please remember that weekly reports should use a two-column table.'],
    assistantText: 'Understood.',
  };
}

function processPrisma(job: ReturnType<typeof makeJob>, updates: unknown[]): PrismaClient {
  return {
    knowledgeLearningJob: {
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => job,
      findMany: async () => [],
      update: async (input: unknown) => { updates.push(input); return job; },
    },
    knowledgeResource: { findMany: async () => [] },
  } as unknown as PrismaClient;
}
