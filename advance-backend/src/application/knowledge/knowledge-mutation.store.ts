import type {
  KnowledgeApprovalAuthority,
  KnowledgeMutationAction,
  KnowledgeMutationRecord,
  KnowledgeMutationStatus,
  KnowledgePolicySnapshot,
  KnowledgeResourceKind,
  KnowledgeTargetIdentity,
} from '../../domain/knowledge/knowledge-mutation';

export interface CreateKnowledgeProposalInput extends KnowledgeTargetIdentity {
  readonly kind: KnowledgeResourceKind;
  readonly logicalKey: string;
  readonly action: KnowledgeMutationAction;
  readonly baseVersion: number | null;
  readonly proposedContent: unknown | null;
  readonly proposedContentHash: string | null;
  readonly fileAssetId: string | null;
  readonly evidence: unknown | null;
  readonly sourceType: string;
  readonly sourceRef: string | null;
  readonly requesterId: string;
  readonly policy: KnowledgePolicySnapshot;
  readonly initialStatus: KnowledgeMutationStatus;
  readonly idempotencyKey: string;
}

export interface KnowledgeApprovalReceipt {
  readonly approvalId: string;
  readonly companyId: string;
  readonly status: 'approved' | 'executing';
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly authority: Exclude<KnowledgeApprovalAuthority, 'none'>;
  readonly mutationId: string;
  readonly contentHash: string | null;
}

export interface AppliedKnowledgeMutation {
  readonly mutation: KnowledgeMutationRecord;
  readonly resourceId: string;
  readonly versionId: string | null;
  readonly version: number;
  readonly outboxEventId: string;
}

export interface SettledKnowledgeRequesterDecision {
  readonly mutation: KnowledgeMutationRecord;
  readonly decisionStatus: 'executing' | 'rejected';
  readonly replayed: boolean;
}

export interface SettledKnowledgeAuthorityDecision {
  readonly mutation: KnowledgeMutationRecord;
  readonly parentStatus: 'consumed' | 'rejected' | 'failed';
  readonly replayed: boolean;
}

export interface KnowledgeMutationStore {
  resolveResourceId?(input: {
    companyId: string;
    kind: KnowledgeResourceKind;
    targetKey: string;
    logicalKey: string;
  }): Promise<string | null>;

  /** Projection-known slug ownership checked before a person reviews a skill. */
  findSkillSlugConflict?(input: {
    companyId: string;
    scope: KnowledgeTargetIdentity['scope'];
    departmentId: string | null;
    slug: string;
    existingResourceId: string | null;
  }): Promise<{ readonly skillId: string; readonly isSystem: boolean } | null>;

  resolvePolicy(input: {
    companyId: string;
    kind: KnowledgeResourceKind;
    scope: KnowledgeTargetIdentity['scope'];
    action: KnowledgeMutationAction;
  }): Promise<KnowledgePolicySnapshot | null>;

  createProposal(input: CreateKnowledgeProposalInput): Promise<KnowledgeMutationRecord>;

  getMutation(input: {
    mutationId: string;
    companyId: string;
  }): Promise<KnowledgeMutationRecord | null>;

  /** Durable recovery anchor for an exact explicit command after cache loss. */
  findAppliedBySourceRef?(input: {
    companyId: string;
    requesterId: string;
    sourceRef: string;
    requestHash: string;
  }): Promise<AppliedKnowledgeMutation | null>;

  confirmRequesterReview(input: {
    mutationId: string;
    companyId: string;
    requesterId: string;
    expectedContentHash: string | null;
    nextStatus: Extract<KnowledgeMutationStatus, 'awaiting_approval' | 'approved'>;
  }): Promise<KnowledgeMutationRecord>;

  /** Atomically records the requester Decision and its mutation transition. */
  settleRequesterDecision(input: {
    mutationId: string;
    decisionId: string;
    companyId: string;
    requesterId: string;
    expectedContentHash: string | null;
    decision: 'approved' | 'rejected';
    summary: string;
    nextStatus: Extract<KnowledgeMutationStatus, 'awaiting_approval' | 'approved'>;
  }): Promise<SettledKnowledgeRequesterDecision>;

  /** Atomically closes a linked requester Decision with its authority outcome. */
  settleAuthorityDecision(input: {
    mutationId: string;
    parentDecisionId: string;
    approvalId: string;
    companyId: string;
    status: 'completed' | 'rejected' | 'failed';
    result: unknown;
  }): Promise<SettledKnowledgeAuthorityDecision>;

  /** Cancels expired requester Decisions and their still-unreviewed mutations. */
  expireRequesterDecisions(limit: number): Promise<number>;

  attachRuntimeApproval(input: {
    mutationId: string;
    companyId: string;
    requesterId: string;
    expectedContentHash: string | null;
    approvalId: string;
    authority: Exclude<KnowledgeApprovalAuthority, 'none'>;
  }): Promise<KnowledgeMutationRecord>;

  readApprovalReceipt(approvalId: string): Promise<KnowledgeApprovalReceipt | null>;

  acceptApproval(input: {
    mutationId: string;
    companyId: string;
    receipt: KnowledgeApprovalReceipt;
  }): Promise<KnowledgeMutationRecord>;

  applyApproved(input: {
    mutationId: string;
    companyId: string;
  }): Promise<AppliedKnowledgeMutation>;

  reject(input: {
    mutationId: string;
    companyId: string;
    actorId: string;
    reason: string;
  }): Promise<KnowledgeMutationRecord>;

  cancel(input: {
    mutationId: string;
    companyId: string;
    requesterId: string;
  }): Promise<KnowledgeMutationRecord>;
}
