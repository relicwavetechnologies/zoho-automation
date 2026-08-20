import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionResumeService } from '../../src/application/connections/connection-resume.ts';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

const CLAIM = {
  intentId: 'intent-1',
  companyId: 'company-1',
  userId: 'user-1',
  connectionId: 'connection-1',
  larkOpenId: 'user-1',
  larkTenantKey: 'web',
  chatId: 'web-thread-1',
  chatType: 'web',
  originalMessageId: 'run-1',
  replyInThread: false,
  originalRequest: 'Put the Menhood data in a Google Sheet',
  requestedToolIds: ['googleSheets'],
  correlationId: 'correlation-1',
  continuationIdempotencyKey: 'key-1',
};

function build(overrides: {
  claim?: unknown;
  connections?: readonly unknown[];
  onFinish?: (...args: any[]) => void;
  onWithdraw?: (input: any) => void;
} = {}) {
  const service = new ConnectionResumeService({
    intentRepo: {
      claimContinuation: async () => ({
        ok: true,
        value: 'claim' in overrides ? overrides.claim : CLAIM,
      }),
      finishContinuation: async (...args: any[]) => {
        overrides.onFinish?.(...args);
        return { ok: true, value: undefined };
      },
    } as any,
    connectionRepo: {
      listAccessibleGoogleConnections: async () => ({
        ok: true,
        value: overrides.connections ?? [{
          connectionId: 'connection-1',
          ownerType: 'user',
          ownerUserId: 'user-1',
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        }],
      }),
    } as any,
    decisions: {
      withdraw: async (input: any) => {
        overrides.onWithdraw?.(input);
        return 1;
      },
    },
    logger: noopLogger,
  });
  return service;
}

const RESUME = { askId: 'intent-1', companyId: 'company-1', userId: 'user-1' };

describe('resuming a run that waited for a connection', () => {
  it('reports only the scope groups Google actually returned', async () => {
    const outcome = await build().resume(RESUME);

    assert.equal(outcome.status, 'connected');
    assert.equal(outcome.status === 'connected' && outcome.provider, 'google_workspace');
    /* Three groups, because `googleSheets` needs Drive alongside Sheets. Only
       the ones Google returned are named; the rest read as not granted. */
    assert.deepEqual(
      outcome.status === 'connected' ? outcome.grantedScopeGroups : null,
      ['spreadsheets', 'none returned', 'spreadsheets'],
    );
  });

  it('names a requested group that was declined rather than assuming it', async () => {
    /* A member can approve part of a consent screen. A run told it received
       everything it asked for will confidently do the wrong thing next. */
    const outcome = await build({
      connections: [{
        connectionId: 'connection-1',
        ownerType: 'user',
        ownerUserId: 'user-1',
        scopes: [],
      }],
    }).resume(RESUME);

    assert.deepEqual(
      outcome.status === 'connected' ? outcome.grantedScopeGroups : null,
      ['none returned', 'none returned', 'none returned'],
    );
  });

  it('settles the intent and takes the Connect card back', async () => {
    const finished: any[] = [];
    const withdrawn: any[] = [];
    await build({
      onFinish: (...args) => finished.push(args),
      onWithdraw: input => withdrawn.push(input),
    }).resume(RESUME);

    assert.deepEqual(finished, [['intent-1', { runId: 'connection-resume:intent-1' }]]);
    assert.deepEqual(withdrawn, [
      { idempotencyKey: 'intent-1', reason: 'google_connected' },
    ]);
  });

  it('reads a second resume as nothing left to pick up', async () => {
    /* `claimContinuation` is the atomic claim. A duplicate answer must not tell
       one run two different stories about the same authorization. */
    const outcome = await build({ claim: null }).resume(RESUME);
    assert.equal(outcome.status, 'not_pending');
  });

  it('refuses an ask that belongs to another member', async () => {
    const withdrawn: any[] = [];
    const outcome = await build({ onWithdraw: input => withdrawn.push(input) })
      .resume({ askId: 'intent-1', companyId: 'company-2', userId: 'user-9' });

    assert.equal(outcome.status, 'not_yours');
    assert.equal(withdrawn.length, 1, 'the intent is released, not left running');
  });

  it('reports a connection it can no longer read instead of inventing scopes', async () => {
    const outcome = await build({ connections: [] }).resume(RESUME);
    assert.equal(outcome.status, 'connection_missing');
  });

  it('does not require a decision module', async () => {
    /* Lark delivers its own card rather than a decision row. */
    const service = new ConnectionResumeService({
      intentRepo: {
        claimContinuation: async () => ({ ok: true, value: CLAIM }),
        finishContinuation: async () => ({ ok: true, value: undefined }),
      } as any,
      connectionRepo: {
        listAccessibleGoogleConnections: async () => ({
          ok: true,
          value: [{
            connectionId: 'connection-1',
            ownerType: 'user',
            ownerUserId: 'user-1',
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          }],
        }),
      } as any,
      logger: noopLogger,
    });

    assert.equal((await service.resume(RESUME)).status, 'connected');
  });
});
