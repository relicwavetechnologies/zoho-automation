import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialKnowledgeMutationStatus,
  knowledgeResourceStatusAfterMutation,
  knowledgeTargetIdentity,
  validateKnowledgePolicy,
  type KnowledgePolicySnapshot,
} from '../../src/domain/knowledge/knowledge-mutation.ts';

describe('knowledge mutation policy invariants', () => {
  it('makes every successfully reviewed create visible immediately', () => {
    assert.equal(knowledgeResourceStatusAfterMutation('draft', 'create'), 'active');
    assert.equal(knowledgeResourceStatusAfterMutation('draft', 'publish'), 'active');
    assert.equal(knowledgeResourceStatusAfterMutation('active', 'update'), 'active');
  });

  it('derives opaque target keys only from authenticated resolved scope', () => {
    assert.deepEqual(knowledgeTargetIdentity({
      scope: 'personal',
      companyId: 'co-1' as never,
      userId: 'user-a' as never,
    }), {
      companyId: 'co-1',
      scope: 'personal',
      targetKey: 'personal:user-a',
      ownerUserId: 'user-a',
      departmentId: null,
    });
    assert.equal(knowledgeTargetIdentity({
      scope: 'department',
      companyId: 'co-1' as never,
      departmentId: 'dept-1' as never,
      departmentName: 'Tech',
    }).targetKey, 'department:dept-1');
    assert.equal(knowledgeTargetIdentity({
      scope: 'company',
      companyId: 'co-1' as never,
    }).targetKey, 'company');
  });

  it('fails closed for shared policies without exact review and authority', () => {
    const base: KnowledgePolicySnapshot = {
      id: 'p1',
      tenantKey: 'global',
      kind: 'memory',
      scope: 'department',
      action: 'publish',
      requesterReviewRequired: true,
      requiredAuthority: 'department_manager',
      distinctApprover: true,
      enabled: true,
      version: 1,
    };
    assert.equal(validateKnowledgePolicy(base), null);
    assert.match(validateKnowledgePolicy({ ...base, requesterReviewRequired: false }) ?? '', /requester review/);
    assert.match(validateKnowledgePolicy({ ...base, requiredAuthority: 'company_admin' }) ?? '', /department-manager/);
    assert.match(validateKnowledgePolicy({ ...base, distinctApprover: false }) ?? '', /other than the requester/);
  });

  it('keeps personal memory approval-free and every personal skill/file mutation owner-reviewed', () => {
    const personalMemory: KnowledgePolicySnapshot = {
      id: 'p-memory', tenantKey: 'global', kind: 'memory', scope: 'personal', action: 'create',
      requesterReviewRequired: false, requiredAuthority: 'none', distinctApprover: false,
      enabled: true, version: 1,
    };
    const personalSkill: KnowledgePolicySnapshot = {
      ...personalMemory,
      id: 'p-skill',
      kind: 'skill',
      action: 'publish',
      requesterReviewRequired: true,
    };
    assert.equal(initialKnowledgeMutationStatus(personalMemory), 'approved');
    assert.equal(initialKnowledgeMutationStatus(personalSkill), 'awaiting_requester_review');
    for (const kind of ['skill', 'file'] as const) {
      for (const action of ['create', 'update', 'publish', 'delete'] as const) {
        const policy: KnowledgePolicySnapshot = {
          ...personalMemory,
          id: `p-${kind}-${action}`,
          kind,
          scope: 'personal',
          action,
          requesterReviewRequired: true,
          requiredAuthority: 'none',
          distinctApprover: false,
        };
        assert.equal(validateKnowledgePolicy(policy), null);
        assert.equal(initialKnowledgeMutationStatus(policy), 'awaiting_requester_review');
      }
    }
  });
});
