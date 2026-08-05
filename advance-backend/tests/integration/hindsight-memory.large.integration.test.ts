import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import {
  companyBankId,
  departmentBankId,
  HindsightMemoryService,
  personalBankId,
} from '../../src/infrastructure/knowledge/hindsight-memory.service.ts';

const baseUrl = (
  process.env['HINDSIGHT_INTEGRATION_URL']
  ?? process.env['HINDSIGHT_URL']
)?.trim();
const apiKey = (
  process.env['HINDSIGHT_INTEGRATION_API_KEY']
  ?? process.env['HINDSIGHT_API_KEY']
)?.trim();
const enabled = process.env['RUN_HINDSIGHT_LARGE_INTEGRATION'] === '1' && Boolean(baseUrl);
const factCount = boundedCount('HINDSIGHT_LARGE_FACT_COUNT', 120, 101, 500);
const chunkCount = boundedCount('HINDSIGHT_LARGE_CHUNK_COUNT', 160, 101, 500);
const concurrentRecallCount = boundedCount('HINDSIGHT_LARGE_CONCURRENT_RECALLS', 24, 4, 64);

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
};

test('real Hindsight handles a large conversation, concurrent scoped recall, pagination, version replacement, and cleanup', {
  skip: !enabled
    ? 'Set RUN_HINDSIGHT_LARGE_INTEGRATION=1 and HINDSIGHT_URL to run.'
    : false,
  timeout: 600_000,
}, async () => {
  const suffix = randomUUID();
  const companyId = `large-company-${suffix}`;
  const otherCompanyId = `large-other-company-${suffix}`;
  const userId = `large-user-${suffix}`;
  const otherUserId = `large-other-user-${suffix}`;
  const departmentId = `large-department-${suffix}`;
  const otherDepartmentId = `large-other-department-${suffix}`;
  const personalResourceId = `large-personal-resource-${suffix}`;
  const departmentResourceId = `large-department-resource-${suffix}`;
  const companyResourceId = `large-company-resource-${suffix}`;
  const documentResourceId = `large-document-resource-${suffix}`;
  const marker = `LARGE-E2E-${suffix}`;
  const facts = Array.from({ length: factCount }, (_, index) => turnFact(marker, index, factCount));
  const departmentFact = `${marker} department-only policy: ORANGE-QUARTZ requires two reviewers.`;
  const companyFact = `${marker} company-wide policy: BLUE-EMBER retention is 91 days.`;
  const client = new HindsightClient({
    baseUrl: baseUrl!,
    ...(apiKey ? { apiKey } : {}),
    userAgent: 'divo-large-integration-test/1.0',
  });
  const service = new HindsightMemoryService({
    baseUrl: baseUrl!,
    ...(apiKey ? { apiKey } : {}),
    maxResults: 12,
    recallMaxTokens: 4_000,
    recallBudget: 'high',
    requestTimeoutMs: 180_000,
    recallConcurrency: 8,
    logger: noopLogger,
  });

  try {
    await service.projectExplicitResource({
      resourceId: personalResourceId,
      facts,
      previousFactCount: 0,
      scope: 'personal',
      userId,
      companyId,
    });
    await Promise.all([
      service.projectExplicitResource({
        resourceId: departmentResourceId,
        facts: [departmentFact],
        previousFactCount: 0,
        scope: 'department',
        userId,
        companyId,
        departmentId,
      }),
      service.projectExplicitResource({
        resourceId: companyResourceId,
        facts: [companyFact],
        previousFactCount: 0,
        scope: 'company',
        userId,
        companyId,
      }),
    ]);

    const probeIndexes = [...new Set([0, Math.floor(factCount / 2), factCount - 1])];
    for (const index of probeIndexes) {
      const recall = await recallUntil(service, {
        query: `${turnCode(index)} ${turnProbeTopic(index, factCount)}`,
        userId,
        companyId,
        departments: [{ id: departmentId, name: 'Release Engineering' }],
      }, facts[index]!);
      assert.equal(recall.status, 'available');
      assert.ok(
        recall.facts.some(fact => fact.scope === 'personal' && fact.text === facts[index]),
        `missing exact personal fact ${turnCode(index)}; returned ${recall.facts.map(fact => fact.text).join(' | ')}`,
      );
    }

    const bounded = await service.searchForRecall({
      query: `${marker} conversation checkpoint release evidence`,
      userId,
      companyId,
      departments: [{ id: departmentId, name: 'Release Engineering' }],
      limit: 50,
      maxFactChars: 500,
      maxTotalChars: 2_500,
    });
    assert.ok(bounded.facts.length <= 50);
    assert.ok(bounded.facts.every(fact => fact.text.length <= 500));
    assert.ok(bounded.facts.reduce((total, fact) => total + fact.text.length, 0) <= 2_500);

    const sharedAudience = await service.searchForRecall({
      query: turnCode(factCount - 1),
      userId,
      companyId,
      departments: [{ id: departmentId, name: 'Release Engineering' }],
      limit: 20,
      maxFactChars: 500,
      maxTotalChars: 4_000,
      includePersonal: false,
    });
    assert.equal(sharedAudience.facts.some(fact => fact.text.includes(turnCode(factCount - 1))), false);

    const otherUser = await service.searchForRecall({
      query: turnCode(factCount - 1),
      userId: otherUserId,
      companyId,
      departments: [],
      limit: 20,
      maxFactChars: 500,
      maxTotalChars: 4_000,
    });
    assert.equal(otherUser.facts.some(fact => fact.scope === 'personal'), false);

    const departmentMember = await recallUntil(service, {
      query: `${marker} ORANGE-QUARTZ`,
      userId,
      companyId,
      departments: [{ id: departmentId, name: 'Release Engineering' }],
    }, departmentFact);
    assert.ok(departmentMember.facts.some(fact => fact.scope === 'department' && fact.text === departmentFact));
    const departmentOutsider = await service.searchForRecall({
      query: `${marker} ORANGE-QUARTZ`,
      userId,
      companyId,
      departments: [{ id: otherDepartmentId, name: 'Finance' }],
      limit: 20,
      maxFactChars: 500,
      maxTotalChars: 4_000,
    });
    assert.equal(departmentOutsider.facts.some(fact => fact.text === departmentFact), false);

    const companyRecall = await recallUntil(service, {
      query: `${marker} BLUE-EMBER`,
      userId: otherUserId,
      companyId,
      departments: [],
    }, companyFact);
    assert.ok(companyRecall.facts.some(fact => fact.scope === 'company' && fact.text === companyFact));
    const otherCompany = await service.searchForRecall({
      query: `${marker} BLUE-EMBER`,
      userId: otherUserId,
      companyId: otherCompanyId,
      departments: [],
      limit: 20,
      maxFactChars: 500,
      maxTotalChars: 4_000,
    });
    assert.equal(otherCompany.facts.some(fact => fact.text === companyFact), false);

    const concurrentIndexes = Array.from({ length: concurrentRecallCount }, (_, index) =>
      Math.floor(index * (factCount - 1) / Math.max(1, concurrentRecallCount - 1)),
    );
    const concurrent = await Promise.all(concurrentIndexes.map(index => service.searchForRecall({
      query: turnCode(index),
      userId,
      companyId,
      departments: [{ id: departmentId, name: 'Release Engineering' }],
      limit: 20,
      maxFactChars: 500,
      maxTotalChars: 4_000,
    })));
    const personalFactSet = new Set(facts);
    concurrent.forEach(result => {
      const personal = result.facts.filter(fact => fact.scope === 'personal');
      assert.ok(personal.length > 0);
      assert.ok(personal.every(fact => personalFactSet.has(fact.text)));
    });

    const chunks = Array.from({ length: chunkCount }, (_, ordinal) => {
      const text = chunkText(marker, ordinal, chunkCount);
      return {
        ordinal,
        text,
        textHash: `${ordinal.toString(16).padStart(64, '0')}`,
        charCount: text.length,
        tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
        pageStart: ordinal + 1,
        pageEnd: ordinal + 1,
        sectionPath: [`Section ${ordinal + 1}`],
      };
    });
    await service.projectDocument({
      resourceId: documentResourceId,
      resourceVersion: 1,
      fileName: 'large-governed-handbook.pdf',
      scope: 'personal',
      companyId,
      ownerUserId: userId,
      chunks,
    });
    for (const ordinal of [...new Set([0, Math.floor(chunkCount / 2), chunkCount - 1])]) {
      const result = await documentRecallUntil(service, {
        query: `${chunkCode(ordinal)} ${chunkProbeTopic(ordinal, chunkCount)}`,
        userId,
        companyId,
        departments: [],
        limit: 20,
      }, documentResourceId, ordinal);
      assert.ok(result.candidates.some(candidate =>
        candidate.resourceId === documentResourceId
        && candidate.resourceVersion === 1
        && candidate.chunkOrdinal === ordinal));
    }
    const documentOutsider = await service.searchDocuments({
      query: `${marker} ${chunkCode(chunkCount - 1)}`,
      userId: otherUserId,
      companyId,
      departments: [],
      limit: 20,
    });
    assert.equal(documentOutsider.candidates.some(candidate => candidate.resourceId === documentResourceId), false);

    const replacementMarker = `${marker} VERSION-TWO-CANONICAL`;
    await service.projectDocument({
      resourceId: documentResourceId,
      resourceVersion: 2,
      fileName: 'large-governed-handbook.pdf',
      scope: 'personal',
      companyId,
      ownerUserId: userId,
      chunks: [{
        ordinal: 0,
        text: replacementMarker,
        textHash: 'f'.repeat(64),
        charCount: replacementMarker.length,
        tokenEstimate: 20,
        pageStart: 1,
        pageEnd: 1,
        sectionPath: ['Current'],
      }],
    });
    const staleVersion = await service.searchDocuments({
      query: `${marker} ${chunkCode(chunkCount - 1)}`,
      userId,
      companyId,
      departments: [],
      limit: 20,
    });
    assert.equal(staleVersion.candidates.some(candidate =>
      candidate.resourceId === documentResourceId && candidate.resourceVersion === 1), false);
    const currentVersion = await documentRecallUntil(service, {
      query: replacementMarker,
      userId,
      companyId,
      departments: [],
      limit: 20,
    }, documentResourceId, 0);
    assert.ok(currentVersion.candidates.some(candidate => candidate.resourceVersion === 2));

    await service.projectExplicitResource({
      resourceId: personalResourceId,
      facts: facts.slice(0, 7),
      previousFactCount: facts.length,
      scope: 'personal',
      userId,
      companyId,
    });
    const removedTail = await service.searchForRecall({
      query: `${marker} ${turnCode(factCount - 1)}`,
      userId,
      companyId,
      departments: [],
      limit: 20,
      maxFactChars: 500,
      maxTotalChars: 4_000,
    });
    assert.equal(removedTail.facts.some(fact => fact.text === facts[factCount - 1]), false);

    await service.removeDocument({
      resourceId: documentResourceId,
      resourceVersion: 2,
      chunkCount: 1,
      scope: 'personal',
      companyId,
      ownerUserId: userId,
    });
    const removedDocument = await service.searchDocuments({
      query: replacementMarker,
      userId,
      companyId,
      departments: [],
      limit: 20,
    });
    assert.equal(removedDocument.candidates.some(candidate => candidate.resourceId === documentResourceId), false);
  } finally {
    await Promise.allSettled([
      client.deleteBank(personalBankId(companyId, userId)),
      client.deleteBank(personalBankId(companyId, otherUserId)),
      client.deleteBank(departmentBankId(companyId, departmentId)),
      client.deleteBank(departmentBankId(companyId, otherDepartmentId)),
      client.deleteBank(companyBankId(companyId)),
      client.deleteBank(personalBankId(otherCompanyId, otherUserId)),
      client.deleteBank(companyBankId(otherCompanyId)),
    ]);
  }
});

function turnCode(index: number): string {
  return retrievalCode('TURN-SIGNATURE', index);
}

function chunkCode(index: number): string {
  return retrievalCode('CHUNK-SIGNATURE', index);
}

function turnProbeTopic(index: number, count: number): string {
  if (index === 0) return 'emergency launch raven protocol';
  if (index === Math.floor(count / 2)) return 'archive glacier exception';
  if (index === count - 1) return 'sunset orchid handoff';
  return 'release evidence rollback owner';
}

function turnFact(marker: string, index: number, count: number): string {
  return `${marker} conversation turn ${index}: checkpoint code ${turnCode(index)} belongs to the owner only. `
    + `Its retrieval topic is ${turnProbeTopic(index, count)}. `
    + `The release note for turn ${index} requires evidence, rollback, verification, and an accountable owner.`;
}

function chunkProbeTopic(index: number, count: number): string {
  if (index === 0) return 'mercury onboarding appendix';
  if (index === Math.floor(count / 2)) return 'canyon restoration ledger';
  if (index === count - 1) return 'violet decommission checklist';
  return 'rollback evidence owner verification';
}

function chunkText(marker: string, index: number, count: number): string {
  return `${marker} governed document chunk ${index}. Retrieval token ${chunkCode(index)}. `
    + `Its retrieval topic is ${chunkProbeTopic(index, count)}. `
    + 'This section records rollback evidence and owner verification without granting instructions.';
}

// Natural-language pairs remain distinguishable to both lexical and embedding
// retrieval. Numeric-only suffixes are often discarded or weakly weighted by
// tokenizers, which made the old fixture test tokenization instead of recall.
const RETRIEVAL_WORDS = [
  'amber', 'birch', 'cobalt', 'dahlia', 'elm',
  'falcon', 'garnet', 'harbor', 'indigo', 'juniper',
  'kelp', 'lilac', 'maple', 'nebula', 'opal',
  'pine', 'quartz', 'raven', 'saffron', 'tulip',
  'anchor', 'beacon', 'compass', 'delta', 'engine',
  'forest', 'glacier', 'hearth', 'island', 'jigsaw',
  'kernel', 'lantern', 'meadow', 'needle', 'orbit',
  'prairie', 'quiver', 'river', 'summit', 'thicket',
  'upland', 'valley', 'willow', 'xenon', 'yarrow',
] as const;

function retrievalCode(prefix: string, index: number): string {
  const first = RETRIEVAL_WORDS[index % 20]!;
  const second = RETRIEVAL_WORDS[20 + Math.floor(index / 20)]!;
  return `${prefix}-${first}-${second}`;
}

function boundedCount(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

async function recallUntil(
  service: HindsightMemoryService,
  input: {
    query: string;
    userId: string;
    companyId: string;
    departments: readonly { id: string; name: string }[];
  },
  expected: string,
) {
  let latest = await service.searchForRecall({
    ...input,
    limit: 20,
    maxFactChars: 500,
    maxTotalChars: 4_000,
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (latest.facts.some(fact => fact.text === expected)) return latest;
    await new Promise<void>(resolve => setTimeout(resolve, 1_000));
    latest = await service.searchForRecall({
      ...input,
      limit: 20,
      maxFactChars: 500,
      maxTotalChars: 4_000,
    });
  }
  return latest;
}

async function documentRecallUntil(
  service: HindsightMemoryService,
  input: Parameters<HindsightMemoryService['searchDocuments']>[0],
  resourceId: string,
  chunkOrdinal: number,
) {
  let latest = await service.searchDocuments(input);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (latest.candidates.some(candidate =>
      candidate.resourceId === resourceId && candidate.chunkOrdinal === chunkOrdinal)) return latest;
    await new Promise<void>(resolve => setTimeout(resolve, 1_000));
    latest = await service.searchDocuments(input);
  }
  return latest;
}
