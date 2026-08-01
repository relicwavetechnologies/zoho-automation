import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { PrismaKnowledgeDocumentRepository } from '../../src/infrastructure/persistence/knowledge-document.repository.ts';

const enabled = process.env['RUN_DATABASE_INTEGRATION'] === '1' && Boolean(process.env['DATABASE_URL']);
const prisma = enabled ? new PrismaClient() : null;
const suffix = randomUUID();
let companyId = '';
let ownerId = '';
let otherUserId = '';

before(async () => {
  if (!prisma) return;
  const owner = await prisma.user.create({
    data: { email: `knowledge-owner-${suffix}@example.test`, password: 'integration-only' },
  });
  const other = await prisma.user.create({
    data: { email: `knowledge-other-${suffix}@example.test`, password: 'integration-only' },
  });
  const company = await prisma.company.create({ data: { name: `Knowledge integration ${suffix}` } });
  ownerId = owner.id;
  otherUserId = other.id;
  companyId = company.id;
});

after(async () => {
  if (!prisma) return;
  if (companyId) await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
  if (ownerId || otherUserId) {
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherUserId].filter(Boolean) } } });
  }
  await prisma.$disconnect();
});

test('real Postgres keyword index and canonical hydration enforce live scope and version', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const repository = new PrismaKnowledgeDocumentRepository(prisma!);
  const companyResource = await createResourceWithAsset({
    scope: 'company',
    targetKey: 'company',
    logicalKey: `integration.company.${suffix}`,
    text: `Rollback marker ${suffix} must happen before Owners. साप्ताहिक गुणवत्ता जाँच शुक्रवार को होगी।`,
  });

  const keyword = await repository.keywordSearch({
    companyId,
    userId: ownerId,
    departmentIds: [],
    query: `rollback ${suffix}`,
    limit: 10,
  });
  assert.equal(keyword.length, 1);
  assert.equal(keyword[0]?.resourceId, companyResource.resourceId);
  const hydrated = await repository.hydrateAuthorized({
    companyId,
    userId: ownerId,
    departmentIds: [],
    candidates: keyword,
  });
  assert.equal(hydrated[0]?.fileName, 'company-procedure.pdf');
  assert.equal(hydrated[0]?.pageStart, 4);
  assert.match(hydrated[0]?.text ?? '', /before Owners/);

  const multilingual = await repository.keywordSearch({
    companyId,
    userId: ownerId,
    departmentIds: [],
    query: 'साप्ताहिक गुणवत्ता जाँच',
    limit: 10,
  });
  assert.equal(multilingual.some(hit => hit.resourceId === companyResource.resourceId), true);

  await prisma!.knowledgeResource.update({
    where: { id: companyResource.resourceId },
    data: { currentVersion: 2 },
  });
  assert.deepEqual(await repository.hydrateAuthorized({
    companyId,
    userId: ownerId,
    departmentIds: [],
    candidates: keyword,
  }), []);

  const personal = await createResourceWithAsset({
    scope: 'personal',
    targetKey: `personal:${ownerId}`,
    ownerUserId: ownerId,
    logicalKey: `integration.personal.${suffix}`,
    text: `Private phrase ${suffix} uses a two-column report.`,
  });
  const otherUserHits = await repository.keywordSearch({
    companyId,
    userId: otherUserId,
    departmentIds: [],
    query: `private phrase ${suffix}`,
    limit: 10,
  });
  assert.equal(otherUserHits.some(hit => hit.resourceId === personal.resourceId), false);
  const ownerHits = await repository.keywordSearch({
    companyId,
    userId: ownerId,
    departmentIds: [],
    query: `private phrase ${suffix}`,
    limit: 10,
  });
  assert.equal(ownerHits.some(hit => hit.resourceId === personal.resourceId), true);
});

async function createResourceWithAsset(input: {
  scope: 'personal' | 'company';
  targetKey: string;
  ownerUserId?: string;
  logicalKey: string;
  text: string;
}): Promise<{ resourceId: string }> {
  const resource = await prisma!.knowledgeResource.create({
    data: {
      companyId,
      kind: 'file',
      scope: input.scope,
      targetKey: input.targetKey,
      ownerUserId: input.ownerUserId ?? null,
      logicalKey: input.logicalKey,
      status: 'active',
      currentVersion: 1,
      createdById: ownerId,
    },
  });
  const asset = await prisma!.knowledgeFileAsset.create({
    data: {
      companyId,
      uploadedById: ownerId,
      knowledgeResourceId: resource.id,
      provider: 'integration',
      storageKey: `integration/${suffix}/${randomUUID()}`,
      resourceType: 'raw',
      deliveryType: 'authenticated',
      fileName: input.scope === 'company' ? 'company-procedure.pdf' : 'personal-procedure.pdf',
      mimeType: 'application/pdf',
      sizeBytes: input.text.length,
      sha256: createHash('sha256').update(input.text).digest('hex'),
      status: 'attached',
      expiresAt: new Date(Date.now() + 60_000),
      attachedAt: new Date(),
    },
  });
  const repository = new PrismaKnowledgeDocumentRepository(prisma!);
  const document = await repository.beginIndex({
    companyId,
    resourceId: resource.id,
    resourceVersion: 1,
    fileAssetId: asset.id,
    sourceSha256: asset.sha256,
    mimeType: asset.mimeType,
    parserVersion: 'integration-v1',
  });
  await repository.replaceChunks({
    documentId: document.id,
    pageCount: 4,
    parserVersion: 'integration-v1',
    warnings: [],
    chunks: [{
      ordinal: 0,
      text: input.text,
      textHash: createHash('sha256').update(input.text).digest('hex'),
      charCount: input.text.length,
      tokenEstimate: Math.ceil(input.text.length / 4),
      pageStart: 4,
      pageEnd: 4,
      sectionPath: ['Rollback'],
    }],
  });
  await repository.markReady(document.id);
  return { resourceId: resource.id };
}
