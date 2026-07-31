import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentResolverService } from '../../../src/application/email/attachment-resolver.service.ts';
import type { AttachmentSourceAdapter } from '../../../src/application/email/attachment.types.ts';

describe('AttachmentResolverService', () => {
  const ctx = { companyId: 'co1', userId: 'u1' };

  it('resolves attachments through matching adapters', async () => {
    const adapter: AttachmentSourceAdapter = {
      source: 'outbound_artifact',
      resolve: async () => ({
        fileName: '../unsafe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
        content: Buffer.from('abc'),
        source: 'outbound_artifact',
      }),
    };
    const service = new AttachmentResolverService(new Map([['outbound_artifact', adapter]]));

    const result = await service.resolve([{ source: 'outbound_artifact', artifactId: 'f1' }], ctx);

    assert.equal(result.ok, true);
    assert.equal((result as any).value[0].fileName, '.. unsafe.pdf');
    assert.equal((result as any).value[0].sizeBytes, 3);
  });

  it('returns a structured error for unknown sources', async () => {
    const service = new AttachmentResolverService(new Map());
    const result = await service.resolve([{ source: 'outbound_artifact', artifactId: 'f1' }], ctx);
    assert.equal(result.ok, false);
    assert.equal((result as any).error.code, 'source_disabled');
  });

  it('returns policy violations after adapter resolution', async () => {
    const adapter: AttachmentSourceAdapter = {
      source: 'outbound_artifact',
      resolve: async () => ({
        fileName: 'large.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 11 * 1024 * 1024,
        content: Buffer.alloc(11 * 1024 * 1024),
        source: 'outbound_artifact',
      }),
    };
    const service = new AttachmentResolverService(new Map([['outbound_artifact', adapter]]));
    const result = await service.resolve([{ source: 'outbound_artifact', artifactId: 'f1' }], ctx);
    assert.equal(result.ok, false);
    assert.equal((result as any).error.code, 'file_too_large');
  });
});
