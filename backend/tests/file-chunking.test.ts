import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIndexedFileChunks,
  chooseFileChunkingPlan,
  classifyFileDocument,
} from '../src/modules/file-upload/file-chunking';

test('file chunking classifies policy documents into structured hierarchical chunks', () => {
  const documentClass = classifyFileDocument({
    fileName: 'Employee Refund Policy Handbook.md',
    mimeType: 'text/markdown',
    text: 'Refund Policy\n\nSection 1. Eligibility\n\nEmployees can request reimbursement.',
  });
  const plan = chooseFileChunkingPlan({
    fileName: 'Employee Refund Policy Handbook.md',
    mimeType: 'text/markdown',
    text: 'Refund Policy\n\nSection 1. Eligibility\n\nEmployees can request reimbursement.',
  });

  assert.equal(documentClass, 'handbook');
  assert.equal(plan.strategy, 'hybrid_structured');
  assert.equal(plan.hierarchical, true);
});

test('file chunking stores raw chunk text separately from indexed hierarchical context', () => {
  const chunks = buildIndexedFileChunks({
    companyId: 'company-1',
    fileAssetId: 'file-1',
    fileName: 'Refund Policy.md',
    mimeType: 'text/markdown',
    sourceUrl: 'https://example.com/refund-policy',
    uploaderUserId: 'user-1',
    allowedRoles: ['MEMBER'],
    text: [
      '# Refund Policy',
      '',
      '## Carryover',
      '',
      'Unused credit expires after 90 days unless the employee is on an approved leave.',
      '',
      '## Exceptions',
      '',
      'Finance may approve longer carryover for legal hold cases.',
    ].join('\n'),
  });

  assert.ok(chunks.length >= 2);
  const carryoverChunk = chunks.find((chunk) => chunk.sectionPath?.includes('Carryover'));
  assert.ok(carryoverChunk);
  assert.equal(carryoverChunk?.payload.documentClass, 'policy');
  assert.equal(carryoverChunk?.payload.chunkingStrategy, 'hybrid_structured');
  assert.ok(Array.isArray(carryoverChunk?.payload.sectionPath));
  assert.match(String(carryoverChunk?.payload.parentSectionText), /Unused credit expires after 90 days/);
  assert.match(String(carryoverChunk?.payload.contextPrefix), /Document "Refund Policy.md"/);
  assert.notEqual(carryoverChunk?.payload._chunk, carryoverChunk?.payload.text);
});

