import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  summariseCorrespondents,
  type CorrespondentEvent,
} from '../../src/application/mail-ops/mail-correspondents';

const OWN = 'abhishek@emiactech.com';

function event(metadata: Record<string, unknown>): CorrespondentEvent {
  return { metadata: { subject: 's', snippet: '', bodyText: '', hasAttachment: false, ...metadata } };
}

/** N messages from one sender, so a domain clears its two-message floor. */
function from(address: string, count: number, extra: Record<string, unknown> = {}) {
  return Array.from({ length: count }, () => event({ from: address, to: OWN, ...extra }));
}

const valueOf = (list: readonly { value: string }[]) => list.map(s => s.value);

describe('summariseCorrespondents', () => {
  it('offers a domain above its senders once more than one writes from it', () => {
    const summary = summariseCorrespondents(
      [...from('billing@acme.com', 4), ...from('support@acme.com', 3)],
      OWN,
    );

    const domain = summary.from.find(s => s.kind === 'domain');
    assert.equal(domain?.value, '@acme.com');
    assert.equal(domain?.messageCount, 7);
    assert.equal(domain?.senderCount, 2);
    // Volume first, so the domain that groups them leads.
    assert.equal(summary.from[0]?.value, '@acme.com');
  });

  it('does not offer a domain that groups a single sender', () => {
    // Two rows saying the same thing, one of them wider than intended.
    const summary = summariseCorrespondents(from('billing@acme.com', 9), OWN);
    assert.deepEqual(valueOf(summary.from), ['billing@acme.com']);
  });

  it('never offers a public mailbox provider as a domain', () => {
    const summary = summariseCorrespondents(
      [...from('a@gmail.com', 6), ...from('b@gmail.com', 5)],
      OWN,
    );
    assert.equal(summary.from.some(s => s.kind === 'domain'), false);
    // The individuals are still worth offering.
    assert.deepEqual(valueOf(summary.from).sort(), ['a@gmail.com', 'b@gmail.com']);
  });

  it('ignores mail Divo forwarded itself', () => {
    // A rule delivering back into the mailbox it watches would otherwise read
    // as a frequent correspondent, and a rule built on it forwards for ever.
    const summary = summariseCorrespondents(
      from('billing@acme.com', 5, { forwardedByRuleId: 'rule-1' }),
      OWN,
    );
    assert.deepEqual(summary.from, []);
  });

  it('drops a one-off sender', () => {
    const summary = summariseCorrespondents(from('someone@acme.com', 1), OWN);
    assert.deepEqual(summary.from, []);
  });

  it('reads the address out of a display-name header', () => {
    const summary = summariseCorrespondents(
      [
        event({ from: '"Doe, John" <j@acme.com>', to: OWN }),
        event({ from: 'John Doe <j@acme.com>', to: OWN }),
      ],
      OWN,
    );
    assert.deepEqual(valueOf(summary.from), ['j@acme.com']);
  });

  it('offers own-organisation recipients and flags the aliases', () => {
    const summary = summariseCorrespondents(
      [
        event({ from: 'a@acme.com', to: OWN }),
        event({ from: 'b@acme.com', to: 'sales@emiactech.com', cc: OWN }),
        event({ from: 'c@acme.com', deliveredTo: 'sales@emiactech.com', to: 'someone@else.com' }),
      ],
      OWN,
    );

    const own = summary.to.find(s => s.value === OWN);
    const alias = summary.to.find(s => s.value === 'sales@emiactech.com');
    assert.equal(own?.alias, undefined);
    assert.equal(alias?.alias, true);
    assert.equal(alias?.messageCount, 2);
    // An external party cc'd on a thread is not an address this inbox
    // receives at, and a rule written on one would wait for ever.
    assert.equal(summary.to.some(s => s.value === 'someone@else.com'), false);
  });

  it('keeps the owner’s own address however rarely it is counted', () => {
    // A mailbox whose mail mostly arrives via aliases would otherwise not list
    // the one answer to "addressed to me directly".
    const summary = summariseCorrespondents([event({ from: 'a@acme.com', to: OWN })], OWN);
    assert.deepEqual(valueOf(summary.to), [OWN]);
  });

  it('does not offer the owner as a sender', () => {
    const summary = summariseCorrespondents(from(OWN, 5), OWN);
    assert.deepEqual(summary.from, []);
  });

  it('counts a message once when it names the same address twice', () => {
    const summary = summariseCorrespondents(
      [event({ from: 'a@acme.com', to: OWN, cc: OWN, deliveredTo: OWN })],
      OWN,
    );
    assert.equal(summary.to.find(s => s.value === OWN)?.messageCount, 1);
  });
});
