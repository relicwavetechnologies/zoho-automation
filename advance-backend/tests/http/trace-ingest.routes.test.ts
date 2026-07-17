import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ingestTraceBatch } from '../../src/http/desktop/trace-ingest.routes';
import { ExecutionRepository } from '../../src/infrastructure/persistence/execution.repository';
import type { TokenUsageService } from '../../src/application/observability/token-usage.service';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

function harness() {
  const tokenWrites: unknown[] = [];
  const events: unknown[] = [];
  const completions: unknown[] = [];
  const failures: unknown[] = [];
  const runs = {
    findOrCreateByRequestId: async () => 'execution-1',
    appendEvent: async (event: unknown) => { events.push(event); },
    appendStepResult: async () => {},
    complete: async (...args: unknown[]) => { completions.push(args); },
    fail: async (...args: unknown[]) => { failures.push(args); },
  } as unknown as ExecutionRepository;
  const tokens = {
    recordForRun: async (usage: unknown) => { tokenWrites.push(usage); },
  } as unknown as TokenUsageService;
  return { runs, tokens, tokenWrites, events, completions, failures };
}

describe('desktop trace usage ownership', () => {
  it('keeps the desktop model timeline but defers token persistence to the proxy', async () => {
    const test = harness();
    const result = await ingestTraceBatch(
      test.runs,
      test.tokens,
      noopLogger,
      { companyId: 'company-1', userId: 'user-1' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        usageAuthority: 'proxy',
        events: [{
          kind: 'model',
          seq: 2,
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          usage: { input: 10, output: 5 },
        }],
      },
    );

    assert.equal(result.executionId, 'execution-1');
    assert.equal(test.events.length, 1);
    assert.equal(test.tokenWrites.length, 0);
  });

  it('records desktop token usage when no authoritative proxy owns it', async () => {
    const test = harness();
    await ingestTraceBatch(
      test.runs,
      test.tokens,
      noopLogger,
      { companyId: 'company-1', userId: 'user-1' },
      {
        runId: 'run-direct',
        usageAuthority: 'desktop',
        events: [{
          kind: 'model',
          seq: 1,
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          usage: { input: 10, output: 5 },
        }],
      },
    );

    assert.equal(test.tokenWrites.length, 1);
  });
});

describe('execution run correlation ownership', () => {
  it('does not let an authenticated principal claim another principal\'s run id', async () => {
    const repository = new ExecutionRepository({
      executionRun: {
        findUnique: async () => ({
          id: 'execution-existing',
          companyId: 'company-other',
          userId: 'user-other',
        }),
      },
    } as never);

    await assert.rejects(
      repository.findOrCreateByRequestId({
        requestId: 'run-collision',
        companyId: 'company-1',
        userId: 'user-1',
        channel: 'desktop',
        entrypoint: 'pi',
      }),
      /different authenticated principal/,
    );
  });
});

describe('desktop trace terminal status', () => {
  it('fails rather than completes a run when Pi emits an error terminal event', async () => {
    const test = harness();

    await ingestTraceBatch(
      test.runs,
      test.tokens,
      noopLogger,
      { companyId: 'company-1', userId: 'user-1' },
      {
        runId: 'run-failed',
        usageAuthority: 'proxy',
        events: [{
          kind: 'run_end',
          seq: 4,
          status: 'error',
          summary: 'Assistant error: request_too_large (HTTP 413, payload_too_large)',
        }],
      },
    );

    assert.deepEqual(test.completions, []);
    assert.deepEqual(test.failures, [[
      'execution-1',
      'pi_run_error',
      'Assistant error: request_too_large (HTTP 413, payload_too_large)',
    ]]);
    assert.deepEqual(test.events, [{
      executionId: 'execution-1',
      sequence: 4,
      phase: 'run',
      eventType: 'run_end',
      actorType: 'engine',
      title: 'run_end',
      summary: 'Assistant error: request_too_large (HTTP 413, payload_too_large)',
      status: 'error',
    }]);
  });

  it('captures a bounded learning packet only for a successful terminal run', async () => {
    const test = harness();
    const captured: unknown[] = [];
    const personaLearning = {
      captureCompletedManagerRun: async (input: unknown) => { captured.push(input); },
    } as any;

    await ingestTraceBatch(
      test.runs,
      test.tokens,
      noopLogger,
      { companyId: 'company-1', userId: 'manager-1' },
      {
        runId: 'run-learning',
        threadId: 'thread-1',
        usageAuthority: 'proxy',
        events: [
          {
            kind: 'learning_context',
            seq: 1,
            userMessages: ['Always use bullets in weekly reports.'],
            assistantResponse: 'Here is the weekly report in bullets.',
            toolSummary: [{ toolName: 'googleSheets', isError: false }],
          },
          { kind: 'run_end', seq: 2, status: 'ok', summary: 'Weekly report delivered.' },
        ],
      },
      personaLearning,
    );

    assert.deepEqual(captured, [{
      executionRunId: 'execution-1',
      companyId: 'company-1',
      managerId: 'manager-1',
      threadId: 'thread-1',
      runSummary: 'Weekly report delivered.',
      context: {
        userMessages: ['Always use bullets in weekly reports.'],
        assistantResponse: 'Here is the weekly report in bullets.',
      },
      tools: [{ toolName: 'googleSheets', isError: false }],
    }]);
    assert.deepEqual(test.events[0], {
      executionId: 'execution-1',
      sequence: 1,
      phase: 'learning',
      eventType: 'learning_context',
      actorType: 'engine',
      title: 'Manager learning context captured',
      status: 'ok',
      payload: { userMessageCount: 1, hasAssistantResponse: true, toolCount: 1 },
    });
  });

  it('does not capture learning context for a failed terminal run', async () => {
    const test = harness();
    const captured: unknown[] = [];
    const personaLearning = {
      captureCompletedManagerRun: async (input: unknown) => { captured.push(input); },
    } as any;

    await ingestTraceBatch(
      test.runs,
      test.tokens,
      noopLogger,
      { companyId: 'company-1', userId: 'manager-1' },
      {
        runId: 'run-failed-learning',
        threadId: 'thread-1',
        usageAuthority: 'proxy',
        events: [
          { kind: 'learning_context', seq: 1, userMessages: ['Remember this'], toolSummary: [] },
          { kind: 'run_end', seq: 2, status: 'error', summary: 'Network failure' },
        ],
      },
      personaLearning,
    );

    assert.deepEqual(captured, []);
  });
});
