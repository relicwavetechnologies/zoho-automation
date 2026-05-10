import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleDriveAttachmentAdapter } from '../../../../src/application/email/adapters/google-drive.adapter.ts';

describe('GoogleDriveAttachmentAdapter', () => {
  it('downloads native Drive files', async () => {
    const client = {
      listFiles: async () => [],
      searchFiles: async () => [],
      createFolder: async () => ({ fileId: 'folder' }),
      getFile: async () => ({ name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
      downloadFile: async (fileId: string) => {
        assert.equal(fileId, 'f1');
        return Buffer.from('abc');
      },
      exportFile: async () => Buffer.alloc(0),
    };
    const adapter = new GoogleDriveAttachmentAdapter(async () => client);

    const result = await adapter.resolve({ source: 'google_drive', fileId: 'f1' }, {
      companyId: 'co1',
      userId: 'u1',
    });

    assert.equal(result.fileName, 'report.pdf');
    assert.equal(result.mimeType, 'application/pdf');
    assert.equal(result.content.toString(), 'abc');
  });

  it('exports Google Workspace files with sensible defaults', async () => {
    const calls: string[] = [];
    const client = {
      listFiles: async () => [],
      searchFiles: async () => [],
      createFolder: async () => ({ fileId: 'folder' }),
      getFile: async () => ({ name: 'Sheet', mimeType: 'application/vnd.google-apps.spreadsheet' }),
      downloadFile: async () => Buffer.alloc(0),
      exportFile: async (_fileId: string, mimeType: string) => {
        calls.push(mimeType);
        return Buffer.from('xlsx');
      },
    };
    const adapter = new GoogleDriveAttachmentAdapter(async () => client);

    const result = await adapter.resolve({ source: 'google_drive', fileId: 'sheet1' }, {
      companyId: 'co1',
      userId: 'u1',
    });

    assert.equal(result.fileName, 'Sheet.xlsx');
    assert.equal(result.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.deepEqual(calls, ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
  });
});
