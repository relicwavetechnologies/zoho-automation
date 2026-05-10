import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FileAssetAttachmentAdapter } from '../../../../src/application/email/adapters/file-asset.adapter.ts';

describe('FileAssetAttachmentAdapter', () => {
  it('loads metadata, downloads signed Cloudinary bytes, and returns a resolved attachment', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request) => {
      assert.equal(String(url), 'https://signed.example/report.pdf');
      return new Response(Buffer.from('pdf bytes'));
    };
    try {
      const repo = {
        findById: async () => ({
          ok: true,
          value: {
            companyId: 'co1',
            fileName: 'report.pdf',
            mimeType: 'application/pdf',
            cloudinaryPublicId: 'pub1',
            cloudinaryResourceType: 'raw',
          },
        }),
      };
      const cloudinary = {
        getSignedDownloadUrl: () => 'https://signed.example/report.pdf',
      };
      const adapter = new FileAssetAttachmentAdapter(repo as any, cloudinary as any);

      const result = await adapter.resolve({ source: 'file_asset', fileAssetId: 'f1' }, {
        companyId: 'co1',
        userId: 'u1',
      });

      assert.equal(result.fileName, 'report.pdf');
      assert.equal(result.mimeType, 'application/pdf');
      assert.equal(result.sizeBytes, Buffer.byteLength('pdf bytes'));
      assert.equal(result.content.toString(), 'pdf bytes');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
