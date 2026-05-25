import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_AGGREGATE_SIZE_BYTES,
  MAX_ATTACHMENT_SIZE_BYTES,
  sanitizeFilename,
  validateAttachmentPolicy,
} from '../../../src/application/email/attachment-policy.ts';
import type { ResolvedAttachment } from '../../../src/application/email/attachment.types.ts';

describe('attachment policy', () => {
  const attachment = (fileName: string, sizeBytes = 1): ResolvedAttachment => ({
    fileName,
    mimeType: 'application/octet-stream',
    sizeBytes,
    content: Buffer.alloc(sizeBytes),
    source: 'file_asset',
  });

  it('sanitizes unsafe filenames', () => {
    assert.equal(sanitizeFilename('../secret\u0000/report.pdf'), '.. secret report.pdf');
    assert.equal(sanitizeFilename('  spaced \n\t name.pdf  '), 'spaced name.pdf');
    assert.equal(sanitizeFilename(''), 'attachment');
    assert.equal(sanitizeFilename('a'.repeat(240)).length, 200);
  });

  it('allows empty arrays and ten files', () => {
    assert.equal(validateAttachmentPolicy([]).ok, true);
    assert.equal(validateAttachmentPolicy(Array.from({ length: 10 }, (_, i) => attachment(`f${i}.pdf`))).ok, true);
  });

  it('rejects too many files', () => {
    const result = validateAttachmentPolicy(Array.from({ length: 11 }, (_, i) => attachment(`f${i}.pdf`)));
    assert.equal(result.ok, false);
    assert.equal((result as any).error.code, 'too_many_files');
  });

  it('rejects oversized files and aggregate payloads', () => {
    const tooLarge = validateAttachmentPolicy([attachment('large.pdf', MAX_ATTACHMENT_SIZE_BYTES + 1)]);
    assert.equal(tooLarge.ok, false);
    assert.equal((tooLarge as any).error.code, 'file_too_large');

    const aggregate = validateAttachmentPolicy([
      attachment('a.pdf', 9 * 1024 * 1024),
      attachment('b.pdf', 9 * 1024 * 1024),
      attachment('c.pdf', 1),
    ]);
    assert.equal(aggregate.ok, false);
    assert.equal((aggregate as any).error.code, 'aggregate_too_large');
  });

  it('blocks executable and macro extensions', () => {
    assert.equal(validateAttachmentPolicy([attachment('invoice.exe')]).ok, false);
    assert.equal(validateAttachmentPolicy([attachment('report.docm')]).ok, false);
    assert.equal(validateAttachmentPolicy([attachment('report.pdf')]).ok, true);
  });
});
