import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { KnowledgeMutationService } from '../../src/application/knowledge/knowledge-mutation.service.ts';
import { PersonalMemoryCommandService } from '../../src/application/knowledge/personal-memory-command.service.ts';
import { KnowledgeResourceQueryService } from '../../src/application/knowledge/knowledge-resource-query.service.ts';
import { PrismaKnowledgeMutationStore } from '../../src/infrastructure/persistence/knowledge-mutation.repository.ts';
import { ok } from '../../src/shared/result.ts';

const enabled = process.env['RUN_DATABASE_LARGE_INTEGRATION'] === '1'
  && Boolean(process.env['DATABASE_URL']);
const resourceCount = boundedCount('KNOWLEDGE_LARGE_RESOURCE_COUNT', 150, 101, 500);
const prisma = enabled ? new PrismaClient() : null;
const suffix = randomUUID();
let companyId = '';
let ownerId = '';
let otherUserId = '';

const departments = { listActiveMemberships: async () => ok([] as never[]) };

before(async () => {
  if (!prisma) return;
  const [owner, other, company] = await prisma.$transaction([
    prisma.user.create({
      data: { email: `large-memory-owner-${suffix}@example.test`, password: 'integration-only' },
    }),
    prisma.user.create({
      data: { email: `large-memory-other-${suffix}@example.test`, password: 'integration-only' },
    }),
    prisma.company.create({ data: { name: `Large memory integration ${suffix}` } }),
  ]);
  ownerId = owner.id;
  otherUserId = other.id;
  companyId = company.id;
  await prisma.adminMembership.createMany({
    data: [ownerId, otherUserId].map(userId => ({
      userId,
      companyId,
      role: 'MEMBER',
      isActive: true,
    })),
  });
  await prisma.knowledgePolicy.createMany({
    data: (['create', 'update', 'delete'] as const).map(action => ({
      tenantKey: companyId,
      kind: 'memory' as const,
      scope: 'personal' as const,
      action,
      requesterReviewRequired: false,
      requiredAuthority: 'none' as const,
      distinctApprover: false,
      enabled: true,
      version: 1,
    })),
  });
});

after(async () => {
  if (!prisma) return;
  if (companyId) {
    await prisma.knowledgePolicy.deleteMany({ where: { tenantKey: companyId } });
    await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
  }
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherUserId].filter(Boolean) } } });
  await prisma.$disconnect();
});

test('real Postgres converges large concurrent personal-memory writes without leakage or duplicate history', {
  skip: !enabled
    ? 'Set RUN_DATABASE_LARGE_INTEGRATION=1 with DATABASE_URL to run.'
    : false,
  timeout: 180_000,
}, async () => {
  const resources = new KnowledgeResourceQueryService({ prisma: prisma!, departments });
  const mutations = new KnowledgeMutationService(new PrismaKnowledgeMutationStore(prisma!));
  const commands = new PersonalMemoryCommandService({
    permissions: { canInvoke: async () => ok(undefined) } as never,
    resources,
    mutations,
    projections: { projectMutation: async () => undefined } as never,
  });
  const common = {
    companyId,
    userId: ownerId,
    companyRole: 'MEMBER',
    channel: 'desktop' as const,
  };
  const marker = `PG-LARGE-${suffix}`;
  const records = Array.from({ length: resourceCount }, (_, index) => ({
    subject: uniqueSubject(suffix, index),
    logicalKey: `large.${suffix}.${index.toString().padStart(4, '0')}`,
    fact: `${uniqueSubject(suffix, index)} ${marker} canonical fact ${index}: `
      + `retrieval token PG-CODE-${index.toString().padStart(4, '0')}.`,
  }));

  for (let offset = 0; offset < records.length; offset += 25) {
    const batch = records.slice(offset, offset + 25);
    const results = await Promise.all(batch.map((record, batchIndex) => commands.execute({
      ...common,
      sourceRef: `large-load:${offset + batchIndex}`,
      evidence: { contract: 1, requestHash: `large-hash-${offset + batchIndex}` },
      command: {
        action: 'set',
        subject: record.subject,
        logicalKey: record.logicalKey,
        facts: [record.fact],
      },
    })));
    assert.ok(results.every(result => result.action === 'created' && result.version === 1));
  }

  assert.equal(await prisma!.knowledgeResource.count({
    where: { companyId, ownerUserId: ownerId, kind: 'memory', status: 'active' },
  }), resourceCount);
  assert.equal(await prisma!.knowledgeVersion.count({
    where: { resource: { companyId, ownerUserId: ownerId, kind: 'memory' } },
  }), resourceCount);
  assert.equal(await prisma!.knowledgeMutation.count({
    where: { companyId, requesterId: ownerId, status: 'applied' },
  }), resourceCount);
  assert.equal(await prisma!.knowledgeOutbox.count({
    where: { mutation: { companyId, requesterId: ownerId, kind: 'memory' } },
  }), resourceCount);

  for (const index of [...new Set([0, Math.floor(resourceCount / 2), resourceCount - 1])]) {
    const record = records[index]!;
    const found = await resources.searchMemories({
      companyId,
      userId: ownerId,
      query: `PG-CODE-${index.toString().padStart(4, '0')}`,
      scope: 'personal',
      limit: 10,
    });
    assert.equal(found[0]?.resource.logicalKey, record.logicalKey);
    assert.deepEqual((found[0]?.resource.content as { facts: string[] }).facts, [record.fact]);
    const leaked = await resources.searchMemories({
      companyId,
      userId: otherUserId,
      query: `PG-CODE-${index.toString().padStart(4, '0')}`,
      scope: 'personal',
      limit: 10,
    });
    assert.deepEqual(leaked, []);
  }

  const duplicateIndex = resourceCount;
  const duplicate = {
    subject: uniqueSubject(suffix, duplicateIndex),
    logicalKey: `large.${suffix}.duplicate`,
    fact: `${uniqueSubject(suffix, duplicateIndex)} ${marker} duplicate requests converge on PG-DUPLICATE-ONE.`,
  };
  const duplicates = await Promise.all(Array.from({ length: 24 }, () => commands.execute({
    ...common,
    sourceRef: 'large-duplicate:one',
    evidence: { contract: 1, requestHash: 'large-duplicate-hash' },
    command: {
      action: 'set',
      subject: duplicate.subject,
      logicalKey: duplicate.logicalKey,
      facts: [duplicate.fact],
    },
  })));
  assert.equal(new Set(duplicates.map(result => result.resourceId)).size, 1);
  assert.equal(new Set(duplicates.map(result => result.version)).size, 1);
  assert.equal(await prisma!.knowledgeResource.count({
    where: { companyId, ownerUserId: ownerId, logicalKey: duplicate.logicalKey },
  }), 1);
  const duplicateResourceId = duplicates[0]!.resourceId;
  assert.equal(await prisma!.knowledgeVersion.count({ where: { resourceId: duplicateResourceId } }), 1);
  assert.equal(await prisma!.knowledgeMutation.count({
    where: { companyId, logicalKey: duplicate.logicalKey },
  }), 1);

  const conflictBase = records[duplicateIndex - 1]!;
  const conflictResults = await Promise.allSettled([
    commands.execute({
      ...common,
      command: {
        action: 'set',
        subject: conflictBase.subject,
        logicalKey: conflictBase.logicalKey,
        facts: [`${conflictBase.subject} ${marker} competing value ALPHA.`],
      },
    }),
    commands.execute({
      ...common,
      command: {
        action: 'set',
        subject: conflictBase.subject,
        logicalKey: conflictBase.logicalKey,
        facts: [`${conflictBase.subject} ${marker} competing value BRAVO.`],
      },
    }),
  ]);
  assert.equal(conflictResults.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(conflictResults.filter(result => result.status === 'rejected').length, 1);
  const final = await resources.getPersonalMemoryByLogicalKey({
    companyId,
    userId: ownerId,
    logicalKey: conflictBase.logicalKey,
  });
  assert.equal(final?.currentVersion, 2);
  const finalFacts = (final?.content as { facts: string[] }).facts;
  assert.equal(
    finalFacts[0] === `${conflictBase.subject} ${marker} competing value ALPHA.`
      || finalFacts[0] === `${conflictBase.subject} ${marker} competing value BRAVO.`,
    true,
  );
});

function boundedCount(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function uniqueSubject(runId: string, index: number): string {
  return `subject${runId.replaceAll('-', '')}${index.toString().padStart(4, '0')}token`;
}
