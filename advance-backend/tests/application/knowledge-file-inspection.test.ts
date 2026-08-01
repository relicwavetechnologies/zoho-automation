import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectKnowledgeFile,
  KNOWLEDGE_FILE_INSPECTION_VERSION,
} from '../../src/application/knowledge/knowledge-file-inspection.ts';

test('accepts bytes whose extension, MIME, and signature agree', () => {
  const result = inspectKnowledgeFile({
    fileName: 'policy.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'),
  });
  assert.equal(result.inspectionVersion, KNOWLEDGE_FILE_INSPECTION_VERSION);
});

test('rejects a renamed executable before private storage', () => {
  assert.throws(() => inspectKnowledgeFile({
    fileName: 'policy.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
  }), /Executable files cannot be stored/);
});

test('rejects MIME and extension disagreement', () => {
  assert.throws(() => inspectKnowledgeFile({
    fileName: 'policy.exe',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\n%%EOF'),
  }), /extension does not match/);
});

test('rejects active PDF content', () => {
  assert.throws(() => inspectKnowledgeFile({
    fileName: 'policy.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\n/OpenAction 1 0 R\n%%EOF'),
  }), /active or embedded content/);
});

test('rejects invalid UTF-8 and executable text', () => {
  assert.throws(() => inspectKnowledgeFile({
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from([0xc3, 0x28]),
  }), /valid UTF-8/);
  assert.throws(() => inspectKnowledgeFile({
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('#!/bin/sh\necho nope'),
  }), /Executable scripts/);
});

test('distinguishes Word, Excel, and PowerPoint Open XML packages', () => {
  const fakePackage = (family: string) => Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(`[Content_Types].xml\u0000${family}`),
  ]);
  assert.doesNotThrow(() => inspectKnowledgeFile({
    fileName: 'guide.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: fakePackage('word/document.xml'),
  }));
  assert.throws(() => inspectKnowledgeFile({
    fileName: 'guide.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: fakePackage('xl/workbook.xml'),
  }), /does not match/);
});
