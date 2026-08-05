import { Prisma, type PrismaClient } from '../../generated/prisma';
import type {
  KnowledgeMutationRecord,
  KnowledgeMutationStatus,
  KnowledgePolicySnapshot,
  KnowledgeResourceKind,
} from '../../domain/knowledge/knowledge-mutation';
import {
  knowledgeResourceStatusAfterMutation,
  validateKnowledgePolicy,
} from '../../domain/knowledge/knowledge-mutation';
import { KnowledgeMutationError } from '../../application/knowledge/knowledge-mutation.errors';
import type {
  AppliedKnowledgeMutation,
  CreateKnowledgeProposalInput,
  KnowledgeApprovalReceipt,
  KnowledgeMutationStore,
} from '../../application/knowledge/knowledge-mutation.store';

const LIVE_MUTATION_STATUSES: KnowledgeMutationStatus[] = [
  'awaiting_requester_review',
  'awaiting_approval',
  'approved',
  'applying',
];

export class PrismaKnowledgeMutationStore implements KnowledgeMutationStore {
  private readonly requireThreatScan: boolean;

  constructor(
    private readonly prisma: PrismaClient,
    options: { readonly requireThreatScan?: boolean } = {},
  ) {
    // Production is fail-closed. Tests or explicitly disabled local environments
    // may opt out, but a caller must make that relaxation explicit.
    this.requireThreatScan = options.requireThreatScan ?? true;
  }

  async resolveResourceId(input: {
    companyId: string;
    kind: KnowledgeResourceKind;
    targetKey: string;
    logicalKey: string;
  }): Promise<string | null> {
    try {
      const resource = await this.prisma.knowledgeResource.findUnique({
        where: {
          companyId_kind_targetKey_logicalKey: input,
        },
        select: { id: true },
      });
      return resource?.id ?? null;
    } catch (cause) {
      throw storageFailure('resolve knowledge resource', cause);
    }
  }

  async resolvePolicy(input: {
    companyId: string;
    kind: KnowledgeResourceKind;
    scope: 'personal' | 'department' | 'company';
    action: 'create' | 'update' | 'publish' | 'delete';
  }): Promise<KnowledgePolicySnapshot | null> {
    try {
      const rows = await this.prisma.knowledgePolicy.findMany({
        where: {
          tenantKey: { in: [input.companyId, 'global'] },
          kind: input.kind,
          scope: input.scope,
          action: input.action,
        },
      });
      const row = rows.find(candidate => candidate.tenantKey === input.companyId)
        ?? rows.find(candidate => candidate.tenantKey === 'global');
      return row ? toPolicy(row) : null;
    } catch (cause) {
      throw storageFailure('resolve policy', cause);
    }
  }

  async createProposal(input: CreateKnowledgeProposalInput): Promise<KnowledgeMutationRecord> {
    try {
      return await this.prisma.$transaction(async tx => {
        await advisoryLock(tx, 'knowledge-idempotency', input.idempotencyKey);
        await lockAutomaticLearningSource(tx, input);
        await assertLiveKnowledgeAuthority(tx, input);
        const existing = await tx.knowledgeMutation.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing) return toMutation(existing);

        await advisoryLock(
          tx,
          'knowledge-target',
          `${input.companyId}:${input.kind}:${input.targetKey}:${input.logicalKey}`,
        );
        const resource = await tx.knowledgeResource.findUnique({
          where: {
            companyId_kind_targetKey_logicalKey: {
              companyId: input.companyId,
              kind: input.kind,
              targetKey: input.targetKey,
              logicalKey: input.logicalKey,
            },
          },
        });
        const competing = await tx.knowledgeMutation.findFirst({
          where: {
            companyId: input.companyId,
            kind: input.kind,
            targetKey: input.targetKey,
            logicalKey: input.logicalKey,
            status: { in: LIVE_MUTATION_STATUSES },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (competing) {
          throw new KnowledgeMutationError(
            'conflict',
            'Another mutation for this exact knowledge resource is still in progress.',
          );
        }

        const resourceId = validateResourcePrecondition(resource, input);
        const created = await tx.knowledgeMutation.create({
          data: {
            companyId: input.companyId,
            resourceId,
            kind: input.kind,
            scope: input.scope,
            targetKey: input.targetKey,
            ownerUserId: input.ownerUserId,
            departmentId: input.departmentId,
            logicalKey: input.logicalKey,
            action: input.action,
            baseVersion: input.baseVersion,
            proposedContentJson: jsonOrDbNull(input.proposedContent),
            proposedContentHash: input.proposedContentHash,
            fileAssetId: input.fileAssetId,
            evidenceJson: jsonOrDbNull(input.evidence),
            sourceType: input.sourceType,
            sourceRef: input.sourceRef,
            requesterId: input.requesterId,
            requesterReviewRequired: input.policy.requesterReviewRequired,
            requiredAuthority: input.policy.requiredAuthority,
            distinctApprover: input.policy.distinctApprover,
            policyId: input.policy.id,
            policyVersion: input.policy.version,
            status: input.initialStatus,
            idempotencyKey: input.idempotencyKey,
          },
        });
        return toMutation(created);
      });
    } catch (cause) {
      throw preserveOrWrap('create proposal', cause);
    }
  }

  async getMutation(input: {
    mutationId: string;
    companyId: string;
  }): Promise<KnowledgeMutationRecord | null> {
    try {
      const row = await this.prisma.knowledgeMutation.findFirst({
        where: { id: input.mutationId, companyId: input.companyId },
      });
      return row ? toMutation(row) : null;
    } catch (cause) {
      throw storageFailure('read mutation', cause);
    }
  }

  async findAppliedBySourceRef(input: {
    companyId: string;
    requesterId: string;
    sourceRef: string;
    requestHash: string;
  }): Promise<AppliedKnowledgeMutation | null> {
    try {
      return await this.prisma.$transaction(async tx => {
        const mutation = await tx.knowledgeMutation.findFirst({
          where: {
            companyId: input.companyId,
            requesterId: input.requesterId,
            kind: 'memory',
            scope: 'personal',
            sourceType: 'user_explicit',
            sourceRef: input.sourceRef,
            status: 'applied',
            evidenceJson: {
              equals: { contract: 1, requestHash: input.requestHash },
            },
          },
          orderBy: { createdAt: 'desc' },
        });
        return mutation ? replayApplied(tx, mutation) : null;
      });
    } catch (cause) {
      throw preserveOrWrap('recover applied mutation', cause);
    }
  }

  async confirmRequesterReview(input: {
    mutationId: string;
    companyId: string;
    requesterId: string;
    expectedContentHash: string | null;
    nextStatus: 'awaiting_approval' | 'approved';
  }): Promise<KnowledgeMutationRecord> {
    try {
      return await this.prisma.$transaction(async tx => {
        await advisoryLock(tx, 'knowledge-mutation', input.mutationId);
        const row = await requireMutation(tx, input.mutationId, input.companyId);
        await assertLiveKnowledgeAuthority(tx, row);
        if (row.requesterId !== input.requesterId) deny('Only the requester may review this proposal.');
        if (row.status !== 'awaiting_requester_review') invalidState('Proposal is not awaiting requester review.');
        if (row.proposedContentHash !== input.expectedContentHash) staleContent();
        const updated = await tx.knowledgeMutation.update({
          where: { id: row.id },
          data: {
            requesterReviewedAt: new Date(),
            status: input.nextStatus,
          },
        });
        return toMutation(updated);
      });
    } catch (cause) {
      throw preserveOrWrap('confirm requester review', cause);
    }
  }

  async attachRuntimeApproval(input: {
    mutationId: string;
    companyId: string;
    requesterId: string;
    expectedContentHash: string | null;
    approvalId: string;
    authority: 'department_manager' | 'company_admin';
  }): Promise<KnowledgeMutationRecord> {
    try {
      return await this.prisma.$transaction(async tx => {
        await advisoryLock(tx, 'knowledge-mutation', input.mutationId);
        const row = await requireMutation(tx, input.mutationId, input.companyId);
        await assertLiveKnowledgeAuthority(tx, row);
        if (row.requesterId !== input.requesterId) deny('Only the requester may submit this proposal.');
        if (row.status !== 'awaiting_approval') invalidState('Proposal is not awaiting approval.');
        if (row.proposedContentHash !== input.expectedContentHash) staleContent();
        if (row.requiredAuthority !== input.authority) {
          throw new KnowledgeMutationError('approval_mismatch', 'Approval authority does not match policy.');
        }
        if (row.runtimeApprovalId && row.runtimeApprovalId !== input.approvalId) {
          throw new KnowledgeMutationError('approval_mismatch', 'A different approval is already bound to this proposal.');
        }
        const updated = await tx.knowledgeMutation.update({
          where: { id: row.id },
          data: { runtimeApprovalId: input.approvalId },
        });
        return toMutation(updated);
      });
    } catch (cause) {
      throw preserveOrWrap('attach runtime approval', cause);
    }
  }

  async readApprovalReceipt(approvalId: string): Promise<KnowledgeApprovalReceipt | null> {
    try {
      const row = await this.prisma.runtimeApproval.findUnique({
        where: { id: approvalId },
        include: { conversation: { select: { companyId: true } } },
      });
      if (!row || row.status !== 'executing' || !row.requestedBy || !row.approvedBy) return null;
      const metadata = asRecord(row.metadataJson);
      const payload = asRecord(row.payloadJson);
      const args = asRecord(payload['args']);
      const authority = metadata['approvalAuthority'];
      if (authority !== 'department_manager' && authority !== 'company_admin') return null;
      const mutationId = args['mutationId'];
      const contentHash = args['contentHash'];
      if (typeof mutationId !== 'string') return null;
      if (contentHash !== null && typeof contentHash !== 'string') return null;
      return {
        approvalId: row.id,
        companyId: row.conversation.companyId,
        status: 'executing',
        requestedBy: row.requestedBy,
        approvedBy: row.approvedBy,
        authority,
        mutationId,
        contentHash: contentHash ?? null,
      };
    } catch (cause) {
      throw storageFailure('read approval receipt', cause);
    }
  }

  async acceptApproval(input: {
    mutationId: string;
    companyId: string;
    receipt: KnowledgeApprovalReceipt;
  }): Promise<KnowledgeMutationRecord> {
    try {
      return await this.prisma.$transaction(async tx => {
        await advisoryLock(tx, 'knowledge-mutation', input.mutationId);
        const row = await requireMutation(tx, input.mutationId, input.companyId);
        if (row.status !== 'awaiting_approval') invalidState('Proposal is not awaiting approval.');
        if (row.runtimeApprovalId !== input.receipt.approvalId) {
          throw new KnowledgeMutationError('approval_mismatch', 'Approval is not bound to this proposal.');
        }
        await assertLiveKnowledgeAuthority(tx, row, input.receipt.approvedBy);
        const updated = await tx.knowledgeMutation.update({
          where: { id: row.id },
          data: { status: 'approved', decidedAt: new Date() },
        });
        return toMutation(updated);
      });
    } catch (cause) {
      throw preserveOrWrap('accept approval', cause);
    }
  }

  async applyApproved(input: {
    mutationId: string;
    companyId: string;
  }): Promise<AppliedKnowledgeMutation> {
    try {
      return await this.prisma.$transaction(async tx => {
        await advisoryLock(tx, 'knowledge-mutation', input.mutationId);
        let mutation = await requireMutation(tx, input.mutationId, input.companyId);
        await lockAutomaticLearningSource(tx, mutation);
        if (mutation.status === 'applied') return replayApplied(tx, mutation);
        if (mutation.status !== 'approved') invalidState('Mutation is not approved for application.');
        await advisoryLock(
          tx,
          'knowledge-target',
          `${mutation.companyId}:${mutation.kind}:${mutation.targetKey}:${mutation.logicalKey}`,
        );

        const approval = mutation.runtimeApprovalId
          ? await tx.runtimeApproval.findUnique({
              where: { id: mutation.runtimeApprovalId },
              select: { status: true, approvedBy: true },
            })
          : null;
        await assertLiveKnowledgeAuthority(tx, mutation, approval?.approvedBy ?? undefined);

        if (mutation.requiredAuthority !== 'none') {
          if (!mutation.runtimeApprovalId) {
            throw new KnowledgeMutationError('approval_required', 'Shared mutation has no bound approval.');
          }
          if (approval?.status !== 'executing') {
            throw new KnowledgeMutationError(
              'approval_mismatch',
              'The exact approval has not been atomically claimed for execution.',
            );
          }
        }

        mutation = await tx.knowledgeMutation.update({
          where: { id: mutation.id },
          data: { status: 'applying' },
        });

        const existingResource = mutation.resourceId
          ? await tx.knowledgeResource.findUnique({ where: { id: mutation.resourceId } })
          : await tx.knowledgeResource.findUnique({
              where: {
                companyId_kind_targetKey_logicalKey: {
                  companyId: mutation.companyId,
                  kind: mutation.kind,
                  targetKey: mutation.targetKey,
                  logicalKey: mutation.logicalKey,
                },
              },
            });

        if (mutation.action === 'delete') {
          if (!existingResource || existingResource.currentVersion !== mutation.baseVersion) staleVersion();
          const resource = await tx.knowledgeResource.update({
            where: { id: existingResource.id },
            data: { status: 'deleted' },
          });
          const outbox = await tx.knowledgeOutbox.create({
            data: {
              mutationId: mutation.id,
              eventType: 'knowledge.resource.deleted',
              dedupeKey: `${mutation.id}:delete`,
              payloadJson: {
                contract: 1,
                mutationId: mutation.id,
                resourceId: resource.id,
                companyId: resource.companyId,
                kind: resource.kind,
                scope: resource.scope,
                targetKey: resource.targetKey,
                logicalKey: resource.logicalKey,
                version: resource.currentVersion,
              },
            },
          });
          const applied = await tx.knowledgeMutation.update({
            where: { id: mutation.id },
            data: {
              resourceId: resource.id,
              status: 'applied',
              appliedAt: new Date(),
            },
          });
          return {
            mutation: toMutation(applied),
            resourceId: resource.id,
            versionId: null,
            version: resource.currentVersion,
            outboxEventId: outbox.id,
          };
        }

        if (!mutation.proposedContentHash || mutation.proposedContentJson === null) {
          throw new KnowledgeMutationError('invalid_request', 'Mutation content is missing.');
        }

        const resource = existingResource
          ? await prepareExistingResource(tx, existingResource, mutation)
          : await createResource(tx, mutation);
        if (mutation.kind === 'file') {
          await bindFileAsset(tx, mutation, resource.id, this.requireThreatScan);
        }
        const currentVersion = resource.currentVersion > 0
          ? await tx.knowledgeVersion.findUnique({
              where: { resourceId_version: { resourceId: resource.id, version: resource.currentVersion } },
            })
          : null;

        let version = currentVersion;
        if (!version || version.contentHash !== mutation.proposedContentHash) {
          const nextVersion = resource.currentVersion + 1;
          version = await tx.knowledgeVersion.create({
            data: {
              resourceId: resource.id,
              version: nextVersion,
              contentJson: mutation.proposedContentJson,
              contentHash: mutation.proposedContentHash,
              searchText: knowledgeVersionSearchText(
                mutation.logicalKey,
                mutation.proposedContentJson,
              ),
              evidenceJson: mutation.evidenceJson ?? Prisma.DbNull,
              sourceType: mutation.sourceType,
              sourceRef: mutation.sourceRef,
              createdById: mutation.requesterId,
            },
          });
          await tx.$executeRaw`
            UPDATE "KnowledgeVersion"
            SET "searchVector" = to_tsvector('simple', coalesce("searchText", ''))
            WHERE "id" = ${version.id}
          `;
          const updated = await tx.knowledgeResource.updateMany({
            where: { id: resource.id, currentVersion: resource.currentVersion },
            data: {
              currentVersion: nextVersion,
              status: knowledgeResourceStatusAfterMutation(resource.status, mutation.action),
            },
          });
          if (updated.count !== 1) staleVersion();
        } else {
          await tx.knowledgeResource.update({
            where: { id: resource.id },
            data: { status: knowledgeResourceStatusAfterMutation(resource.status, mutation.action) },
          });
        }

        const outbox = await tx.knowledgeOutbox.create({
          data: {
            mutationId: mutation.id,
            eventType: 'knowledge.version.applied',
            dedupeKey: `${mutation.id}:version:${version.version}`,
            payloadJson: {
              contract: 1,
              mutationId: mutation.id,
              resourceId: resource.id,
              versionId: version.id,
              version: version.version,
              contentHash: version.contentHash,
              companyId: mutation.companyId,
              kind: mutation.kind,
              scope: mutation.scope,
              targetKey: mutation.targetKey,
              logicalKey: mutation.logicalKey,
            },
          },
        });
        const applied = await tx.knowledgeMutation.update({
          where: { id: mutation.id },
          data: {
            resourceId: resource.id,
            appliedVersionId: version.id,
            status: 'applied',
            appliedAt: new Date(),
          },
        });
        return {
          mutation: toMutation(applied),
          resourceId: resource.id,
          versionId: version.id,
          version: version.version,
          outboxEventId: outbox.id,
        };
      });
    } catch (cause) {
      throw preserveOrWrap('apply mutation', cause);
    }
  }

  async reject(input: {
    mutationId: string;
    companyId: string;
    actorId: string;
    reason: string;
  }): Promise<KnowledgeMutationRecord> {
    try {
      return await this.prisma.$transaction(async tx => {
        await advisoryLock(tx, 'knowledge-mutation', input.mutationId);
        const row = await requireMutation(tx, input.mutationId, input.companyId);
        if (row.status !== 'awaiting_approval' || !row.runtimeApprovalId) {
          invalidState('Mutation is not awaiting authority approval.');
        }
        const approval = await tx.runtimeApproval.findUnique({
          where: { id: row.runtimeApprovalId },
          select: { metadataJson: true },
        });
        const approverId = asRecord(approval?.metadataJson)['resolvedManagerUserId'];
        if (approverId !== input.actorId) deny('Only the configured approver may reject this mutation.');
        await assertLiveKnowledgeAuthority(tx, row, input.actorId);
        const updated = await tx.knowledgeMutation.update({
          where: { id: row.id },
          data: {
            status: 'rejected',
            rejectionReason: input.reason,
            decidedAt: new Date(),
          },
        });
        return toMutation(updated);
      });
    } catch (cause) {
      throw preserveOrWrap('reject mutation', cause);
    }
  }

  async cancel(input: {
    mutationId: string;
    companyId: string;
    requesterId: string;
  }): Promise<KnowledgeMutationRecord> {
    try {
      return await this.prisma.$transaction(async tx => {
        await advisoryLock(tx, 'knowledge-mutation', input.mutationId);
        const row = await requireMutation(tx, input.mutationId, input.companyId);
        if (row.requesterId !== input.requesterId) deny('Only the requester may cancel this mutation.');
        if (!['awaiting_requester_review', 'awaiting_approval', 'approved'].includes(row.status)) {
          invalidState('Mutation can no longer be cancelled.');
        }
        const decidedAt = new Date();
        if (row.runtimeApprovalId) {
          await tx.runtimeApproval.updateMany({
            where: {
              id: row.runtimeApprovalId,
              status: { in: ['dispatching', 'pending', 'approved'] },
            },
            data: {
              status: 'rejected',
              rejectedAt: decidedAt,
              resolutionReason: 'The requester cancelled the linked knowledge proposal.',
            },
          });
        }
        const updated = await tx.knowledgeMutation.update({
          where: { id: row.id },
          data: { status: 'cancelled', decidedAt },
        });
        return toMutation(updated);
      });
    } catch (cause) {
      throw preserveOrWrap('cancel mutation', cause);
    }
  }
}

function knowledgeVersionSearchText(logicalKey: string, content: unknown): string {
  const serialized = JSON.stringify(content) ?? '';
  return `${logicalKey} ${serialized}`
    .replaceAll('\u0000', '')
    .normalize('NFKC')
    .slice(0, 100_000);
}

type Tx = Prisma.TransactionClient;
type MutationRow = Awaited<ReturnType<Tx['knowledgeMutation']['findFirst']>> & {};
type ResourceRow = NonNullable<Awaited<ReturnType<Tx['knowledgeResource']['findUnique']>>>;

interface KnowledgeAuthoritySubject {
  readonly companyId: string;
  readonly scope: 'personal' | 'department' | 'company';
  readonly ownerUserId: string | null;
  readonly departmentId: string | null;
  readonly requesterId: string;
  readonly kind: KnowledgeResourceKind;
  readonly action: 'create' | 'update' | 'publish' | 'delete';
  readonly policy?: KnowledgePolicySnapshot;
  readonly policyId?: string;
  readonly policyVersion?: number;
  readonly requesterReviewRequired?: boolean;
  readonly requiredAuthority?: 'none' | 'department_manager' | 'company_admin';
  readonly distinctApprover?: boolean;
}

/**
 * Re-check mutable authority inside the transaction that advances a proposal.
 * A review card proves intent, not continuing permission: memberships, roles,
 * department state, and policy can change while a human decision is pending.
 */
export async function assertLiveKnowledgeAuthority(
  tx: Tx,
  subject: KnowledgeAuthoritySubject,
  approvedBy?: string,
): Promise<void> {
  const requesterMembership = await tx.adminMembership.findFirst({
    where: {
      companyId: subject.companyId,
      userId: subject.requesterId,
      isActive: true,
    },
    select: { id: true },
  });
  if (!requesterMembership) deny('The requester is no longer an active company member.');

  if (subject.scope === 'personal') {
    if (subject.ownerUserId !== subject.requesterId || subject.departmentId !== null) {
      deny('Personal knowledge no longer matches the authenticated owner.');
    }
  } else if (subject.scope === 'department') {
    if (!subject.departmentId || subject.ownerUserId !== null) {
      deny('Department knowledge has an invalid target.');
    }
    const membership = await tx.departmentMembership.findFirst({
      where: {
        departmentId: subject.departmentId,
        userId: subject.requesterId,
        status: 'active',
        department: { companyId: subject.companyId, status: 'active' },
      },
      select: { id: true },
    });
    if (!membership) {
      deny('The requester is no longer an active member of the target department.');
    }
  } else if (subject.ownerUserId !== null || subject.departmentId !== null) {
    deny('Company knowledge has an invalid target.');
  }

  const policies = await tx.knowledgePolicy.findMany({
    where: {
      tenantKey: { in: [subject.companyId, 'global'] },
      kind: subject.kind,
      scope: subject.scope,
      action: subject.action,
    },
  });
  const policy = policies.find(candidate => candidate.tenantKey === subject.companyId)
    ?? policies.find(candidate => candidate.tenantKey === 'global');
  if (!policy) {
    throw new KnowledgeMutationError('policy_missing', 'The governing knowledge policy no longer exists.');
  }
  if (!policy.enabled) {
    throw new KnowledgeMutationError('policy_disabled', 'The governing knowledge policy is now disabled.');
  }
  const policySnapshot = toPolicy(policy);
  const policyError = validateKnowledgePolicy(policySnapshot);
  if (policyError) throw new KnowledgeMutationError('policy_invalid', policyError);

  const originalPolicy = subject.policy ?? (
    subject.policyId === undefined
      ? undefined
      : {
          id: subject.policyId,
          tenantKey: '',
          kind: subject.kind,
          scope: subject.scope,
          action: subject.action,
          requesterReviewRequired: subject.requesterReviewRequired!,
          requiredAuthority: subject.requiredAuthority!,
          distinctApprover: subject.distinctApprover!,
          enabled: true,
          version: subject.policyVersion!,
        }
  );
  if (
    originalPolicy
    && (
      policySnapshot.id !== originalPolicy.id
      || policySnapshot.version !== originalPolicy.version
      || policySnapshot.requesterReviewRequired !== originalPolicy.requesterReviewRequired
      || policySnapshot.requiredAuthority !== originalPolicy.requiredAuthority
      || policySnapshot.distinctApprover !== originalPolicy.distinctApprover
    )
  ) {
    throw new KnowledgeMutationError(
      'policy_changed',
      'Knowledge policy changed after this proposal was created. Open a new review under the current policy.',
    );
  }

  if (!approvedBy) return;
  const requiredAuthority = originalPolicy?.requiredAuthority ?? subject.requiredAuthority;
  const distinctApprover = originalPolicy?.distinctApprover ?? subject.distinctApprover;
  if (distinctApprover !== false && approvedBy === subject.requesterId) {
    deny('The requester cannot approve their own shared knowledge change.');
  }
  if (requiredAuthority === 'department_manager') {
    if (!subject.departmentId) deny('Department approval has no department target.');
    const manager = await tx.departmentMembership.findFirst({
      where: {
        departmentId: subject.departmentId!,
        userId: approvedBy,
        status: 'active',
        department: { companyId: subject.companyId, status: 'active' },
        role: { slug: { in: ['MANAGER', 'manager'] } },
      },
      select: { id: true },
    });
    if (!manager) deny('The approver is no longer an active manager of the target department.');
  } else if (requiredAuthority === 'company_admin') {
    const admin = await tx.adminMembership.findFirst({
      where: {
        companyId: subject.companyId,
        userId: approvedBy,
        isActive: true,
        role: { in: ['COMPANY_ADMIN', 'SUPER_ADMIN'] },
      },
      select: { id: true },
    });
    if (!admin) deny('The approver is no longer an active company administrator.');
  } else {
    throw new KnowledgeMutationError(
      'approval_mismatch',
      'Personal knowledge cannot use a shared approval receipt.',
    );
  }
}

async function advisoryLock(tx: Tx, namespace: string, key: string): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtext(${namespace}), hashtext(${key}))::text AS lock_result
  `;
}

async function lockAutomaticLearningSource(
  tx: Tx,
  input: {
    readonly companyId: string;
    readonly requesterId: string;
    readonly sourceType: string;
    readonly sourceRef: string | null;
  },
): Promise<void> {
  if (input.sourceType !== 'automatic_learning') return;
  if (!input.sourceRef) invalidState('Automatic learning has no durable source job.');
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT job."id"
    FROM "KnowledgeLearningJob" AS job
    WHERE job."companyId" = ${input.companyId}
      AND job."userId" = ${input.requesterId}
      AND job."sourceId" = ${input.sourceRef}
    FOR UPDATE
  `;
  if (rows.length !== 1) {
    invalidState('Automatic learning source was erased or is no longer available.');
  }
}

async function requireMutation(tx: Tx, mutationId: string, companyId: string) {
  const row = await tx.knowledgeMutation.findFirst({ where: { id: mutationId, companyId } });
  if (!row) throw new KnowledgeMutationError('not_found', 'Knowledge mutation not found.');
  return row;
}

function validateResourcePrecondition(
  resource: ResourceRow | null,
  input: CreateKnowledgeProposalInput,
): string | null {
  if (input.action === 'create' || (input.action === 'publish' && input.baseVersion === null)) {
    if (resource) {
      if (isPersonalMemoryResurrection(resource, input)) return resource.id;
      throw new KnowledgeMutationError('conflict', 'This knowledge resource already exists; update it by version.');
    }
    return null;
  }
  if (!resource || resource.status === 'deleted') {
    throw new KnowledgeMutationError('not_found', 'The knowledge resource does not exist or is deleted.');
  }
  if (resource.currentVersion !== input.baseVersion) staleVersion();
  return resource.id;
}

async function prepareExistingResource(tx: Tx, resource: ResourceRow, mutation: NonNullable<MutationRow>) {
  if (mutation.action === 'create' && isPersonalMemoryResurrection(resource, mutation)) return resource;
  if (mutation.action === 'create' || (mutation.action === 'publish' && mutation.baseVersion === null)) {
    throw new KnowledgeMutationError('conflict', 'This knowledge resource already exists.');
  }
  if (resource.status === 'deleted' || resource.currentVersion !== mutation.baseVersion) staleVersion();
  return resource;
}

async function createResource(tx: Tx, mutation: NonNullable<MutationRow>) {
  if (mutation.action !== 'create' && !(mutation.action === 'publish' && mutation.baseVersion === null)) {
    throw new KnowledgeMutationError('not_found', 'The target resource disappeared before apply.');
  }
  return tx.knowledgeResource.create({
    data: {
      companyId: mutation.companyId,
      kind: mutation.kind,
      scope: mutation.scope,
      targetKey: mutation.targetKey,
      ownerUserId: mutation.ownerUserId,
      departmentId: mutation.departmentId,
      logicalKey: mutation.logicalKey,
      status: knowledgeResourceStatusAfterMutation('draft', mutation.action),
      createdById: mutation.requesterId,
    },
  });
}

async function bindFileAsset(
  tx: Tx,
  mutation: NonNullable<MutationRow>,
  resourceId: string,
  requireThreatScan: boolean,
): Promise<void> {
  const assetId = mutation.fileAssetId;
  if (!assetId) {
    throw new KnowledgeMutationError('invalid_request', 'Governed file content has no staged asset.');
  }
  await advisoryLock(tx, 'knowledge-file-asset', assetId);
  const asset = await tx.knowledgeFileAsset.findFirst({
    where: { id: assetId, companyId: mutation.companyId },
  });
  if (!asset || asset.status === 'deleted' || asset.status === 'deleting') {
    throw new KnowledgeMutationError('not_found', 'The staged file no longer exists.');
  }
  if (asset.status !== 'staged') {
    throw new KnowledgeMutationError('conflict', 'The governed file is no longer an attachable staged asset.');
  }
  if (asset.expiresAt.getTime() <= Date.now()) {
    throw new KnowledgeMutationError('conflict', 'The staged file expired before final attachment.');
  }
  if (asset.uploadedById !== mutation.requesterId) {
    throw new KnowledgeMutationError('permission_denied', 'The requester does not own this staged file.');
  }
  if (asset.knowledgeResourceId && asset.knowledgeResourceId !== resourceId) {
    throw new KnowledgeMutationError('conflict', 'The staged file is already attached elsewhere.');
  }
  if (requireThreatScan && (!asset.threatScanProvider || !asset.threatScannedAt)) {
    throw new KnowledgeMutationError(
      'storage_failure',
      'The staged file has no verified malware-scan evidence at final attachment.',
    );
  }
  const content = asRecord(mutation.proposedContentJson);
  if (
    content['assetId'] !== asset.id
    || content['fileName'] !== asset.fileName
    || content['mimeType'] !== asset.mimeType
    || content['sizeBytes'] !== asset.sizeBytes
    || content['sha256'] !== asset.sha256
  ) {
    throw new KnowledgeMutationError(
      'conflict',
      'The governed file metadata changed before final attachment.',
    );
  }
  await tx.knowledgeFileAsset.update({
    where: { id: asset.id },
    data: {
      knowledgeResourceId: resourceId,
      status: 'attached',
      attachedAt: asset.attachedAt ?? new Date(),
    },
  });
}

function isPersonalMemoryResurrection(
  resource: ResourceRow,
  input: Pick<CreateKnowledgeProposalInput, 'kind' | 'scope' | 'targetKey' | 'ownerUserId' | 'departmentId' | 'requesterId'>,
): boolean {
  // The command layer intentionally keeps its public action vocabulary small:
  // an explicit create against this exact tombstone is the resurrection
  // operation. The target advisory lock and the immutable next version keep it
  // from creating a second resource or rewriting prior history.
  return resource.status === 'deleted'
    && input.kind === 'memory'
    && input.scope === 'personal'
    && input.targetKey === `personal:${input.requesterId}`
    && input.ownerUserId === input.requesterId
    && input.departmentId === null;
}

async function replayApplied(tx: Tx, mutation: NonNullable<MutationRow>): Promise<AppliedKnowledgeMutation> {
  if (!mutation.resourceId) invalidState('Applied mutation has no resource.');
  const resource = await tx.knowledgeResource.findUnique({ where: { id: mutation.resourceId! } });
  const outbox = await tx.knowledgeOutbox.findFirst({
    where: { mutationId: mutation.id },
    orderBy: { createdAt: 'desc' },
  });
  const appliedVersion = mutation.appliedVersionId
    ? await tx.knowledgeVersion.findUnique({
        where: { id: mutation.appliedVersionId },
        select: { version: true },
      })
    : null;
  if (!resource || !outbox) invalidState('Applied mutation is missing its durable result.');
  return {
    mutation: toMutation(mutation),
    resourceId: resource!.id,
    versionId: mutation.appliedVersionId,
    version: appliedVersion?.version ?? mutation.baseVersion ?? resource!.currentVersion,
    outboxEventId: outbox!.id,
  };
}

function toPolicy(row: {
  id: string;
  tenantKey: string;
  kind: KnowledgeResourceKind;
  scope: 'personal' | 'department' | 'company';
  action: 'create' | 'update' | 'publish' | 'delete';
  requesterReviewRequired: boolean;
  requiredAuthority: 'none' | 'department_manager' | 'company_admin';
  distinctApprover: boolean;
  enabled: boolean;
  version: number;
}): KnowledgePolicySnapshot {
  return row;
}

function toMutation(row: NonNullable<MutationRow>): KnowledgeMutationRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    resourceId: row.resourceId,
    kind: row.kind,
    scope: row.scope,
    targetKey: row.targetKey,
    ownerUserId: row.ownerUserId,
    departmentId: row.departmentId,
    logicalKey: row.logicalKey,
    action: row.action,
    baseVersion: row.baseVersion,
    proposedContent: row.proposedContentJson,
    proposedContentHash: row.proposedContentHash,
    requesterId: row.requesterId,
    requesterReviewRequired: row.requesterReviewRequired,
    requesterReviewedAt: row.requesterReviewedAt,
    requiredAuthority: row.requiredAuthority,
    distinctApprover: row.distinctApprover,
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    runtimeApprovalId: row.runtimeApprovalId,
    appliedVersionId: row.appliedVersionId,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function jsonOrDbNull(value: unknown | null): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
  return value === null ? Prisma.DbNull : value as Prisma.InputJsonValue;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function preserveOrWrap(operation: string, cause: unknown): KnowledgeMutationError {
  return cause instanceof KnowledgeMutationError ? cause : storageFailure(operation, cause);
}

function storageFailure(operation: string, cause: unknown): KnowledgeMutationError {
  return new KnowledgeMutationError('storage_failure', `Failed to ${operation}.`, cause);
}

function staleContent(): never {
  throw new KnowledgeMutationError('conflict', 'Proposal content changed after review.');
}

function staleVersion(): never {
  throw new KnowledgeMutationError('stale_version', 'Knowledge changed since this proposal was prepared.');
}

function invalidState(message: string): never {
  throw new KnowledgeMutationError('invalid_state', message);
}

function deny(message: string): never {
  throw new KnowledgeMutationError('permission_denied', message);
}
