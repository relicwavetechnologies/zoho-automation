import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  KNOWLEDGE_SKILL_REVIEW_ROW_KIND,
  KnowledgeSkillReviewService,
} from '../../src/application/knowledge/knowledge-skill-review.service.ts';
import type { KnowledgeMutationRecord } from '../../src/domain/knowledge/knowledge-mutation.ts';
import { makeDeniedPerm, noopLogger } from '../tools/tool-test.helpers.ts';

const contentHash = 'a'.repeat(64);

describe('durable knowledge skill review lifecycle', () => {
  it('lets the current department manager confirm and apply their own skill once', async () => {
    const test = setup({ managerId: 'user-1' });

    const outcome = await test.service.decide({
      actor: actor(),
      row: reviewRow(),
      answer: approvedAnswer(),
      verdict: 'approved',
      summary: 'Approve',
    });

    assert.equal(outcome.ok, true);
    assert.deepEqual(test.calls, [
      'settle:approved',
      'persist-answer',
      'resolve-manager',
      'attach-approval',
      'accept-approval',
      'apply',
      'project',
      'complete',
    ]);
    assert.equal(
      outcome.ok ? (outcome.execution as { status?: string }).status : null,
      'applied',
    );
  });

  it('cancels a rejected requester review without resolving authority or applying', async () => {
    const test = setup({ managerId: 'user-1' });

    const outcome = await test.service.decide({
      actor: actor(),
      row: reviewRow(),
      answer: rejectedAnswer(),
      verdict: 'rejected',
      summary: 'Reject',
    });

    assert.equal(outcome.ok, true);
    assert.deepEqual(test.calls, ['settle:rejected', 'persist-answer', 'persist-result']);
    assert.equal(outcome.ok ? outcome.verdict : null, 'rejected');
  });

  it('reports projection failure as queued without claiming the revision is active', async () => {
    const test = setup({ managerId: 'user-1', projectionFails: true });

    const outcome = await test.service.decide({
      actor: actor(),
      row: reviewRow(),
      answer: approvedAnswer(),
      verdict: 'approved',
      summary: 'Approve',
    });

    assert.equal(outcome.ok, true);
    assert.equal(
      outcome.ok ? (outcome.execution as { status?: string }).status : null,
      'projection_queued',
    );
    assert.match(
      outcome.ok ? String((outcome.execution as { message?: string }).message) : '',
      /still queued/i,
    );
  });

  it('hands a terminal Lark result to recoverable outcome delivery', async () => {
    const test = setup({ managerId: 'user-1' });

    const outcome = await test.service.decide({
      actor: actor('lark'),
      row: reviewRow('lark'),
      answer: approvedAnswer(),
      verdict: 'approved',
      summary: 'Approve',
    });

    assert.equal(outcome.ok, true);
    assert.deepEqual(test.deliveredDecisions, ['decision-1']);
  });

  it('forwards completed, rejected, and failed authority outcomes to the mutation owner', async () => {
    const test = setup({ managerId: 'manager-2' });
    for (const status of ['completed', 'rejected', 'failed'] as const) {
      assert.equal(await test.service.settleLinkedOutcome({
        parentDecisionId: 'decision-1',
        approvalId: `approval-${status}`,
        status,
        result: { status },
      }), true);
    }

    assert.deepEqual(test.authorityStatuses, ['completed', 'rejected', 'failed']);
  });
});

function setup(options: { managerId: string; projectionFails?: boolean }) {
  const calls: string[] = [];
  const authorityStatuses: string[] = [];
  const deliveredDecisions: string[] = [];
  const mutation = reviewMutation();
  const accepted = { ...mutation, status: 'approved' as const };
  const service = new KnowledgeSkillReviewService({
    mutations: {
      settleRequesterDecision: async (input: { decision: string }) => {
        calls.push(`settle:${input.decision}`);
        return {
          mutation: input.decision === 'approved'
            ? mutation
            : { ...mutation, status: 'cancelled' as const },
          decisionStatus: input.decision === 'approved' ? 'executing' : 'rejected',
          replayed: false,
        };
      },
      attachRuntimeApproval: async () => { calls.push('attach-approval'); return mutation; },
      acceptRuntimeApproval: async () => { calls.push('accept-approval'); return accepted; },
      apply: async () => {
        calls.push('apply');
        return {
          mutation: { ...accepted, status: 'applied' as const },
          resourceId: 'resource-1',
          versionId: 'version-2',
          version: 2,
          outboxEventId: 'outbox-1',
        };
      },
      settleAuthorityDecision: async (input: { status: string }) => {
        authorityStatuses.push(input.status);
        return { mutation, parentStatus: 'consumed', replayed: false };
      },
    },
    projections: {
      projectMutation: async () => {
        calls.push('project');
        if (options.projectionFails) throw new Error('projection unavailable');
      },
    },
    approvals: {
      persistAnswer: async () => { calls.push('persist-answer'); return { ok: true, value: true }; },
      persistResult: async () => { calls.push('persist-result'); return { ok: true, value: true }; },
      completeApprovedExecution: async () => { calls.push('complete'); return { ok: true, value: true }; },
      findById: async () => ({ ok: true, value: reviewRow() }),
    },
    permissions: {
      resolve: async () => ({
        ok: true,
        value: {
          ...makeDeniedPerm(),
          department: {
            id: 'dept-1',
            name: 'Finance',
            roleSlug: 'MANAGER',
            zohoReadScope: 'personalized',
          },
        },
      }),
    },
    approvalResolver: {
      resolveManager: async () => {
        calls.push('resolve-manager');
        return {
          userId: options.managerId,
          larkOpenId: null,
          displayName: 'Manager',
        };
      },
    },
    tools: { executeForRuntime: async () => { throw new Error('unexpected authority path'); } },
    decisions: {},
    resources: {},
    approvalGate: {},
    outcomeDelivery: {
      deliver: async (decisionId: string) => { deliveredDecisions.push(decisionId); },
      deliverPending: async () => {},
    },
    logger: noopLogger,
  } as never);
  return { service, calls, authorityStatuses, deliveredDecisions };
}

function reviewMutation(): KnowledgeMutationRecord {
  return {
    id: 'mutation-1',
    companyId: 'company-1',
    resourceId: 'resource-1',
    kind: 'skill',
    scope: 'department',
    targetKey: 'department:dept-1',
    ownerUserId: null,
    departmentId: 'dept-1',
    logicalKey: 'cursor-design-html',
    action: 'update',
    baseVersion: 1,
    proposedContent: {
      name: 'Cursor Design HTML',
      slug: 'cursor-design-html',
      summary: 'Build HTML interfaces.',
      markdown: '# Cursor Design HTML\n\nUpdated.',
      toolIds: [],
      tags: ['design'],
    },
    proposedContentHash: contentHash,
    requesterId: 'user-1',
    requesterReviewRequired: true,
    requesterReviewedAt: new Date(),
    requiredAuthority: 'department_manager',
    distinctApprover: false,
    policyId: 'policy-1',
    policyVersion: 2,
    runtimeApprovalId: null,
    appliedVersionId: null,
    status: 'awaiting_approval',
    idempotencyKey: 'idem-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function reviewRow(channel: 'web' | 'lark' = 'web') {
  const sourceChatId = channel === 'lark' ? 'oc_finance' : 'web_thread-1';
  return {
    id: 'decision-1',
    companyId: 'company-1',
    conversationId: 'conversation-1',
    runId: 'runtime-run-1',
    toolId: 'knowledge',
    actionGroup: 'update',
    kind: KNOWLEDGE_SKILL_REVIEW_ROW_KIND,
    summary: 'Update Cursor Design HTML',
    payloadJson: {
      args: {
        operation: 'apply',
        mutationId: 'mutation-1',
        contentHash,
        kind: 'skill',
        action: 'update',
        scope: 'department',
        departmentId: 'dept-1',
      },
    },
    metadataJson: {
      departmentId: 'dept-1',
      sourceChannel: channel,
      sourceChatId,
      ...(channel === 'lark' ? { requesterLarkOpenId: 'ou_manager' } : {}),
      execution: {
        version: 1,
        threadId: channel === 'lark' ? 'lark_thread-1' : 'web_thread-1',
        runId: 'run-1',
        actionId: 'action-1',
      },
    },
    status: 'pending',
    channel,
    requestedBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;
}

function actor(channel: 'web' | 'lark' = 'web') {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    displayName: 'Manager',
    member: {
      companyId: 'company-1',
      userId: 'user-1',
      aiRole: 'COMPANY_ADMIN',
      channel,
      email: 'manager@example.com',
      runtimeChatId: channel === 'lark' ? 'oc_finance' : 'web_thread-1',
      runtimeRunId: 'run-1',
      runtimeThreadId: channel === 'lark' ? 'lark_thread-1' : 'web_thread-1',
      ...(channel === 'lark' ? { larkOpenId: 'ou_manager', larkTenantKey: 'tenant-1' } : {}),
      sessionId: 'session-1',
    },
  } as never;
}

function approvedAnswer() {
  return { responses: [{ questionId: 'confirm', chose: ['yes'] }] };
}

function rejectedAnswer() {
  return { responses: [{ questionId: 'confirm', chose: ['no'] }] };
}
