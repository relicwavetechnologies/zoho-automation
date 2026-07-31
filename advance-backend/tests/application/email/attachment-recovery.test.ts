import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentResolverService } from '../../../src/application/email/attachment-resolver.service.ts';
import type { AttachmentSourceAdapter } from '../../../src/application/email/attachment.types.ts';

describe('attachment recovery', () => {
  it('converts adapter throws into source_disabled errors', async () => {
    const adapter: AttachmentSourceAdapter = {
      source: 'lark',
      resolve: async () => {
        throw new Error('Lark file not found');
      },
    };
    const service = new AttachmentResolverService(new Map([['lark', adapter]]));
    const result = await service.resolve([{ source: 'lark', messageId: 'm1', fileKey: 'k1' }], {
      companyId: 'co1',
      userId: 'u1',
    });

    assert.equal(result.ok, false);
    assert.equal((result as any).error.code, 'source_disabled');
    assert.match((result as any).error.message, /Lark file not found/);
  });

  it('allows zero-byte and unicode filenames after sanitization', async () => {
    const adapter: AttachmentSourceAdapter = {
      source: 'outbound_artifact',
      resolve: async () => ({
        fileName: 'Résumé 2026.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 0,
        content: Buffer.alloc(0),
        source: 'outbound_artifact',
      }),
    };
    const service = new AttachmentResolverService(new Map([['outbound_artifact', adapter]]));
    const result = await service.resolve([{ source: 'outbound_artifact', artifactId: 'f1' }], {
      companyId: 'co1',
      userId: 'u1',
    });

    assert.equal(result.ok, true);
    assert.equal((result as any).value[0].fileName, 'Résumé 2026.pdf');
    assert.equal((result as any).value[0].sizeBytes, 0);
  });
});
