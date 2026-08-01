import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeMutationError } from '../../src/application/knowledge/knowledge-mutation.errors.ts';
import { assertLiveKnowledgeAuthority } from '../../src/infrastructure/persistence/knowledge-mutation.repository.ts';

const departmentPolicy = {
  id: 'policy-department',
  tenantKey: 'global',
  kind: 'memory' as const,
  scope: 'department' as const,
  action: 'publish' as const,
  requesterReviewRequired: true,
  requiredAuthority: 'department_manager' as const,
  distinctApprover: true,
  enabled: true,
  version: 1,
};

const subject = {
  companyId: 'company-1',
  scope: 'department' as const,
  ownerUserId: null,
  departmentId: 'department-1',
  requesterId: 'requester-1',
  kind: 'memory' as const,
  action: 'publish' as const,
  policyId: departmentPolicy.id,
  policyVersion: departmentPolicy.version,
  requesterReviewRequired: true,
  requiredAuthority: 'department_manager' as const,
  distinctApprover: true,
};

function transaction(options: {
  readonly requesterActive?: boolean;
  readonly departmentMember?: boolean;
  readonly managerActive?: boolean;
  readonly policyVersion?: number;
  readonly policyEnabled?: boolean;
} = {}) {
  return {
    adminMembership: {
      findFirst: async ({ where }: { where: { userId: string } }) =>
        where.userId === subject.requesterId && options.requesterActive !== false
          ? { id: 'company-membership-1' }
          : null,
    },
    departmentMembership: {
      findFirst: async ({ where }: { where: { userId: string } }) => {
        if (where.userId === subject.requesterId) {
          return options.departmentMember === false ? null : { id: 'department-membership-1' };
        }
        return options.managerActive === false ? null : { id: 'manager-membership-1' };
      },
    },
    knowledgePolicy: {
      findMany: async () => [{
        ...departmentPolicy,
        version: options.policyVersion ?? departmentPolicy.version,
        enabled: options.policyEnabled ?? departmentPolicy.enabled,
      }],
    },
  };
}

describe('live knowledge mutation authority', () => {
  it('accepts the exact current policy, requester membership, and manager authority', async () => {
    await assertLiveKnowledgeAuthority(transaction() as never, subject, 'manager-1');
  });

  it('revokes a pending proposal when the requester leaves the company', async () => {
    await rejectsWithCode(
      assertLiveKnowledgeAuthority(transaction({ requesterActive: false }) as never, subject),
      'permission_denied',
    );
  });

  it('revokes a pending department proposal when the requester leaves that department', async () => {
    await rejectsWithCode(
      assertLiveKnowledgeAuthority(transaction({ departmentMember: false }) as never, subject),
      'permission_denied',
    );
  });

  it('requires a new review when policy changes after the card was created', async () => {
    await rejectsWithCode(
      assertLiveKnowledgeAuthority(transaction({ policyVersion: 2 }) as never, subject),
      'policy_changed',
    );
  });

  it('rejects an approver who is no longer the active department manager', async () => {
    await rejectsWithCode(
      assertLiveKnowledgeAuthority(transaction({ managerActive: false }) as never, subject, 'manager-1'),
      'permission_denied',
    );
  });

  it('fails closed when the current policy is disabled', async () => {
    await rejectsWithCode(
      assertLiveKnowledgeAuthority(transaction({ policyEnabled: false }) as never, subject),
      'policy_disabled',
    );
  });
});

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof KnowledgeMutationError, true);
    assert.equal((error as KnowledgeMutationError).code, code);
    return true;
  });
}
