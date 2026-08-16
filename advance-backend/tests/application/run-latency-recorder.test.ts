import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RunLatencyRecorder,
  type RunLatencySpanStore,
} from '../../src/application/observability/run-latency-recorder';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

describe('RunLatencyRecorder', () => {
  it('owns clocks, causal nesting, persistence, and flush idempotency', async () => {
    let now = 0;
    let nextId = 0;
    let insertCalls = 0;
    const persisted: any[] = [];
    const lookups: any[] = [];
    const store: RunLatencySpanStore = {
      findOwnedIdByRequestId: async input => {
        lookups.push(input);
        return 'execution-1';
      },
      insertSpans: async input => {
        insertCalls += 1;
        persisted.push(...input);
      },
    };
    const recorder = new RunLatencyRecorder(store, noopLogger, () => now, () => `span-${++nextId}`);
    const trace = recorder.trace({
      runId: 'run-1',
      companyId: 'company-1',
      userId: 'user-1',
      source: 'test',
    });

    await trace.measure({
      name: 'root',
      category: 'runtime',
      attributes: { channel: 'lark', prompt: 'do not persist me' },
    }, async () => {
      now = 10;
      await trace.measure({ name: 'child', category: 'persistence' }, async () => {
        now = 40;
      });
      now = 100;
    });
    await trace.flush();
    await trace.flush();

    assert.deepEqual(lookups, [{ requestId: 'run-1', companyId: 'company-1', userId: 'user-1' }]);
    assert.equal(insertCalls, 1, 'one trace flush must be one persistence round trip');
    assert.equal(persisted.length, 2);
    const child = persisted.find(span => span.name === 'child');
    const root = persisted.find(span => span.name === 'root');
    assert.equal(child.parentSpanId, root.spanId);
    assert.equal(child.durationMs, 30);
    assert.equal(root.durationMs, 100);
    assert.deepEqual(root.attributes, { channel: 'lark' });
  });

  it('records failures without leaking error messages', async () => {
    let now = 10;
    const persisted: any[] = [];
    const recorder = new RunLatencyRecorder({
      findOwnedIdByRequestId: async () => 'execution-1',
      insertSpans: async input => { persisted.push(...input); },
    }, noopLogger, () => now, () => 'span-error');
    const trace = recorder.trace({ runId: 'run-1', companyId: 'co-1', userId: 'u-1', source: 'test' });

    await assert.rejects(trace.measure({ name: 'broken', category: 'gateway' }, async () => {
      now = 25;
      throw new TypeError('secret provider response');
    }), /secret provider response/);
    await trace.flush();

    assert.equal(persisted[0].status, 'error');
    assert.deepEqual(persisted[0].attributes, { errorType: 'TypeError' });
    assert.equal(JSON.stringify(persisted).includes('secret provider response'), false);
  });
});
