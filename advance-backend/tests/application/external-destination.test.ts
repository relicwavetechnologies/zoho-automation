import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  externalMailDestination,
  mailRuleLeavesOrganisation,
} from '../../src/application/mail-ops/external-destination';

describe('external mail destinations', () => {
  it('treats the requester\'s own domain as internal', () => {
    assert.equal(
      mailRuleLeavesOrganisation({
        destinationEmail: 'finance@example.com',
        requesterEmail: 'owner@example.com',
      }),
      false,
    );
    assert.equal(
      mailRuleLeavesOrganisation({
        destinationEmail: 'FINANCE@Example.COM',
        requesterEmail: 'owner@example.com',
      }),
      false,
    );
  });

  it('treats any other domain as leaving the organisation', () => {
    assert.equal(
      mailRuleLeavesOrganisation({
        destinationEmail: 'collector@evil.test',
        requesterEmail: 'owner@example.com',
      }),
      true,
    );
    // A lookalike subdomain is not the same domain, and this is the one place
    // where being generous would cost a mailbox.
    assert.equal(
      mailRuleLeavesOrganisation({
        destinationEmail: 'collector@mail.example.com',
        requesterEmail: 'owner@example.com',
      }),
      true,
    );
  });

  it('calls it external when it cannot tell', () => {
    // No requester address, or an unparseable one. The failure direction that
    // asks a human one extra question is the only acceptable one here.
    assert.equal(
      mailRuleLeavesOrganisation({ destinationEmail: 'x@example.com' }),
      true,
    );
    assert.equal(
      mailRuleLeavesOrganisation({
        destinationEmail: 'not-an-address',
        requesterEmail: 'owner@example.com',
      }),
      true,
    );
  });

  it('reads create and update arguments without trusting their shape', () => {
    // The approval gate sees whatever the model sent, before the tool has had
    // a chance to reject it.
    const requesterEmail = 'owner@example.com';
    assert.equal(
      externalMailDestination({
        args: {
          operation: 'create',
          destination: { type: 'email', email: 'collector@evil.test' },
        },
        requesterEmail,
      }),
      'collector@evil.test',
    );
    assert.equal(
      externalMailDestination({
        args: {
          operation: 'update',
          destination: { type: 'email', email: 'collector@evil.test' },
        },
        requesterEmail,
      }),
      'collector@evil.test',
    );
    for (const args of [
      null,
      'nonsense',
      { operation: 'list' },
      { operation: 'pause', ruleId: 'r' },
      { operation: 'create' },
      { operation: 'create', destination: null },
      { operation: 'create', destination: { type: 'current_lark_chat' } },
      { operation: 'create', destination: { type: 'email' } },
      { operation: 'create', destination: { type: 'email', email: 'finance@example.com' } },
    ]) {
      assert.equal(
        externalMailDestination({ args, requesterEmail }),
        null,
        `expected no external destination for ${JSON.stringify(args)}`,
      );
    }
  });
});
