import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleConnectionContinuationWorker } from '../../src/application/connections/google-connection-continuation';
import type { RunOrigin } from '../../src/application/connections/run-origin.store';

const noopLogger = {
  child: function() { return this; },
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

const intent = {
  intentId: 'intent-web-1',
  provider: 'google_workspace' as const,
  companyId: 'company-1',
  userId: 'user-1',
  larkOpenId: 'user-1',
  larkTenantKey: 'web',
  chatId: 'web-thread-1',
  chatType: 'web',
  originalMessageId: 'web-run-1',
  replyInThread: false,
  originalRequest: 'Export the Sheet',
  requestedToolIds: ['googleSheets'],
  connectionId: 'connection-1',
  correlationId: 'correlation-1',
  continuationIdempotencyKey: 'google-oauth-continuation:correlation-1',
};

const origin: RunOrigin = {
  version: 1,
  channel: 'web',
  companyId: 'company-1',
  userId: 'user-1',
  originalRequest: 'Export the Sheet',
  conversationKey: 'web-thread-1',
  web: {
    threadId: 'web-thread-1',
    userExternalId: 'user-1',
    sessionId: 'session-1',
    timestamp: '2026-08-21T00:00:00.000Z',
  },
};

describe('web Google continuation', () => {
  it('uses the existing continuation queue and resumes through the web runtime', async () => {
    let webInput: any;
    let finishInput: any;
    const worker = new GoogleConnectionContinuationWorker({
      redisUrl: 'redis://unused',
      queue: { enqueue: async () => '' },
      intentRepo: {
        findPendingContinuation: async () => ({ ok: true, value: intent }),
        claimContinuation: async () => ({ ok: true, value: intent }),
        finishContinuation: async (...args: any[]) => {
          finishInput = args;
          return { ok: true, value: undefined };
        },
        listPendingContinuationIds: async () => ({ ok: true, value: [] }),
      } as any,
      identityRepo: {
        resolveByUserId: async () => ({
          ok: true,
          value: {
            companyId: 'company-1',
            userId: 'user-1',
            aiRole: 'MEMBER',
            channel: 'web',
            email: 'member@example.com',
            activeDepartmentId: 'department-1',
          },
        }),
      } as any,
      connectionRepo: {
        listAccessibleGoogleConnections: async () => ({
          ok: true,
          value: [{
            connectionId: 'connection-1',
            ownerType: 'user',
            ownerUserId: 'user-1',
          }],
        }),
      } as any,
      runPi: async () => {
        throw new Error('web continuation must not use the Lark delivery path');
      },
      runWeb: async input => {
        webInput = input;
        return 'continued';
      },
      runOrigins: {
        recall: async () => origin,
      },
      channelAdapter: {} as any,
      logger: noopLogger,
    });

    await worker.process({ id: 'job-web-1', data: { intentId: intent.intentId } });

    assert.equal(webInput.threadId, 'web-thread-1');
    assert.equal(webInput.sessionId, 'session-1');
    assert.equal(webInput.runContext.channel, 'web');
    assert.equal(webInput.runContext.departmentId, 'department-1');
    assert.equal(webInput.incomingText, intent.originalRequest);
    assert.deepEqual(finishInput, [
      intent.intentId,
      { runId: intent.continuationIdempotencyKey },
    ]);
  });
});
