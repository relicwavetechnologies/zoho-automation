import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BusinessActionService } from '../../src/application/approval/business-action.service.ts';
import type { PreparedToolInvocation, ToolExecutor } from '../../src/application/gateway/tool-executor.ts';
import type { GatewayMemberContext, GatewayResponse } from '../../src/application/gateway/gateway.types.ts';
import { noopLogger } from '../tools/tool-test.helpers.ts';
import { InMemoryBusinessActionApprovals } from './business-action.test-support.ts';

const member: GatewayMemberContext = {
  companyId: 'company-1',
  userId: 'user-1',
  aiRole: 'MEMBER',
  email: 'user@example.com',
  larkOpenId: null,
  sessionId: 'session-1',
  channel: 'desktop',
};

const prepared: PreparedToolInvocation = {
  toolId: 'zohoBooks',
  action: 'create',
  args: { operation: 'create_bill', vendorId: 'vendor-1', total: 17107.75 },
};

function harness(invoke: (input: Parameters<ToolExecutor['invoke']>[0]) => Promise<GatewayResponse>) {
  const approvals = new InMemoryBusinessActionApprovals();
  const actions = new BusinessActionService({
    approvals: approvals.asRepository(),
    toolExecutor: { invoke } as ToolExecutor,
    logger: noopLogger,
  });
  return { actions, approvals };
}

describe('BusinessActionService', () => {
  it('stores one durable requester decision and executes its exact payload once', async () => {
    const invoked: unknown[] = [];
    const { actions, approvals } = harness(async input => {
      invoked.push(input);
      return { ok: true, status: 'success', data: { result: { billId: 'bill-1' } } };
    });
    const execution = { version: 1 as const, threadId: 'web_thread', runId: 'run-1', actionId: 'call-1' };

    const first = await actions.prepare({ member, prepared, execution });
    const second = await actions.prepare({ member, prepared, execution });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(approvals.rows.size, 1);
    const actionId = (first.data as { intentId: string }).intentId;
    assert.equal((second.data as { intentId: string }).intentId, actionId);
    assert.equal(approvals.rows.get(actionId)?.status, 'pending');

    const decided = await actions.decide({ member, actionId, decision: 'approved' });
    assert.equal(decided.handled, true);
    assert.equal(decided.handled && decided.response.status, 'success');
    assert.equal(invoked.length, 1);
    assert.deepEqual((invoked[0] as { args: unknown }).args, prepared.args);
    assert.equal(approvals.rows.get(actionId)?.status, 'consumed');

    const replay = await actions.decide({ member, actionId, decision: 'approved' });
    assert.equal(replay.handled, true);
    assert.equal(replay.handled && replay.response.status, 'success');
    assert.equal(invoked.length, 1);
  });

  it('moves the same action into governance and requests automatic exact resume', async () => {
    const invoked: Array<Parameters<ToolExecutor['invoke']>[0]> = [];
    const pending: GatewayResponse = {
      ok: false,
      status: 'approval_required',
      error: { code: 'approval_required', message: 'Waiting for Finance Manager.' },
      approval: {
        approvalId: 'manager-approval-1',
        message: 'Waiting for Finance Manager.',
        status: 'pending',
        authority: 'department_manager',
        approverName: 'Finance Manager',
        scope: 'once',
        requestState: 'created',
        nextAction: 'wait',
        retry: 'retry_exact',
      },
    };
    const { actions, approvals } = harness(async input => {
      invoked.push(input);
      return pending;
    });
    const created = await actions.prepare({ member, prepared });
    const actionId = (created.data as { intentId: string }).intentId;

    const decided = await actions.decide({ member, actionId, decision: 'approved' });

    assert.equal(decided.handled && decided.response.status, 'approval_required');
    assert.equal(approvals.rows.get(actionId)?.status, 'awaiting_governance');
    assert.equal(invoked[0]?.resumeOnApproval, true);
    assert.equal(invoked[0]?.parentBusinessActionId, actionId);
  });

  it('allows only the requester to decide and records cancellation without execution', async () => {
    let executions = 0;
    const { actions, approvals } = harness(async () => {
      executions += 1;
      return { ok: true, status: 'success', data: {} };
    });
    const created = await actions.prepare({ member, prepared });
    const actionId = (created.data as { intentId: string }).intentId;
    const stranger = { ...member, userId: 'user-2', email: 'other@example.com' };

    const forbidden = await actions.decide({ member: stranger, actionId, decision: 'approved' });
    assert.equal(forbidden.handled && forbidden.response.status, 'permission_denied');

    const rejected = await actions.decide({ member, actionId, decision: 'rejected' });
    assert.equal(rejected.handled && rejected.response.status, 'approval_rejected');
    assert.equal(approvals.rows.get(actionId)?.status, 'rejected');
    assert.equal(executions, 0);
  });
});
