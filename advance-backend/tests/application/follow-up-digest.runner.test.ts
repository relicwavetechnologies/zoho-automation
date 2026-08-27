import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFollowUpDigestRunner } from '../../src/application/follow-ups/follow-up-digest.runner.ts';
import { err, ok } from '../../src/shared/result.ts';
import { InfraError } from '../../src/shared/errors.ts';
import type { ClaimedDigest } from '../../src/infrastructure/persistence/follow-ups.repository.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child() { return this; },
} as any;

const RAN_AT = new Date('2026-08-25T03:30:00Z');   // 09:00 Asia/Kolkata

const claim: ClaimedDigest = {
  digestId: 'digest-1',
  companyId: 'company-1',
  departmentId: 'dept-ua',
  larkChatId: 'oc_ua_group',
  timesJson: ['09:00', '18:00'],
  daysJson: ['MO', 'TU', 'WE', 'TH', 'FR'],
  timeZone: 'Asia/Kolkata',
  coveredThrough: new Date('2026-08-24T12:00:00Z'),
  scheduledFor: RAN_AT,
  claimToken: 'token-1',
};

const followUp = (over: Record<string, unknown> = {}) => ({
  id: 'f-1', title: 'Send Priya the Q3 invoice', detail: '', kind: 'commitment',
  owner: 'us', counterparty: 'Priya', dueDate: null, urgency: 'medium',
  status: 'open', remindAt: null, chatId: 'chat-1', chatName: 'Venue — Taj',
  updatedAt: RAN_AT, sessionId: 'sess-1', sessionLabel: 'Bookings desk',
  ...over,
});

function makeRepo(window: { items?: any[]; dark?: any[] } = {}) {
  return {
    completed: [] as any[],
    released: [] as any[],
    async readDigestWindow() {
      return ok({ items: window.items ?? [], dark: window.dark ?? [] });
    },
    async completeDigest(input: any) { this.completed.push(input); return ok(undefined); },
    async releaseDigest(input: any) { this.released.push(input); return ok(undefined); },
  } as any;
}

import type { AuditService } from '../../src/application/observability/audit.service.ts';
const fakeAudit = {
  record: () => {},
  beginRequired: async () => 'audit-1',
  settle: () => {},
} as unknown as AuditService;

const runner = (repo: any, deliver: any, authorize?: any) =>
  createFollowUpDigestRunner({
    repo, deliver, logger: noopLogger, now: () => RAN_AT, auditService: fakeAudit,
    ...(authorize ? { authorizeLarkChat: authorize } : {}),
  });

describe('follow-up digest runner', () => {
  it('sends one card per number and advances the window', async () => {
    const sent: any[] = [];
    const repo = makeRepo({
      items: [
        followUp(),
        followUp({ id: 'f-2', sessionId: 'sess-2', sessionLabel: 'Sales 2', title: 'Chase venue' }),
      ],
    });
    await runner(repo, async (i: any) => { sent.push(i); return 'msg-1'; })(claim);

    assert.equal(sent.length, 2, 'one card per number, not one merged card');
    assert.equal(repo.completed.length, 1);
    assert.equal(repo.completed[0].coveredThrough.getTime(), RAN_AT.getTime());
    // Next weekday slot after 09:00 IST is 18:00 IST the same day.
    assert.ok(repo.completed[0].nextRunAt > RAN_AT);
  });

  it('does NOT advance the window when a send fails', async () => {
    // Whatever this run would have reported folds into the next one instead of
    // being lost — a gap is exactly when somebody most needs telling.
    const repo = makeRepo({ items: [followUp()] });
    await runner(repo, async () => { throw new Error('lark down'); })(claim);

    assert.equal(repo.completed.length, 0, 'window not advanced');
    assert.equal(repo.released.length, 0, 'same slot is retained for an idempotent retry');
  });

  it('sends a health card when a number is dark, even with no follow-ups', async () => {
    // The state that produces no traffic is the one that most needs saying.
    const sent: any[] = [];
    const repo = makeRepo({
      items: [],
      dark: [{ label: 'Bookings desk', darkSince: new Date('2026-08-23T11:30:00Z') }],
    });
    await runner(repo, async (i: any) => { sent.push(i); return 'msg-1'; })(claim);

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /not being read/);
    assert.equal(repo.completed.length, 1);
  });

  it('says nothing at all when everything is clear', async () => {
    // "All clear" twice a day from ten handsets is how a group learns to ignore
    // the channel. The run still counts.
    const sent: any[] = [];
    const repo = makeRepo({ items: [], dark: [] });
    await runner(repo, async (i: any) => { sent.push(i); return 'x'; })(claim);

    assert.equal(sent.length, 0);
    assert.equal(repo.completed.length, 1, 'the run happened, so the window moves');
  });

  it('stops permanently on a cross-company room', async () => {
    const repo = makeRepo({ items: [followUp()] });
    const sent: any[] = [];
    await runner(repo, async (i: any) => { sent.push(i); return 'x'; },
      async () => ({ status: 'other_company' as const }))(claim);

    assert.equal(sent.length, 0, 'nothing sent');
    // Never going to become right, so it must not knock twice a day forever.
    assert.equal(repo.released[0].nextRunAt, null, 'unscheduled, not retried');
  });

  it('keeps its schedule when Divo has simply never been in the room', async () => {
    const repo = makeRepo({ items: [followUp()] });
    const sent: any[] = [];
    await runner(repo, async (i: any) => { sent.push(i); return 'x'; },
      async () => ({ status: 'unknown_chat' as const }))(claim);

    assert.equal(sent.length, 0);
    // Ordinary and fixable — add Divo to the group and it starts working.
    assert.ok(repo.released[0].nextRunAt, 'still scheduled');
  });

  it('uses an idempotency key per slot and card', async () => {
    const sent: any[] = [];
    const repo = makeRepo({ items: [followUp()] });
    await runner(repo, async (i: any) => { sent.push(i); return 'x'; })(claim);
    // A retry of the same slot must not post the same card twice.
    assert.match(sent[0].idempotencyKey, /digest-1/);
    assert.match(sent[0].idempotencyKey, /sess-1/);
    assert.match(sent[0].idempotencyKey, /2026-08-25T03:30/);
  });

  it('does not deliver when the durable audit checkpoint is unavailable', async () => {
    const sent: any[] = [];
    const repo = makeRepo({ items: [followUp()] });
    const audit = {
      beginRequired: async () => { throw new Error('audit database unavailable'); },
      settle: () => {},
    } as unknown as AuditService;
    const run = createFollowUpDigestRunner({
      repo,
      deliver: async (input: any) => { sent.push(input); return 'x'; },
      logger: noopLogger,
      now: () => RAN_AT,
      auditService: audit,
    });

    await run(claim);
    assert.equal(sent.length, 0);
    assert.equal(repo.released.length, 1, 'failure before delivery moves to the next slot');
  });

  it('retains the same slot when completion fails after delivery', async () => {
    const sent: any[] = [];
    const repo = makeRepo({ items: [followUp()] });
    repo.completeDigest = async () => err(new InfraError({
      layer: 'prisma', op: 'followUps.completeDigest', cause: 'db', message: 'db unavailable',
    }));
    await runner(repo, async (input: any) => { sent.push(input); return 'x'; })(claim);

    assert.equal(sent.length, 1);
    assert.equal(repo.released.length, 0, 'stale-claim recovery reuses scheduledFor');
  });
});
