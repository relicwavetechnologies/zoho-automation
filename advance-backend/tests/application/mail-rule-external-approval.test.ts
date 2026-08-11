/**
 * What the browser hands the approval gate.
 *
 * Almost nothing here is logic — the value is in the shape of the request,
 * because every field that matters fails *silently* when it is wrong. A missing
 * `deliveryMode` sends the outcome to a chat id that is not a chat. A `channel`
 * other than `lark` drops the requester's Lark identity from the record, and
 * the resumer then cannot verify who asked. A chat id built per rule instead of
 * per member turns five clicks into five cards.
 *
 * None of those raise anything. They are only visible as an approval that never
 * arrives, which is why they are asserted rather than trusted.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMailRuleExternalApproval } from '../../src/application/mail-ops/mail-rule-external-approval';
import type { ApprovalDecision } from '../../src/application/approval/approval.types';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function () { return this; },
} as never;

const PENDING: ApprovalDecision = {
  kind: 'pending',
  approvalId: 'ap_1',
  message: 'sent',
  authority: 'department_manager',
  approverName: 'Abhishek',
  requestState: 'created',
  nextAction: 'wait',
  retry: 'retry_exact',
  deliveredVia: 'lark',
};

const INPUT = {
  companyId: 'c1',
  userId: 'u1',
  companyRole: 'MEMBER',
  departmentId: 'd1',
  requesterEmail: 'anish@emiactech.com',
  larkOpenId: 'ou_anish',
  larkTenantKey: 'tk_1',
  mailboxEmail: 'anish@emiactech.com',
  rule: {
    connectionId: '11111111-1111-4111-8111-111111111111',
    name: 'Invoices',
    match: { from: '@acme.com' },
    destination: { type: 'email' as const, email: 'anish.personal@gmail.com' },
    rateLimitPerHour: 5,
  },
};

const ask = (decision: ApprovalDecision = PENDING, permissionOk = true) => {
  const seen: Record<string, unknown>[] = [];
  const request = createMailRuleExternalApproval({
    approvalGate: {
      check: async (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        return decision;
      },
    } as never,
    permissions: {
      resolve: async () => (permissionOk
        ? { ok: true, value: { department: { id: 'd1', name: 'Ops' } } }
        : { ok: false, error: new Error('no membership') }),
    } as never,
    logger: silentLogger,
  });
  return { request, seen };
};

describe('mail rule external approval — the request', () => {
  it('asks about the tool call the manager will actually see run', async () => {
    const { request, seen } = ask();
    await request(INPUT);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!['toolId'], 'mailAutomations');
    assert.deepEqual(seen[0]!['args'], {
      operation: 'create',
      connectionId: INPUT.rule.connectionId,
      name: 'Invoices',
      match: { from: '@acme.com' },
      destination: { type: 'email', email: 'anish.personal@gmail.com' },
      rateLimitPerHour: 5,
    });
  });

  it('carries a whole routing table into the replay, not one address of it', async () => {
    /*
     * The replayed args are what actually gets written when the manager agrees.
     * Rebuilt from a single address, a routed rule would come back as an
     * ordinary forward to one branch — so the manager would have approved a
     * table and the member been handed something else, on the one operation
     * where a difference between the two matters most.
     */
    const destination = {
      type: 'routed' as const,
      routes: [
        { key: 'invoices', when: 'an invoice', destination: { type: 'email' as const, email: 'anish.personal@gmail.com' } },
        { key: 'product', when: 'the product', destination: { type: 'email' as const, email: 'rdx.omega@gmail.com' } },
      ],
      otherwise: 'hold' as const,
    };
    const { request, seen } = ask();
    await request({ ...INPUT, rule: { ...INPUT.rule, destination } });

    assert.deepEqual(
      (seen[0]!['args'] as Record<string, unknown>)['destination'],
      destination,
    );
  });

  it('names every external recipient on the card, not the first', async () => {
    // The sentence the approver actually reads. One name where there are two is
    // a card that asks about less than it grants.
    const { request, seen } = ask();
    await request({
      ...INPUT,
      rule: {
        ...INPUT.rule,
        destination: {
          type: 'routed',
          routes: [
            { key: 'invoices', when: 'an invoice', destination: { type: 'email', email: 'anish.personal@gmail.com' } },
            { key: 'product', when: 'the product', destination: { type: 'email', email: 'rdx.omega@gmail.com' } },
          ],
          otherwise: 'hold',
        },
      },
    });

    const summary = String(seen[0]!['argsSummary']);
    assert.match(summary, /anish\.personal@gmail\.com/);
    assert.match(summary, /rdx\.omega@gmail\.com/);
  });

  it('leaves an internal branch out of the sentence', async () => {
    // Only what leaves the company is what the approval is about. Listing an
    // internal colleague beside it makes the card read as a bigger ask.
    const { request, seen } = ask();
    await request({
      ...INPUT,
      rule: {
        ...INPUT.rule,
        destination: {
          type: 'routed',
          routes: [
            { key: 'invoices', when: 'an invoice', destination: { type: 'email', email: 'finance@emiactech.com' } },
            { key: 'product', when: 'the product', destination: { type: 'email', email: 'rdx.omega@gmail.com' } },
          ],
          otherwise: 'hold',
        },
      },
    });

    const summary = String(seen[0]!['argsSummary']);
    assert.match(summary, /rdx\.omega@gmail\.com/);
    assert.ok(!summary.includes('finance@emiactech.com'), summary);
  });

  it('binds to the mailbox the member was looking at', async () => {
    // Re-resolving on the way back could pick a different Google account, and
    // nothing on the card would have said which one was approved.
    const { request, seen } = ask();
    await request(INPUT);
    assert.equal(
      (seen[0]!['args'] as { connectionId: string }).connectionId,
      INPUT.rule.connectionId,
    );
  });

  it('says what leaves and from where, not "approve a mail rule"', async () => {
    const { request, seen } = ask();
    await request(INPUT);
    const summary = String(seen[0]!['argsSummary']);
    assert.ok(summary.includes('anish@emiactech.com'));
    assert.ok(summary.includes('anish.personal@gmail.com'));
  });

  it('records the requester’s Lark identity, which the resumer verifies later', async () => {
    const { request, seen } = ask();
    await request(INPUT);
    const run = seen[0]!['runContext'] as Record<string, unknown>;
    // The gate only stores these when the channel says lark.
    assert.equal(run['channel'], 'lark');
    assert.equal(run['userExternalId'], 'ou_anish');
    assert.equal(run['tenantId'], 'tk_1');
  });

  it('marks the request as having no chat to answer into', async () => {
    // Without this the approved outcome is addressed to a synthetic chat id
    // and the member is never told their rule turned on.
    const { request, seen } = ask();
    await request(INPUT);
    const run = seen[0]!['runContext'] as Record<string, unknown>;
    assert.equal(run['deliveryMode'], 'scheduled_runtime_delivery');
  });

  it('scopes the chat id per member, so the same rule asked twice is one card', async () => {
    const { request, seen } = ask();
    await request(INPUT);
    await request({ ...INPUT, rule: { ...INPUT.rule, name: 'Renamed' } });
    assert.ok(String(seen[0]!['chatId']).startsWith('gateway:'));
    assert.equal(seen[0]!['chatId'], seen[1]!['chatId']);
    // The rule itself still separates them — that is the args hash's job.
    assert.notDeepEqual(seen[0]!['args'], seen[1]!['args']);
  });

  it('passes the chat id through the run context too, or the grant is never found', async () => {
    // The resumer replays with metadata.sourceChatId, which the gate derives
    // from runContext.chatId. If the two disagree the approved request is
    // looked up under a key nothing was ever stored at.
    const { request, seen } = ask();
    await request(INPUT);
    const run = seen[0]!['runContext'] as Record<string, unknown>;
    assert.equal(run['chatId'], seen[0]!['chatId']);
  });

  it('omits a Lark identity it does not have rather than inventing one', async () => {
    const { request, seen } = ask();
    await request({ ...INPUT, larkOpenId: null, larkTenantKey: null });
    const run = seen[0]!['runContext'] as Record<string, unknown>;
    assert.equal('userExternalId' in run, false);
    assert.equal('tenantId' in run, false);
  });

  it('says a yes finishes the rule rather than unblocking a retry', async () => {
    /*
     * Gateway-origin requests default to "the requester will come back and
     * re-issue it", which is right for a desktop action somebody is sitting in
     * front of and wrong for a form that is closed by the time the manager
     * looks. Without this the approval lands and nothing happens — the worst
     * shape of failure, because the manager is told it worked.
     */
    const { request, seen } = ask();
    await request(INPUT);
    assert.equal(seen[0]!['resumeOnApproval'], true);
  });

  it('reports who was asked', async () => {
    const { request } = ask();
    const outcome = await request(INPUT);
    assert.deepEqual(outcome, {
      kind: 'requested',
      approvalId: 'ap_1',
      approverName: 'Abhishek',
      reused: false,
      deliveredVia: 'lark',
    });
  });

  /*
   * The member is told where to look, and the gate is the only thing that
   * knows. A request that lands in the approval inbox is as delivered as a
   * card is; what made it read as a silent failure was being told "asked
   * them" and finding nothing in Lark.
   */
  it('says where the request is waiting when no card was sent', async () => {
    const { request } = ask({ ...PENDING, deliveredVia: 'desktop' });
    const outcome = await request(INPUT);
    assert.equal(outcome.kind === 'requested' && outcome.deliveredVia, 'desktop');
  });

  it('says an open request is open rather than sending a second card', async () => {
    const { request } = ask({ ...PENDING, requestState: 'reused' });
    const outcome = await request(INPUT);
    assert.equal(outcome.kind === 'requested' && outcome.reused, true);
  });

  it('does not ask when it cannot work out who the requester is', async () => {
    const { request, seen } = ask(PENDING, false);
    const outcome = await request(INPUT);
    assert.equal(outcome.kind, 'unavailable');
    assert.equal(seen.length, 0);
  });

  it('carries a refusal back as a refusal', async () => {
    const { request } = ask({
      kind: 'rejected',
      approvalId: 'ap_1',
      message: 'Not approved.',
      authority: 'department_manager',
      approverName: 'Abhishek',
      requestState: 'reused',
      nextAction: 'change_request',
      retry: 'change_request',
    });
    const outcome = await request(INPUT);
    assert.equal(outcome.kind, 'declined');
  });
});
