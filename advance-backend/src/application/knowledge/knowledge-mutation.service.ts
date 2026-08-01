import { z } from 'zod';
import type { ResolvedKnowledgeScope } from '../../domain/knowledge/knowledge-scope';
import {
  initialKnowledgeMutationStatus,
  knowledgeTargetIdentity,
  statusAfterRequesterReview,
  validateKnowledgePolicy,
  type KnowledgeApprovalAuthority,
  type KnowledgeMutationAction,
  type KnowledgeMutationRecord,
  type KnowledgeResourceKind,
} from '../../domain/knowledge/knowledge-mutation';
import { sha256CanonicalJson } from '../../shared/hash';
import { KnowledgeMutationError } from './knowledge-mutation.errors';
import type {
  AppliedKnowledgeMutation,
  KnowledgeMutationStore,
} from './knowledge-mutation.store';
import {
  DefaultKnowledgeContentValidator,
  type KnowledgeContentValidator,
} from './knowledge-content-validator';

const logicalKeySchema = z.string().trim().min(1).max(240);
const sourceTypeSchema = z.enum([
  'user_explicit',
  'automatic_learning',
  'file_upload',
  'skill_teach',
  'admin',
  'migration',
]);
const sourceRefSchema = z.string().trim().min(1).max(500);

export interface ProposeKnowledgeMutationInput {
  readonly target: ResolvedKnowledgeScope;
  readonly requester: {
    readonly companyId: string;
    readonly userId: string;
  };
  readonly kind: KnowledgeResourceKind;
  readonly logicalKey: string;
  readonly action: KnowledgeMutationAction;
  readonly baseVersion?: number;
  readonly content?: unknown;
  readonly evidence?: unknown;
  readonly sourceType: z.infer<typeof sourceTypeSchema>;
  readonly sourceRef?: string;
}

/**
 * Sole application authority for knowledge mutations.
 *
 * Channel adapters may render cards and projections may index content, but
 * neither may decide scope, policy, review, approval, or version transitions.
 */
export class KnowledgeMutationService {
  private readonly contentValidator: KnowledgeContentValidator;

  constructor(
    private readonly store: KnowledgeMutationStore,
    contentValidator: KnowledgeContentValidator = new DefaultKnowledgeContentValidator(),
  ) {
    this.contentValidator = contentValidator;
  }

  async get(input: { mutationId: string; companyId: string }): Promise<KnowledgeMutationRecord> {
    return this.requireMutation(input.mutationId, input.companyId);
  }

  async propose(input: ProposeKnowledgeMutationInput): Promise<KnowledgeMutationRecord> {
    const target = knowledgeTargetIdentity(input.target);
    this.assertAuthenticatedTarget(target, input.requester);

    const kind = parseOrThrow(
      z.enum(['memory', 'skill', 'file']),
      input.kind,
      'Unknown knowledge resource kind.',
    );
    const action = parseOrThrow(
      z.enum(['create', 'update', 'publish', 'delete']),
      input.action,
      'Unknown knowledge mutation action.',
    );
    const logicalKey = parseOrThrow(logicalKeySchema, input.logicalKey, 'Invalid logical key.');
    const sourceType = parseOrThrow(sourceTypeSchema, input.sourceType, 'Invalid knowledge source type.');
    const sourceRef = input.sourceRef === undefined
      ? null
      : parseOrThrow(sourceRefSchema, input.sourceRef, 'Invalid knowledge source reference.');
    const baseVersion = validateBaseVersion(action, input.baseVersion);
    const rawContent = validateContent(action, input.content);
    const existingResourceId = kind === 'file'
      ? await this.store.resolveResourceId?.({
          companyId: target.companyId,
          kind,
          targetKey: target.targetKey,
          logicalKey,
        }) ?? null
      : null;
    const proposedContent = await this.contentValidator.validate({
      kind,
      action,
      content: rawContent,
      target: input.target,
      requester: input.requester,
      existingResourceId,
    });
    const proposedContentHash = action === 'delete'
      ? null
      : hashJson(proposedContent);
    const evidence = input.evidence === undefined ? null : validateJson(input.evidence, 'evidence');

    const policy = await this.store.resolvePolicy({
      companyId: target.companyId,
      kind,
      scope: target.scope,
      action,
    });
    if (!policy) {
      throw new KnowledgeMutationError(
        'policy_missing',
        'No knowledge policy exists for this exact resource, scope, and action.',
      );
    }
    if (!policy.enabled) {
      throw new KnowledgeMutationError('policy_disabled', 'This knowledge mutation is disabled by company policy.');
    }
    const policyError = validateKnowledgePolicy(policy);
    if (policyError) throw new KnowledgeMutationError('policy_invalid', policyError);
    if (policy.kind !== kind || policy.scope !== target.scope || policy.action !== action) {
      throw new KnowledgeMutationError('policy_invalid', 'The resolved policy does not match the requested mutation.');
    }

    const initialStatus = initialKnowledgeMutationStatus(policy);
    const idempotencyKey = sha256CanonicalJson({
      contract: 1,
      companyId: target.companyId,
      kind,
      scope: target.scope,
      targetKey: target.targetKey,
      logicalKey,
      action,
      baseVersion,
      proposedContentHash,
      fileAssetId: kind === 'file' && proposedContent && typeof proposedContent === 'object'
        ? String((proposedContent as { assetId: string }).assetId)
        : null,
      requesterId: input.requester.userId,
      policyId: policy.id,
      policyVersion: policy.version,
    });

    return this.store.createProposal({
      ...target,
      kind,
      logicalKey,
      action,
      baseVersion,
      proposedContent,
      proposedContentHash,
      fileAssetId: kind === 'file' && proposedContent && typeof proposedContent === 'object'
        ? String((proposedContent as { assetId: string }).assetId)
        : null,
      evidence,
      sourceType,
      sourceRef,
      requesterId: input.requester.userId,
      policy,
      initialStatus,
      idempotencyKey,
    });
  }

  async confirmRequesterReview(input: {
    mutationId: string;
    companyId: string;
    requesterId: string;
    expectedContentHash: string | null;
  }): Promise<KnowledgeMutationRecord> {
    const mutation = await this.requireMutation(input.mutationId, input.companyId);
    if (mutation.requesterId !== input.requesterId) {
      throw new KnowledgeMutationError('permission_denied', 'Only the requester may confirm this exact proposal.');
    }
    if (!mutation.requesterReviewRequired) {
      if (mutation.status === 'approved' || mutation.status === 'awaiting_approval') return mutation;
      throw new KnowledgeMutationError('invalid_state', 'This mutation does not have a requester-review step.');
    }
    if (['awaiting_approval', 'approved', 'applied'].includes(mutation.status)) {
      assertExactHash(mutation.proposedContentHash, input.expectedContentHash);
      return mutation;
    }
    if (mutation.status !== 'awaiting_requester_review') {
      throw new KnowledgeMutationError('invalid_state', 'This proposal is no longer awaiting requester review.');
    }
    assertExactHash(mutation.proposedContentHash, input.expectedContentHash);

    return this.store.confirmRequesterReview({
      mutationId: mutation.id,
      companyId: mutation.companyId,
      requesterId: input.requesterId,
      expectedContentHash: input.expectedContentHash,
      nextStatus: statusAfterRequesterReview(mutation),
    });
  }

  async attachRuntimeApproval(input: {
    mutationId: string;
    companyId: string;
    requesterId: string;
    expectedContentHash: string | null;
    approvalId: string;
    authority: Exclude<KnowledgeApprovalAuthority, 'none'>;
  }): Promise<KnowledgeMutationRecord> {
    const mutation = await this.requireMutation(input.mutationId, input.companyId);
    if (mutation.requesterId !== input.requesterId) {
      throw new KnowledgeMutationError('permission_denied', 'Only the requester may submit this proposal for approval.');
    }
    if (mutation.status !== 'awaiting_approval') {
      throw new KnowledgeMutationError('invalid_state', 'This proposal is not ready for authority approval.');
    }
    if (mutation.requiredAuthority === 'none' || mutation.requiredAuthority !== input.authority) {
      throw new KnowledgeMutationError('approval_mismatch', 'The approval authority does not match policy.');
    }
    assertExactHash(mutation.proposedContentHash, input.expectedContentHash);
    return this.store.attachRuntimeApproval(input);
  }

  async acceptRuntimeApproval(input: {
    mutationId: string;
    companyId: string;
    approvalId: string;
  }): Promise<KnowledgeMutationRecord> {
    const mutation = await this.requireMutation(input.mutationId, input.companyId);
    if (mutation.status === 'approved') return mutation;
    if (mutation.status !== 'awaiting_approval') {
      throw new KnowledgeMutationError('invalid_state', 'This proposal is not awaiting approval.');
    }
    if (mutation.runtimeApprovalId !== input.approvalId) {
      throw new KnowledgeMutationError('approval_mismatch', 'The approval is not bound to this mutation.');
    }
    const receipt = await this.store.readApprovalReceipt(input.approvalId);
    if (!receipt) throw new KnowledgeMutationError('approval_required', 'The bound approval does not exist.');
    if (
      receipt.companyId !== mutation.companyId
      || receipt.mutationId !== mutation.id
      || receipt.requestedBy !== mutation.requesterId
      || receipt.authority !== mutation.requiredAuthority
      || receipt.contentHash !== mutation.proposedContentHash
    ) {
      throw new KnowledgeMutationError('approval_mismatch', 'The approval receipt does not match the exact proposal.');
    }
    if (mutation.distinctApprover && receipt.approvedBy === mutation.requesterId) {
      throw new KnowledgeMutationError('permission_denied', 'A requester cannot approve their own shared mutation.');
    }

    return this.store.acceptApproval({
      mutationId: mutation.id,
      companyId: mutation.companyId,
      receipt,
    });
  }

  async apply(input: {
    mutationId: string;
    companyId: string;
  }): Promise<AppliedKnowledgeMutation> {
    const mutation = await this.requireMutation(input.mutationId, input.companyId);
    if (mutation.status === 'awaiting_requester_review') {
      throw new KnowledgeMutationError('review_required', 'The requester has not reviewed the exact proposal.');
    }
    if (mutation.status === 'awaiting_approval') {
      throw new KnowledgeMutationError('approval_required', 'The required authority has not approved this proposal.');
    }
    if (mutation.status !== 'approved' && mutation.status !== 'applied') {
      throw new KnowledgeMutationError('invalid_state', 'This mutation cannot be applied from its current state.');
    }
    return this.store.applyApproved(input);
  }

  async reject(input: {
    mutationId: string;
    companyId: string;
    actorId: string;
    reason: string;
  }): Promise<KnowledgeMutationRecord> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 1000) {
      throw new KnowledgeMutationError('invalid_request', 'A concise rejection reason is required.');
    }
    return this.store.reject({ ...input, reason });
  }

  async cancel(input: {
    mutationId: string;
    companyId: string;
    requesterId: string;
  }): Promise<KnowledgeMutationRecord> {
    return this.store.cancel(input);
  }

  private async requireMutation(mutationId: string, companyId: string): Promise<KnowledgeMutationRecord> {
    const mutation = await this.store.getMutation({ mutationId, companyId });
    if (!mutation) throw new KnowledgeMutationError('not_found', 'Knowledge mutation not found.');
    return mutation;
  }

  private assertAuthenticatedTarget(
    target: ReturnType<typeof knowledgeTargetIdentity>,
    requester: ProposeKnowledgeMutationInput['requester'],
  ): void {
    if (target.companyId !== requester.companyId) {
      throw new KnowledgeMutationError('permission_denied', 'Cross-company knowledge targeting is not allowed.');
    }
    if (target.scope === 'personal' && target.ownerUserId !== requester.userId) {
      throw new KnowledgeMutationError('permission_denied', 'Personal knowledge can only target the authenticated user.');
    }
  }
}

function validateBaseVersion(
  action: KnowledgeMutationAction,
  raw: number | undefined,
): number | null {
  if (action === 'create') {
    if (raw !== undefined) {
      throw new KnowledgeMutationError('invalid_request', 'Create must not include a base version.');
    }
    return null;
  }
  if (action === 'publish' && raw === undefined) return null;
  if (!Number.isInteger(raw) || (raw ?? 0) < 1) {
    throw new KnowledgeMutationError('invalid_request', `${action} requires a positive base version.`);
  }
  return raw!;
}

function validateContent(action: KnowledgeMutationAction, content: unknown): unknown | null {
  if (action === 'delete') {
    if (content !== undefined && content !== null) {
      throw new KnowledgeMutationError('invalid_request', 'Delete must not include replacement content.');
    }
    return null;
  }
  if (content === undefined || content === null) {
    throw new KnowledgeMutationError('invalid_request', `${action} requires content.`);
  }
  return validateJson(content, 'content');
}

function validateJson(value: unknown, label: string): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('not JSON representable');
    return JSON.parse(encoded) as unknown;
  } catch (cause) {
    throw new KnowledgeMutationError('invalid_request', `Knowledge ${label} must be valid JSON.`, cause);
  }
}

function hashJson(value: unknown): string {
  try {
    return sha256CanonicalJson(value);
  } catch (cause) {
    throw new KnowledgeMutationError('invalid_request', 'Knowledge content could not be fingerprinted.', cause);
  }
}

function assertExactHash(actual: string | null, expected: string | null): void {
  if (actual !== expected) {
    throw new KnowledgeMutationError(
      'conflict',
      'The proposal changed after it was shown. Review the new exact content before continuing.',
    );
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new KnowledgeMutationError('invalid_request', message);
  return parsed.data;
}
