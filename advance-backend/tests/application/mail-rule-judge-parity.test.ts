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

  /*
   * The same strip hazard, on the answer to "did you make me a new rule?".
   *
   * `create` is an upsert on the rule's own content, so asking for a rule that
   * already exists rewrites its name, its ceiling and its question — and brings
   * it back if it was paused or archived. The tool reported every one of those
   * as a plain creation, so an agent could tell a member it had built them
   * something new when it had actually resurrected a rule they retired months
   * ago. Reporting it is only half the fix: a key this schema does not name is
   * stripped on the way out and the model never sees it.
   */
  it('carries what was already there through the result schema', () => {
    for (const existing of ['active', 'paused', 'archived', null] as const) {
      const parsed = tool.resultSchema.parse({
        success: true,
        operation: 'create',
        existing,
      }) as Record<string, unknown>;

      assert.equal('existing' in parsed, true, `${existing} must survive the schema`);
      assert.equal(parsed['existing'], existing);
    }
  });

  /*
   * The fourth time. `list.judge`, `create.existing`, `create.rule.judge` — and
   * now a routing table, where the consequence is the worst of the four.
   *
   * The instructions tell the model to read a rule from `list` and re-send it
   * on `update`, and `update` replaces rather than merges. A stripped `routes`
   * therefore turns "rename this rule" into "delete this rule's routing table",
   * and what comes back forwards everything to a single destination — silently,
   * on a rule that keeps reporting itself as working.
   */
  const ROUTES = [
    { key: 'invoices', when: 'an invoice or a bill', destination: { type: 'email', email: 'anish@emiactech.com' } },
    { key: 'product', when: 'about the product', destination: { type: 'email', email: 'rdx@emiactech.com' } },
  ];

  it('carries a rule’s branches through the result schema', () => {
    const parsed = tool.resultSchema.parse({
      success: true,
      operation: 'list',
      rules: [{
        ruleId: '11111111-1111-4111-8111-111111111111',
        name: 'Client mail, sorted',
        status: 'active',
        mailboxEmail: 'abhishek@emiactech.com',
        connectionId: '22222222-2222-4222-8222-222222222222',
        match: { from: 'client@google.com' },
        action: { type: 'forward' },
        destination: { type: 'routed', routes: ROUTES, otherwise: 'hold' },
        routes: ROUTES,
        otherwise: 'hold',
        judge: null,
        createdAt: new Date().toISOString(),
        valid: true,
      }],
    }) as { rules: Array<Record<string, unknown>> };

    assert.deepEqual(parsed.rules[0]?.['routes'], ROUTES);
    assert.equal(parsed.rules[0]?.['otherwise'], 'hold');
  });

  it('carries a named fallback, which is a recipient like any other', () => {
    const otherwise = { type: 'email', email: 'everything-else@emiactech.com' };
    const parsed = tool.resultSchema.parse({
      success: true,
      operation: 'create',
      rule: {
        ruleId: '11111111-1111-4111-8111-111111111111',
        name: 'Client mail, sorted',
        status: 'active',
        mailboxEmail: 'abhishek@emiactech.com',
        connectionId: '22222222-2222-4222-8222-222222222222',
        match: { from: 'client@google.com' },
        action: { type: 'forward' },
        destination: { type: 'routed', routes: ROUTES, otherwise },
        routes: ROUTES,
        otherwise,
        judge: null,
        createdAt: new Date().toISOString(),
        valid: true,
      },
    }) as { rule: Record<string, unknown> };

    assert.deepEqual(parsed.rule?.['otherwise'], otherwise);
    assert.equal((parsed.rule?.['routes'] as unknown[]).length, 2);
  });

  it('carries the branches an update left the rule with', () => {
    // `update` replaces the whole destination, so this is the answer to "what
    // does this rule route by now" — reported on the call that changed it.
    const parsed = tool.resultSchema.parse({
      success: true,
      operation: 'update',
      judge: null,
      routes: ROUTES,
      otherwise: 'hold',
      message: 'Mail automation update completed.',
    }) as Record<string, unknown>;

    assert.deepEqual(parsed['routes'], ROUTES);
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

/**
 * The same strip hazard on the two answers either side of `list`.
 *
 * `list` was fixed first because the instructions name it. But an agent does
 * not always go back to `list`: it creates a rule and then edits it in the same
 * turn ("actually call it X"), reading the rule out of the answer it just got.
 * That answer carried every other field and said `valid: true`, so there was
 * nothing in it to suggest the question was missing rather than absent.
 */
describe('the answers a rule is read out of', () => {
  const tool = createMailAutomationsTool({} as never);

  it('carries a new rule’s question back on create', () => {
    const judge = { question: 'Is this a real invoice addressed to us?', onFailure: 'closed' };
    const parsed = tool.resultSchema.parse({
      success: true,
      operation: 'create',
      rule: {
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
      },
    }) as { rule: Record<string, unknown> };

    assert.deepEqual(parsed.rule['judge'], judge);
  });

  /*
   * `update` replaces the judge rather than merging it, so the commonest way to
   * destroy one is an edit about something else. The result now states which of
   * the two happened — and has to survive the schema to do it.
   */
  it('says on update whether the rule still has a question', () => {
    for (const judge of [{ question: 'Is this urgent?' }, null]) {
      const parsed = tool.resultSchema.parse({
        success: true,
        operation: 'update',
        judge,
      }) as Record<string, unknown>;

      assert.equal('judge' in parsed, true, 'the verdict on the question must survive');
      assert.deepEqual(parsed['judge'], judge);
    }
  });
});
