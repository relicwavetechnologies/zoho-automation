/**
 * Unit tests for observability services:
 *   - AuditService.record() (fire-and-forget, redacts secrets)
 *   - AuditService.query()  (company-scoped, maps to AuditLogView)
 *   - TokenUsageService.record() (skips zeros, fire-and-forget)
 *   - TokenUsageService.summariseByModel()
 *   - ExecutionQueryService.listRuns(), getRun(), getEvents()
 *     (including raw execution-data payload redaction)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AuditService }          from '../../src/application/observability/audit.service.ts';
import { TokenUsageService }     from '../../src/application/observability/token-usage.service.ts';
import { ExecutionQueryService } from '../../src/application/observability/execution-query.service.ts';
import { sparklineHeights }      from '../../src/application/observability/token-cost.ts';

// ─── Shared helpers ───────────────────────────────────────────────────────────

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

// ─── AuditService ─────────────────────────────────────────────────────────────

describe('AuditService', () => {
  describe('record()', () => {
    it('calls prisma.auditLog.create fire-and-forget', async () => {
      let captured: any = null;
      const prisma = {
        auditLog: {
          create: async (args: any) => { captured = args; return {}; },
        },
      } as any;
      const svc = new AuditService(prisma, noopLogger);
      svc.record({ actorId: 'u1', action: 'test', outcome: 'success' });

      // give the microtask queue a tick
      await new Promise(r => setTimeout(r, 0));
      assert.ok(captured, 'create was called');
      assert.equal(captured.data.actorId, 'u1');
      assert.equal(captured.data.action, 'test');
    });

    it('redacts secret keys from metadata', async () => {
      let captured: any = null;
      const prisma = {
        auditLog: {
          create: async (args: any) => { captured = args; return {}; },
        },
      } as any;
      const svc = new AuditService(prisma, noopLogger);
      svc.record({
        actorId:  'u1',
        action:   'test',
        outcome:  'success',
        metadata: { toolId: 'larkTask', apiKey: 'super-secret', token: 'abc', plain: 'ok' },
      });

      await new Promise(r => setTimeout(r, 0));
      const meta = captured.data.metadata;
      assert.equal(meta.apiKey, '[REDACTED]');
      assert.equal(meta.token, '[REDACTED]');
      assert.equal(meta.plain, 'ok');
      assert.equal(meta.toolId, 'larkTask');
    });

    it('swallows DB errors without throwing', async () => {
      const prisma = {
        auditLog: {
          create: async () => { throw new Error('db down'); },
        },
      } as any;
      const svc = new AuditService(prisma, noopLogger);
      // must not throw — fire-and-forget
      svc.record({ actorId: 'u1', action: 'test', outcome: 'failure' });
      await new Promise(r => setTimeout(r, 0));
      // reaching here means no unhandled rejection
    });

    it('omits companyId key when not provided', async () => {
      let captured: any = null;
      const prisma = {
        auditLog: { create: async (args: any) => { captured = args; return {}; } },
      } as any;
      const svc = new AuditService(prisma, noopLogger);
      svc.record({ actorId: 'u1', action: 'a', outcome: 'success' });
      await new Promise(r => setTimeout(r, 0));
      assert.equal('companyId' in captured.data, false);
    });

    it('includes companyId when provided', async () => {
      let captured: any = null;
      const prisma = {
        auditLog: { create: async (args: any) => { captured = args; return {}; } },
      } as any;
      const svc = new AuditService(prisma, noopLogger);
      svc.record({ actorId: 'u1', companyId: 'co-1', action: 'a', outcome: 'success' });
      await new Promise(r => setTimeout(r, 0));
      assert.equal(captured.data.companyId, 'co-1');
    });
  });

  describe('query()', () => {
    const now = new Date();
    const fakeLog = {
      id: 'log-1', actorId: 'u1', companyId: 'co-1',
      action: 'permission.set', outcome: 'success',
      metadata: { toolId: 'x' }, createdAt: now,
    };

    it('maps DB rows to AuditLogView with ISO date', async () => {
      const prisma = {
        auditLog: { findMany: async () => [fakeLog] },
      } as any;
      const svc = new AuditService(prisma, noopLogger);
      const results = await svc.query({ companyId: 'co-1' });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.id, 'log-1');
      assert.equal(results[0]!.createdAt, now.toISOString());
    });

    it('caps limit at 500', async () => {
      let capturedTake = 0;
      const prisma = {
        auditLog: { findMany: async (args: any) => { capturedTake = args.take; return []; } },
      } as any;
      const svc = new AuditService(prisma, noopLogger);
      await svc.query({ companyId: 'co-1', limit: 9999 });
      assert.equal(capturedTake, 500);
    });

    it('defaults limit to 100', async () => {
      let capturedTake = 0;
      const prisma = {
        auditLog: { findMany: async (args: any) => { capturedTake = args.take; return []; } },
      } as any;
      const svc = new AuditService(prisma, noopLogger);
      await svc.query({ companyId: 'co-1' });
      assert.equal(capturedTake, 100);
    });
  });

  describe('required checkpoints', () => {
    it('persists pending before work and settles the same row', async () => {
      const writes: any[] = [];
      const updates: any[] = [];
      const prisma = {
        auditLog: {
          create: async (args: any) => { writes.push(args); return { id: 'audit-1' }; },
          update: async (args: any) => { updates.push(args); return {}; },
        },
      } as any;
      const svc = new AuditService(prisma, noopLogger);

      const id = await svc.beginRequired({
        actorId: 'u1', companyId: 'co-1', action: 'followups.test', metadata: { count: 2 },
      });
      assert.equal(id, 'audit-1');
      assert.equal(writes[0].data.outcome, 'pending');

      svc.settle({ checkpointId: id, outcome: 'success', metadata: { count: 2 } });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(updates[0].where.id, 'audit-1');
      assert.equal(updates[0].data.outcome, 'success');
    });

    it('rejects admission when the audit row cannot be persisted', async () => {
      const prisma = {
        auditLog: { create: async () => { throw new Error('db down'); } },
      } as any;
      const svc = new AuditService(prisma, noopLogger);
      await assert.rejects(() => svc.beginRequired({ actorId: 'u1', action: 'followups.test' }));
    });

    it('leaves a pending checkpoint instead of throwing after settlement failure', async () => {
      const prisma = {
        auditLog: { update: async () => { throw new Error('db down'); } },
      } as any;
      const svc = new AuditService(prisma, noopLogger);
      assert.doesNotThrow(() => svc.settle({ checkpointId: 'audit-1', outcome: 'failure' }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    it('reuses a pending checkpoint for the same idempotent effect', async () => {
      let creates = 0;
      const tx = {
        $queryRaw: async () => [{ lock_result: '' }],
        auditLog: {
          findFirst: async () => ({ id: 'audit-existing' }),
          create: async () => { creates += 1; return { id: 'audit-new' }; },
        },
      };
      const prisma = {
        $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
      } as any;
      const svc = new AuditService(prisma, noopLogger);
      const id = await svc.beginRequired({
        actorId: 'system',
        companyId: 'co-1',
        action: 'followups.digest.delivered',
        checkpointKey: 'digest-1:slot-1',
      });
      assert.equal(id, 'audit-existing');
      assert.equal(creates, 0);
    });

    it('serializes concurrent admission for one checkpoint key', async () => {
      let pendingId: string | null = null;
      let creates = 0;
      let lockCalls = 0;
      let lockTail = Promise.resolve();

      const prisma = {
        $transaction: async (run: (client: any) => Promise<string>) => {
          const previousLock = lockTail;
          let releaseLock!: () => void;
          lockTail = new Promise<void>(resolve => { releaseLock = resolve; });
          const tx = {
            $queryRaw: async () => {
              lockCalls += 1;
              await previousLock;
              return [{ lock_result: '' }];
            },
            auditLog: {
              findFirst: async () => pendingId ? { id: pendingId } : null,
              create: async () => {
                creates += 1;
                await new Promise(resolve => setTimeout(resolve, 0));
                pendingId = `audit-${creates}`;
                return { id: pendingId };
              },
            },
          };
          try {
            return await run(tx);
          } finally {
            releaseLock();
          }
        },
      } as any;
      const svc = new AuditService(prisma, noopLogger);
      const input = {
        actorId: 'system', companyId: 'co-1', action: 'followups.digest.delivered',
        checkpointKey: 'digest-1:slot-1',
      };

      const ids = await Promise.all([svc.beginRequired(input), svc.beginRequired(input)]);

      assert.deepEqual(ids, ['audit-1', 'audit-1']);
      assert.equal(creates, 1);
      assert.equal(lockCalls, 2);
    });
  });
});

// ─── TokenUsageService ────────────────────────────────────────────────────────

describe('TokenUsageService', () => {
  const baseInput = {
    companyId: 'co-1', userId: 'u-1', agentTarget: 'planner',
    modelId: 'gpt-4o', provider: 'openai', channel: 'lark',
  };

  describe('record()', () => {
    it('calls prisma.aiTokenUsage.create when tokens > 0', async () => {
      let called = false;
      const prisma = {
        aiTokenUsage: { create: async () => { called = true; return {}; } },
      } as any;
      const svc = new TokenUsageService(prisma, noopLogger);
      svc.record({ ...baseInput, actualInputTokens: 100, actualOutputTokens: 50 });
      await new Promise(r => setTimeout(r, 0));
      assert.equal(called, true);
    });

    it('skips create when both token counts are 0', async () => {
      let called = false;
      const prisma = {
        aiTokenUsage: { create: async () => { called = true; return {}; } },
      } as any;
      const svc = new TokenUsageService(prisma, noopLogger);
      svc.record({ ...baseInput, actualInputTokens: 0, actualOutputTokens: 0 });
      await new Promise(r => setTimeout(r, 0));
      assert.equal(called, false);
    });

    it('skips create when both counts are undefined', async () => {
      let called = false;
      const prisma = {
        aiTokenUsage: { create: async () => { called = true; return {}; } },
      } as any;
      const svc = new TokenUsageService(prisma, noopLogger);
      svc.record({ ...baseInput });
      await new Promise(r => setTimeout(r, 0));
      assert.equal(called, false);
    });

    it('records when only inputTokens is non-zero', async () => {
      let called = false;
      const prisma = {
        aiTokenUsage: { create: async () => { called = true; return {}; } },
      } as any;
      const svc = new TokenUsageService(prisma, noopLogger);
      svc.record({ ...baseInput, actualInputTokens: 200 });
      await new Promise(r => setTimeout(r, 0));
      assert.equal(called, true);
    });

    it('swallows DB errors without throwing', async () => {
      const prisma = {
        aiTokenUsage: { create: async () => { throw new Error('db down'); } },
      } as any;
      const svc = new TokenUsageService(prisma, noopLogger);
      svc.record({ ...baseInput, actualInputTokens: 10, actualOutputTokens: 5 });
      await new Promise(r => setTimeout(r, 0));
    });

    it('defaults wasCompacted=false and mode=high', async () => {
      let captured: any = null;
      const prisma = {
        aiTokenUsage: { create: async (args: any) => { captured = args; return {}; } },
      } as any;
      const svc = new TokenUsageService(prisma, noopLogger);
      svc.record({ ...baseInput, actualInputTokens: 10 });
      await new Promise(r => setTimeout(r, 0));
      assert.equal(captured.data.wasCompacted, false);
      assert.equal(captured.data.mode, 'high');
    });
  });

  describe('summariseByModel()', () => {
    it('maps groupBy result to TokenUsageSummary[]', async () => {
      const from = new Date('2025-01-01');
      const to   = new Date('2025-01-31');
      const prisma = {
        aiTokenUsage: {
          groupBy: async () => [
            { modelId: 'gpt-4o', _sum: { actualInputTokens: 1000, actualOutputTokens: 500 }, _count: { id: 3 } },
          ],
        },
      } as any;
      const svc = new TokenUsageService(prisma, noopLogger);
      const result = await svc.summariseByModel({ companyId: 'co-1', from, to });
      assert.equal(result.length, 1);
      assert.equal(result[0]!.modelId, 'gpt-4o');
      assert.equal(result[0]!.totalInputTokens, 1000);
      assert.equal(result[0]!.totalOutputTokens, 500);
      assert.equal(result[0]!.callCount, 3);
    });

    it('handles null _sum values as 0', async () => {
      const prisma = {
        aiTokenUsage: {
          groupBy: async () => [
            { modelId: 'gpt-4o-mini', _sum: { actualInputTokens: null, actualOutputTokens: null }, _count: { id: 1 } },
          ],
        },
      } as any;
      const svc = new TokenUsageService(prisma, noopLogger);
      const result = await svc.summariseByModel({ companyId: 'co-1', from: new Date(), to: new Date() });
      assert.equal(result[0]!.totalInputTokens, 0);
      assert.equal(result[0]!.totalOutputTokens, 0);
    });
  });
});

// ─── ExecutionQueryService ────────────────────────────────────────────────────

describe('ExecutionQueryService', () => {
  const now = new Date('2025-01-01T10:00:00Z');
  const later = new Date('2025-01-01T10:05:00Z');

  const fakeRun = {
    id: 'run-1', status: 'success', channel: 'lark',
    entrypoint: 'lark-webhook', latestSummary: 'Done',
    errorCode: null, errorMessage: null,
    startedAt: now, finishedAt: later,
    userId: 'u-1', threadId: 'th-1', chatId: 'ch-1', agentTarget: 'supervisor',
  };

  const fakeEvent = {
    id: 'ev-1', sequence: 1, phase: 'planning', eventType: 'plan_created',
    actorType: 'planner', actorKey: null, title: 'Plan created',
    summary: 'Two steps', status: 'success',
    payload: { steps: 2, prompt: 'secret system prompt', toolCall: { name: 'x' } },
    createdAt: now,
  };

  const queryRepoDefaults = {
    aggregateRunStats: async (runIds: string[]) =>
      new Map(runIds.map((id) => [id, { turns: 0, models: [] }])),
    resolveUsers: async () => new Map(),
  };

  describe('listRuns()', () => {
    it('returns RunSummaryDto array with computed durationMs', async () => {
      const repo = {
        ...queryRepoDefaults,
        listByCompany: async () => [fakeRun],
        findById:      async () => fakeRun,
        listEvents:    async () => [],
      } as any;
      const svc = new ExecutionQueryService({ repo, logger: noopLogger });
      const runs = await svc.listRuns({ companyId: 'co-1' });
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.id, 'run-1');
      assert.equal(runs[0]!.durationMs, 300_000);
      assert.equal(runs[0]!.startedAt, now.toISOString());
      assert.equal(runs[0]!.finishedAt, later.toISOString());
    });

    it('durationMs is null when finishedAt is null', async () => {
      const repo = {
        ...queryRepoDefaults,
        listByCompany: async () => [{ ...fakeRun, finishedAt: null }],
      } as any;
      const svc = new ExecutionQueryService({ repo, logger: noopLogger });
      const runs = await svc.listRuns({ companyId: 'co-1' });
      assert.equal(runs[0]!.durationMs, null);
    });

    it('caps limit at 200', async () => {
      let capturedLimit = 0;
      const repo = {
        ...queryRepoDefaults,
        listByCompany: async (args: any) => { capturedLimit = args.limit; return []; },
      } as any;
      const svc = new ExecutionQueryService({ repo, logger: noopLogger });
      await svc.listRuns({ companyId: 'co-1', limit: 9999 });
      assert.equal(capturedLimit, 200);
    });
  });

  describe('getRun()', () => {
    it('returns null when run not found', async () => {
      const repo = { findById: async () => null } as any;
      const svc = new ExecutionQueryService({ repo, logger: noopLogger });
      const result = await svc.getRun({ id: 'x', companyId: 'co-1' });
      assert.equal(result, null);
    });

    it('includes userId, threadId, chatId, agentTarget', async () => {
      const repo = { ...queryRepoDefaults, findById: async () => fakeRun } as any;
      const svc = new ExecutionQueryService({ repo, logger: noopLogger });
      const result = await svc.getRun({ id: 'run-1', companyId: 'co-1' });
      assert.equal(result!.userId, 'u-1');
      assert.equal(result!.threadId, 'th-1');
      assert.equal(result!.agentTarget, 'supervisor');
    });
  });

  describe('getEvents() — payload redaction', () => {
    it('a caller with raw execution-data access sees the full payload including prompt and toolCall', async () => {
      const repo = { listEvents: async () => [fakeEvent] } as any;
      const svc = new ExecutionQueryService({ repo, logger: noopLogger });
      const events = await svc.getEvents({ executionId: 'run-1', companyId: 'co-1', canViewRawExecutionData: true });
      const payload = events[0]!.payload as any;
      assert.equal(payload.prompt, 'secret system prompt');
      assert.ok('toolCall' in payload);
    });

    it('a caller without raw execution-data access has prompt and toolCall redacted', async () => {
      const repo = { listEvents: async () => [fakeEvent] } as any;
      const svc = new ExecutionQueryService({ repo, logger: noopLogger });
      const events = await svc.getEvents({ executionId: 'run-1', companyId: 'co-1', canViewRawExecutionData: false });
      const payload = events[0]!.payload as any;
      assert.equal('prompt' in payload, false);
      assert.equal('toolCall' in payload, false);
      assert.equal(payload.steps, 2);
    });

    it('keeps non-sensitive payload fields for all roles', async () => {
      const repo = { listEvents: async () => [fakeEvent] } as any;
      const svc = new ExecutionQueryService({ repo, logger: noopLogger });
      const events = await svc.getEvents({ executionId: 'run-1', companyId: 'co-1', canViewRawExecutionData: false });
      assert.equal((events[0]!.payload as any).steps, 2);
    });

    it('null payload passes through unchanged', async () => {
      const nullPayloadEvent = { ...fakeEvent, payload: null };
      const repo = { listEvents: async () => [nullPayloadEvent] } as any;
      const svc = new ExecutionQueryService({ repo, logger: noopLogger });
      const events = await svc.getEvents({ executionId: 'run-1', companyId: 'co-1', canViewRawExecutionData: false });
      assert.equal(events[0]!.payload, null);
    });

    it('caps limit at 1000', async () => {
      let capturedLimit = 0;
      const repo = {
        listEvents: async (args: any) => { capturedLimit = args.limit; return []; },
      } as any;
      const svc = new ExecutionQueryService({ repo, logger: noopLogger });
      await svc.getEvents({ executionId: 'run-1', companyId: 'co-1', canViewRawExecutionData: false, limit: 9999 });
      assert.equal(capturedLimit, 1000);
    });

    it('maps event to EventDto with ISO createdAt', async () => {
      const repo = { listEvents: async () => [fakeEvent] } as any;
      const svc = new ExecutionQueryService({ repo, logger: noopLogger });
      const events = await svc.getEvents({ executionId: 'run-1', companyId: 'co-1', canViewRawExecutionData: true });
      assert.equal(events[0]!.id, 'ev-1');
      assert.equal(events[0]!.sequence, 1);
      assert.equal(events[0]!.createdAt, now.toISOString());
    });
  });
});

describe('sparklineHeights', () => {
  /*
   * The bug this exists to stop: a member with nothing in the window was sent
   * a flat 6 for every day, which drew fourteen full-height bars under a card
   * reading "$0.00" and "0 tasks".
   */
  it('reports nothing for a window with no spend', () => {
    assert.deepEqual(sparklineHeights([0, 0, 0, 0]), [0, 0, 0, 0]);
  });

  it('scales to the tallest day', () => {
    assert.deepEqual(sparklineHeights([0, 5, 10]), [0, 50, 100]);
  });

  /*
   * A quiet day inside a busy window is still a quiet day. The old floor of 6
   * could not be told apart from a real small day, which is the same lie in
   * miniature.
   */
  it('leaves an empty day empty even when other days are busy', () => {
    assert.deepEqual(sparklineHeights([100, 0, 50]), [100, 0, 50]);
  });

  it('handles an empty series without producing NaN', () => {
    assert.deepEqual(sparklineHeights([]), []);
  });
});
