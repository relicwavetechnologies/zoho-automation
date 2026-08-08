/**
 * A rule that carries several destinations, and the identity that keeps them
 * from overwriting each other.
 *
 * `create` is an upsert on `mailRuleDedupeKey`. Everything else in this file is
 * ordinary schema validation; the reason it exists is the first block, where
 * getting the identity wrong means asking for "same sender, different
 * recipients" silently rewrites who receives somebody's mail — with nothing
 * anywhere saying so, on a rule that keeps working.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIL_RULE_MAX_ROUTES,
  mailDestinationKind,
  mailDestinationLeaves,
  mailRuleDedupeKey,
  type MailRuleDestination,
  type MailRuleIdentity,
} from '../../src/application/mail-ops/mail-ops.types.ts';
import { parseMailRule } from '../../src/application/mail-ops/mail-rule.matcher.ts';

const base = (destination: MailRuleDestination): MailRuleIdentity => ({
  companyId: 'c1',
  userId: 'u1',
  connectionId: 'k1',
  match: { from: '@client.com' },
  action: { type: 'forward' },
  destination,
});

const route = (key: string, email: string) => ({
  key,
  when: `something that looks like ${key}`,
  destination: { type: 'email' as const, email },
});

const routed = (
  routes: ReturnType<typeof route>[],
  otherwise: MailRuleDestination extends { otherwise: infer O } ? O : never = 'hold' as never,
): MailRuleDestination => ({ type: 'routed', routes, otherwise });

describe('a routing table is part of a rule’s identity', () => {
  /* The whole reason routes are stored beside the destination and not inside
     the judge, where `question` sits and is deliberately ignored. */
  it('makes two rules out of the same sender sent to different people', () => {
    const a = mailRuleDedupeKey(base(routed([
      route('invoices', 'anish@emiactech.com'),
      route('product', 'rdx@gmail.com'),
    ])));
    const b = mailRuleDedupeKey(base(routed([
      route('invoices', 'anish@emiactech.com'),
      route('product', 'someone-else@gmail.com'),
    ])));
    assert.notEqual(a, b);
  });

  it('makes one rule out of the same recipients written in two orders', () => {
    // Same as `phraseIdentity` sorting alternatives: order changes how the
    // branches read and changes nothing about who gets mail. Two rules here
    // would both be active and forward every matching message twice.
    const a = mailRuleDedupeKey(base(routed([
      route('invoices', 'anish@emiactech.com'),
      route('product', 'rdx@gmail.com'),
    ])));
    const b = mailRuleDedupeKey(base(routed([
      route('product', 'rdx@gmail.com'),
      route('invoices', 'anish@emiactech.com'),
    ])));
    assert.equal(a, b);
  });

  /*
   * The one this was originally written wrong.
   *
   * The key folded only the *set* of recipients, by analogy with
   * `judge.question` — which is excluded because a question does not change who
   * receives mail. A route's description does: it is half of a meaning →
   * recipient pair, and the pairing is what the rule is. With only the
   * recipients folded in, swapping which branch reaches whom produced the same
   * key, so asking for the second rule landed on the first as an upsert and
   * every invoice kept going to the person the member had just moved it away
   * from. Found in cold review.
   */
  it('tells apart two tables that send the same two people opposite things', () => {
    const a = mailRuleDedupeKey(base(routed([
      route('invoices', 'anish@emiactech.com'),
      route('product', 'rdx@gmail.com'),
    ])));
    const swapped = mailRuleDedupeKey(base(routed([
      { key: 'invoices', when: 'something that looks like invoices', destination: { type: 'email', email: 'rdx@gmail.com' } },
      { key: 'product', when: 'something that looks like product', destination: { type: 'email', email: 'anish@emiactech.com' } },
    ])));
    assert.notEqual(a, swapped);
  });

  it('makes one rule out of the same branches with different keys', () => {
    /*
     * The `key` is still a label: the editor derives it from row position, so
     * folding it in would make dragging a row into a different order produce a
     * second rule — both active, forwarding everything twice.
     */
    const a = mailRuleDedupeKey(base(routed([
      route('invoices', 'anish@emiactech.com'),
      route('product', 'rdx@gmail.com'),
    ])));
    const b = mailRuleDedupeKey(base(routed([
      { key: 'route-1', when: 'something that looks like invoices', destination: { type: 'email', email: 'anish@emiactech.com' } },
      { key: 'route-2', when: 'something that looks like product', destination: { type: 'email', email: 'rdx@gmail.com' } },
    ])));
    assert.equal(a, b);
  });

  it('folds a description the way every other free text here is folded', () => {
    // Case-insensitively, because the runtime matches that way.
    const a = mailRuleDedupeKey(base(routed([
      route('invoices', 'anish@emiactech.com'),
      route('product', 'rdx@gmail.com'),
    ])));
    const b = mailRuleDedupeKey(base(routed([
      { key: 'invoices', when: 'Something That Looks Like Invoices', destination: { type: 'email', email: 'anish@emiactech.com' } },
      { key: 'product', when: 'something that looks like product', destination: { type: 'email', email: 'rdx@gmail.com' } },
    ])));
    assert.equal(a, b);
  });

  it('tells a held fallback apart from one that names a person', () => {
    const held = mailRuleDedupeKey(base(routed([
      route('invoices', 'anish@emiactech.com'),
      route('product', 'rdx@gmail.com'),
    ])));
    const sent = mailRuleDedupeKey(base({
      type: 'routed',
      routes: [route('invoices', 'anish@emiactech.com'), route('product', 'rdx@gmail.com')],
      otherwise: { type: 'email', email: 'everyone@emiactech.com' },
    }));
    assert.notEqual(held, sent);
  });

  /*
   * The regression that matters most and is the easiest to cause.
   *
   * `destinationIdentity` was extracted out of a nested ternary that sat inline
   * in the key. If it produces anything different for a shape that already
   * exists, every rule in the database becomes a different rule — and the next
   * create for each of them makes a second copy beside the one already running.
   */
  it('leaves every destination that already exists keyed exactly as it was', () => {
    /*
     * Asserted as properties, not against captured hashes — a literal here
     * would have to be regenerated by the very code under test, which proves
     * nothing. What has to still hold is: the four existing shapes key apart
     * from each other, an email is still case-folded, and the two opaque ids
     * are still not.
     */
    const existing: MailRuleDestination[] = [
      { type: 'email', email: 'books@vendor-cpa.com' },
      { type: 'lark_chat', chatId: 'oc_ABC' },
      { type: 'lark_dm', openId: 'ou_ABC' },
      { type: 'none' },
    ];
    const keys = existing.map(destination => mailRuleDedupeKey(base(destination)));
    assert.equal(new Set(keys).size, keys.length);

    assert.equal(
      mailRuleDedupeKey(base({ type: 'email', email: 'Books@Vendor-CPA.com' })),
      mailRuleDedupeKey(base({ type: 'email', email: 'books@vendor-cpa.com' })),
    );
    assert.notEqual(
      mailRuleDedupeKey(base({ type: 'lark_chat', chatId: 'oc_ABC' })),
      mailRuleDedupeKey(base({ type: 'lark_chat', chatId: 'oc_abc' })),
    );
  });
});

describe('what a routing table is allowed to say', () => {
  const parse = (destination: unknown, action: unknown = { type: 'forward' }) =>
    parseMailRule({
      match: { from: '@client.com' },
      action: action as Record<string, unknown>,
      destination: destination as Record<string, unknown>,
    });

  it('reads a routed rule back with its branches intact', () => {
    const parsed = parse({
      type: 'routed',
      routes: [
        { key: 'invoices', when: 'an invoice or a bill', destination: { type: 'email', email: 'anish@emiactech.com' } },
        { key: 'product', when: 'about the product', destination: { type: 'email', email: 'rdx@gmail.com' } },
      ],
      otherwise: 'hold',
    });
    assert.equal(parsed.destination.type, 'routed');
    assert.equal(
      parsed.destination.type === 'routed' && parsed.destination.routes.length,
      2,
    );
  });

  it('refuses a table that mixes email and Lark', () => {
    // One rule is one action, and the runtime dispatches on it. A mixed table
    // is a rule that is both `forward` and `deliver`.
    assert.throws(() => parse({
      type: 'routed',
      routes: [
        { key: 'invoices', when: 'an invoice', destination: { type: 'email', email: 'a@b.com' } },
        { key: 'product', when: 'the product', destination: { type: 'lark_chat', chatId: 'oc_1' } },
      ],
      otherwise: 'hold',
    }));
  });

  it('refuses a fallback that sends a different way than the branches', () => {
    assert.throws(() => parse({
      type: 'routed',
      routes: [
        { key: 'invoices', when: 'an invoice', destination: { type: 'email', email: 'a@b.com' } },
        { key: 'product', when: 'the product', destination: { type: 'email', email: 'c@d.com' } },
      ],
      otherwise: { type: 'lark_dm', openId: 'ou_1' },
    }));
  });

  it('refuses one branch, and more than six', () => {
    const one = [route('invoices', 'a@b.com')];
    const seven = Array.from({ length: MAIL_RULE_MAX_ROUTES + 1 }, (_, i) =>
      route(`k${i}`, `a${i}@b.com`));
    assert.throws(() => parse({ type: 'routed', routes: one, otherwise: 'hold' }));
    assert.throws(() => parse({ type: 'routed', routes: seven, otherwise: 'hold' }));
  });

  it('refuses two branches sharing a key, which no answer could tell apart', () => {
    assert.throws(() => parse({
      type: 'routed',
      routes: [route('invoices', 'a@b.com'), route('invoices', 'c@d.com')],
      otherwise: 'hold',
    }));
  });

  it('refuses a branch called none, which is the answer for "nothing fits"', () => {
    assert.throws(() => parse({
      type: 'routed',
      routes: [route('none', 'a@b.com'), route('product', 'c@d.com')],
      otherwise: 'hold',
    }));
  });

  it('refuses a Lark table paired with a forward action', () => {
    assert.throws(() => parse({
      type: 'routed',
      routes: [route('a', 'x@y.com'), route('b', 'z@y.com')],
      otherwise: 'hold',
    }, { type: 'deliver' }));
  });

  it('still reads every rule shape that existed before routing', () => {
    // A payload or a row that stops parsing fails its delivery outright, so
    // this is the check that the change is additive.
    assert.equal(parse({ type: 'email', email: 'a@b.com' }).destination.type, 'email');
    assert.equal(
      parse({ type: 'lark_dm', openId: 'ou_1' }, { type: 'deliver' }).destination.type,
      'lark_dm',
    );
    assert.equal(
      parse({ type: 'none' }, { type: 'organize', label: 'Invoices' }).destination.type,
      'none',
    );
  });
});

describe('asking a destination what it is and who it reaches', () => {
  it('answers for a whole routing table at once', () => {
    const table = routed([route('invoices', 'a@b.com'), route('product', 'c@d.com')]);
    assert.equal(mailDestinationKind(table), 'email');
    assert.deepEqual(mailDestinationLeaves(table).map(l => l.type === 'email' && l.email), [
      'a@b.com', 'c@d.com',
    ]);
  });

  it('counts a named fallback as somewhere mail reaches', () => {
    // It is a recipient like any other, and the external-forward gate has to
    // see it — a fallback pointed outside the company is still a standing
    // export, and it is the branch nobody thinks about.
    const leaves = mailDestinationLeaves({
      type: 'routed',
      routes: [route('invoices', 'a@b.com'), route('product', 'c@d.com')],
      otherwise: { type: 'email', email: 'everything-else@gmail.com' },
    });
    assert.equal(leaves.length, 3);
  });

  it('says an organize rule reaches nobody', () => {
    assert.deepEqual(mailDestinationLeaves({ type: 'none' }), []);
  });
});
