import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LarkAttachmentAdapter } from '../../../../src/application/email/adapters/lark.adapter.ts';

describe('LarkAttachmentAdapter', () => {
  it('downloads Lark message files', async () => {
    const adapter = new LarkAttachmentAdapter({
      downloadFile: async (messageId, fileKey) => {
        assert.equal(messageId, 'm1');
        assert.equal(fileKey, 'k1');
        return Buffer.from('lark bytes');
      },
    });

    const result = await adapter.resolve({
      source: 'lark',
      messageId: 'm1',
      fileKey: 'k1',
      fileName: 'upload.txt',
    }, { companyId: 'co1', userId: 'u1' });

    assert.equal(result.fileName, 'upload.txt');
    assert.equal(result.mimeType, 'application/octet-stream');
    assert.equal(result.content.toString(), 'lark bytes');
  });
});
