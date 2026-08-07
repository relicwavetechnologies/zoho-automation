/**
 * The two places a working AI step disappears without anybody being told.
 *
 * Both were found by review rather than by use, and neither would have surfaced
 * as an error: one deletes a rule's question during an unrelated edit, the other
 * makes a rule that is working perfectly report that it has never matched
 * anything. A member's response to the second is to widen the rule, which makes
 * it worse.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMailAutomationsTool } from '../../src/application/tools/families/mail-automations.tool.ts';
import { assessRule } from '../../src/application/mail-ops/mail-ops-health.ts';

/**
 * `list` has to answer with the rule's question, or Lark cannot edit a rule
 * without destroying it.
 *
 * Every tool result is re-parsed against `resultSchema` and the *parsed* value
 * is what reaches the model, so zod's default strip silently removes any key
 * the schema does not name. The tool's own instructions tell the model to read
 * `judge` from `list` and carry it forward on `update`; if the key never
 * arrives, "rename this rule" in Lark issues an update with no judge, and
 * `replaceRule` writes `judgeJson: DbNull`. The rule then forwards everything it
 * was written to hold back, and nothing anywhere says the step was removed.
 */
describe('mail automations tool result', () => {
  const tool = createMailAutomationsTool({} as never);

  const listResult = (judge: unknown) => ({
    success: true,
    operation: 'list',
    rules: [{
      ruleId: '11111111-1111-4111-8111-111111111111',
      name: 'Vendor invoices → Finance',
      status: 'active',
      mailboxEmail: 'rahul@emiactech.com',
      connectionId: '22222222-2222-4222-8222-222222222222',
      match: { subjectContains: 'invoice' },
      action: { type: 'forward' },
      destination: { type: 'email', email: 'finance@emiactech.com' },
      judge,
      createdAt: new Date().toISOString(),
      valid: true,
    }],
  });

  it('carries a rule’s question through the result schema', () => {
    const question = 'Is this a real invoice addressed to us, rather than marketing?';
    const parsed = tool.resultSchema.parse(
      listResult({ question, onFailure: 'closed' }),
    ) as { rules: Array<Record<string, unknown>> };

    assert.deepEqual(parsed.rules[0]?.['judge'], { question, onFailure: 'closed' });
  });

  it('says plainly that a rule has no question, rather than omitting it', () => {
    const parsed = tool.resultSchema.parse(listResult(null)) as {
      rules: Array<Record<string, unknown>>;
    };

    // `null` rather than an absent key: the model is told to carry the current
    // value forward, and "there isn't one" has to be distinguishable from "the
    // list did not mention it".
    assert.equal(parsed.rules[0]?.['judge'], null);
    assert.equal('judge' in (parsed.rules[0] ?? {}), true);
  });
});

describe('a rule whose question holds everything', () => {
  const base = {
    status: 'active',
    match: { subjectContains: 'invoice' },
    action: { type: 'forward' },
    destination: { type: 'email', email: 'finance@emiactech.com' },
    lastDeliveredAt: null,
    abandonedCount: 0,
    blockedCount: 0,
    heldCount: 0,
    lastBlockedAt: null,
    blockedReason: null,
    lastError: null,
  };
  const mailbox = { rulesCanFire: true, state: 'healthy' as const };

  it('is working, not waiting', () => {
    const health = assessRule({ ...base, heldCount: 40 }, mailbox);

    // "Active. No matching mail has arrived yet." on a rule that has read and
    // rejected forty messages is the app contradicting the Held back count
    // sitting two rows below it on the same screen.
    assert.notEqual(health.state, 'waiting');
    assert.equal(health.state, 'working');
    assert.match(health.summary, /40 messages/);
  });

  it('still reads as waiting when nothing has matched at all', () => {
    assert.equal(assessRule(base, mailbox).state, 'waiting');
  });

  it('a rule that has delivered is working regardless of what it held', () => {
    const health = assessRule(
      { ...base, heldCount: 12, lastDeliveredAt: new Date() },
      mailbox,
    );
    assert.equal(health.state, 'working');
    // The delivered branch wins, so the summary is about delivery rather than
    // about the count of messages the step passed over.
    assert.equal(health.summary, 'Working.');
  });
});
