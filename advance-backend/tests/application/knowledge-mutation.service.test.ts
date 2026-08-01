import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeMutationService } from '../../src/application/knowledge/knowledge-mutation.service.ts';
import { KnowledgeMutationError } from '../../src/application/knowledge/knowledge-mutation.errors.ts';
import type {
  AppliedKnowledgeMutation,
  CreateKnowledgeProposalInput,
  KnowledgeApprovalReceipt,
  KnowledgeMutationStore,
} from '../../src/application/knowledge/knowledge-mutation.store.ts';
import type {
  KnowledgeMutationRecord,
  KnowledgePolicySnapshot,
} from '../../src/domain/knowledge/knowledge-mutation.ts';
import type { ResolvedKnowledgeScope } from '../../src/domain/knowledge/knowledge-scope.ts';
import { DefaultKnowledgeContentValidator } from '../../src/application/knowledge/knowledge-content-validator.ts';

const NOW = new Date('2026-07-31T00:00:00.000Z');

class FakeKnowledgeStore implements KnowledgeMutationStore {
  readonly mutations = new Map<string, KnowledgeMutationRecord>();
  readonly receipts = new Map<string, KnowledgeApprovalReceipt>();
  private nextId = 1;

  async resolvePolicy(input: Parameters<KnowledgeMutationStore['resolvePolicy']>[0]) {
    const shared = input.scope !== 'personal';
    return {
      id: `policy:${input.kind}:${input.scope}:${input.action}`,
      tenantKey: 'global',
      kind: input.kind,
      scope: input.scope,
      action: input.action,
      requesterReviewRequired: shared || (
        input.kind === 'skill' && input.scope === 'personal' && input.action === 'publish'
      ),
      requiredAuthority: input.scope === 'department'
        ? 'department_manager'
        : input.scope === 'company'
          ? 'company_admin'
          : 'none',
      distinctApprover: shared,
      enabled: true,
      version: 1,
    } satisfies KnowledgePolicySnapshot;
  }

  async createProposal(input: CreateKnowledgeProposalInput): Promise<KnowledgeMutationRecord> {
    const replay = [...this.mutations.values()].find(row => row.idempotencyKey === input.idempotencyKey);
    if (replay) return replay;
    const id = `mutation-${this.nextId++}`;
    const row: KnowledgeMutationRecord = {
      id,
      companyId: input.companyId,
      resourceId: null,
      kind: input.kind,
      scope: input.scope,
      targetKey: input.targetKey,
      ownerUserId: input.ownerUserId,
      departmentId: input.departmentId,
      logicalKey: input.logicalKey,
      action: input.action,
      baseVersion: input.baseVersion,
      proposedContent: input.proposedContent,
      proposedContentHash: input.proposedContentHash,
      requesterId: input.requesterId,
      requesterReviewRequired: input.policy.requesterReviewRequired,
      requesterReviewedAt: null,
      requiredAuthority: input.policy.requiredAuthority,
      distinctApprover: input.policy.distinctApprover,
      policyId: input.policy.id,
      policyVersion: input.policy.version,
      runtimeApprovalId: null,
      appliedVersionId: null,
      status: input.initialStatus,
      idempotencyKey: input.idempotencyKey,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.mutations.set(id, row);
    return row;
  }

  async getMutation(input: { mutationId: string; companyId: string }) {
    const row = this.mutations.get(input.mutationId);
    return row?.companyId === input.companyId ? row : null;
  }

  async confirmRequesterReview(input: Parameters<KnowledgeMutationStore['confirmRequesterReview']>[0]) {
    return this.replace(input.mutationId, {
      requesterReviewedAt: NOW,
      status: input.nextStatus,
    });
  }

  async attachRuntimeApproval(input: Parameters<KnowledgeMutationStore['attachRuntimeApproval']>[0]) {
    return this.replace(input.mutationId, { runtimeApprovalId: input.approvalId });
  }

  async readApprovalReceipt(approvalId: string) {
    return this.receipts.get(approvalId) ?? null;
  }

  async acceptApproval(input: Parameters<KnowledgeMutationStore['acceptApproval']>[0]) {
    return this.replace(input.mutationId, { status: 'approved' });
  }

  async applyApproved(input: Parameters<KnowledgeMutationStore['applyApproved']>[0]): Promise<AppliedKnowledgeMutation> {
    const existing = this.mutations.get(input.mutationId)!;
    const applied = existing.status === 'applied'
      ? existing
      : this.replace(input.mutationId, {
          resourceId: `resource:${existing.targetKey}:${existing.logicalKey}`,
          appliedVersionId: existing.action === 'delete' ? null : `version:${existing.id}`,
          status: 'applied',
        });
    return {
      mutation: applied,
      resourceId: applied.resourceId!,
      versionId: applied.appliedVersionId,
      version: 1,
      outboxEventId: `outbox:${applied.id}`,
    };
  }

  async reject(input: Parameters<KnowledgeMutationStore['reject']>[0]) {
    return this.replace(input.mutationId, { status: 'rejected' });
  }

  async cancel(input: Parameters<KnowledgeMutationStore['cancel']>[0]) {
    return this.replace(input.mutationId, { status: 'cancelled' });
  }

  private replace(id: string, patch: Partial<KnowledgeMutationRecord>): KnowledgeMutationRecord {
    const current = this.mutations.get(id)!;
    const next = { ...current, ...patch, updatedAt: NOW };
    this.mutations.set(id, next);
    return next;
  }
}

describe('KnowledgeMutationService', () => {
  it('applies personal memory immediately without requester or manager approval', async () => {
    const store = new FakeKnowledgeStore();
    const service = new KnowledgeMutationService(store);
    const proposed = await service.propose({
      target: personalTarget('co-1', 'user-a'),
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'memory',
      logicalKey: 'weekly-report-format',
      action: 'create',
      content: { facts: ['Weekly reports use a two-column table.'] },
      sourceType: 'user_explicit',
    });

    assert.equal(proposed.status, 'approved');
    assert.equal(proposed.requiredAuthority, 'none');
    assert.equal(proposed.targetKey, 'personal:user-a');
    const applied = await service.apply({ mutationId: proposed.id, companyId: 'co-1' });
    assert.equal(applied.mutation.status, 'applied');
  });

  it('requires exact requester review and a different department manager before apply', async () => {
    const store = new FakeKnowledgeStore();
    const service = new KnowledgeMutationService(store);
    const proposed = await service.propose({
      target: departmentTarget('co-1', 'dept-tech'),
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'memory',
      logicalKey: 'weekly-qa-cutoff',
      action: 'publish',
      content: { facts: ['Tech Testing weekly QA cutoff is Friday at 5 PM.'] },
      sourceType: 'user_explicit',
    });
    assert.equal(proposed.status, 'awaiting_requester_review');
    await assertRejectCode(
      service.apply({ mutationId: proposed.id, companyId: 'co-1' }),
      'review_required',
    );

    const reviewed = await service.confirmRequesterReview({
      mutationId: proposed.id,
      companyId: 'co-1',
      requesterId: 'user-a',
      expectedContentHash: proposed.proposedContentHash,
    });
    assert.equal(reviewed.status, 'awaiting_approval');

    const bound = await service.attachRuntimeApproval({
      mutationId: proposed.id,
      companyId: 'co-1',
      requesterId: 'user-a',
      expectedContentHash: proposed.proposedContentHash,
      approvalId: 'approval-1',
      authority: 'department_manager',
    });
    assert.equal(bound.runtimeApprovalId, 'approval-1');
    store.receipts.set('approval-1', {
      approvalId: 'approval-1',
      companyId: 'co-1',
      status: 'executing',
      requestedBy: 'user-a',
      approvedBy: 'manager-b',
      authority: 'department_manager',
      mutationId: proposed.id,
      contentHash: proposed.proposedContentHash,
    });
    const approved = await service.acceptRuntimeApproval({
      mutationId: proposed.id,
      companyId: 'co-1',
      approvalId: 'approval-1',
    });
    assert.equal(approved.status, 'approved');
    assert.equal((await service.apply({ mutationId: proposed.id, companyId: 'co-1' })).mutation.status, 'applied');
  });

  it('rejects self-approval even when the approval row otherwise matches', async () => {
    const store = new FakeKnowledgeStore();
    const service = new KnowledgeMutationService(store);
    const proposal = await prepareSharedProposal(service, 'company');
    await service.attachRuntimeApproval({
      mutationId: proposal.id,
      companyId: 'co-1',
      requesterId: 'user-a',
      expectedContentHash: proposal.proposedContentHash,
      approvalId: 'approval-self',
      authority: 'company_admin',
    });
    store.receipts.set('approval-self', {
      approvalId: 'approval-self',
      companyId: 'co-1',
      status: 'executing',
      requestedBy: 'user-a',
      approvedBy: 'user-a',
      authority: 'company_admin',
      mutationId: proposal.id,
      contentHash: proposal.proposedContentHash,
    });

    await assertRejectCode(service.acceptRuntimeApproval({
      mutationId: proposal.id,
      companyId: 'co-1',
      approvalId: 'approval-self',
    }), 'permission_denied');
  });

  it('invalidates review when the exact content hash changes', async () => {
    const store = new FakeKnowledgeStore();
    const service = new KnowledgeMutationService(store);
    const proposal = await service.propose({
      target: departmentTarget('co-1', 'dept-tech'),
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'skill',
      logicalKey: 'document-creation',
      action: 'publish',
      content: skillContent('# Document creation\n\nRollback before Owners.'),
      sourceType: 'skill_teach',
    });

    await assertRejectCode(service.confirmRequesterReview({
      mutationId: proposal.id,
      companyId: 'co-1',
      requesterId: 'user-a',
      expectedContentHash: 'content-was-edited',
    }), 'conflict');
    assert.equal(store.mutations.get(proposal.id)?.status, 'awaiting_requester_review');
  });

  it('fails closed on cross-company and cross-user personal targets', async () => {
    const service = new KnowledgeMutationService(new FakeKnowledgeStore());
    await assertRejectCode(service.propose({
      target: personalTarget('co-2', 'user-a'),
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'memory',
      logicalKey: 'preference',
      action: 'create',
      content: { facts: ['Private.'] },
      sourceType: 'user_explicit',
    }), 'permission_denied');
    await assertRejectCode(service.propose({
      target: personalTarget('co-1', 'user-b'),
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'memory',
      logicalKey: 'preference',
      action: 'create',
      content: { facts: ['Private.'] },
      sourceType: 'user_explicit',
    }), 'permission_denied');
  });

  it('creates independent department and company proposals instead of a bypassing both scope', async () => {
    const store = new FakeKnowledgeStore();
    const service = new KnowledgeMutationService(store);
    const base = {
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'skill' as const,
      logicalKey: 'document-creation',
      action: 'publish' as const,
      content: skillContent('# Procedure'),
      sourceType: 'skill_teach' as const,
    };
    const department = await service.propose({ ...base, target: departmentTarget('co-1', 'dept-tech') });
    const company = await service.propose({ ...base, target: companyTarget('co-1') });

    assert.notEqual(department.id, company.id);
    assert.notEqual(department.idempotencyKey, company.idempotencyKey);
    assert.equal(department.requiredAuthority, 'department_manager');
    assert.equal(company.requiredAuthority, 'company_admin');
  });

  it('deduplicates the same exact proposal while preserving a changed proposal', async () => {
    const store = new FakeKnowledgeStore();
    const service = new KnowledgeMutationService(store);
    const input = {
      target: personalTarget('co-1', 'user-a'),
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'memory' as const,
      logicalKey: 'report-format',
      action: 'create' as const,
      content: { facts: ['Two columns.'] },
      sourceType: 'user_explicit' as const,
    };
    const first = await service.propose(input);
    const replay = await service.propose(input);
    const changed = await service.propose({ ...input, content: { facts: ['Three columns.'] } });

    assert.equal(replay.id, first.id);
    assert.notEqual(changed.id, first.id);
  });

  it('requires optimistic base versions for update and delete', async () => {
    const service = new KnowledgeMutationService(new FakeKnowledgeStore());
    await assertRejectCode(service.propose({
      target: personalTarget('co-1', 'user-a'),
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'memory',
      logicalKey: 'report-format',
      action: 'update',
      content: { facts: ['Updated.'] },
      sourceType: 'user_explicit',
    }), 'invalid_request');
    await assertRejectCode(service.propose({
      target: personalTarget('co-1', 'user-a'),
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'memory',
      logicalKey: 'report-format',
      action: 'delete',
      content: { should: 'not exist' },
      baseVersion: 1,
      sourceType: 'user_explicit',
    }), 'invalid_request');
  });

  it('accepts only an exact backend-staged file owned by the requester', async () => {
    const store = new FakeKnowledgeStore();
    const service = new KnowledgeMutationService(store, new DefaultKnowledgeContentValidator({
      getForValidation: async ({ assetId, companyId }) => assetId === '00000000-0000-4000-8000-000000000099'
        && companyId === 'co-1'
        ? {
            id: assetId,
            companyId,
            uploadedById: 'user-a',
            knowledgeResourceId: null,
            fileName: 'procedure.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 42,
            sha256: 'a'.repeat(64),
            threatScanProvider: 'clamav',
            threatScannedAt: new Date(),
            status: 'staged',
            expiresAt: new Date(Date.now() + 60_000),
          }
        : null,
    }, { requireThreatScan: true }));
    const exact = {
      assetId: '00000000-0000-4000-8000-000000000099',
      fileName: 'procedure.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 42,
      sha256: 'a'.repeat(64),
    };
    const proposal = await service.propose({
      target: departmentTarget('co-1', 'dept-tech'),
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'file',
      logicalKey: 'procedure-pdf',
      action: 'publish',
      content: exact,
      sourceType: 'file_upload',
    });
    assert.deepEqual(proposal.proposedContent, exact);

    await assertRejectCode(service.propose({
      target: departmentTarget('co-1', 'dept-tech'),
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'file',
      logicalKey: 'forged-provider-key',
      action: 'publish',
      content: { ...exact, objectKey: 'another-company/private-object' },
      sourceType: 'file_upload',
    }), 'invalid_request');
    await assertRejectCode(service.propose({
      target: departmentTarget('co-1', 'dept-tech'),
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'file',
      logicalKey: 'changed-file',
      action: 'publish',
      content: { ...exact, sha256: 'b'.repeat(64) },
      sourceType: 'file_upload',
    }), 'conflict');

    const unscanned = new KnowledgeMutationService(store, new DefaultKnowledgeContentValidator({
      getForValidation: async () => ({
        id: exact.assetId,
        companyId: 'co-1',
        uploadedById: 'user-a',
        knowledgeResourceId: null,
        fileName: exact.fileName,
        mimeType: exact.mimeType,
        sizeBytes: exact.sizeBytes,
        sha256: exact.sha256,
        threatScanProvider: null,
        threatScannedAt: null,
        status: 'staged',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    }, { requireThreatScan: true }));
    await assertRejectCode(unscanned.propose({
      target: departmentTarget('co-1', 'dept-tech'),
      requester: { companyId: 'co-1', userId: 'user-a' },
      kind: 'file',
      logicalKey: 'unscanned-file',
      action: 'publish',
      content: exact,
      sourceType: 'file_upload',
    }), 'storage_failure');
  });
});

async function prepareSharedProposal(
  service: KnowledgeMutationService,
  scope: 'department' | 'company',
): Promise<KnowledgeMutationRecord> {
  const proposal = await service.propose({
    target: scope === 'department' ? departmentTarget('co-1', 'dept-tech') : companyTarget('co-1'),
    requester: { companyId: 'co-1', userId: 'user-a' },
    kind: 'memory',
    logicalKey: 'founded-year',
    action: 'publish',
    content: { facts: ['The company was founded in 2016.'] },
    sourceType: 'user_explicit',
  });
  return service.confirmRequesterReview({
    mutationId: proposal.id,
    companyId: proposal.companyId,
    requesterId: proposal.requesterId,
    expectedContentHash: proposal.proposedContentHash,
  });
}

function personalTarget(companyId: string, userId: string): ResolvedKnowledgeScope {
  return { scope: 'personal', companyId: companyId as never, userId: userId as never };
}

function departmentTarget(companyId: string, departmentId: string): ResolvedKnowledgeScope {
  return {
    scope: 'department',
    companyId: companyId as never,
    departmentId: departmentId as never,
    departmentName: 'Tech Testing',
  };
}

function companyTarget(companyId: string): ResolvedKnowledgeScope {
  return { scope: 'company', companyId: companyId as never };
}

function skillContent(markdown: string) {
  return {
    name: 'Document creation',
    slug: 'document-creation',
    summary: 'Create a document consistently.',
    markdown,
    toolIds: [],
    tags: ['documents'],
  };
}

async function assertRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof KnowledgeMutationError, true);
    assert.equal((error as KnowledgeMutationError).code, code);
    return true;
  });
}
