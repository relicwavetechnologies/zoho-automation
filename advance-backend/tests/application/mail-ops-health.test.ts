import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assessMailbox,
  assessRule,
  shouldNotifyMailbox,
} from '../../src/application/mail-ops/mail-ops-health';
import type { MailboxHealthRecord } from '../../src/infrastructure/persistence/mail-ops-read.repository';

const AT = new Date('2026-08-02T10:00:00.000Z');

function mailbox(
  overrides: Partial<MailboxHealthRecord> = {},
): MailboxHealthRecord {
  return {
    subscriptionId: 'sub-1',
    mailboxEmail: 'person@acme.com',
    status: 'active',
    connectionId: 'conn-1',
    hasHistoryCursor: true,
    watchRegisteredAt: AT,
    watchExpirationAt: new Date('2026-08-09T10:00:00.000Z'),
    watchFailureCode: null,
    lastSignalAt: AT,
    lastSyncAt: AT,
    lastSucceededAt: AT,
    lastFailedAt: null,
    failureCode: null,
    lastError: null,
    activeRuleCount: 1,
    totalRuleCount: 1,
    ...overrides,
  };
}

const VALID_RULE = {
  status: 'active',
  match: { from: 'alerts@example.com' },
  action: { type: 'forward' },
  destination: { type: 'email', email: 'person@acme.com' },
  lastDeliveredAt: null,
  abandonedCount: 0,
  lastError: null,
};

describe('mailbox health', () => {
  it('reports a mailbox whose watch never registered as never started', () => {
    const health = assessMailbox(mailbox({ watchRegisteredAt: null }));

    assert.equal(health.state, 'never_started');
    assert.equal(health.rulesCanFire, false);
    assert.match(health.summary, /never been able to start watching/);
  });

  it('does not let a paused-looking mailbox hide a watch that never started', () => {
    // A mailbox with no active rules parks itself, which would otherwise
    // report 'paused' and conceal that it never worked in the first place.
    const health = assessMailbox(mailbox({
      watchRegisteredAt: null,
      status: 'paused',
      activeRuleCount: 0,
    }));

    assert.equal(health.state, 'never_started');
  });

  it('separates a watch that stopped renewing from a sync that is failing', () => {
    assert.equal(
      assessMailbox(mailbox({ watchFailureCode: 'scope_missing' })).state,
      'watch_failing',
    );
    assert.equal(
      assessMailbox(mailbox({ failureCode: 'connection_unavailable' })).state,
      'sync_failing',
    );
  });

  it('gives a remedy only for failures it can honestly advise on', () => {
    assert.match(
      assessMailbox(mailbox({ failureCode: 'scope_missing' })).remedy ?? '',
      /Reconnect Google/,
    );
    // An unrecognised provider code must not produce an invented instruction.
    assert.equal(
      assessMailbox(mailbox({ failureCode: 'provider_sync_failed' })).remedy,
      null,
    );
  });

  it('treats an active subscription with no active rules as paused, not broken', () => {
    const health = assessMailbox(mailbox({ activeRuleCount: 0, totalRuleCount: 2 }));

    assert.equal(health.state, 'paused');
    assert.equal(health.rulesCanFire, false);
    assert.match(health.remedy ?? '', /Resume a rule/);
  });

  it('reports a registered, syncing mailbox with rules as healthy', () => {
    const health = assessMailbox(mailbox());

    assert.equal(health.state, 'healthy');
    assert.equal(health.rulesCanFire, true);
    assert.equal(health.remedy, null);
  });
});

describe('rule health', () => {
  const healthy = { rulesCanFire: true, state: 'healthy' as const };
  const dead = { rulesCanFire: false, state: 'never_started' as const };

  it('flags a rule the current matcher rejects as broken, with the reason', () => {
    const health = assessRule(
      { ...VALID_RULE, match: { from: 'anthropic' } },
      healthy,
    );

    assert.equal(health.state, 'broken');
    assert(health.invalidReason);
    assert.match(health.summary, /not\s+firing/);
  });

  it('reports a paused rule as broken when it would not work if resumed', () => {
    // Resuming a rule that cannot match is a silent no-op, so validity is
    // reported ahead of status rather than hidden behind "paused".
    const health = assessRule(
      { ...VALID_RULE, status: 'paused', match: { from: 'anthropic' } },
      healthy,
    );

    assert.equal(health.state, 'broken');
  });

  it('distinguishes a rule waiting for mail from one its mailbox cannot fire', () => {
    assert.equal(assessRule(VALID_RULE, healthy).state, 'waiting');
    assert.equal(assessRule(VALID_RULE, dead).state, 'blocked');
  });

  it('says a working rule is working, and still surfaces failed deliveries', () => {
    const health = assessRule(
      { ...VALID_RULE, lastDeliveredAt: AT, abandonedCount: 2 },
      healthy,
    );

    assert.equal(health.state, 'working');
    assert.match(health.summary, /2 messages could not be delivered/);
  });

  it('does not offer to resume an archived rule', () => {
    const health = assessRule({ ...VALID_RULE, status: 'archived' }, healthy);

    assert.equal(health.state, 'archived');
    assert.match(health.summary, /cannot be resumed/);
  });
});

describe('notification gating', () => {
  it('notifies once on the way into a broken state, not while it stays broken', () => {
    assert.equal(shouldNotifyMailbox('healthy', 'watch_failing'), true);
    assert.equal(shouldNotifyMailbox('watch_failing', 'watch_failing'), false);
  });

  it('notifies again when a broken mailbox breaks a different way', () => {
    assert.equal(shouldNotifyMailbox('watch_failing', 'sync_failing'), true);
  });

  it('never notifies for recovery or for a deliberate pause', () => {
    assert.equal(shouldNotifyMailbox('sync_failing', 'healthy'), false);
    assert.equal(shouldNotifyMailbox('healthy', 'paused'), false);
  });

  it('notifies on a first sighting that is already broken', () => {
    assert.equal(shouldNotifyMailbox(null, 'never_started'), true);
    assert.equal(shouldNotifyMailbox(null, 'healthy'), false);
  });
});
