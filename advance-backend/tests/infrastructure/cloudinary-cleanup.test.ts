import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { v2 as cloudinary } from 'cloudinary';
import { Writable } from 'node:stream';
import { CloudinaryAdapter } from '../../src/infrastructure/cloudinary/cloudinary.adapter.ts';
import { ok } from '../../src/shared/result.ts';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
} as any;

const cache = {
  get: async () => ok(null),
  set: async () => ok(undefined),
  del: async () => ok(undefined),
  scanDel: async () => ok(0),
} as any;

describe('CloudinaryAdapter cleanupExpiredExports', () => {
  it('uploads CSV exports as authenticated assets with expiring private download URLs', async () => {
    const originalUploadStream = cloudinary.uploader.upload_stream;
    const originalPrivateDownloadUrl = cloudinary.utils.private_download_url;
    let uploadOptions: Record<string, unknown> | undefined;
    let downloadOptions: Record<string, unknown> | undefined;

    cloudinary.uploader.upload_stream = ((options: Record<string, unknown>, callback: (error: unknown, result: unknown) => void) => {
      uploadOptions = options;
      const stream = new Writable({ write(_chunk, _encoding, done) { done(); } });
      stream.on('finish', () => callback(null, {
        public_id: 'temp_exports/company-1/export.csv',
        secure_url: 'https://example.test/public-should-not-be-used.csv',
        resource_type: 'raw',
        format: 'csv',
        bytes: 12,
        original_filename: 'export.csv',
      }));
      return stream;
    }) as typeof cloudinary.uploader.upload_stream;
    cloudinary.utils.private_download_url = ((publicId: string, format: string, options: Record<string, unknown>) => {
      assert.equal(publicId, 'temp_exports/company-1/export.csv');
      assert.equal(format, 'csv');
      downloadOptions = options;
      return 'https://api.cloudinary.test/download?signature=signed';
    }) as typeof cloudinary.utils.private_download_url;

    try {
      const adapter = new CloudinaryAdapter({
        cloudName: 'demo',
        apiKey: 'key',
        apiSecret: 'secret',
      }, cache, noopLogger);
      const result = await adapter.uploadCsvBuffer({
        buffer: Buffer.from('id\n1\n'),
        fileName: 'export.csv',
        companyId: 'company-1',
        ttlSeconds: 60,
      });

      assert.equal(uploadOptions?.['type'], 'authenticated');
      assert.match(
        String(uploadOptions?.['public_id']),
        /^export-[0-9a-f-]{36}\.csv$/,
      );
      assert.equal(downloadOptions?.['type'], 'authenticated');
      assert.equal(downloadOptions?.['resource_type'], 'raw');
      assert.equal(downloadOptions?.['attachment'], true);
      assert.equal(result?.signedUrl, 'https://api.cloudinary.test/download?signature=signed');
      assert.match(result?.expiresAt ?? '', /^20/);
    } finally {
      cloudinary.uploader.upload_stream = originalUploadStream;
      cloudinary.utils.private_download_url = originalPrivateDownloadUrl;
    }
  });

  it('deletes raw temp_export resources older than the configured TTL', async () => {
    const originalResourcesByTag = cloudinary.api.resources_by_tag;
    const originalDeleteResources = cloudinary.api.delete_resources;
    const deleted: Array<{ ids: string[]; type?: string }> = [];

    cloudinary.api.resources_by_tag = (async (_tag: string, options: { type?: string }) => ({
      resources: options.type === 'authenticated'
        ? [
            { public_id: 'temp_exports/co/authenticated-old.csv', created_at: '2026-05-09T00:00:00Z' },
            { public_id: 'temp_exports/co/authenticated-new.csv', created_at: '2026-05-10T23:00:00Z' },
          ]
        : [
            { public_id: 'temp_exports/co/legacy-old.csv', created_at: '2026-05-09T00:00:00Z' },
            { public_id: 'temp_exports/co/legacy-new.csv', created_at: '2026-05-10T23:00:00Z' },
          ],
    })) as typeof cloudinary.api.resources_by_tag;
    cloudinary.api.delete_resources = (async (ids: string[], options: { type?: string }) => {
      deleted.push({ ids, type: options.type });
      return { deleted: Object.fromEntries(ids.map(id => [id, 'deleted'])) };
    }) as typeof cloudinary.api.delete_resources;

    try {
      const adapter = new CloudinaryAdapter({
        cloudName: 'demo',
        apiKey: 'key',
        apiSecret: 'secret',
      }, cache, noopLogger);

      const result = await adapter.cleanupExpiredExports({
        ttlSeconds: 86_400,
        now: new Date('2026-05-11T00:00:00Z'),
      });

      assert.equal(result.scanned, 4);
      assert.equal(result.deleted, 2);
      assert.deepEqual(deleted, [
        {
          ids: ['temp_exports/co/authenticated-old.csv'],
          type: 'authenticated',
        },
        {
          ids: ['temp_exports/co/legacy-old.csv'],
          type: 'upload',
        },
      ]);
    } finally {
      cloudinary.api.resources_by_tag = originalResourcesByTag;
      cloudinary.api.delete_resources = originalDeleteResources;
    }
  });
});
