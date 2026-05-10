import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OutboundArtifactAttachmentAdapter } from '../../../../src/application/email/adapters/outbound-artifact.adapter.ts';

describe('OutboundArtifactAttachmentAdapter', () => {
  it('decodes inline base64 artifacts', async () => {
    const prisma = {
      outboundArtifact: {
        findFirst: async () => ({
          fileName: 'export.csv',
          mimeType: 'text/csv',
          contentBase64: Buffer.from('a,b\n1,2').toString('base64'),
        }),
      },
    };
    const adapter = new OutboundArtifactAttachmentAdapter(prisma as any);

    const result = await adapter.resolve({ source: 'outbound_artifact', artifactId: 'a1' }, {
      companyId: 'co1',
      userId: 'u1',
    });

    assert.equal(result.fileName, 'export.csv');
    assert.equal(result.mimeType, 'text/csv');
    assert.equal(result.content.toString(), 'a,b\n1,2');
  });

  it('throws when the artifact is missing', async () => {
    const prisma = { outboundArtifact: { findFirst: async () => null } };
    const adapter = new OutboundArtifactAttachmentAdapter(prisma as any);
    await assert.rejects(
      () => adapter.resolve({ source: 'outbound_artifact', artifactId: 'missing' }, { companyId: 'co1', userId: 'u1' }),
      /not found/,
    );
  });
});
