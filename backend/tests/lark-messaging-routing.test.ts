import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveLarkPeopleFromDirectory,
  type VercelLarkPerson,
} from '../src/company/orchestration/vercel/lark-helpers';
import { normalizeToolRoutingIntent } from '../src/company/memory/tool-routing.service';

const people: VercelLarkPerson[] = [
  {
    channelIdentityId: '1',
    displayName: 'Anish Suman',
    email: 'anish@example.com',
    externalUserId: 'ou_anish',
    larkOpenId: 'ou_anish',
    larkUserId: 'u_anish',
    isCurrentUser: false,
  },
  {
    channelIdentityId: '2',
    displayName: 'Shivam Sharma',
    email: 'shivam.sharma@example.com',
    externalUserId: 'ou_shivam_1',
    larkOpenId: 'ou_shivam_1',
    larkUserId: 'u_shivam_1',
    isCurrentUser: false,
  },
  {
    channelIdentityId: '3',
    displayName: 'Shivam Singh',
    email: 'shivam.singh@example.com',
    externalUserId: 'ou_shivam_2',
    larkOpenId: 'ou_shivam_2',
    larkUserId: 'u_shivam_2',
    isCurrentUser: false,
  },
  {
    channelIdentityId: '4',
    displayName: 'Abhishek Verma',
    email: 'abhishek@example.com',
    externalUserId: 'ou_me',
    larkOpenId: 'ou_me',
    larkUserId: 'u_me',
    isCurrentUser: true,
  },
];

test('resolveLarkPeopleFromDirectory matches an exact full name', () => {
  const result = resolveLarkPeopleFromDirectory({
    people,
    assigneeNames: ['Anish Suman'],
  });

  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.ambiguous, []);
  assert.equal(result.people[0]?.larkOpenId, 'ou_anish');
});

test('resolveLarkPeopleFromDirectory matches an exact open id', () => {
  const result = resolveLarkPeopleFromDirectory({
    people,
    assigneeNames: ['ou_anish'],
  });

  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.ambiguous, []);
  assert.equal(result.people[0]?.displayName, 'Anish Suman');
});

test('resolveLarkPeopleFromDirectory matches partial names with honorifics', () => {
  const result = resolveLarkPeopleFromDirectory({
    people,
    assigneeNames: ['Anish sir'],
  });

  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.ambiguous, []);
  assert.equal(result.people[0]?.larkOpenId, 'ou_anish');
});

test('resolveLarkPeopleFromDirectory returns ambiguity for shared first names', () => {
  const result = resolveLarkPeopleFromDirectory({
    people,
    assigneeNames: ['Shivam'],
  });

  assert.equal(result.people.length, 0);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.ambiguous.length, 1);
  assert.equal(result.ambiguous[0]?.matches.length, 2);
});

test('resolveLarkPeopleFromDirectory returns unresolved names cleanly', () => {
  const result = resolveLarkPeopleFromDirectory({
    people,
    assigneeNames: ['Unknown Person'],
  });

  assert.deepEqual(result.people, []);
  assert.deepEqual(result.ambiguous, []);
  assert.deepEqual(result.unresolved, ['Unknown Person']);
});

test('resolveLarkPeopleFromDirectory resolves me to the current user', () => {
  const result = resolveLarkPeopleFromDirectory({
    people,
    assigneeNames: ['me'],
  });

  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.ambiguous, []);
  assert.equal(result.people[0]?.larkOpenId, 'ou_me');
});

test('normalizeToolRoutingIntent routes DM language to the lark message domain', () => {
  const intent = normalizeToolRoutingIntent({
    latestUserMessage: 'send hi in my dm',
  });

  assert.equal(intent.domain, 'lark_message');
  assert.equal(intent.operationClass, 'send');
  assert.equal(intent.entity, 'messages');
});

test('normalizeToolRoutingIntent routes multi-recipient Lark DM requests', () => {
  const intent = normalizeToolRoutingIntent({
    latestUserMessage: 'send hi to me, Anish, and Shivam sir on Lark',
  });

  assert.equal(intent.domain, 'lark_message');
  assert.equal(intent.operationClass, 'send');
});
