import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mailRuleDedupeKey } from '../../src/application/mail-ops/mail-ops.types';
import { parseMailRule } from '../../src/application/mail-ops/mail-rule.matcher';

const BASE = { companyId: 'c1', userId: 'u1', connectionId: 'k1' };

describe('lark_dm destination', () => {
  it('parses as a delivery destination', () => {
    const parsed = parseMailRule({
      match: { from: '@acme.com' },
      action: { type: 'deliver' },
      destination: { type: 'lark_dm', openId: 'ou_abc' },
    });
    assert.deepEqual(parsed.destination, { type: 'lark_dm', openId: 'ou_abc' });
  });

  it('is refused by a forward action, which needs an address', () => {
    assert.throws(() => parseMailRule({
      match: { from: '@acme.com' },
      action: { type: 'forward' },
      destination: { type: 'lark_dm', openId: 'ou_abc' },
    }));
  });

  it('gives two people distinct rules for the same match', () => {
    // The open id is part of the rule's identity. Were it left out, one
    // person's DM rule would collide with another's and the second create
    // would silently adopt the first.
    const rule = (openId: string) => mailRuleDedupeKey({
      ...BASE,
      ...parseMailRule({
        match: { from: '@acme.com' },
        action: { type: 'deliver' },
        destination: { type: 'lark_dm', openId },
      }),
    });
    assert.notEqual(rule('ou_abc'), rule('ou_xyz'));
  });

  it('does not fold the open id’s case', () => {
    // Opaque and case-sensitive, exactly as a chat id is.
    const rule = (openId: string) => mailRuleDedupeKey({
      ...BASE,
      ...parseMailRule({
        match: { from: '@acme.com' },
        action: { type: 'deliver' },
        destination: { type: 'lark_dm', openId },
      }),
    });
    assert.notEqual(rule('ou_AbC'), rule('ou_abc'));
  });
});
