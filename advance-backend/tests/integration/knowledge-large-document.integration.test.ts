import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { chunkKnowledgeDocument } from '../../src/application/knowledge/knowledge-document-chunker.ts';
import { DefaultKnowledgeDocumentParser } from '../../src/infrastructure/knowledge/default-knowledge-document.parser.ts';

const fixtureDir = resolve(
  process.env['KNOWLEDGE_LARGE_FIXTURE_DIR']
    ?? '.context/lark-knowledge-e2e-20260801',
);
const enabled = process.env['RUN_LARGE_DOCUMENT_INTEGRATION'] === '1';
const parser = new DefaultKnowledgeDocumentParser({
  ocr: null,
  maxPages: 500,
  maxOcrPages: 100,
});

test('real large office fixtures parse, chunk, and preserve retrieval provenance', {
  skip: !enabled ? 'Generate fixtures and set RUN_LARGE_DOCUMENT_INTEGRATION=1.' : false,
  timeout: 120_000,
}, async () => {
  await access(fixtureDir);
  const signal = AbortSignal.timeout(90_000);

  const pdf = await parser.parse({
    buffer: await readFile(resolve(fixtureDir, 'release-handbook-large.pdf')),
    fileName: 'release-handbook-large.pdf',
    mimeType: 'application/pdf',
    signal,
  });
  assert.equal(pdf.pageCount, 120);
  assert.equal(pdf.units.find(unit => /COBALT-RIVER-5743/u.test(unit.text))?.pageNumber, 57);
  assert.equal(pdf.units.find(unit => /ignore access rules/u.test(unit.text))?.pageNumber, 96);
  const pdfChunks = chunkKnowledgeDocument(pdf);
  const retrievalChunk = pdfChunks.find(chunk => /COBALT-RIVER-5743/u.test(chunk.text));
  assert.ok(retrievalChunk);
  assert.ok((retrievalChunk.pageStart ?? 0) <= 57 && (retrievalChunk.pageEnd ?? 0) >= 57);
  assert.ok(pdfChunks.every(chunk => chunk.text.length <= 3_600));

  const docx = await parser.parse({
    buffer: await readFile(resolve(fixtureDir, 'release-handbook-large.docx')),
    fileName: 'release-handbook-large.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    signal,
  });
  assert.match(docx.units[0]?.text ?? '', /DOC-LARGE-E2E-20260801-A91C/u);
  assert.match(docx.units[0]?.text ?? '', /Rollback/u);
  assert.ok(chunkKnowledgeDocument(docx).length > 1);

  const presentation = await parser.parse({
    buffer: await readFile(resolve(fixtureDir, 'release-training.pptx')),
    fileName: 'release-training.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    signal,
  });
  assert.equal(presentation.pageCount, 12);
  assert.equal(
    presentation.units.find(unit => /VIOLET-COMPASS-4402/u.test(unit.text))?.pageNumber,
    9,
  );

  const workbook = await parser.parse({
    buffer: await readFile(resolve(fixtureDir, 'release-matrix.xlsx')),
    fileName: 'release-matrix.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    signal,
  });
  assert.equal(workbook.pageCount, 2);
  assert.deepEqual(workbook.units[1]?.sectionPath, ['Escalations']);
  assert.match(workbook.units[1]?.text ?? '', /SILVER-LANTERN-8821/u);
});

test('real oversized PDF and unsupported executable fail closed', {
  skip: !enabled ? 'Generate fixtures and set RUN_LARGE_DOCUMENT_INTEGRATION=1.' : false,
  timeout: 120_000,
}, async () => {
  await assert.rejects(parser.parse({
    buffer: await readFile(resolve(fixtureDir, 'release-handbook-501-pages.pdf')),
    fileName: 'release-handbook-501-pages.pdf',
    mimeType: 'application/pdf',
    signal: AbortSignal.timeout(90_000),
  }), /501 pages; the limit is 500/u);

  await assert.rejects(parser.parse({
    buffer: await readFile(resolve(fixtureDir, 'unsupported-test.exe')),
    fileName: 'unsupported-test.exe',
    mimeType: 'application/x-msdownload',
    signal: AbortSignal.timeout(5_000),
  }), /No governed document parser is registered/u);
});
