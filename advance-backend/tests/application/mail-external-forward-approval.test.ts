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
      { destinations: [], companyId: 'c1', requesterId: 'u1', departmentId: 'd1' },
      port(),
    );
    assert.equal(verdict.kind, 'not_external');
  });

  it('names the approver for a forward that leaves the company', async () => {
    const verdict = await inspectExternalForward(
      { destinations: ['x@gmail.com'], companyId: 'c1', requesterId: 'u1', departmentId: 'd1' },
      port(),
    );
    assert.equal(verdict.kind, 'required');
    assert.equal(verdict.kind === 'required' && verdict.approver.displayName, 'Abhishek');
  });

  it('fails closed when nobody in the company can approve it', async () => {
    // Not "allowed because there is no policy". A standing forward to an
    // address nobody chose is the outcome this refuses to reach quietly.
    const verdict = await inspectExternalForward(
      { destinations: ['x@gmail.com'], companyId: 'c1', requesterId: 'u1', departmentId: 'd1' },
      port({ resolveManager: async () => null }),
    );
    assert.equal(verdict.kind, 'misconfigured');
  });

  it('fails closed when the requester has no department to resolve one from', async () => {
    let asked = false;
    const verdict = await inspectExternalForward(
      { destinations: ['x@gmail.com'], companyId: 'c1', requesterId: 'u1', departmentId: null },
      port({ resolveManager: async () => { asked = true; return MANAGER; } }),
    );
    assert.equal(verdict.kind, 'misconfigured');
    assert.equal(asked, false);
  });

  it('says Divo could not look, rather than that nobody was found', async () => {
    /*
     * Two different facts, and they used to share one sentence. "None could be
     * found" is a claim about the company; with no department Divo never
     * searched at all. On the web that was reached every single time, and it
     * sent people to appoint a manager they already had.
     */
    const noDepartment = await inspectExternalForward(
      { destinations: ['x@gmail.com'], companyId: 'c1', requesterId: 'u1', departmentId: null },
      port(),
    );
    const noApprover = await inspectExternalForward(
      { destinations: ['x@gmail.com'], companyId: 'c1', requesterId: 'u1', departmentId: 'd1' },
      port({ resolveManager: async () => null }),
    );
    assert.equal(noDepartment.kind, 'misconfigured');
    assert.equal(noApprover.kind, 'misconfigured');
    assert.notEqual(
      noDepartment.kind === 'misconfigured' && noDepartment.message,
      noApprover.kind === 'misconfigured' && noApprover.message,
    );
    assert.ok(
      noDepartment.kind === 'misconfigured'
        && noDepartment.message.includes('which department'),
    );
  });

  it('lets the approver set up their own, and says so', async () => {
    const seen: string[] = [];
    const verdict = await inspectExternalForward(
      { destinations: ['x@gmail.com'], companyId: 'c1', requesterId: 'mgr', departmentId: 'd1' },
      port({ onSelfBypass: (b) => { seen.push(b.destination); } }),
    );
    assert.equal(verdict.kind, 'allowed');
    assert.deepEqual(seen, ['x@gmail.com']);
  });

  it('holds the approver to it where the bypass is switched off', async () => {
    const verdict = await inspectExternalForward(
      { destinations: ['x@gmail.com'], companyId: 'c1', requesterId: 'mgr', departmentId: 'd1' },
      port({ disableManagerSelfBypass: true }),
    );
    assert.equal(verdict.kind, 'required');
  });
});

/**
 * The company admin, who is asked about nothing.
 *
 * The self-bypass above could never cover them: `resolveManager` is called with
 * `excludeUserId: requesterId`, so an admin is removed from the candidate list
 * *before* the bypass is tested, and the three things that happened instead
 * were — their department manager was carded, another admin was carded, or with
 * neither available the rule was refused outright.
 */
describe('external forward approval — a company admin is not asked', () => {
  const ADMIN = {
    destinations: ['x@gmail.com'],
    companyId: 'c1',
    requesterId: 'admin',
    departmentId: 'd1',
    requesterCompanyRole: 'COMPANY_ADMIN',
  } as const;

  it('allows it without resolving an approver at all', async () => {
    let asked = false;
    const verdict = await inspectExternalForward(
      ADMIN,
      port({ resolveManager: async () => { asked = true; return MANAGER; } }),
    );
    assert.equal(verdict.kind, 'allowed');
    // Not merely "no card". Nobody was even looked up — which is what stops the
    // department manager being carded about their own admin's rule.
    assert.equal(asked, false);
  });

  it('allows it where the old path refused outright', async () => {
    // No department, and no approver anywhere. Both of these were
    // `misconfigured` — a flat refusal of a rule an admin may create.
    for (const input of [
      { ...ADMIN, departmentId: null },
      ADMIN,
    ]) {
      const verdict = await inspectExternalForward(
        input,
        port({ resolveManager: async () => null }),
      );
      assert.equal(verdict.kind, 'allowed');
    }
  });

  it('logs it as an exemption, not as a self-bypass', async () => {
    /*
     * The two end in the same verdict and mean opposite things: a self-bypass
     * says the approver and the requester were the same person, this says
     * nobody was asked. One log line for both would make an unapproved external
     * forward indistinguishable from an approved one.
     */
    const bypassed: unknown[] = [];
    const exempted: unknown[] = [];
    const verdict = await inspectExternalForward(ADMIN, port({
      onSelfBypass: (b) => { bypassed.push(b); },
      onCompanyAdminExempt: (e) => { exempted.push(e); },
    }));
    assert.equal(verdict.kind, 'allowed');
    assert.deepEqual(bypassed, []);
    assert.deepEqual(exempted, [{
      userId: 'admin',
      destination: 'x@gmail.com',
      companyRole: 'COMPANY_ADMIN',
    }]);
  });

  it('exempts a super admin too', async () => {
    // A role above the exempted one cannot be held to a stricter rule than the
    // one below it.
    const verdict = await inspectExternalForward(
      { ...ADMIN, requesterCompanyRole: 'super_admin' },
      port(),
    );
    assert.equal(verdict.kind, 'allowed');
  });

  it('changes nothing for an ordinary member', async () => {
    for (const role of ['MEMBER', undefined]) {
      const verdict = await inspectExternalForward(
        { ...ADMIN, requesterCompanyRole: role },
        port(),
      );
      assert.equal(verdict.kind, 'required', `role ${String(role)}`);
    }
  });

  it('restores the old behaviour when the exemption is switched off', async () => {
    const verdict = await inspectExternalForward(
      ADMIN,
      port({ disableCompanyAdminExemption: true }),
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

  it('defers a routed rule whose fallback is the only thing leaving', async () => {
    /*
     * `otherwise` is the branch nobody thinks about, and it is exactly where an
     * unwatched address ends up — "everything else goes to X". Reading only the
     * named branches would have written this rule with no approval at all.
     */
    const w = writer();
    const outcome = await create(w, {
      ...REQUEST,
      destination: {
        type: 'routed',
        routes: [
          { key: 'invoices', when: 'an invoice', destination: { type: 'email', email: 'anish@emiactech.com' } },
          { key: 'product', when: 'the product', destination: { type: 'email', email: 'rdx@emiactech.com' } },
        ],
        otherwise: { type: 'email', email: 'catch-all@gmail.com' },
      },
    });
    assert.equal(outcome.status, 'external_approval_required');
    assert.deepEqual(w.written, []);
  });

  it('names every external branch in the refusal, and no internal one', async () => {
    const w = writer();
    const outcome = await create(w, {
      ...REQUEST,
      destination: {
        type: 'routed',
        routes: [
          { key: 'invoices', when: 'an invoice', destination: { type: 'email', email: 'anish@emiactech.com' } },
          { key: 'product', when: 'the product', destination: { type: 'email', email: 'rdx@gmail.com' } },
        ],
        otherwise: { type: 'email', email: 'catch-all@gmail.com' },
      },
    });
    assert.equal(outcome.status, 'external_approval_required');
    if (outcome.status !== 'external_approval_required') return;
    assert.deepEqual([...outcome.destinations].sort(), ['catch-all@gmail.com', 'rdx@gmail.com']);
    assert.ok(!outcome.destination.includes('anish@emiactech.com'), outcome.destination);
  });

  it('writes a routed rule whose every branch stays inside the company', async () => {
    const w = writer();
    const outcome = await create(w, {
      ...REQUEST,
      destination: {
        type: 'routed',
        routes: [
          { key: 'invoices', when: 'an invoice', destination: { type: 'email', email: 'anish@emiactech.com' } },
          { key: 'product', when: 'the product', destination: { type: 'email', email: 'rdx@emiactech.com' } },
        ],
        otherwise: 'hold',
      },
    });
    assert.equal(outcome.status, 'created');
  });

  it('writes an admin\'s external forward without deferring it', async () => {
    // The same request that defers for a member, from somebody nobody approves
    // for. It has to reach `created`, or the exemption exists only in the pure
    // function and not on the path a browser actually takes.
    const w = writer();
    const outcome = await create(w, { ...REQUEST, companyRole: 'COMPANY_ADMIN' });
    assert.equal(outcome.status, 'created');
    assert.deepEqual(w.written, ['me@emiactech.com']);
  });

  /*
   * Found in cold review: the writer validated with `parseMailRule({match,
   * action, destination})` and then wrote `judge` anyway — so a routed rule
   * with a question saved cleanly and only failed later, when the *worker*
   * re-parsed the stored row. The member was told the rule was active; it then
   * reported itself broken and matched nothing.
   */
  it('refuses a routing table that also carries a question, at write time', async () => {
    const w = writer();
    const outcome = await create(w, {
      ...REQUEST,
      destination: {
        type: 'routed',
        routes: [
          { key: 'invoices', when: 'an invoice', destination: { type: 'email', email: 'anish@emiactech.com' } },
          { key: 'product', when: 'the product', destination: { type: 'email', email: 'rdx@emiactech.com' } },
        ],
        otherwise: 'hold',
      },
      judge: { question: 'Is this really from the client?' },
    });
    assert.notEqual(outcome.status, 'created');
    assert.deepEqual(w.written, []);
  });

  /*
   * Also cold review: chat grounding was written against a top-level
   * `lark_chat`, so a routing table's chats — one level down — were never
   * checked. The worker re-checks and abandons rather than delivering, so
   * nothing reached another company; what was lost was the refusal happening
   * while somebody was still looking at the form.
   */
  it('grounds every Lark chat in a routing table, not only a top-level one', async () => {
    const asked: string[] = [];
    const w = writer({
      authorizeLarkChat: async ({ chatId }) => {
        asked.push(chatId);
        return chatId === 'oc_bad'
          ? { status: 'not_found' }
          : { status: 'allowed' };
      },
    });
    const outcome = await w.instance.create({
      ...REQUEST,
      destination: {
        type: 'routed',
        routes: [
          { key: 'invoices', when: 'an invoice', destination: { type: 'lark_chat', chatId: 'oc_good' } },
          { key: 'product', when: 'the product', destination: { type: 'lark_chat', chatId: 'oc_bad' } },
        ],
        otherwise: 'hold',
      },
    }, { type: 'deliver' });

    assert.equal(outcome.status, 'destination_refused');
    assert.deepEqual(asked, ['oc_good', 'oc_bad']);
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
