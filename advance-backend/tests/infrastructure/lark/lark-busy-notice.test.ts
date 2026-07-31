import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideBusyNotice,
  BusyLaneNotices,
} from '../../../src/infrastructure/channels/lark/lark-busy-notice.ts';

describe('decideBusyNotice', () => {
  it('says nothing when the lane is free', () => {
    const decision = decideBusyNotice({
      laneBusy: false, alreadyNotified: false, isCommand: false,
    });
    assert.equal(decision.notify, false);
    assert.equal(decision.reason, 'lane_idle');
  });

  it('notifies the first message that has to wait', () => {
    assert.equal(
      decideBusyNotice({ laneBusy: true, alreadyNotified: false, isCommand: false }).notify,
      true,
    );
  });

  it('stays quiet for every message after the first', () => {
    // Four quick thoughts should not produce four "please wait" notices and no
    // answers — that is noisier than saying nothing at all.
    const decision = decideBusyNotice({
      laneBusy: true, alreadyNotified: true, isCommand: false,
    });
    assert.equal(decision.notify, false);
    assert.equal(decision.reason, 'already_notified');
  });

  it('never queues-notices a command', () => {
    // Commands answer from the webhook path, not from an agent run, so they are
    // not actually waiting on the lane.
    assert.equal(
      decideBusyNotice({ laneBusy: true, alreadyNotified: false, isCommand: true }).notify,
      false,
    );
  });
});

describe('BusyLaneNotices', () => {
  it('notifies once per busy stretch and then again after the lane drains', () => {
    const notices = new BusyLaneNotices();
    const busy = { laneBusy: true, isCommand: false };

    assert.equal(notices.decide('lane-a', busy).notify, true);
    assert.equal(notices.decide('lane-a', busy).notify, false);

    notices.clear('lane-a');

    // A new backlog later is worth mentioning again.
    assert.equal(notices.decide('lane-a', busy).notify, true);
  });

  it('tracks lanes separately', () => {
    const notices = new BusyLaneNotices();
    const busy = { laneBusy: true, isCommand: false };

    assert.equal(notices.decide('lane-a', busy).notify, true);
    assert.equal(notices.decide('lane-b', busy).notify, true);
  });

  it('does not remember a lane it never notified about', () => {
    const notices = new BusyLaneNotices();

    notices.decide('lane-a', { laneBusy: false, isCommand: false });

    assert.equal(notices.size, 0, 'an idle lane leaves nothing to clean up');
  });
});
