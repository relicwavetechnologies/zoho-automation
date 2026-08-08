import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  externalMailDestinations,
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
    assert.deepEqual(
      externalMailDestinations({
        args: {
          operation: 'create',
          destination: { type: 'email', email: 'collector@evil.test' },
        },
        requesterEmail,
      }),
      ['collector@evil.test'],
    );
    assert.deepEqual(
      externalMailDestinations({
        args: {
          operation: 'update',
          destination: { type: 'email', email: 'collector@evil.test' },
        },
        requesterEmail,
      }),
      ['collector@evil.test'],
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
      assert.deepEqual(
        externalMailDestinations({ args, requesterEmail }),
        [],
        `expected no external destination for ${JSON.stringify(args)}`,
      );
    }
  });

  /*
   * A routing table sends to several people, and the gate reads it before any
   * schema has vetted it — so it is read by shape, and every branch counts.
   *
   * Missing one here is not a missing warning. It is a standing export of
   * company mail that nobody was ever asked about, on a rule that reports
   * itself as approved.
   */
  it('finds every external branch of a routing table, including the fallback', () => {
    const requesterEmail = 'owner@example.com';
    assert.deepEqual(
      externalMailDestinations({
        args: {
          operation: 'create',
          destination: {
            type: 'routed',
            routes: [
              { key: 'a', when: 'invoices', destination: { type: 'email', email: 'inside@example.com' } },
              { key: 'b', when: 'product', destination: { type: 'email', email: 'first@evil.test' } },
            ],
            otherwise: { type: 'email', email: 'second@evil.test' },
          },
        },
        requesterEmail,
      }),
      ['first@evil.test', 'second@evil.test'],
    );
  });

  it('says nothing leaves when every branch stays inside', () => {
    assert.deepEqual(
      externalMailDestinations({
        args: {
          operation: 'create',
          destination: {
            type: 'routed',
            routes: [
              { key: 'a', when: 'invoices', destination: { type: 'email', email: 'a@example.com' } },
              { key: 'b', when: 'product', destination: { type: 'email', email: 'b@example.com' } },
            ],
            otherwise: 'hold',
          },
        },
        requesterEmail: 'owner@example.com',
      }),
      [],
    );
  });

  it('names one address once, however many branches point at it', () => {
    // Two branches reaching one person is one thing to approve. Naming it twice
    // on a card reads as two different requests.
    assert.deepEqual(
      externalMailDestinations({
        args: {
          operation: 'create',
          destination: {
            type: 'routed',
            routes: [
              { key: 'a', when: 'invoices', destination: { type: 'email', email: 'one@evil.test' } },
              { key: 'b', when: 'product', destination: { type: 'email', email: 'one@evil.test' } },
            ],
          },
        },
        requesterEmail: 'owner@example.com',
      }),
      ['one@evil.test'],
    );
  });
});
