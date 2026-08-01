import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import {
  companyBankId,
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
const enabled = process.env['RUN_HINDSIGHT_INTEGRATION'] === '1' && Boolean(baseUrl);

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
};

test('real Hindsight retain, isolated recall, listing, source removal, and bank cleanup', {
  skip: !enabled ? 'Set RUN_HINDSIGHT_INTEGRATION=1 and HINDSIGHT_URL to run.' : false,
  timeout: 120_000,
}, async () => {
  const suffix = randomUUID();
  const companyId = `integration-company-${suffix}`;
  const userId = `integration-user-${suffix}`;
  const otherUserId = `integration-other-${suffix}`;
  const personalFact = `Integration preference ${suffix}: weekly summaries use compact tables.`;
  const companyFact = `Integration policy ${suffix}: fiscal review happens on the first Monday.`;
  const client = new HindsightClient({
    baseUrl: baseUrl!,
    ...(apiKey ? { apiKey } : {}),
    userAgent: 'divo-integration-test/1.0',
  });
  const service = new HindsightMemoryService({
    baseUrl: baseUrl!,
    ...(apiKey ? { apiKey } : {}),
    maxResults: 12,
    recallMaxTokens: 1_200,
    recallBudget: 'mid',
    requestTimeoutMs: 30_000,
    recallConcurrency: 4,
    logger: noopLogger,
  });

  try {
    const version = await client.getVersion();
    assert.match(version.api_version, /^\d+\.\d+\.\d+/);

    const personalResourceId = `personal-${suffix}`;
    await service.projectExplicitResource({
      resourceId: personalResourceId,
      facts: [personalFact],
      previousFactCount: 0,
      scope: 'personal',
      userId,
      companyId,
    });
    await service.projectExplicitResource({
      resourceId: `company-${suffix}`,
      facts: [companyFact],
      previousFactCount: 0,
      scope: 'company',
      userId,
      companyId,
    });

    const ownerRecall = await waitForRecall(() => service.searchForRecall({
      query: `What summary format is preferred for ${suffix}?`,
      userId,
      companyId,
      departments: [],
      limit: 12,
      maxFactChars: 500,
      maxTotalChars: 3_000,
    }), personalFact);
    assert.ok(ownerRecall.facts.some(fact => fact.scope === 'personal' && fact.text === personalFact));
    assert.ok(ownerRecall.facts.some(fact => fact.scope === 'company' && fact.text === companyFact));

    const otherRecall = await service.searchForRecall({
      query: `What summary format is preferred for ${suffix}?`,
      userId: otherUserId,
      companyId,
      departments: [],
      limit: 12,
      maxFactChars: 500,
      maxTotalChars: 3_000,
    });
    assert.equal(otherRecall.facts.some(fact => fact.scope === 'personal' && fact.text === personalFact), false);

    await service.removeProjectedResource({
      resourceId: personalResourceId,
      factCount: 1,
      scope: 'personal',
      userId,
      companyId,
    });

    const afterInvalidation = await service.searchForRecall({
      query: `What summary format is preferred for ${suffix}?`,
      userId,
      companyId,
      departments: [],
      limit: 12,
      maxFactChars: 500,
      maxTotalChars: 3_000,
    });
    assert.equal(
      afterInvalidation.facts.some(fact => fact.scope === 'personal' && fact.text === personalFact),
      false,
    );
  } finally {
    await Promise.allSettled([
      client.deleteBank(personalBankId(companyId, userId)),
      client.deleteBank(personalBankId(companyId, otherUserId)),
      client.deleteBank(companyBankId(companyId)),
    ]);
  }
});

test('real Hindsight governed-file projection uses strict tags and isolated personal banks', {
  skip: !enabled ? 'Set RUN_HINDSIGHT_INTEGRATION=1 and HINDSIGHT_URL to run.' : false,
  timeout: 120_000,
}, async () => {
  const suffix = randomUUID();
  const companyId = `integration-file-company-${suffix}`;
  const userId = `integration-file-user-${suffix}`;
  const otherUserId = `integration-file-other-${suffix}`;
  const resourceId = `integration-file-resource-${suffix}`;
  const marker = `DOC-HINDSIGHT-${suffix}`;
  const client = new HindsightClient({
    baseUrl: baseUrl!,
    ...(apiKey ? { apiKey } : {}),
    userAgent: 'divo-integration-test/1.0',
  });
  const service = new HindsightMemoryService({
    baseUrl: baseUrl!,
    ...(apiKey ? { apiKey } : {}),
    maxResults: 12,
    recallMaxTokens: 1_200,
    recallBudget: 'mid',
    requestTimeoutMs: 30_000,
    recallConcurrency: 4,
    logger: noopLogger,
  });

  try {
    await service.projectDocument({
      resourceId,
      resourceVersion: 1,
      fileName: 'release-procedure.pdf',
      scope: 'personal',
      companyId,
      ownerUserId: userId,
      chunks: [{
        ordinal: 0,
        text: `${marker}: Rollback must happen before Owners.`,
        textHash: 'a'.repeat(64),
        charCount: marker.length + 38,
        tokenEstimate: 20,
        pageStart: 9,
        pageEnd: 9,
        sectionPath: ['Rollback'],
      }],
    });

    const owner = await waitForDocumentRecall(() => service.searchDocuments({
      query: `${marker} rollback owners`,
      userId,
      companyId,
      departments: [],
      limit: 10,
    }), resourceId);
    assert.equal(owner.candidates.some(item =>
      item.resourceId === resourceId
      && item.resourceVersion === 1
      && item.chunkOrdinal === 0
      && item.scope === 'personal'), true);

    const other = await service.searchDocuments({
      query: `${marker} rollback owners`,
      userId: otherUserId,
      companyId,
      departments: [],
      limit: 10,
    });
    assert.equal(other.candidates.some(item => item.resourceId === resourceId), false);

    await service.removeDocument({
      resourceId,
      resourceVersion: 1,
      chunkCount: 1,
      scope: 'personal',
      companyId,
      ownerUserId: userId,
    });
    const removed = await service.searchDocuments({
      query: `${marker} rollback owners`,
      userId,
      companyId,
      departments: [],
      limit: 10,
    });
    assert.equal(removed.candidates.some(item => item.resourceId === resourceId), false);
  } finally {
    await Promise.allSettled([
      client.deleteBank(personalBankId(companyId, userId)),
      client.deleteBank(personalBankId(companyId, otherUserId)),
      client.deleteBank(companyBankId(companyId)),
    ]);
  }
});

async function waitForRecall<T extends { facts: readonly { text: string }[] }>(
  recall: () => Promise<T>,
  expected: string,
): Promise<T> {
  let latest = await recall();
  for (let attempt = 0; attempt < 20; attempt++) {
    if (latest.facts.some(fact => fact.text === expected)) return latest;
    await new Promise<void>(resolve => setTimeout(resolve, 1_000));
    latest = await recall();
  }
  return latest;
}

async function waitForDocumentRecall<T extends {
  candidates: readonly { resourceId: string }[];
}>(recall: () => Promise<T>, resourceId: string): Promise<T> {
  let latest = await recall();
  for (let attempt = 0; attempt < 20; attempt++) {
    if (latest.candidates.some(item => item.resourceId === resourceId)) return latest;
    await new Promise<void>(resolve => setTimeout(resolve, 1_000));
    latest = await recall();
  }
  return latest;
}
