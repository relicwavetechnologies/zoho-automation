/**
 * The gate that was reachable from one surface and not the other.
 *
 * `inspectExternalMailForward` in the approval gate has its own tests and they
 * were not touched, which is what proves the extraction changed no behaviour.
 * These cover the second caller — the web write path, which asked nobody until
 * now — and the decision they both share.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  inspectExternalForward,
  type ExternalForwardApprovalPort,
} from '../../src/application/mail-ops/external-forward-approval';
import {
  createMailRuleWriter,
  actionForDestination,
  type MailRuleWriteRequest,
  type MailRuleWriterDeps,
} from '../../src/application/mail-ops/mail-rule-writer';

const MANAGER = { userId: 'mgr', larkOpenId: 'ou_mgr', displayName: 'Abhishek' };

const port = (over: Partial<ExternalForwardApprovalPort> = {}): ExternalForwardApprovalPort => ({
  resolveManager: async () => MANAGER,
  ...over,
});

describe('external forward approval — the decision', () => {
  it('asks nobody when the request establishes no external forward', async () => {
    const verdict = await inspectExternalForward(
      { destination: null, companyId: 'c1', requesterId: 'u1', departmentId: 'd1' },
      port(),
    );
    assert.equal(verdict.kind, 'not_external');
  });

  it('names the approver for a forward that leaves the company', async () => {
    const verdict = await inspectExternalForward(
      { destination: 'x@gmail.com', companyId: 'c1', requesterId: 'u1', departmentId: 'd1' },
      port(),
    );
    assert.equal(verdict.kind, 'required');
    assert.equal(verdict.kind === 'required' && verdict.approver.displayName, 'Abhishek');
  });

  it('fails closed when nobody in the company can approve it', async () => {
    // Not "allowed because there is no policy". A standing forward to an
    // address nobody chose is the outcome this refuses to reach quietly.
    const verdict = await inspectExternalForward(
      { destination: 'x@gmail.com', companyId: 'c1', requesterId: 'u1', departmentId: 'd1' },
      port({ resolveManager: async () => null }),
    );
    assert.equal(verdict.kind, 'misconfigured');
  });

  it('fails closed when the requester has no department to resolve one from', async () => {
    let asked = false;
    const verdict = await inspectExternalForward(
      { destination: 'x@gmail.com', companyId: 'c1', requesterId: 'u1', departmentId: null },
      port({ resolveManager: async () => { asked = true; return MANAGER; } }),
    );
    assert.equal(verdict.kind, 'misconfigured');
    assert.equal(asked, false);
  });

  it('lets the approver set up their own, and says so', async () => {
    const seen: string[] = [];
    const verdict = await inspectExternalForward(
      { destination: 'x@gmail.com', companyId: 'c1', requesterId: 'mgr', departmentId: 'd1' },
      port({ onSelfBypass: (b) => { seen.push(b.destination); } }),
    );
    assert.equal(verdict.kind, 'allowed');
    assert.deepEqual(seen, ['x@gmail.com']);
  });

  it('holds the approver to it where the bypass is switched off', async () => {
    const verdict = await inspectExternalForward(
      { destination: 'x@gmail.com', companyId: 'c1', requesterId: 'mgr', departmentId: 'd1' },
      port({ disableManagerSelfBypass: true }),
    );
    assert.equal(verdict.kind, 'required');
  });
});

const writer = (over: Partial<MailRuleWriterDeps> = {}) => {
  const written: string[] = [];
  const instance = createMailRuleWriter({
    runtime: { pubsubConfigured: true, workersEnabled: true },
    resolveConnection: async () => ({
      status: 'resolved',
      connectionId: 'k1',
      mailboxEmail: 'me@emiactech.com',
    }),
    externalForward: port(),
    repo: {
      setRuleStatus: async () => ({ ok: true, value: true }),
      createRuleForMailbox: async (input) => {
        written.push(input.mailboxEmail);
        return { ok: true, value: { ruleId: 'r1', subscriptionId: 's1' } };
      },
    },
    ...over,
  });
  return { instance, written };
};

const REQUEST: MailRuleWriteRequest = {
  companyId: 'c1',
  userId: 'u1',
  departmentId: 'd1',
  name: 'Invoices',
  match: { from: '@acme.com' },
  destination: { type: 'email', email: 'books@vendor-cpa.com' },
  requesterEmail: 'me@emiactech.com',
};

const create = (w: ReturnType<typeof writer>, request: MailRuleWriteRequest) =>
  w.instance.create(request, actionForDestination(request.destination, request.rateLimitPerHour));

describe('external forward approval — the web write path', () => {
  it('defers an external forward instead of writing it', async () => {
    const w = writer();
    const outcome = await create(w, REQUEST);
    assert.equal(outcome.status, 'external_approval_required');
    assert.deepEqual(w.written, []);
  });

  it('writes a forward that stays inside the company', async () => {
    const w = writer();
    const outcome = await create(w, {
      ...REQUEST,
      destination: { type: 'email', email: 'anish@emiactech.com' },
    });
    assert.equal(outcome.status, 'created');
  });

  it('treats an unknown requester address as external', async () => {
    // The direction that asks one extra person, never the one that asks none.
    const w = writer();
    const { requesterEmail: _drop, ...withoutEmail } = REQUEST;
    const outcome = await create(w, withoutEmail);
    assert.equal(outcome.status, 'external_approval_required');
  });

  it('writes it once the approval has already been granted', async () => {
    // The resumer's path, and the agent path, which runs the gate upstream.
    const w = writer();
    const outcome = await create(w, { ...REQUEST, externalForwardApproved: true });
    assert.equal(outcome.status, 'created');
  });

  it('does not gate an organize rule, which sends nothing anywhere', async () => {
    const w = writer();
    const outcome = await w.instance.create(
      { ...REQUEST, destination: { type: 'none' } },
      { type: 'organize', label: 'Invoices' },
    );
    assert.equal(outcome.status, 'created');
  });

  it('refuses rather than writing when nobody can approve', async () => {
    const w = writer({ externalForward: port({ resolveManager: async () => null }) });
    const outcome = await create(w, REQUEST);
    assert.equal(outcome.status, 'external_approval_unavailable');
    assert.deepEqual(w.written, []);
  });

  it('asks before grounding a destination, so a refusal costs nothing', async () => {
    // Order is load-bearing: there is no reason to have grounded a Lark chat
    // for a rule a manager may refuse.
    let grounded = false;
    const w = writer({
      authorizeLarkChat: async () => { grounded = true; return { status: 'allowed' }; },
    });
    await create(w, REQUEST);
    assert.equal(grounded, false);
  });
});
