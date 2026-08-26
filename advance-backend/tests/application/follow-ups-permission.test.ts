import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  followUpsActionGroup,
  followUpsPermission,
  followUpsRefusal,
  type FollowUpsOperation,
} from '../../src/application/follow-ups/follow-ups-permission';

const granted = (...actions: string[]) => new Set(actions);

// The three tiers the grant is meant to express. Written as data so a new
// operation cannot be added without landing in one of them.
const READS: FollowUpsOperation[] = ['list', 'listNumbers', 'listChats', 'pairingStatus'];
const WRITES: FollowUpsOperation[] = ['resolve', 'muteChat', 'linkNumber', 'pairingCode', 'reread'];
const SENDS: FollowUpsOperation[] = [
  'listBroadcasts', 'readBroadcast', 'pickRecipients', 'previewBroadcast', 'sendBroadcast',
];

test('reads need read', () => {
  for (const operation of READS) {
    assert.equal(followUpsActionGroup(operation), 'read', operation);
    assert.equal(followUpsPermission(operation, granted('read')).allowed, true, operation);
    assert.equal(followUpsPermission(operation, granted('update', 'send')).allowed, false, operation);
  }
});

test('writes need update, and read alone is not enough', () => {
  for (const operation of WRITES) {
    assert.equal(followUpsActionGroup(operation), 'update', operation);
    assert.equal(followUpsPermission(operation, granted('update')).allowed, true, operation);
    assert.equal(followUpsPermission(operation, granted('read')).allowed, false, operation);
  }
});

test('the whole broadcast surface needs send, its reads included', () => {
  for (const operation of SENDS) {
    assert.equal(followUpsActionGroup(operation), 'send', operation);
    assert.equal(followUpsPermission(operation, granted('send')).allowed, true, operation);
    // Reading follow-ups does not open the recipient picker or the history.
    assert.equal(followUpsPermission(operation, granted('read', 'update')).allowed, false, operation);
  }
});

test('a granted action does not imply the others', () => {
  assert.equal(followUpsPermission('sendBroadcast', granted('read', 'update')).allowed, false);
  assert.equal(followUpsPermission('resolve', granted('read', 'send')).allowed, false);
  assert.equal(followUpsPermission('list', granted('send')).allowed, false);
});

test('cancelling a send is never harder than starting one', () => {
  // The sender can always stop their own broadcast.
  assert.equal(followUpsPermission('cancelBroadcast', granted('send')).allowed, true);
  // And so can anyone who may edit this department's follow-ups, whether or
  // not they could have sent it — five minutes of pacing is a long time to
  // wait for the one person who can pull the cord.
  assert.equal(followUpsPermission('cancelBroadcast', granted('update')).allowed, true);
  // Reading is not enough. Cancelling changes what other people receive.
  assert.equal(followUpsPermission('cancelBroadcast', granted('read')).allowed, false);
});

test('no grant at all refuses everything', () => {
  for (const operation of [...READS, ...WRITES, ...SENDS, 'cancelBroadcast' as const]) {
    assert.equal(followUpsPermission(operation, undefined).allowed, false, operation);
    assert.equal(followUpsPermission(operation, granted()).allowed, false, operation);
  }
});

test('the refusal names the capability an administrator can actually find', () => {
  const verdict = followUpsPermission('sendBroadcast', granted('read', 'update'));
  assert.equal(verdict.allowed, false);
  if (verdict.allowed) return;
  assert.match(followUpsRefusal(verdict.missing), /Send access to WhatsApp Follow-ups/);

  const write = followUpsPermission('resolve', granted('read'));
  assert.equal(write.allowed, false);
  if (write.allowed) return;
  assert.match(followUpsRefusal(write.missing), /Edit access to WhatsApp Follow-ups/);

  // Someone with nothing is told to ask for the feature, not for an action
  // group inside it — they cannot see the tab to know what is missing.
  const read = followUpsPermission('list', undefined);
  assert.equal(read.allowed, false);
  if (read.allowed) return;
  assert.match(followUpsRefusal(read.missing), /do not have access to WhatsApp Follow-ups/);
});

// ── Where the grants come from ───────────────────────────────────────────

import { followUpsGrants, type FollowUpsStanding } from '../../src/application/follow-ups/follow-ups-permission';

const standing = (over: Partial<FollowUpsStanding> = {}): FollowUpsStanding => ({
  isCompanyAdmin: false,
  isDepartmentMember: true,
  isDepartmentManager: false,
  departmentHasNumber: true,
  ...over,
});

test('a department member reads and edits but does not send', () => {
  const grants = followUpsGrants(standing());
  assert.equal(followUpsPermission('list', grants).allowed, true);
  assert.equal(followUpsPermission('resolve', grants).allowed, true);
  assert.equal(followUpsPermission('sendBroadcast', grants).allowed, false);
});

test('the department manager also sends', () => {
  const grants = followUpsGrants(standing({ isDepartmentManager: true }));
  assert.equal(followUpsPermission('sendBroadcast', grants).allowed, true);
  assert.equal(followUpsPermission('pickRecipients', grants).allowed, true);
});

test('somebody outside the department gets nothing, manager elsewhere or not', () => {
  const outsider = followUpsGrants(standing({ isDepartmentMember: false, isDepartmentManager: true }));
  assert.equal(outsider.size, 0);
  assert.equal(followUpsPermission('list', outsider).allowed, false);
});

test('a member of a department with no linked handset gets nothing', () => {
  // Not an empty list — no access at all. An empty tab in a department that
  // never linked a number reads as broken rather than as "not yours".
  const grants = followUpsGrants(standing({ departmentHasNumber: false }));
  assert.equal(grants.size, 0);
});

test('the manager can set up a department that has no handset yet', () => {
  // The circle this breaks: linking the first number IS an `update`, so gating
  // the manager on a number already existing left the person who leads the team
  // unable to start it. A company admin reaching in from outside is a
  // workaround, not the design.
  const grants = followUpsGrants(standing({
    isDepartmentManager: true,
    departmentHasNumber: false,
  }));
  assert.equal(followUpsPermission('linkNumber', grants).allowed, true);
  assert.equal(followUpsPermission('list', grants).allowed, true);
  assert.equal(followUpsPermission('sendBroadcast', grants).allowed, true);
});

test('leading a department you are not a member of grants nothing', () => {
  // The manager flag is read off a membership row; without one there is no
  // department being led, whatever the flag says.
  const grants = followUpsGrants(standing({
    isDepartmentMember: false,
    isDepartmentManager: true,
    departmentHasNumber: false,
  }));
  assert.equal(grants.size, 0);
});

test('a company admin holds everything, including before the first handset', () => {
  // This is what breaks the circle: linking the first number needs `update`,
  // and `update` for members needs a linked number. Somebody has to go first.
  const grants = followUpsGrants(standing({
    isCompanyAdmin: true,
    isDepartmentMember: false,
    departmentHasNumber: false,
  }));
  assert.equal(followUpsPermission('linkNumber', grants).allowed, true);
  assert.equal(followUpsPermission('sendBroadcast', grants).allowed, true);
});
