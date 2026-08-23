import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forecastGate, type GateForecastInput, type GatePolicy } from '../../src/domain/approval/gate-forecast';
import { personalGateFrom } from '../../src/domain/approval/personal-gate';
import { checkApprovalPolicy } from '../../src/application/approval/approval-policy';

const GATED: GatePolicy = {
  enabled: true,
  requiredActions: [{ toolId: 'larkCalendar', actions: ['create', 'update'] }],
};

const base: GateForecastInput = {
  toolId: 'larkCalendar',
  action: 'create',
  policy: GATED,
  channel: 'web',
  askerIsApprover: false,
  selfBypassDisabled: false,
  personal: null,
  approverExists: true,
};

describe('forecastGate', () => {
  it('never gates a read, whatever the policy says', () => {
    assert.deepEqual(
      forecastGate({ ...base, action: 'read' }),
      { kind: 'immediate', because: 'read' },
    );
  });

  it('runs straight away when the department has no policy or has it off', () => {
    assert.deepEqual(
      forecastGate({ ...base, policy: null }),
      { kind: 'immediate', because: 'no_policy' },
    );
    assert.deepEqual(
      forecastGate({ ...base, policy: { ...GATED, enabled: false } }),
      { kind: 'immediate', because: 'no_policy' },
    );
  });

  it('separates "your team gates nothing" from "your team gates other things"', () => {
    // Two different sentences for the reader, so somebody whose team does use
    // approvals is not told approvals are off.
    assert.deepEqual(
      forecastGate({ ...base, toolId: 'larkTask' }),
      { kind: 'immediate', because: 'not_listed' },
    );
  });

  it('asks the approver when the asker is somebody else', () => {
    assert.deepEqual(forecastGate(base), { kind: 'approver_says_yes' });
  });

  it('runs for the approver themselves, and says that is why', () => {
    // The case that had Abhishek ticking gates and seeing nothing happen.
    assert.deepEqual(
      forecastGate({ ...base, askerIsApprover: true }),
      { kind: 'immediate', because: 'self_bypass' },
    );
  });

  it('stops bypassing when the test flag disables it', () => {
    assert.deepEqual(
      forecastGate({ ...base, askerIsApprover: true, selfBypassDisabled: true }),
      { kind: 'approver_says_yes' },
    );
  });

  it('reports a gate with nobody to answer it as blocked, not as approved', () => {
    assert.deepEqual(
      forecastGate({ ...base, approverExists: false }),
      { kind: 'blocked', because: 'no_approver' },
    );
  });

  it('does not call it a bypass when nothing was gated in the first place', () => {
    // Somebody who is the approver for an action nobody gated is not bypassing
    // anything, and saying so would imply a rule that does not exist.
    assert.deepEqual(
      forecastGate({ ...base, toolId: 'larkTask', askerIsApprover: true }),
      { kind: 'immediate', because: 'not_listed' },
    );
  });

  it('confirms the actions somebody picked, whatever their team gates', () => {
    // The personal gate. It beats every other outcome including self-bypass,
    // which is the only way an approver ever sees their own actions.
    assert.deepEqual(
      forecastGate({ ...base, toolId: 'larkTask', personal: personalGateFrom(false, [['larkTask', 'create']]) }),
      { kind: 'you_confirm', because: 'you_picked' },
    );
    assert.deepEqual(
      forecastGate({ ...base, askerIsApprover: true, personal: personalGateFrom(true, []) }),
      { kind: 'you_confirm', because: 'you_picked' },
    );
  });

  it('leaves the actions they did not pick exactly as they were', () => {
    /* The reason this stopped being one boolean. Picking Lark Task must not
       change the forecast for Lark Calendar, or the page is back to offering a
       choice between no interruptions and all of them. */
    const personal = personalGateFrom(false, [['larkTask', 'create']]);
    assert.deepEqual(forecastGate({ ...base, personal }), { kind: 'approver_says_yes' });
    assert.deepEqual(
      forecastGate({ ...base, toolId: 'zohoBooks', personal }),
      { kind: 'immediate', because: 'not_listed' },
    );
  });

  it('still never asks about a read, even having picked everything', () => {
    assert.deepEqual(
      forecastGate({ ...base, action: 'read', personal: personalGateFrom(true, []) }),
      { kind: 'immediate', because: 'read' },
    );
  });

  it('puts personal confirmation ahead of the manager gate on channels that have it', () => {
    // Desktop confirms with the requester before central governance is reached,
    // so the forecast has to say so rather than showing the manager's gate.
    assert.deepEqual(
      forecastGate({ ...base, channel: 'desktop' }),
      { kind: 'you_confirm', because: 'channel' },
    );
  });

  it('agrees with the runtime rule about what is gated', () => {
    /*
     * The assertion the whole module exists for. `checkApprovalPolicy` is what
     * actually stops a tool call; this walks the same cases through both and
     * fails if they ever disagree about gating. Without it the screen is a
     * second copy of the rules, correct until the first time one of them moves.
     *
     * Only the gating half is compared. Self-bypass and approver existence are
     * decided above `checkApprovalPolicy`, in the gate service, and are covered
     * by the cases above.
     */
    const cases = [
      { toolId: 'larkCalendar', action: 'create' as const, policy: GATED },
      { toolId: 'larkCalendar', action: 'delete' as const, policy: GATED },
      { toolId: 'larkTask', action: 'create' as const, policy: GATED },
      { toolId: 'larkCalendar', action: 'create' as const, policy: { ...GATED, enabled: false } },
      { toolId: 'zohoBooks', action: 'create' as const, policy: {
        enabled: true, requiredActions: [], requiredToolIds: ['zohoBooks'],
      } },
      { toolId: 'gmail', action: 'send' as const, policy: {
        enabled: true, requiredActions: [], requiredActionGroups: ['send'],
      } },
    ];

    for (const testCase of cases) {
      const runtime = checkApprovalPolicy({
        toolId: testCase.toolId,
        action: testCase.action,
        args: { any: 'thing' },
        perm: { department: { managerApprovalJson: testCase.policy } } as never,
        runContext: { approvalGrants: [] } as never,
      });
      const forecast = forecastGate({
        ...base,
        toolId: testCase.toolId,
        action: testCase.action,
        policy: testCase.policy,
      });
      const forecastGates = forecast.kind === 'approver_says_yes';

      assert.equal(
        forecastGates,
        runtime.required,
        `disagreed on ${testCase.toolId}:${testCase.action} — runtime ${runtime.required}, forecast ${forecast.kind}`,
      );
    }
  });
});
