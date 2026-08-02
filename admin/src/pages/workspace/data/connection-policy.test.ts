import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  defaultGovernancePolicy, samePolicy, scopeLabel, setActionPolicy, sharedGrants,
  type ConnectionGovernancePolicy,
} from './connection-policy'

/*
 * Only the parts where being wrong is silent.
 *
 * A policy in the wrong *shape* comes back as a 400 and the person sees it. A
 * policy in a valid but wrong shape saves cleanly and changes what Divo is
 * allowed to do without anybody being told — which is what these cover.
 */

describe('setActionPolicy', () => {
  it('seeds an approver when an action becomes enforced', () => {
    // The backend refuses `mode: enforced` with no approval, so a switch that
    // sent one would 400 on save rather than at the click.
    const next = setActionPolicy(defaultGovernancePolicy(), 'send', { mode: 'enforced' })
    assert.deepEqual(next.actions.send, { mode: 'enforced', approval: 'connection_owner' })
  })

  it('keeps a chosen approver rather than re-seeding it', () => {
    const enforced = setActionPolicy(defaultGovernancePolicy(), 'send', { mode: 'enforced' })
    const chosen = setActionPolicy(enforced, 'send', { approval: 'company_admin' })
    assert.equal(chosen.actions.send?.approval, 'company_admin')
    assert.equal(chosen.actions.send?.mode, 'enforced')
  })

  it('carries stored rate caps through an approver change', () => {
    // Not editable on this screen, and dropping them would delete a limit set
    // elsewhere with no sign that it happened.
    const withCaps: ConnectionGovernancePolicy = {
      version: 1,
      actions: { send: { mode: 'enforced', approval: 'connection_owner', requestsPerMinute: 5, requestsPerDay: 100 } },
    }
    const next = setActionPolicy(withCaps, 'send', { approval: 'company_admin' })
    assert.equal(next.actions.send?.requestsPerMinute, 5)
    assert.equal(next.actions.send?.requestsPerDay, 100)
  })

  it('clears everything when an action goes back to the platform default', () => {
    // A leftover approver on an inherited action means the next person to
    // enforce it inherits a decision nobody made.
    const enforced = setActionPolicy(defaultGovernancePolicy(), 'delete', { mode: 'enforced', approval: 'company_admin' })
    const reverted = setActionPolicy(enforced, 'delete', { mode: 'inherit' })
    assert.deepEqual(reverted.actions.delete, { mode: 'inherit' })
  })

  it('leaves the other five actions alone', () => {
    const next = setActionPolicy(defaultGovernancePolicy(), 'delete', { mode: 'enforced' })
    assert.deepEqual(next.actions.read, { mode: 'inherit' })
    assert.deepEqual(next.actions.send, { mode: 'inherit' })
  })
})

describe('samePolicy', () => {
  it('treats an absent action as inherited', () => {
    // The backend omits actions nobody has touched, so a fetched policy and a
    // freshly defaulted one describe identical rules in different shapes.
    assert.equal(samePolicy({ version: 1, actions: {} }, defaultGovernancePolicy()), true)
  })

  it('ignores fields that cannot affect an inherited action', () => {
    const stale: ConnectionGovernancePolicy = {
      version: 1,
      actions: { read: { mode: 'inherit', requestsPerMinute: 9 } },
    }
    assert.equal(samePolicy(stale, defaultGovernancePolicy()), true)
  })

  it('sees a changed approver', () => {
    const owner = setActionPolicy(defaultGovernancePolicy(), 'send', { mode: 'enforced' })
    const admin = setActionPolicy(owner, 'send', { approval: 'company_admin' })
    assert.equal(samePolicy(owner, admin), false)
  })

  it('sees an action switched on', () => {
    const enforced = setActionPolicy(defaultGovernancePolicy(), 'send', { mode: 'enforced' })
    assert.equal(samePolicy(defaultGovernancePolicy(), enforced), false)
  })
})

describe('sharedGrants', () => {
  const owner = { granteeType: 'user', granteeId: 'u-owner' }
  const colleague = { granteeType: 'user', granteeId: 'u-other' }
  const finance = { granteeType: 'department', granteeId: 'd-finance' }

  it('drops the grant the owner holds on their own connection', () => {
    // Connecting an account writes this row on top of ownership. Shown, it put
    // the owner on screen twice — once as "You · Owner" and once as themselves
    // "shared by you" — with a Revoke button beside the second.
    assert.deepEqual(sharedGrants([owner, colleague], 'u-owner'), [colleague])
  })

  it('keeps grants to everybody else', () => {
    assert.deepEqual(sharedGrants([owner, colleague, finance], 'u-owner'), [colleague, finance])
  })

  it('keeps a department grant that happens to share the owner id', () => {
    // Ids come from different tables, so matching on id alone would hide a
    // real department grant on a collision.
    const dept = { granteeType: 'department', granteeId: 'u-owner' }
    assert.deepEqual(sharedGrants([dept], 'u-owner'), [dept])
  })

  it('keeps the creator grant on a company-owned connection', () => {
    // Same initial grant, but the creator is not the owner — their access
    // really does come from it, and revoking it really does remove it.
    assert.deepEqual(sharedGrants([colleague], null), [colleague])
    assert.deepEqual(sharedGrants([colleague], undefined), [colleague])
  })
})

describe('scopeLabel', () => {
  it('reads a Google scope URL', () => {
    assert.equal(scopeLabel('https://www.googleapis.com/auth/gmail.modify'), 'Gmail modify')
    assert.equal(scopeLabel('https://www.googleapis.com/auth/drive.readonly'), 'Drive readonly')
  })

  it('names the sign-in scopes for what they are', () => {
    assert.equal(scopeLabel('openid'), 'Sign-in')
    assert.equal(scopeLabel('https://www.googleapis.com/auth/userinfo.email'), 'Email')
  })

  it('reads Lark and Zoho scopes without a per-provider table', () => {
    assert.equal(scopeLabel('contact:user.base:readonly'), 'Contact user base readonly')
    assert.equal(scopeLabel('ZohoCRM.modules.ALL'), 'ZohoCRM modules ALL')
  })

  it('never swallows a scope it does not recognise', () => {
    // Showing nothing would understate what an account handed over.
    assert.equal(scopeLabel('somethingopaque'), 'Somethingopaque')
  })
})
