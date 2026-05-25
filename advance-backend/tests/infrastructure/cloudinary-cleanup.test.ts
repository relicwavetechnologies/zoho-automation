import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { v2 as cloudinary } from 'cloudinary';
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
  it('deletes raw temp_export resources older than the configured TTL', async () => {
    const originalResourcesByTag = cloudinary.api.resources_by_tag;
    const originalDeleteResources = cloudinary.api.delete_resources;
    const deleted: string[][] = [];

    cloudinary.api.resources_by_tag = (async () => ({
      resources: [
        { public_id: 'temp_exports/co/export-old.csv', created_at: '2026-05-09T00:00:00Z' },
        { public_id: 'temp_exports/co/export-new.csv', created_at: '2026-05-10T23:00:00Z' },
      ],
    })) as typeof cloudinary.api.resources_by_tag;
    cloudinary.api.delete_resources = (async (ids: string[]) => {
      deleted.push(ids);
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

      assert.equal(result.scanned, 2);
      assert.equal(result.deleted, 1);
      assert.deepEqual(deleted, [['temp_exports/co/export-old.csv']]);
    } finally {
      cloudinary.api.resources_by_tag = originalResourcesByTag;
      cloudinary.api.delete_resources = originalDeleteResources;
    }
  });
});
