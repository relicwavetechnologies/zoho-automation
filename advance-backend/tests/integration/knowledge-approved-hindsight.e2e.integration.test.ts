import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { KnowledgeMutationService } from '../../src/application/knowledge/knowledge-mutation.service.ts';
import { KnowledgeProjectionService } from '../../src/application/knowledge/knowledge-projection.service.ts';
import { KnowledgeRecallService } from '../../src/application/knowledge/knowledge-recall.service.ts';
import { KnowledgeResourceQueryService } from '../../src/application/knowledge/knowledge-resource-query.service.ts';
import {
  companyBankId,
  HindsightMemoryService,
} from '../../src/infrastructure/knowledge/hindsight-memory.service.ts';
import { PrismaKnowledgeMutationStore } from '../../src/infrastructure/persistence/knowledge-mutation.repository.ts';
import { RuntimeApprovalRepository } from '../../src/infrastructure/persistence/runtime-approval.repository.ts';
import { asCompanyId, asUserId } from '../../src/shared/ids.ts';
import { ok } from '../../src/shared/result.ts';

const baseUrl = (
  process.env['HINDSIGHT_INTEGRATION_URL']
  ?? process.env['HINDSIGHT_URL']
)?.trim();
const apiKey = (
  process.env['HINDSIGHT_INTEGRATION_API_KEY']
  ?? process.env['HINDSIGHT_API_KEY']
)?.trim();
const enabled = process.env['RUN_APPROVED_MEMORY_E2E'] === '1'
  && Boolean(process.env['DATABASE_URL'])
  && Boolean(baseUrl);
const prisma = enabled ? new PrismaClient() : null;
const suffix = randomUUID();
let companyId = '';
let requesterId = '';
let approverId = '';
let otherUserId = '';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
};
const departments = { listActiveMemberships: async () => ok([] as never[]) };
const permissions = { canInvoke: async () => ok(undefined) } as never;

before(async () => {
  if (!prisma) return;
  const [requester, approver, other, company] = await prisma.$transaction([
    prisma.user.create({
      data: { email: `approved-memory-requester-${suffix}@example.test`, password: 'integration-only' },
    }),
    prisma.user.create({
      data: { email: `approved-memory-approver-${suffix}@example.test`, password: 'integration-only' },
    }),
    prisma.user.create({
      data: { email: `approved-memory-other-${suffix}@example.test`, password: 'integration-only' },
    }),
    prisma.company.create({ data: { name: `Approved Hindsight E2E ${suffix}` } }),
  ]);
  requesterId = requester.id;
  approverId = approver.id;
  otherUserId = other.id;
  companyId = company.id;
  await prisma.adminMembership.createMany({
    data: [
      { userId: requesterId, companyId, role: 'MEMBER', isActive: true },
      { userId: approverId, companyId, role: 'COMPANY_ADMIN', isActive: true },
      { userId: otherUserId, companyId, role: 'MEMBER', isActive: true },
    ],
  });
  await prisma.knowledgePolicy.createMany({
    data: (['create', 'delete'] as const).map(action => ({
      tenantKey: companyId,
      kind: 'memory' as const,
      scope: 'company' as const,
      action,
      requesterReviewRequired: true,
      requiredAuthority: 'company_admin' as const,
      distinctApprover: true,
      enabled: true,
      version: 1,
    })),
  });
});

after(async () => {
  if (!prisma) return;
  if (baseUrl && companyId) {
    const client = new HindsightClient({
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      userAgent: 'divo-approved-memory-e2e/1.0',
    });
    await client.deleteBank(companyBankId(companyId)).catch(() => undefined);
  }
  if (companyId) {
    await prisma.knowledgePolicy.deleteMany({ where: { tenantKey: companyId } });
    await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
  }
  await prisma.user.deleteMany({
    where: { id: { in: [requesterId, approverId, otherUserId].filter(Boolean) } },
  });
  await prisma.$disconnect();
});

test('real requester review and company approval project to Hindsight, hydrate canonically, and invalidate on approved deletion', {
  skip: !enabled
    ? 'Set RUN_APPROVED_MEMORY_E2E=1, DATABASE_URL, and HINDSIGHT_URL to run.'
    : false,
  timeout: 180_000,
}, async () => {
  const hindsight = new HindsightMemoryService({
    baseUrl: baseUrl!,
    ...(apiKey ? { apiKey } : {}),
    maxResults: 12,
    recallMaxTokens: 1_200,
    recallBudget: 'mid',
    requestTimeoutMs: 30_000,
    recallConcurrency: 4,
    logger: noopLogger,
  });
  const resources = new KnowledgeResourceQueryService({ prisma: prisma!, departments });
  const mutations = new KnowledgeMutationService(new PrismaKnowledgeMutationStore(prisma!));
  const projections = new KnowledgeProjectionService({
    prisma: prisma!,
    memory: hindsight,
    logger: noopLogger,
  });
  const approvals = new RuntimeApprovalRepository(prisma!);
  const recall = new KnowledgeRecallService({
    memory: hindsight,
    departments,
    permissions,
    resources,
  });
  const fact = `APPROVED-E2E-${suffix}: customer incident summaries retain evidence for 37 days.`;
  const logicalKey = `approved.e2e.${suffix}`;

  const proposal = await mutations.propose({
    target: { scope: 'company', companyId: asCompanyId(companyId) },
    requester: { companyId, userId: requesterId },
    kind: 'memory',
    logicalKey,
    action: 'create',
    content: { facts: [fact] },
    sourceType: 'user_explicit',
    sourceRef: `approved-create:${suffix}`,
  });
  assert.equal(proposal.status, 'awaiting_requester_review');
  await assert.rejects(
    mutations.apply({ mutationId: proposal.id, companyId }),
    (error: any) => error?.code === 'review_required',
  );
  const reviewed = await mutations.confirmRequesterReview({
    mutationId: proposal.id,
    companyId,
    requesterId,
    expectedContentHash: proposal.proposedContentHash,
  });
  assert.equal(reviewed.status, 'awaiting_approval');

  const approvalId = await createClaimedApproval({
    approvals,
    mutationId: proposal.id,
    contentHash: proposal.proposedContentHash,
    actionGroup: 'create',
  });
  await mutations.attachRuntimeApproval({
    mutationId: proposal.id,
    companyId,
    requesterId,
    expectedContentHash: proposal.proposedContentHash,
    approvalId,
    authority: 'company_admin',
  });
  await mutations.acceptRuntimeApproval({ mutationId: proposal.id, companyId, approvalId });
  const applied = await mutations.apply({ mutationId: proposal.id, companyId });
  await projections.projectMutation(proposal.id);
  assert.equal((await approvals.completeApprovedExecution(approvalId, { status: 'completed' })).ok, true);
  assert.equal((await prisma!.knowledgeOutbox.findFirstOrThrow({
    where: { mutationId: proposal.id },
  })).status, 'completed');

  const semantic = await waitForSemantic(hindsight, fact);
  assert.ok(semantic.facts.some(item => item.text === fact && item.resourceId === applied.resourceId));
  const canonical = await recall.recall({
    query: `APPROVED-E2E-${suffix}`,
    companyId,
    userId: otherUserId,
    companyRole: 'MEMBER',
    channel: 'desktop',
  });
  assert.ok(canonical.facts.some(item => item.scope === 'company' && item.text === fact));

  const deletion = await mutations.propose({
    target: { scope: 'company', companyId: asCompanyId(companyId) },
    requester: { companyId, userId: requesterId },
    kind: 'memory',
    logicalKey,
    action: 'delete',
    baseVersion: applied.version,
    sourceType: 'user_explicit',
    sourceRef: `approved-delete:${suffix}`,
  });
  await mutations.confirmRequesterReview({
    mutationId: deletion.id,
    companyId,
    requesterId,
    expectedContentHash: null,
  });
  const deletionApprovalId = await createClaimedApproval({
    approvals,
    mutationId: deletion.id,
    contentHash: null,
    actionGroup: 'delete',
  });
  await mutations.attachRuntimeApproval({
    mutationId: deletion.id,
    companyId,
    requesterId,
    expectedContentHash: null,
    approvalId: deletionApprovalId,
    authority: 'company_admin',
  });
  await mutations.acceptRuntimeApproval({
    mutationId: deletion.id,
    companyId,
    approvalId: deletionApprovalId,
  });
  await mutations.apply({ mutationId: deletion.id, companyId });
  await projections.projectMutation(deletion.id);
  assert.equal((await approvals.completeApprovedExecution(
    deletionApprovalId,
    { status: 'completed' },
  )).ok, true);

  const afterDeleteSemantic = await hindsight.searchForRecall({
    query: `APPROVED-E2E-${suffix}`,
    userId: otherUserId,
    companyId,
    departments: [],
    limit: 12,
    maxFactChars: 500,
    maxTotalChars: 3_000,
  });
  assert.equal(afterDeleteSemantic.facts.some(item => item.text === fact), false);
  const afterDeleteCanonical = await recall.recall({
    query: `APPROVED-E2E-${suffix}`,
    companyId,
    userId: otherUserId,
    companyRole: 'MEMBER',
    channel: 'desktop',
  });
  assert.equal(afterDeleteCanonical.facts.some(item => item.text === fact), false);
});

test('real PostgreSQL permits exactly one concurrent approval decision and execution claim', {
  skip: !enabled
    ? 'Set RUN_APPROVED_MEMORY_E2E=1, DATABASE_URL, and HINDSIGHT_URL to run.'
    : false,
}, async () => {
  const approvals = new RuntimeApprovalRepository(prisma!);
  const decisionId = await createPendingApproval(approvals, `decision-race:${suffix}`);
  const decisions = await Promise.all([
    approvals.atomicResolve(decisionId, 'approved', approverId),
    approvals.atomicResolve(decisionId, 'rejected', approverId),
  ]);
  assert.ok(decisions.every(result => result.ok));
  assert.equal(decisions.filter(result => result.ok && result.value !== null).length, 1);
  const decided = await prisma!.runtimeApproval.findUniqueOrThrow({ where: { id: decisionId } });
  assert.ok(decided.status === 'approved' || decided.status === 'rejected');

  const claimId = await createPendingApproval(approvals, `claim-race:${suffix}`);
  const resolved = await approvals.atomicResolve(claimId, 'approved', approverId);
  assert.equal(resolved.ok && resolved.value !== null, true);
  const claims = await Promise.all([
    approvals.claimApprovedExecution(claimId, requesterId),
    approvals.claimApprovedExecution(claimId, requesterId),
  ]);
  assert.ok(claims.every(result => result.ok));
  assert.equal(claims.filter(result => result.ok && result.value !== null).length, 1);
  assert.equal((await prisma!.runtimeApproval.findUniqueOrThrow({ where: { id: claimId } })).status, 'executing');
});

test('requester cancellation atomically revokes the linked pending approval', {
  skip: !enabled
    ? 'Set RUN_APPROVED_MEMORY_E2E=1, DATABASE_URL, and HINDSIGHT_URL to run.'
    : false,
}, async () => {
  const mutations = new KnowledgeMutationService(new PrismaKnowledgeMutationStore(prisma!));
  const approvals = new RuntimeApprovalRepository(prisma!);
  const proposal = await mutations.propose({
    target: { scope: 'company', companyId: asCompanyId(companyId) },
    requester: { companyId, userId: requesterId },
    kind: 'memory',
    logicalKey: `cancelled.e2e.${suffix}`,
    action: 'create',
    content: { facts: [`CANCELLED-E2E-${suffix}`] },
    sourceType: 'user_explicit',
    sourceRef: `cancelled-create:${suffix}`,
  });
  await mutations.confirmRequesterReview({
    mutationId: proposal.id,
    companyId,
    requesterId,
    expectedContentHash: proposal.proposedContentHash,
  });
  const approvalId = await createPendingApproval(approvals, `cancel-race:${suffix}`);
  await mutations.attachRuntimeApproval({
    mutationId: proposal.id,
    companyId,
    requesterId,
    expectedContentHash: proposal.proposedContentHash,
    approvalId,
    authority: 'company_admin',
  });

  const cancelled = await mutations.cancel({ mutationId: proposal.id, companyId, requesterId });
  assert.equal(cancelled.status, 'cancelled');
  const approval = await prisma!.runtimeApproval.findUniqueOrThrow({ where: { id: approvalId } });
  assert.equal(approval.status, 'rejected');
  assert.match(approval.resolutionReason ?? '', /requester cancelled/i);
  const staleClick = await approvals.atomicResolve(approvalId, 'approved', approverId);
  assert.equal(staleClick.ok, true);
  assert.equal(staleClick.ok ? staleClick.value : undefined, null);
});

async function createClaimedApproval(input: {
  approvals: RuntimeApprovalRepository;
  mutationId: string;
  contentHash: string | null;
  actionGroup: 'create' | 'delete';
}): Promise<string> {
  const created = await input.approvals.create({
    chatId: `approved-memory-e2e-${suffix}`,
    companyId,
    toolId: 'knowledge',
    actionGroup: input.actionGroup,
    kind: 'knowledge_mutation',
    summary: `Approve ${input.actionGroup} for governed memory`,
    payloadJson: { args: { mutationId: input.mutationId, contentHash: input.contentHash } },
    metadataJson: {
      approvalAuthority: 'company_admin',
      resolvedManagerUserId: approverId,
    },
    channel: 'desktop',
    requestedBy: requesterId,
    idempotencyKey: `approved-memory:${input.mutationId}`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (!created.ok) throw created.error;
  const delivered = await input.approvals.setDecisionMessageId(created.value.id, randomUUID());
  if (!delivered.ok) throw delivered.error;
  const resolved = await input.approvals.atomicResolve(created.value.id, 'approved', approverId);
  if (!resolved.ok) throw resolved.error;
  assert.equal(resolved.value?.approvedBy, approverId);
  const claimed = await input.approvals.claimApprovedExecution(created.value.id, requesterId);
  if (!claimed.ok) throw claimed.error;
  assert.equal(claimed.value?.status, 'executing');
  return created.value.id;
}

async function createPendingApproval(
  approvals: RuntimeApprovalRepository,
  idempotencyKey: string,
): Promise<string> {
  const created = await approvals.create({
    chatId: `approved-memory-race-${suffix}`,
    companyId,
    toolId: 'knowledge',
    actionGroup: 'create',
    kind: 'knowledge_mutation',
    summary: 'Concurrent approval integration test',
    payloadJson: { args: {} },
    metadataJson: { resolvedManagerUserId: approverId },
    channel: 'desktop',
    requestedBy: requesterId,
    idempotencyKey,
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (!created.ok) throw created.error;
  const delivered = await approvals.setDecisionMessageId(created.value.id, randomUUID());
  if (!delivered.ok) throw delivered.error;
  return created.value.id;
}

async function waitForSemantic(service: HindsightMemoryService, expected: string) {
  let latest = await service.searchForRecall({
    query: expected,
    userId: otherUserId,
    companyId,
    departments: [],
    limit: 12,
    maxFactChars: 500,
    maxTotalChars: 3_000,
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (latest.facts.some(item => item.text === expected)) return latest;
    await new Promise<void>(resolve => setTimeout(resolve, 1_000));
    latest = await service.searchForRecall({
      query: expected,
      userId: otherUserId,
      companyId,
      departments: [],
      limit: 12,
      maxFactChars: 500,
      maxTotalChars: 3_000,
    });
  }
  return latest;
}
