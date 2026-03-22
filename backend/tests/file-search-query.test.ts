import test from 'node:test';
import assert from 'node:assert/strict';

import {
  broadenDocumentSearchQuery,
  buildDocumentSearchQueries,
  determineDocumentSearchEnhancements,
} from '../src/company/retrieval/file-search-query';

test('document query planner expands exact policy wording requests', () => {
  const enhancements = determineDocumentSearchEnhancements(
    'What is the exact refund policy wording for carryover exceptions?',
  );
  const queries = buildDocumentSearchQueries(
    'What is the exact refund policy wording for carryover exceptions?',
  );

  assert.ok(enhancements.includes('query_expansion'));
  assert.ok(queries.some((query) => /clause/i.test(query)));
  assert.ok(queries.some((query) => /section/i.test(query)));
});

test('document query planner decomposes relationship-heavy prompts into multiple searches', () => {
  const enhancements = determineDocumentSearchEnhancements(
    'Compare onboarding handbook rules and refund policy exceptions across departments',
  );
  const queries = buildDocumentSearchQueries(
    'Compare onboarding handbook rules and refund policy exceptions across departments',
  );

  assert.ok(enhancements.includes('multi_query'));
  assert.ok(queries.some((query) => /onboarding handbook/i.test(query)));
  assert.ok(queries.some((query) => /refund policy exceptions/i.test(query)));
});

test('document query planner broadens exact/freshness-heavy prompts for corrective retries', () => {
  const broadened = broadenDocumentSearchQuery(
    'Please quote the exact latest refund policy clause today',
  );

  assert.equal(broadened.includes('latest'), false);
  assert.equal(broadened.includes('exact'), false);
  assert.match(broadened, /section/i);
});

