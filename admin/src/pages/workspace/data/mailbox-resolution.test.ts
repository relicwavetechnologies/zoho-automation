/**
 * Which refusal a member gets, and therefore where they are sent.
 *
 * Four of the five answers are refusals with four different remedies, and
 * picking the wrong one is invisible: the page renders a confident sentence
 * either way. The case this file exists for is a revoked account, which reads
 * as perfectly eligible on every field the old code looked at — because every
 * one of them was true when it was connected, and none of them is what broke.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveMailboxes } from './mailbox-resolution'
import type { LiveConnection } from './use-connections'

const connection = (over: Partial<LiveConnection> = {}): LiveConnection => ({
  connectionId: 'conn-1',
  label: 'Google',
  accountEmail: 'abhishek@emiactech.com',
  accountName: 'Abhishek',
  ownerType: 'user',
  access: 'admin',
  ...over,
})

const watched = (email: string) => ({
  mailboxEmail: email,
  activeRuleCount: 2,
} as never)

describe('mailbox resolution', () => {
  it('offers the one working account without asking anything', () => {
    const result = resolveMailboxes([connection()], [])
    assert.equal(result.status, 'one')
    assert.equal(result.status === 'one' && result.option.accountEmail, 'abhishek@emiactech.com')
  })

  it('refuses a revoked account instead of building a rule that can never fire', () => {
    // The whole point. Owned, read_write, and indistinguishable from a healthy
    // account except for this one flag — so without the flag it becomes the
    // single `one` option and the wizard runs to completion on a mailbox
    // nothing will ever watch.
    const result = resolveMailboxes([connection({ reconnectRequired: true })], [])
    assert.equal(result.status, 'reconnect')
    assert.deepEqual(
      result.status === 'reconnect' && result.options.map((o) => o.accountEmail),
      ['abhishek@emiactech.com'],
    )
  })

  it('names the revoked account, because that is the one to sign back into', () => {
    // Dropping it and answering `none` would say "connect Google" to somebody
    // looking straight at their connected Google account.
    const result = resolveMailboxes([connection({ reconnectRequired: true })], [])
    assert.notEqual(result.status, 'none')
  })

  it('does not send someone to reconnect when a working account is the obstacle', () => {
    // One revoked, one live but shared read-only. The live one is what stands
    // between them and a rule; telling them to reconnect the other fixes
    // nothing and they come back to the same wall.
    const result = resolveMailboxes(
      [
        connection({ connectionId: 'dead', reconnectRequired: true }),
        connection({ connectionId: 'shared', access: 'read_only', accountEmail: 'shared@emiactech.com' }),
      ],
      [],
    )
    assert.equal(result.status, 'insufficient')
    assert.deepEqual(
      result.status === 'insufficient' && result.options.map((o) => o.connectionId),
      ['shared'],
    )
  })

  it('keeps a revoked account out of the picker when another one works', () => {
    const result = resolveMailboxes(
      [
        connection({ connectionId: 'dead', reconnectRequired: true }),
        connection({ connectionId: 'live', accountEmail: 'other@emiactech.com' }),
      ],
      [],
    )
    // One usable account left, so there is no choice left to ask about.
    assert.equal(result.status, 'one')
    assert.equal(result.status === 'one' && result.option.connectionId, 'live')
  })

  it('says none only when there is genuinely no account', () => {
    assert.equal(resolveMailboxes([], []).status, 'none')
    // A company-owned connection is not this person's to watch.
    assert.equal(resolveMailboxes([connection({ ownerType: 'company' })], []).status, 'none')
  })

  it('asks which mailbox, watched ones first', () => {
    const result = resolveMailboxes(
      [
        connection({ connectionId: 'cold', accountEmail: 'cold@emiactech.com' }),
        connection({ connectionId: 'warm', accountEmail: 'warm@emiactech.com' }),
      ],
      [watched('warm@emiactech.com')],
    )
    assert.equal(result.status, 'choose')
    assert.deepEqual(
      result.status === 'choose' && result.options.map((o) => o.connectionId),
      ['warm', 'cold'],
    )
  })

  it('treats an absent flag as working, not as unknown', () => {
    // Most providers never report this field at all. If its absence read as
    // anything but healthy, every non-Google account would be refused.
    const result = resolveMailboxes([connection({ reconnectRequired: undefined })], [])
    assert.equal(result.status, 'one')
  })
})
