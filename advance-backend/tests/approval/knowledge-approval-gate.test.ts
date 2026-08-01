import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGateService } from '../../src/application/approval/approval-gate.service.ts';
import { asCompanyId, asDepartmentId, asUserId } from '../../src/shared/ids.ts';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role.ts';
import { makeDeniedPerm } from '../tools/tool-test.helpers.ts';
import type { KnowledgeMutationRecord } from '../../src/domain/knowledge/knowledge-mutation.ts';

describe('central knowledge approval gate', () => {
  it('derives department-manager authority from the durable mutation and excludes self', async () => {
    const mutation = knowledgeMutation({
      scope: 'department',
      departmentId: 'dept-1',
      requiredAuthority: 'department_manager',
      requesterReviewedAt: new Date(),
      status: 'awaiting_approval',
    });
    let excludedUserId: string | undefined;
    let adminFallback: boolean | undefined;
    const gate = new ApprovalGateService(
      {} as never,
      {
        resolveManager: async (_departmentId: string, _companyId: string, options: { excludeUserId?: string; allowCompanyAdminFallback?: boolean }) => {
          excludedUserId = options.excludeUserId;
          adminFallback = options.allowCompanyAdminFallback;
          return { userId: 'manager-2', larkOpenId: null, displayName: 'Abhishek Verma' };
        },
      } as never,
      {} as never,
      logger() as never,
      { knowledgeMutations: { get: async () => mutation, attachRuntimeApproval: async () => mutation } },
    );

    const requirement = await gate.inspect({
      toolId: 'knowledge',
      action: 'create',
      args: applyArgs(mutation),
      perm: departmentPerm(),
      runContext: runContext(),
    });

    assert.equal(requirement.kind, 'required');
    assert.equal(requirement.kind === 'required' ? requirement.authority : null, 'department_manager');
    assert.equal(requirement.kind === 'required' ? requirement.approver.displayName : null, 'Abhishek Verma');
    assert.equal(excludedUserId, 'user-1');
    assert.equal(adminFallback, false);
  });

  it('never sends shared knowledge to an approver before requester review', async () => {
    const mutation = knowledgeMutation({
      scope: 'company',
      departmentId: null,
      requiredAuthority: 'company_admin',
      requesterReviewedAt: null,
      status: 'awaiting_requester_review',
    });
    let adminLookups = 0;
    const gate = new ApprovalGateService(
      {} as never,
      { resolveCompanyAdmin: async () => { adminLookups += 1; return null; } } as never,
      {} as never,
      logger() as never,
      { knowledgeMutations: { get: async () => mutation, attachRuntimeApproval: async () => mutation } },
    );
    const result = await gate.inspect({
      toolId: 'knowledge',
      action: 'create',
      args: applyArgs(mutation),
      perm: makeDeniedPerm(),
      runContext: { ...runContext(), departmentId: undefined },
    });

    assert.equal(result.kind, 'misconfigured');
    assert.match(result.kind === 'misconfigured' ? result.message : '', /requester must review/i);
    assert.equal(adminLookups, 0);
  });

  it('binds the RuntimeApproval before delivery so the receipt cannot float', async () => {
    const mutation = knowledgeMutation({
      scope: 'company',
      departmentId: null,
      requiredAuthority: 'company_admin',
      requesterReviewedAt: new Date(),
      status: 'awaiting_approval',
    });
    let attached: Record<string, unknown> | null = null;
    const approval = {
      id: 'approval-1',
      conversationId: 'conversation-1',
      runId: 'run-1',
      toolId: 'knowledge',
      actionGroup: 'create',
      kind: 'tool_action',
      summary: 'Publish reviewed fact',
      payloadJson: {},
      metadataJson: {},
      status: 'pending',
      channel: 'desktop',
      requestedBy: 'user-1',
      approvedBy: null,
      approvedAt: null,
      rejectedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      executionResultJson: null,
      idempotencyKey: 'idem',
      decisionMessageId: null,
      resolutionReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const gate = new ApprovalGateService(
      {
        createOrReuseActive: async () => ({
          ok: true as const,
          value: { approval, created: true, replacedExpired: false },
        }),
        markFailed: async () => ({ ok: true as const, value: approval }),
      } as never,
      {
        resolveUserDisplayName: async () => 'Anish Suman',
        resolveCompanyAdmin: async () => ({
          userId: 'admin-2',
          larkOpenId: null,
          displayName: 'Company Admin',
        }),
      } as never,
      { getStatusMessageId: () => undefined } as never,
      logger() as never,
      {
        knowledgeMutations: {
          get: async () => mutation,
          attachRuntimeApproval: async input => {
            attached = input as unknown as Record<string, unknown>;
            return { ...mutation, runtimeApprovalId: input.approvalId };
          },
        },
      },
    );

    const result = await gate.check({
      toolId: 'knowledge',
      action: 'create',
      args: applyArgs(mutation),
      perm: makeDeniedPerm(),
      runContext: { ...runContext(), departmentId: undefined },
      chatId: 'chat-1',
      argsSummary: 'Publish one reviewed fact to company memory',
    });

    assert.equal(result.kind, 'pending');
    assert.deepEqual(attached, {
      mutationId: mutation.id,
      companyId: mutation.companyId,
      requesterId: mutation.requesterId,
      expectedContentHash: mutation.proposedContentHash,
      approvalId: 'approval-1',
      authority: 'company_admin',
    });
  });
});

function knowledgeMutation(
  patch: Partial<KnowledgeMutationRecord>,
): KnowledgeMutationRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    companyId: 'co-1',
    resourceId: null,
    kind: 'memory',
    scope: 'department',
    targetKey: 'department:dept-1',
    ownerUserId: null,
    departmentId: 'dept-1',
    logicalKey: 'weekly-cutoff',
    action: 'publish',
    baseVersion: null,
    proposedContent: { facts: ['QA cutoff is Friday at 5 PM.'] },
    proposedContentHash: 'a'.repeat(64),
    requesterId: 'user-1',
    requesterReviewRequired: true,
    requesterReviewedAt: new Date(),
    requiredAuthority: 'department_manager',
    distinctApprover: true,
    policyId: 'policy-1',
    policyVersion: 1,
    runtimeApprovalId: null,
    appliedVersionId: null,
    status: 'awaiting_approval',
    idempotencyKey: 'idem-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...patch,
  };
}

function applyArgs(mutation: KnowledgeMutationRecord): Record<string, unknown> {
  return {
    operation: 'apply',
    mutationId: mutation.id,
    contentHash: mutation.proposedContentHash,
    kind: mutation.kind,
    action: mutation.action,
    scope: mutation.scope,
    content: mutation.proposedContent,
    ...(mutation.departmentId ? { departmentId: mutation.departmentId } : {}),
  };
}

function departmentPerm() {
  return {
    ...makeDeniedPerm(),
    department: {
      id: asDepartmentId('dept-1'),
      name: 'Tech Testing',
      roleSlug: 'MEMBER' as never,
      zohoReadScope: 'personalized' as const,
    },
  };
}

function runContext() {
  return {
    companyId: asCompanyId('co-1'),
    userId: asUserId('user-1'),
    companyRole: asCompanyRoleSlug('MEMBER'),
    departmentId: asDepartmentId('dept-1'),
    channel: 'lark' as const,
    chatId: 'chat-1',
  };
}

function logger() {
  const value = {
    child: () => value,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return value;
}
