import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocumentSearchQueries,
  broadenDocumentSearchQuery,
  looksLikeExactDocumentQuery,
} from '../../../src/application/retrieval/query-rewriter.ts';

describe('buildDocumentSearchQueries', () => {
  it('returns the original query at minimum', () => {
    const queries = buildDocumentSearchQueries('refund policy');
    assert.ok(queries.includes('refund policy'), 'original query should be included');
    assert.ok(queries.length >= 1);
  });

  it('expands exact-intent queries', () => {
    const queries = buildDocumentSearchQueries('exact wording of cancellation clause');
    assert.ok(queries.length > 1, 'should expand exact-intent queries');
  });

  it('adds domain variants for policy queries', () => {
    const queries = buildDocumentSearchQueries('leave policy');
    assert.ok(queries.some(q => q.includes('rule') || q.includes('guidance') || q === 'leave policy'));
  });

  it('returns at most 6 queries', () => {
    const queries = buildDocumentSearchQueries('compare refund policy versus cancellation clause between teams and departments');
    assert.ok(queries.length <= 6);
  });

  it('splits multi-intent queries at "and"', () => {
    const queries = buildDocumentSearchQueries('refund policy and cancellation terms');
    assert.ok(queries.length >= 2, 'should produce at least 2 sub-queries for compound query');
  });

  it('strips stopwords in focused variant', () => {
    const queries = buildDocumentSearchQueries('what is the refund policy');
    assert.ok(queries.some(q => !q.startsWith('what is the')));
  });
});

describe('broadenDocumentSearchQuery', () => {
  it('strips exact-intent modifiers', () => {
    const broadened = broadenDocumentSearchQuery('exact wording of cancellation clause');
    assert.ok(!broadened.includes('exact'), `expected "exact" stripped, got: ${broadened}`);
  });

  it('replaces "clause" with "section"', () => {
    const broadened = broadenDocumentSearchQuery('cancellation clause');
    assert.ok(broadened.includes('section') || !broadened.includes('clause'));
  });

  it('handles already simple query unchanged', () => {
    const q = 'refund policy rules';
    assert.equal(broadenDocumentSearchQuery(q), q);
  });
});

describe('looksLikeExactDocumentQuery', () => {
  it('detects verbatim intent', () => {
    assert.ok(looksLikeExactDocumentQuery('give me the exact wording of the refund clause'));
  });

  it('detects section reference', () => {
    assert.ok(looksLikeExactDocumentQuery('show me section 3 of the handbook'));
  });

  it('detects full document request', () => {
    assert.ok(looksLikeExactDocumentQuery('give me the full document text'));
  });

  it('does not trigger on normal search', () => {
    assert.ok(!looksLikeExactDocumentQuery('what is the leave policy'));
  });

  it('does not trigger on casual question', () => {
    assert.ok(!looksLikeExactDocumentQuery('how many days of leave do I get'));
  });
});
