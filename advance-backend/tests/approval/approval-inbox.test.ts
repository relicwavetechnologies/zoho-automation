import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '../../src/shared/result.ts';
import { ApprovalInboxService } from '../../src/application/approval/approval-inbox.service.ts';
import type { Logger } from '../../src/shared/logger.ts';

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child() { return this; } } as never;

const APPROVER = { userId: 'user-manager', companyId: 'comp-1', displayName: 'Priya Nair' };

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1',
    companyId: 'comp-1',
    conversationId: 'conv-1',
    runId: 'run-1',
    toolId: 'googleGmail',
    actionGroup: 'send',
    kind: 'tool_action',
    summary: 'Send email',
    payloadJson: { toolId: 'googleGmail', action: 'send', args: { to: ['boss@example.com'], subject: 'Q2' } },
    metadataJson: {
      resolvedManagerUserId: 'user-manager',
      resolvedManagerName: 'Priya Nair',
      requesterEmail: 'aman@example.com',
      departmentName: 'Finance',
    },
    status: 'pending',
    channel: 'desktop',
    requestedBy: 'user-aman',
    approvedBy: null, approvedAt: null, rejectedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    executionResultJson: null, idempotencyKey: 'idem-1', decisionMessageId: null, resolutionReason: null,
    createdAt: new Date('2026-07-26T10:00:00Z'), updatedAt: new Date('2026-07-26T10:00:00Z'),
    ...overrides,
  };
}

function makeService(row: ReturnType<typeof makeRow> | null, opts: { resolveOk?: boolean } = {}) {
  const calls = { resolved: [] as unknown[], resumed: [] as string[], cards: [] as unknown[], audit: [] as any[] };
  const service = new ApprovalInboxService({
    approvals: {
      findById: async () => ok(row),
      atomicResolve: async (id: string, decision: string, by: string) => {
        calls.resolved.push({ id, decision, by });
        return ok(opts.resolveOk === false ? null : { ...row, status: decision });
      },
      listInboxFor: async () => ok({ awaitingMe: row ? [row] : [], requestedByMe: [] }),
    } as never,
    resumer: { resume: async (id: string) => { calls.resumed.push(id); } } as never,
    logger,
    audit: { record: (entry: unknown) => { calls.audit.push(entry); } } as never,
    onResolvedCard: async (messageId, decision, byName, request) => {
      calls.cards.push({ messageId, decision, byName, request });
    },
  });
  return { service, calls };
}

describe('approval inbox — listing', () => {
  it('presents a request in words rather than tool ids', async () => {
    const { service } = makeService(makeRow());
    const inbox = await service.list(APPROVER);

    const item = inbox.awaitingMe[0]!;
    assert.equal(item.description.tool, 'Gmail');
    assert.equal(item.description.title, 'Send email');
    assert.deepEqual(item.description.details[0], { label: 'To', value: 'boss@example.com' });
    assert.equal(item.requestedByName, 'aman@example.com');
    assert.equal(item.departmentName, 'Finance');
  });

  it('returns an empty inbox rather than throwing when the query fails', async () => {
    const service = new ApprovalInboxService({
      approvals: { listInboxFor: async () => ({ ok: false, error: new Error('db down') }) } as never,
      resumer: { resume: async () => {} } as never,
      logger,
    });
    assert.deepEqual(await service.list(APPROVER), { awaitingMe: [], requestedByMe: [] });
  });
});

describe('approval inbox — deciding', () => {
  it('records the decision and resumes the run', async () => {
    const { service, calls } = makeService(makeRow());
    const outcome = await service.decide(APPROVER, 'approval-1', 'approved');

    assert.equal(outcome.ok, true);
    assert.deepEqual(calls.resolved, [{ id: 'approval-1', decision: 'approved', by: 'user-manager' }]);
    assert.deepEqual(calls.resumed, ['approval-1']);
  });

  it('refuses someone the request is not waiting on', async () => {
    const { service, calls } = makeService(makeRow());
    const outcome = await service.decide({ userId: 'user-someone-else', companyId: 'comp-1' }, 'approval-1', 'approved');

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'forbidden');
    assert.equal(calls.resolved.length, 0);
    // The attempt has to survive somewhere an admin can query it.
    assert.equal(calls.audit[0].action, 'approval.inbox.unauthorized_actor');
    assert.equal(calls.audit[0].outcome, 'failure');
  });

  it('refuses the right person in the wrong company', async () => {
    const { service, calls } = makeService(makeRow());
    const outcome = await service.decide({ userId: 'user-manager', companyId: 'comp-other' }, 'approval-1', 'approved');

    assert.equal(outcome.ok === false && outcome.reason, 'forbidden');
    assert.equal(calls.resolved.length, 0);
  });

  it('will not re-decide a request that is already resolved', async () => {
    const { service, calls } = makeService(makeRow({ status: 'approved' }));
    const outcome = await service.decide(APPROVER, 'approval-1', 'rejected');

    assert.equal(outcome.ok === false && outcome.reason, 'already_resolved');
    assert.equal(calls.resolved.length, 0);
  });

  it('will not decide an expired request', async () => {
    const { service } = makeService(makeRow({ expiresAt: new Date(Date.now() - 1000) }));
    const outcome = await service.decide(APPROVER, 'approval-1', 'approved');
    assert.equal(outcome.ok === false && outcome.reason, 'expired');
  });

  it('answers plainly when the request is gone', async () => {
    const { service } = makeService(null);
    const outcome = await service.decide(APPROVER, 'approval-1', 'approved');
    assert.equal(outcome.ok === false && outcome.reason, 'not_found');
  });

  it('accepts a request still in dispatching, as the Lark card handler does', async () => {
    const { service, calls } = makeService(makeRow({ status: 'dispatching' }));
    const outcome = await service.decide(APPROVER, 'approval-1', 'approved');

    assert.equal(outcome.ok, true);
    assert.equal(calls.resolved.length, 1);
  });

  it('stops a delivered card from offering buttons for a decision already made', async () => {
    const { service, calls } = makeService(makeRow({ decisionMessageId: 'om_123', channel: 'lark' }));
    await service.decide(APPROVER, 'approval-1', 'rejected');

    assert.deepEqual(calls.cards, [{
      messageId: 'om_123',
      decision: 'rejected',
      byName: 'Priya Nair',
      request: {
        toolId: 'googleGmail',
        action: 'send',
        args: { to: ['boss@example.com'], subject: 'Q2' },
        summary: 'Send email',
        requesterName: 'aman@example.com',
        authority: 'department_manager',
        departmentName: 'Finance',
      },
    }]);
  });

  it('does not resume a gateway approval — the requester retries it themselves', async () => {
    const { service, calls } = makeService(makeRow({
      metadataJson: { resolvedManagerUserId: 'user-manager', approvalOrigin: 'gateway' },
    }));
    const outcome = await service.decide(APPROVER, 'approval-1', 'approved');

    assert.equal(outcome.ok, true);
    assert.deepEqual(calls.resumed, []);
  });

  it('reports failure without resuming when the atomic resolve loses the race', async () => {
    const { service, calls } = makeService(makeRow(), { resolveOk: false });
    const outcome = await service.decide(APPROVER, 'approval-1', 'approved');

    assert.equal(outcome.ok === false && outcome.reason, 'failed');
    assert.deepEqual(calls.resumed, []);
  });
});
