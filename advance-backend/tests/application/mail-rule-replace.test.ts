import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMailRuleWriter } from '../../src/application/mail-ops/mail-rule-writer';

/**
 * Editing a rule is not a lesser act than creating one.
 *
 * The property these pin is the one that made `replace` share `prepare` with
 * `create` rather than growing its own sequence: without it, an edit is a way
 * to reach in two steps a rule the first step refused. Build an internal
 * forward, which needs nobody's approval; then edit the address to one outside
 * the company. Every check below is that same door, tried from the edit side.
 */

const ACTOR = { companyId: 'c1', userId: 'u1', ruleId: 'r1' } as const;

const REQUEST = {
  ...ACTOR,
  name: 'Forward to the accountant',
  match: { from: '@acme.com' },
  destination: { type: 'email', email: 'books@vendor-cpa.com' },
  requesterEmail: 'abhishek@emiactech.com',
} as const;

const FORWARD = { type: 'forward' } as const;

/** Everything green, so each test can break exactly one thing. */
const deps = (over: Record<string, unknown> = {}) => ({
  runtime: { pubsubConfigured: true, workersEnabled: true },
  resolveConnection: async () => ({
    status: 'resolved' as const,
    connectionId: 'k1',
    mailboxEmail: 'abhishek@emiactech.com',
  }),
  repo: {
    setRuleStatus: async () => ({ ok: true as const, value: true }),
    createRuleForMailbox: async () => ({
      ok: true as const,
      value: { ruleId: 'r-new', subscriptionId: 's1' },
    }),
    replaceRule: async () => ({ ok: true as const, value: 'replaced' as const }),
  },
  ...over,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const write = (over: Record<string, unknown> = {}) => createMailRuleWriter(deps(over) as any);

describe('editing a mail rule', () => {
  it('asks the same approver a create would, for a forward that leaves the company', async () => {
    let asked = 0;
    const writer = write({
      externalForward: {
        resolveManager: async () => {
          asked += 1;
          return { userId: 'u-mgr', displayName: 'Shivam' };
        },
      },
    });

    const outcome = await writer.replace(
      { ...REQUEST, departmentId: 'd1' } as never,
      FORWARD,
    );

    assert.equal(asked, 1, 'the edit must reach the external-forward gate');
    assert.equal(outcome.status, 'external_approval_required');
    if (outcome.status === 'external_approval_required') {
      assert.equal(outcome.destination, 'books@vendor-cpa.com');
      assert.equal(outcome.approver.displayName, 'Shivam');
      // Carried so the approved edit binds to the account the member was
      // looking at rather than whichever one re-resolves first.
      assert.equal(outcome.mailboxEmail, 'abhishek@emiactech.com');
    }
  });

  it('does not write when the gate defers it', async () => {
    let written = 0;
    const writer = write({
      externalForward: { resolveManager: async () => ({ userId: 'u-mgr', displayName: 'Shivam' }) },
      repo: {
        ...deps().repo,
        replaceRule: async () => { written += 1; return { ok: true as const, value: 'replaced' as const }; },
      },
    });

    await writer.replace({ ...REQUEST, departmentId: 'd1' } as never, FORWARD);
    assert.equal(written, 0, 'a deferred edit must leave the stored rule alone');
  });

  it('lets an edit inside the company through without asking anybody', async () => {
    let asked = 0;
    const writer = write({
      externalForward: {
        resolveManager: async () => { asked += 1; return { userId: 'u-mgr', displayName: 'Shivam' }; },
      },
    });

    const outcome = await writer.replace(
      {
        ...REQUEST,
        departmentId: 'd1',
        destination: { type: 'email', email: 'anish@emiactech.com' },
      } as never,
      FORWARD,
    );

    assert.equal(asked, 0);
    assert.equal(outcome.status, 'replaced');
  });

  it('refuses a Lark room this company has never been in', async () => {
    const writer = write({
      authorizeLarkChat: async () => ({ status: 'unknown_chat' as const }),
    });

    const outcome = await writer.replace(
      { ...REQUEST, destination: { type: 'lark_chat', chatId: 'oc_x' } } as never,
      { type: 'deliver' } as never,
    );

    assert.equal(outcome.status, 'destination_refused');
  });

  it('refuses when the workers are off, rather than saving a rule that cannot run', async () => {
    const writer = write({ runtime: { pubsubConfigured: true, workersEnabled: false } });
    const outcome = await writer.replace(REQUEST as never, FORWARD);
    assert.equal(outcome.status, 'not_configured');
  });

  it('keeps the two collisions apart, because their remedies are opposites', async () => {
    for (const value of ['duplicate', 'duplicate_archived'] as const) {
      const writer = write({
        repo: { ...deps().repo, replaceRule: async () => ({ ok: true as const, value }) },
      });
      const outcome = await writer.replace(REQUEST as never, FORWARD);
      assert.equal(outcome.status, value);
    }
  });

  it('reports a rule that is not yours as not found', async () => {
    const writer = write({
      repo: { ...deps().repo, replaceRule: async () => ({ ok: true as const, value: 'not_found' as const }) },
    });
    const outcome = await writer.replace(REQUEST as never, FORWARD);
    assert.equal(outcome.status, 'not_found');
  });

  /*
   * Archived and missing are different answers, and the member can tell.
   *
   * The repository's lookup excludes archived rules, so editing one used to
   * report "not found in your account" about a rule sitting in that member's
   * own list under Archived. Archiving is final by design, so the honest answer
   * names that — and its remedy is a new rule, not a retry.
   */
  it('says archived rather than not found, because the remedies differ', async () => {
    const writer = write({
      repo: { ...deps().repo, replaceRule: async () => ({ ok: true as const, value: 'archived' as const }) },
    });
    const outcome = await writer.replace(REQUEST as never, FORWARD);
    assert.equal(outcome.status, 'archived');
  });

  /*
   * Editing a paused rule starts it again — deliberate, and documented in the
   * tool's own instructions, but done in silence by the browser. A member who
   * paused a rule because it misbehaved and then corrected it got no hint that
   * their mail was moving again.
   */
  it('reports that an edit took the rule off pause', async () => {
    const writer = write({
      repo: {
        ...deps().repo,
        replaceRule: async () => ({ ok: true as const, value: 'replaced_and_resumed' as const }),
      },
    });
    const outcome = await writer.replace(REQUEST as never, FORWARD);
    assert.equal(outcome.status, 'replaced');
    assert.equal(outcome.status === 'replaced' && outcome.resumed, true);
  });

  it('does not claim a running rule was resumed', async () => {
    const writer = write({
      repo: { ...deps().repo, replaceRule: async () => ({ ok: true as const, value: 'replaced' as const }) },
    });
    const outcome = await writer.replace(REQUEST as never, FORWARD);
    assert.equal(outcome.status === 'replaced' && outcome.resumed, false);
  });

  it('says editing is unavailable rather than throwing where the repo cannot do it', async () => {
    const bare = deps();
    delete (bare.repo as Record<string, unknown>)['replaceRule'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await createMailRuleWriter(bare as any).replace(REQUEST as never, FORWARD);
    assert.equal(outcome.status, 'unavailable');
  });
});

/**
 * Stopping and restarting a rule, and the answer archiving deserves.
 *
 * Here rather than in its own file because `setStatus` shares this writer and
 * these deps with `replace` — and because the defect was that the two disagreed
 * about what an archived rule is. `replace` said "archived"; pause and resume
 * said "not found in your account" about a rule sitting in the member's own
 * Archived list.
 */
describe('pausing, resuming and archiving', () => {
  const status = (value: boolean | 'archived') => write({
    repo: { ...deps().repo, setRuleStatus: async () => ({ ok: true as const, value }) },
  });

  it('says archived rather than not found, on the buttons too', async () => {
    const outcome = await status('archived').setStatus(ACTOR as never, 'resume');
    assert.equal(outcome.status, 'archived');
  });

  it('still says not found when there is no such rule', async () => {
    const outcome = await status(false).setStatus(ACTOR as never, 'pause');
    assert.equal(outcome.status, 'not_found');
  });

  it('reports the change when one was made', async () => {
    const outcome = await status(true).setStatus(ACTOR as never, 'pause');
    assert.equal(outcome.status, 'changed');
  });

  /*
   * Resume is the one that claims a rule will fire again, so it is the one that
   * has to check there is anything to fire it. Pause and archive make a rule do
   * less and are true whatever the workers are doing.
   */
  it('refuses to claim a resume into an environment with no workers', async () => {
    const writer = write({ runtime: { pubsubConfigured: true, workersEnabled: false } });
    assert.equal((await writer.setStatus(ACTOR as never, 'resume')).status, 'not_configured');
    assert.notEqual((await writer.setStatus(ACTOR as never, 'pause')).status, 'not_configured');
  });
});
