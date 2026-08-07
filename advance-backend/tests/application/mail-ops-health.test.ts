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
    watchFailureCount: 0,
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
  blockedCount: 0,
  lastBlockedAt: null,
  blockedReason: null,
  lastError: null,
};

describe('mailbox health', () => {
  it('reports a mailbox that has never worked at all as never started', () => {
    const health = assessMailbox(mailbox({
      watchRegisteredAt: null,
      lastSucceededAt: null,
    }));

    assert.equal(health.state, 'never_started');
    assert.equal(health.rulesCanFire, false);
    assert.match(health.summary, /never been able to start watching/);
  });

  it('does not let a paused-looking mailbox hide a mailbox that never worked', () => {
    // A mailbox with no active rules parks itself, which would otherwise
    // report 'paused' and conceal that it never worked in the first place.
    const health = assessMailbox(mailbox({
      watchRegisteredAt: null,
      lastSucceededAt: null,
      status: 'paused',
      activeRuleCount: 0,
    }));

    assert.equal(health.state, 'never_started');
  });

  it('calls a missing watch late rather than dead once sync has worked', () => {
    // Reconciliation no longer depends on a registered watch, so this mailbox
    // is delivering — an hour behind, but delivering. Reporting it as an
    // outage would send someone chasing a fault that is not happening.
    const health = assessMailbox(mailbox({ watchRegisteredAt: null }));

    assert.equal(health.state, 'watch_delayed');
    assert.equal(health.rulesCanFire, true);
  });

  it('escalates a watch that keeps failing, and only then offers a remedy', () => {
    const delayed = assessMailbox(mailbox({
      watchFailureCode: 'scope_missing',
      watchFailureCount: 2,
    }));
    const degraded = assessMailbox(mailbox({
      watchFailureCode: 'scope_missing',
      watchFailureCount: 3,
    }));

    assert.equal(delayed.state, 'watch_delayed');
    assert.equal(delayed.remedy, null);
    assert.equal(degraded.state, 'watch_degraded');
    assert.match(degraded.remedy ?? '', /Reconnect Google/);
    // Neither stops mail — that is the whole point of dropping the watch gate.
    assert.equal(degraded.rulesCanFire, true);
  });

  it('puts a failing sync ahead of any watch problem', () => {
    // Sync failure is the one that actually stops mail; a broken watch only
    // delays it. Reporting the lesser fault would bury the real one.
    const health = assessMailbox(mailbox({
      watchFailureCode: 'scope_missing',
      watchFailureCount: 9,
      failureCode: 'connection_unavailable',
    }));

    assert.equal(health.state, 'sync_failing');
    assert.equal(health.rulesCanFire, false);
  });

  it('does not describe a parked mailbox in terms of its notifications', () => {
    // A mailbox with no active rules has nothing running, so "rules still run
    // on the hourly check" is untrue — and a watch state ranked above `paused`
    // said exactly that.
    const health = assessMailbox(mailbox({
      watchRegisteredAt: null,
      status: 'paused',
      activeRuleCount: 0,
    }));

    assert.equal(health.state, 'paused');
  });

  it('does not blame Google when the failure is inside Divo', () => {
    // `syncFailureCode` classifies by substring and the permission-store
    // message contains "permission", which used to land on `scope_missing` —
    // telling the member to reconnect a Google account that is working.
    const health = assessMailbox(mailbox({
      failureCode: 'authorization_unavailable',
    }));

    assert.equal(health.state, 'sync_failing');
    assert.match(health.remedy ?? '', /problem inside Divo/);
    assert.doesNotMatch(health.remedy ?? '', /Reconnect Google/);
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
    // `mailbox_down`, not `blocked`. The two share a colour and nothing else:
    // this rule is refused by nobody, and calling it blocked sends its owner
    // hunting a permission problem while the dead connection sits elsewhere.
    assert.equal(assessRule(VALID_RULE, dead).state, 'mailbox_down');
  });

  it('reports a refused rule as blocked rather than waiting', () => {
    // Before refusals were recorded, this rule looked identical to one that
    // had simply never matched anything — which is the whole reason nobody
    // could tell why deliveries stopped.
    const health = assessRule(
      {
        ...VALID_RULE,
        blockedCount: 2,
        lastBlockedAt: AT,
        blockedReason: 'You are no longer in that team.',
      },
      healthy,
    );

    assert.equal(health.state, 'blocked');
    assert.match(health.summary, /2 matching messages were not sent/);
    assert.match(health.summary, /no longer in that team/);
  });

  it('stops calling a rule blocked once it has delivered again', () => {
    // Access can be taken away and given back. `blockedCount` is a 30-day
    // window, so a rule refused a fortnight ago and delivering ever since was
    // reporting itself refused — in red, next to a delivery count saying the
    // opposite.
    const health = assessRule(
      {
        ...VALID_RULE,
        blockedCount: 2,
        lastBlockedAt: AT,
        blockedReason: 'You are no longer in that team.',
        lastDeliveredAt: new Date(AT.getTime() + 60_000),
      },
      healthy,
    );

    assert.equal(health.state, 'working');
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
    assert.equal(shouldNotifyMailbox('healthy', 'watch_degraded'), true);
    assert.equal(shouldNotifyMailbox('watch_degraded', 'watch_degraded'), false);
  });

  it('notifies again when a broken mailbox breaks a different way', () => {
    assert.equal(shouldNotifyMailbox('watch_degraded', 'sync_failing'), true);
  });

  it('never notifies for recovery or for a deliberate pause', () => {
    assert.equal(shouldNotifyMailbox('sync_failing', 'healthy'), false);
    assert.equal(shouldNotifyMailbox('healthy', 'paused'), false);
  });

  it('stays quiet about a watch that is merely late', () => {
    // Rules still fire in this state and Divo is already retrying. An alert
    // for a fault that is usually gone in fifteen minutes is how a channel
    // gets muted — and then the real ones go unread too.
    assert.equal(shouldNotifyMailbox('healthy', 'watch_delayed'), false);
    assert.equal(shouldNotifyMailbox(null, 'watch_delayed'), false);
  });

  it('notifies on a first sighting that is already broken', () => {
    assert.equal(shouldNotifyMailbox(null, 'never_started'), true);
    assert.equal(shouldNotifyMailbox(null, 'healthy'), false);
  });
});
