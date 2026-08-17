import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ExecutionRunLifecycle,
  type ExecutionRunLifecycleStore,
} from '../../src/application/observability/execution-run-lifecycle';

const logger = {
  child() { return this; },
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

describe('ExecutionRunLifecycle', () => {
  it('owns admission metadata and first-writer terminal state', async () => {
    const admissions: unknown[] = [];
    const completions: unknown[] = [];
    const failures: unknown[] = [];
    const store: ExecutionRunLifecycleStore = {
      findOrCreateByRequestId: async input => {
        admissions.push(input);
        return 'execution-1';
      },
      completeIfRunning: async (...input) => {
        completions.push(input);
        return true;
      },
      failIfRunning: async (...input) => {
        failures.push(input);
        return false;
      },
    };
    const lifecycle = new ExecutionRunLifecycle(store, logger);

    assert.equal(await lifecycle.admit({
      runId: 'run-1',
      companyId: 'company-1',
      userId: 'user-1',
      channel: 'web',
      entrypoint: 'pi',
      threadId: 'thread-1',
      chatId: 'chat-1',
      messageId: 'message-1',
    }), 'execution-1');
    assert.equal(await lifecycle.complete('execution-1', 'done'), true);
    assert.equal(await lifecycle.fail('execution-1', 'late_error', 'too late'), false);

    assert.deepEqual(admissions, [{
      requestId: 'run-1',
      companyId: 'company-1',
      userId: 'user-1',
      channel: 'web',
      entrypoint: 'pi',
      threadId: 'thread-1',
      chatId: 'chat-1',
      messageId: 'message-1',
    }]);
    assert.deepEqual(completions, [['execution-1', 'done']]);
    assert.deepEqual(failures, [['execution-1', 'late_error', 'too late']]);
  });
});
