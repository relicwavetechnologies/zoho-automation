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
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
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
    assert.match(webInput.incomingText, /DIVO CONTINUATION CONTEXT/);
    assert.match(webInput.incomingText, /group 1: spreadsheets/);
    assert.match(webInput.incomingText, /group 2: none returned/);
    assert.match(webInput.incomingText, /Export the Sheet/);
    assert.deepEqual(finishInput, [
      intent.intentId,
      { runId: intent.continuationIdempotencyKey },
    ]);
  });

  it('closes the Connect card once the connection exists', async () => {
    /* The card offers to connect an account that is now connected. Its option
       opens a URL and settles nothing, so pressing it never resolved the row —
       something has to take the question back, and OAuth completing is that
       something. Keyed by the intent id, which is what the web courier used as
       the decision's idempotency key. */
    const withdrawn: any[] = [];
    await runWorker({
      decisions: {
        withdraw: async (input: any) => { withdrawn.push(input); return 1; },
      },
    });
    assert.deepEqual(withdrawn, [
      { idempotencyKey: intent.intentId, reason: 'google_connected' },
    ]);
  });

  it('closes the card even when the run could not be delivered', async () => {
    /* Deliberate. The member connected either way, so a button asking them to
       connect is wrong whatever happened to the run afterwards. */
    const withdrawn: any[] = [];
    await runWorker({
      runWeb: async () => null,
      decisions: {
        withdraw: async (input: any) => { withdrawn.push(input); return 1; },
      },
    });
    assert.equal(withdrawn.length, 1);
  });

  it('continues without a decision service, which Lark runs have no use for', async () => {
    /* Lark delivers its own card rather than a decision row. The worker must
       not require one, and every test predating the web surface builds it
       without. */
    let finished: any;
    await runWorker({
      intentRepoOverrides: {
        finishContinuation: async (...args: any[]) => { finished = args; return { ok: true, value: undefined }; },
      },
    });
    assert.deepEqual(finished, [intent.intentId, { runId: intent.continuationIdempotencyKey }]);
  });
});

/** The worker from the test above, with only the parts a case cares about swapped. */
async function runWorker(overrides: {
  runWeb?: (input: any) => Promise<string | null>;
  decisions?: { withdraw: (input: any) => Promise<number> };
  intentRepoOverrides?: Record<string, unknown>;
} = {}): Promise<void> {
  const worker = new GoogleConnectionContinuationWorker({
    redisUrl: 'redis://unused',
    queue: { enqueue: async () => '' },
    intentRepo: {
      findPendingContinuation: async () => ({ ok: true, value: intent }),
      claimContinuation: async () => ({ ok: true, value: intent }),
      finishContinuation: async () => ({ ok: true, value: undefined }),
      listPendingContinuationIds: async () => ({ ok: true, value: [] }),
      ...(overrides.intentRepoOverrides ?? {}),
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
          scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        }],
      }),
    } as any,
    runPi: async () => { throw new Error('web continuation must not use the Lark delivery path'); },
    runWeb: overrides.runWeb ?? (async () => 'continued'),
    runOrigins: { recall: async () => origin },
    channelAdapter: {} as any,
    logger: noopLogger,
    ...(overrides.decisions ? { decisions: overrides.decisions } : {}),
  });
  await worker.process({ id: 'job-web-1', data: { intentId: intent.intentId } });
}
