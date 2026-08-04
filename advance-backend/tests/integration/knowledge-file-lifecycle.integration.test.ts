import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { KnowledgeMutationError } from '../../src/application/knowledge/knowledge-mutation.errors.ts';
import { PrismaKnowledgeFileAssetRepository } from '../../src/infrastructure/persistence/knowledge-file-asset.repository.ts';
import { PrismaKnowledgeMutationStore } from '../../src/infrastructure/persistence/knowledge-mutation.repository.ts';

const enabled = process.env['RUN_DATABASE_INTEGRATION'] === '1' && Boolean(process.env['DATABASE_URL']);
const prisma = enabled ? new PrismaClient() : null;
const suffix = randomUUID();
let companyId = '';
let ownerId = '';

before(async () => {
  if (!prisma) return;
  const owner = await prisma.user.create({
    data: { email: `file-lifecycle-owner-${suffix}@example.test`, password: 'integration-only' },
  });
  const company = await prisma.company.create({ data: { name: `File lifecycle ${suffix}` } });
  ownerId = owner.id;
  companyId = company.id;
  await prisma.adminMembership.create({
    data: { userId: ownerId, companyId, role: 'MEMBER', isActive: true },
  });
  await prisma.knowledgePolicy.create({
    data: {
      tenantKey: companyId,
      kind: 'file',
      scope: 'personal',
      action: 'publish',
      requesterReviewRequired: true,
      requiredAuthority: 'none',
      distinctApprover: false,
      enabled: true,
      version: 1,
    },
  });
});

after(async () => {
  if (!prisma) return;
  if (companyId) {
    await prisma.knowledgePolicy.deleteMany({ where: { tenantKey: companyId } });
    await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
  }
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.$disconnect();
});

test('real apply revalidates expiry, threat evidence, and exact staged metadata', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const expired = await createFixture({
    logicalKey: 'expired',
    expiresAt: new Date(Date.now() - 1),
    scanned: true,
  });
  await assert.rejects(
    new PrismaKnowledgeMutationStore(prisma!).applyApproved({
      mutationId: expired.mutationId,
      companyId,
    }),
    (error: unknown) => error instanceof KnowledgeMutationError && error.code === 'conflict',
  );

  const unscanned = await createFixture({ logicalKey: 'unscanned', scanned: false });
  await assert.rejects(
    new PrismaKnowledgeMutationStore(prisma!).applyApproved({
      mutationId: unscanned.mutationId,
      companyId,
    }),
    (error: unknown) => error instanceof KnowledgeMutationError && error.code === 'storage_failure',
  );

  const metadata = await createFixture({ logicalKey: 'metadata', scanned: true, contentSizeBytes: 999 });
  await assert.rejects(
    new PrismaKnowledgeMutationStore(prisma!).applyApproved({
      mutationId: metadata.mutationId,
      companyId,
    }),
    (error: unknown) => error instanceof KnowledgeMutationError && error.code === 'conflict',
  );
});

test('real staged-file deletion leases are exclusive and token-fenced', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const asset = await prisma!.knowledgeFileAsset.create({
    data: {
      companyId,
      uploadedById: ownerId,
      provider: 'integration',
      storageKey: `integration/${suffix}/${randomUUID()}`,
      resourceType: 'raw',
      deliveryType: 'authenticated',
      fileName: 'lease.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 7,
      sha256: createHash('sha256').update('payload').digest('hex'),
      status: 'staged',
      expiresAt: new Date(Date.now() - 1),
    },
  });
  const repository = new PrismaKnowledgeFileAssetRepository(prisma!);
  const first = await repository.claimStagedDeletion({
    assetId: asset.id,
    companyId,
    uploadedById: ownerId,
  });
  assert.ok(first?.deletionLeaseToken);
  assert.equal(await repository.claimStagedDeletion({
    assetId: asset.id,
    companyId,
    uploadedById: ownerId,
  }), null);
  assert.equal(await repository.completeStagedDeletion({
    assetId: asset.id,
    companyId,
    deletionLeaseToken: 'wrong-token',
  }), false);
  assert.equal(await repository.completeStagedDeletion({
    assetId: asset.id,
    companyId,
    deletionLeaseToken: first!.deletionLeaseToken!,
  }), true);
});

async function createFixture(input: {
  logicalKey: string;
  expiresAt?: Date;
  scanned: boolean;
  contentSizeBytes?: number;
}): Promise<{ mutationId: string }> {
  const assetId = randomUUID();
  const content = {
    assetId,
    fileName: `${input.logicalKey}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: input.contentSizeBytes ?? 7,
    sha256: createHash('sha256').update('payload').digest('hex'),
  };
  await prisma!.knowledgeFileAsset.create({
    data: {
      id: assetId,
      companyId,
      uploadedById: ownerId,
      provider: 'integration',
      storageKey: `integration/${suffix}/${assetId}`,
      resourceType: 'raw',
      deliveryType: 'authenticated',
      fileName: `${input.logicalKey}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 7,
      sha256: content.sha256,
      threatScanProvider: input.scanned ? 'integration-scanner' : null,
      threatScanVersion: input.scanned ? 'test-1' : null,
      threatScannedAt: input.scanned ? new Date() : null,
      status: 'staged',
      expiresAt: input.expiresAt ?? new Date(Date.now() + 60_000),
    },
  });
  const mutation = await prisma!.knowledgeMutation.create({
    data: {
      id: randomUUID(),
      companyId,
      resourceId: null,
      kind: 'file',
      scope: 'personal',
      targetKey: `personal:${ownerId}`,
      ownerUserId: ownerId,
      departmentId: null,
      logicalKey: input.logicalKey,
      action: 'publish',
      baseVersion: null,
      proposedContentJson: content,
      proposedContentHash: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
      fileAssetId: assetId,
      evidenceJson: null,
      sourceType: 'integration',
      sourceRef: null,
      requesterId: ownerId,
      requesterReviewRequired: true,
      requiredAuthority: 'none',
      distinctApprover: false,
      policyId: (await prisma!.knowledgePolicy.findUniqueOrThrow({
        where: { tenantKey_kind_scope_action: {
          tenantKey: companyId, kind: 'file', scope: 'personal', action: 'publish',
        } },
        select: { id: true },
      })).id,
      policyVersion: 1,
      status: 'approved',
      idempotencyKey: randomUUID(),
    },
  });
  return { mutationId: mutation.id };
}
