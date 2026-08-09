import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMailBriefOnboarding } from '../../src/application/mail-ops/mail-brief-onboarding.ts';
import { ok } from '../../src/shared/result.ts';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

describe('mail brief onboarding', () => {
  it('creates a watched mailbox, creates a due brief, and wakes mail ops', async () => {
    const dueAt = new Date('2026-08-10T01:23:00.000Z');
    const calls: any[] = [];
    let wakes = 0;
    const start = createMailBriefOnboarding({
      repo: {
        ensureMailboxForConnection: async (input: any) => {
          calls.push(['mailbox', input]);
          return ok({ subscriptionId: 'sub-1', created: true });
        },
        ensureBrief: async (input: any) => {
          calls.push(['brief', input]);
          return ok({ briefId: 'brief-1', created: true });
        },
        scheduleBriefNow: async (input: any) => {
          calls.push(['schedule', input]);
          return ok(true);
        },
      } as any,
      wakeMailOps: () => { wakes += 1; },
      logger: noopLogger,
      now: () => dueAt,
    });

    const result = await start({
      companyId: 'company-1',
      userId: 'user-1',
      connectionId: 'conn-1',
      mailboxEmail: 'user@example.com',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls[0], ['mailbox', {
      companyId: 'company-1',
      userId: 'user-1',
      connectionId: 'conn-1',
      mailboxEmail: 'user@example.com',
      now: dueAt,
    }]);
    assert.equal(calls[1][0], 'brief');
    assert.equal(calls[1][1].subscriptionId, 'sub-1');
    assert.equal(calls[1][1].nextRunAt, dueAt);
    assert.deepEqual(calls[2], ['schedule', {
      briefId: 'brief-1',
      now: dueAt,
    }]);
    assert.equal(result.value.firstBriefQueued, true);
    assert.equal(wakes, 1);
  });

  it('queues the first brief even when onboarding reuses an existing row', async () => {
    const dueAt = new Date('2026-08-10T01:23:00.000Z');
    const calls: any[] = [];
    let wakes = 0;
    const start = createMailBriefOnboarding({
      repo: {
        ensureMailboxForConnection: async (input: any) => {
          calls.push(['mailbox', input]);
          return ok({ subscriptionId: 'sub-1', created: false });
        },
        ensureBrief: async (input: any) => {
          calls.push(['brief', input]);
          return ok({ briefId: 'brief-existing', created: false });
        },
        scheduleBriefNow: async (input: any) => {
          calls.push(['schedule', input]);
          return ok(true);
        },
      } as any,
      wakeMailOps: () => { wakes += 1; },
      logger: noopLogger,
      now: () => dueAt,
    });

    const result = await start({
      companyId: 'company-1',
      userId: 'user-1',
      connectionId: 'conn-1',
      mailboxEmail: 'user@example.com',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls[2], ['schedule', {
      briefId: 'brief-existing',
      now: dueAt,
    }]);
    assert.equal(result.value.mailboxCreated, false);
    assert.equal(result.value.briefCreated, false);
    assert.equal(result.value.firstBriefQueued, true);
    assert.equal(wakes, 1);
  });
});
