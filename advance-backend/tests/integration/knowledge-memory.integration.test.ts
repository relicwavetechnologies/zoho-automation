import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { ok } from '../../src/shared/result.ts';
import { KnowledgeMutationService } from '../../src/application/knowledge/knowledge-mutation.service.ts';
import { PersonalMemoryCommandService } from '../../src/application/knowledge/personal-memory-command.service.ts';
import { KnowledgeRecallService } from '../../src/application/knowledge/knowledge-recall.service.ts';
import { KnowledgeResourceQueryService } from '../../src/application/knowledge/knowledge-resource-query.service.ts';
import { PrismaKnowledgeMutationStore } from '../../src/infrastructure/persistence/knowledge-mutation.repository.ts';

const enabled = process.env['RUN_DATABASE_INTEGRATION'] === '1' && Boolean(process.env['DATABASE_URL']);
const prisma = enabled ? new PrismaClient() : null;
const suffix = randomUUID();
let companyId = '';
let ownerId = '';
let otherUserId = '';

const departments = { listActiveMemberships: async () => ok([] as any) };

before(async () => {
  if (!prisma) return;
  const owner = await prisma.user.create({
    data: { email: `memory-owner-${suffix}@example.test`, password: 'integration-only' },
  });
  const other = await prisma.user.create({
    data: { email: `memory-other-${suffix}@example.test`, password: 'integration-only' },
  });
  const company = await prisma.company.create({ data: { name: `Memory integration ${suffix}` } });
  ownerId = owner.id;
  otherUserId = other.id;
  companyId = company.id;
  await prisma.adminMembership.createMany({
    data: [owner.id, other.id].map(userId => ({
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

test('real personal mutation resolves key drift and canonical recall survives semantic outage', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
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
    channel: 'lark' as const,
  };
  const created = await commands.execute({
    ...common,
    command: {
      action: 'set',
      subject: 'incident summary heading',
      logicalKey: 'reports.incidentSummary.format',
      facts: ['Incident summaries use Blue Cedar as their heading.'],
    },
  });
  const updated = await commands.execute({
    ...common,
    command: {
      action: 'set',
      subject: 'incident summary heading',
      logicalKey: 'incident.summaries.heading',
      facts: ['The incident summary heading is Green Falcon.'],
    },
  });

  assert.equal(created.action, 'created');
  assert.equal(updated.action, 'updated');
  assert.equal(updated.resourceId, created.resourceId);
  assert.equal(updated.logicalKey, created.logicalKey);
  assert.equal(await prisma!.knowledgeResource.count({
    where: { companyId, ownerUserId: ownerId, kind: 'memory', status: 'active' },
  }), 1);

  const recall = new KnowledgeRecallService({
    permissions: { canInvoke: async () => ok(undefined) } as never,
    departments,
    memory: { searchForRecall: async () => { throw new Error('semantic outage'); } } as never,
    resources,
  });
  const recalled = await recall.recall({
    query: 'incident summary heading',
    ...common,
  });
  assert.equal(recalled.status, 'partial');
  assert.deepEqual(recalled.facts, [
    { scope: 'personal', text: 'The incident summary heading is Green Falcon.' },
  ]);

  const leaked = await resources.searchMemories({
    companyId,
    userId: otherUserId,
    query: 'incident summary heading',
    scope: 'personal',
    limit: 10,
  });
  assert.deepEqual(leaked, []);
});
