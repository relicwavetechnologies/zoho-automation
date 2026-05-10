import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentResolverService } from '../../../src/application/email/attachment-resolver.service.ts';
import type { AttachmentSourceAdapter } from '../../../src/application/email/attachment.types.ts';

describe('AttachmentResolverService', () => {
  const ctx = { companyId: 'co1', userId: 'u1' };

  it('resolves attachments through matching adapters', async () => {
    const adapter: AttachmentSourceAdapter = {
      source: 'file_asset',
      resolve: async () => ({
        fileName: '../unsafe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
        content: Buffer.from('abc'),
        source: 'file_asset',
      }),
    };
    const service = new AttachmentResolverService(new Map([['file_asset', adapter]]));

    const result = await service.resolve([{ source: 'file_asset', fileAssetId: 'f1' }], ctx);

    assert.equal(result.ok, true);
    assert.equal((result as any).value[0].fileName, '.. unsafe.pdf');
    assert.equal((result as any).value[0].sizeBytes, 3);
  });

  it('returns a structured error for unknown sources', async () => {
    const service = new AttachmentResolverService(new Map());
    const result = await service.resolve([{ source: 'file_asset', fileAssetId: 'f1' }], ctx);
    assert.equal(result.ok, false);
    assert.equal((result as any).error.code, 'source_disabled');
  });

  it('returns policy violations after adapter resolution', async () => {
    const adapter: AttachmentSourceAdapter = {
      source: 'file_asset',
      resolve: async () => ({
        fileName: 'large.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 11 * 1024 * 1024,
        content: Buffer.alloc(11 * 1024 * 1024),
        source: 'file_asset',
      }),
    };
    const service = new AttachmentResolverService(new Map([['file_asset', adapter]]));
    const result = await service.resolve([{ source: 'file_asset', fileAssetId: 'f1' }], ctx);
    assert.equal(result.ok, false);
    assert.equal((result as any).error.code, 'file_too_large');
  });
});
