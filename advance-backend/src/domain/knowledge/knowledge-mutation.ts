import { z } from 'zod';
import type { ResolvedKnowledgeScope } from './knowledge-scope';

export const KnowledgeResourceKindSchema = z.enum(['memory', 'skill', 'file']);
export const KnowledgeMutationActionSchema = z.enum(['create', 'update', 'publish', 'delete']);
export const KnowledgeMutationStatusSchema = z.enum([
  'awaiting_requester_review',
  'awaiting_approval',
  'approved',
  'applying',
  'applied',
  'rejected',
  'cancelled',
  'failed',
  'superseded',
]);
export const KnowledgeApprovalAuthoritySchema = z.enum([
  'none',
  'department_manager',
  'company_admin',
]);

export type KnowledgeResourceKind = z.infer<typeof KnowledgeResourceKindSchema>;
export type KnowledgeMutationAction = z.infer<typeof KnowledgeMutationActionSchema>;
export type KnowledgeMutationStatus = z.infer<typeof KnowledgeMutationStatusSchema>;
export type KnowledgeApprovalAuthority = z.infer<typeof KnowledgeApprovalAuthoritySchema>;

export interface KnowledgeTargetIdentity {
  readonly companyId: string;
  readonly scope: 'personal' | 'department' | 'company';
  readonly targetKey: string;
  readonly ownerUserId: string | null;
  readonly departmentId: string | null;
}

export interface KnowledgePolicySnapshot {
  readonly id: string;
  readonly tenantKey: string;
  readonly kind: KnowledgeResourceKind;
  readonly scope: KnowledgeTargetIdentity['scope'];
  readonly action: KnowledgeMutationAction;
  readonly requesterReviewRequired: boolean;
  readonly requiredAuthority: KnowledgeApprovalAuthority;
  readonly distinctApprover: boolean;
  readonly enabled: boolean;
  readonly version: number;
}

export interface KnowledgeMutationRecord {
  readonly id: string;
  readonly companyId: string;
  readonly resourceId: string | null;
  readonly kind: KnowledgeResourceKind;
  readonly scope: KnowledgeTargetIdentity['scope'];
  readonly targetKey: string;
  readonly ownerUserId: string | null;
  readonly departmentId: string | null;
  readonly logicalKey: string;
  readonly action: KnowledgeMutationAction;
  readonly baseVersion: number | null;
  readonly proposedContent: unknown | null;
  readonly proposedContentHash: string | null;
  readonly requesterId: string;
  readonly requesterReviewRequired: boolean;
  readonly requesterReviewedAt: Date | null;
  readonly requiredAuthority: KnowledgeApprovalAuthority;
  readonly distinctApprover: boolean;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly runtimeApprovalId: string | null;
  readonly appliedVersionId: string | null;
  readonly status: KnowledgeMutationStatus;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function knowledgeTargetIdentity(target: ResolvedKnowledgeScope): KnowledgeTargetIdentity {
  if (target.scope === 'personal') {
    return {
      companyId: String(target.companyId),
      scope: 'personal',
      targetKey: `personal:${String(target.userId)}`,
      ownerUserId: String(target.userId),
      departmentId: null,
    };
  }
  if (target.scope === 'department') {
    return {
      companyId: String(target.companyId),
      scope: 'department',
      targetKey: `department:${String(target.departmentId)}`,
      ownerUserId: null,
      departmentId: String(target.departmentId),
    };
  }
  return {
    companyId: String(target.companyId),
    scope: 'company',
    targetKey: 'company',
    ownerUserId: null,
    departmentId: null,
  };
}

export function initialKnowledgeMutationStatus(
  policy: KnowledgePolicySnapshot,
): KnowledgeMutationStatus {
  if (policy.requesterReviewRequired) return 'awaiting_requester_review';
  if (policy.requiredAuthority !== 'none') return 'awaiting_approval';
  return 'approved';
}

export function statusAfterRequesterReview(
  policy: Pick<KnowledgePolicySnapshot, 'requiredAuthority'>,
): Extract<KnowledgeMutationStatus, 'awaiting_approval' | 'approved'> {
  return policy.requiredAuthority === 'none' ? 'approved' : 'awaiting_approval';
}

/**
 * A reviewed create is a publication, not an invisible draft.
 *
 * Every procedure and file has already crossed requester review before it is
 * applied. Leaving a newly created procedure in `draft` after that point makes
 * a successful review impossible to recall in a later session.
 */
export function knowledgeResourceStatusAfterMutation(
  current: 'draft' | 'active' | 'archived' | 'deleted',
  action: KnowledgeMutationAction,
): 'draft' | 'active' | 'archived' | 'deleted' {
  if (action === 'create' || action === 'publish') return 'active';
  return current;
}

export function validateKnowledgePolicy(policy: KnowledgePolicySnapshot): string | null {
  if (!Number.isInteger(policy.version) || policy.version < 1) return 'Policy version must be a positive integer.';
  if (policy.scope === 'department' && policy.requiredAuthority !== 'department_manager') {
    return 'Department knowledge must require department-manager approval.';
  }
  if (policy.scope === 'company' && policy.requiredAuthority !== 'company_admin') {
    return 'Company knowledge must require company-admin approval.';
  }
  if (policy.scope !== 'personal' && !policy.requesterReviewRequired) {
    return 'Shared knowledge must require requester review before authority approval.';
  }
  if (policy.scope !== 'personal' && !policy.distinctApprover) {
    return 'Shared knowledge must require an approver other than the requester.';
  }
  if (policy.scope === 'personal' && policy.requiredAuthority !== 'none') {
    return 'Personal knowledge cannot be delegated to a shared-scope approver.';
  }
  if (
    policy.scope === 'personal'
    && policy.kind !== 'memory'
    && !policy.requesterReviewRequired
  ) {
    return 'Personal skills and files must be reviewed by their owner before mutation.';
  }
  return null;
}
