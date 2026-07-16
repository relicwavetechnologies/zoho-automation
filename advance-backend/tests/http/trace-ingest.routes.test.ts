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
  const runs = {
    findOrCreateByRequestId: async () => 'execution-1',
    appendEvent: async (event: unknown) => { events.push(event); },
    appendStepResult: async () => {},
    complete: async () => {},
    fail: async () => {},
  } as unknown as ExecutionRepository;
  const tokens = {
    recordForRun: async (usage: unknown) => { tokenWrites.push(usage); },
  } as unknown as TokenUsageService;
  return { runs, tokens, tokenWrites, events };
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
