import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkKnowledgeDocument } from '../../src/application/knowledge/knowledge-document-chunker.ts';

describe('knowledge document chunking', () => {
  it('preserves page and inferred heading provenance while enforcing bounds', () => {
    const chunks = chunkKnowledgeDocument({
      parserVersion: 'test',
      warnings: [],
      pageCount: 2,
      units: [
        { pageNumber: 1, text: '# Rollback\n\n' + 'Restore the prior release safely. '.repeat(30) },
        { pageNumber: 2, text: '# Owners\n\n' + 'The release owner verifies completion. '.repeat(30) },
      ],
    }, { targetChars: 400, maxChars: 520, overlapChars: 60, maxChunks: 20 });

    assert.ok(chunks.length >= 2);
    assert.ok(chunks.every(chunk => chunk.text.length <= 520));
    assert.ok(chunks.some(chunk => chunk.pageStart === 1 && chunk.sectionPath.includes('Rollback')));
    assert.ok(chunks.some(chunk => chunk.pageEnd === 2 && chunk.sectionPath.includes('Owners')));
    assert.ok(chunks.every((chunk, index) => chunk.ordinal === index));
    assert.ok(chunks.every(chunk => chunk.textHash.length === 64 && chunk.tokenEstimate > 0));
  });

  it('splits a single oversized paragraph at stable text boundaries', () => {
    const chunks = chunkKnowledgeDocument({
      parserVersion: 'test',
      warnings: [],
      units: [{ text: 'Sentence one explains the procedure. '.repeat(100) }],
    }, { targetChars: 300, maxChars: 420, overlapChars: 40, maxChunks: 50 });
    assert.ok(chunks.length > 4);
    assert.ok(chunks.every(chunk => chunk.charCount <= 420));
    assert.match(chunks.map(chunk => chunk.text).join(' '), /procedure/);
  });

  it('fails closed for empty and extraction-bomb shaped content', () => {
    assert.throws(() => chunkKnowledgeDocument({
      parserVersion: 'test', warnings: [], units: [{ text: '   ' }],
    }), /no searchable text/);
    assert.throws(() => chunkKnowledgeDocument({
      parserVersion: 'test', warnings: [], units: [{ text: 'x'.repeat(2_000) }],
    }, { targetChars: 200, maxChars: 300, overlapChars: 20, maxExtractedChars: 1_000 }), /exceeds/);
  });
});
