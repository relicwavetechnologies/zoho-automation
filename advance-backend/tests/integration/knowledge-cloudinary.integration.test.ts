import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CloudinaryAdapter } from '../../src/infrastructure/cloudinary/cloudinary.adapter.ts';
import { CloudinaryKnowledgeFileStore } from '../../src/infrastructure/knowledge/cloudinary-knowledge-file.store.ts';

const cloudName = process.env['CLOUDINARY_CLOUD_NAME']?.trim();
const apiKey = process.env['CLOUDINARY_API_KEY']?.trim();
const apiSecret = process.env['CLOUDINARY_API_SECRET']?.trim();
const enabled = process.env['RUN_CLOUDINARY_INTEGRATION'] === '1'
  && Boolean(cloudName && apiKey && apiSecret);

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};
const cache = {
  async get() { return { ok: true as const, value: null }; },
  async set() { return { ok: true as const, value: undefined }; },
  async setNx() { return { ok: true as const, value: true }; },
  async del() { return { ok: true as const, value: undefined }; },
  async scanDel() { return { ok: true as const, value: 0 }; },
};

test('real Cloudinary governed-file object stays authenticated, round-trips exact bytes, and deletes', {
  skip: !enabled ? 'Set RUN_CLOUDINARY_INTEGRATION=1 and Cloudinary credentials to run.' : false,
  timeout: 60_000,
}, async () => {
  const adapter = new CloudinaryAdapter({
    cloudName: cloudName!, apiKey: apiKey!, apiSecret: apiSecret!,
  }, cache, logger);
  const store = new CloudinaryKnowledgeFileStore(adapter);
  const id = randomUUID();
  const bytes = Buffer.from(`Divo governed-file integration ${id}`);
  let uploaded: Awaited<ReturnType<CloudinaryKnowledgeFileStore['upload']>> | null = null;
  try {
    uploaded = await store.upload({
      buffer: bytes,
      companyId: `integration-${id}`,
      assetId: id,
      fileName: 'round-trip.txt',
      mimeType: 'text/plain',
    });
    assert.equal(uploaded.deliveryType, 'authenticated');
    assert.equal(uploaded.bytes, bytes.length);
    assert.doesNotMatch(uploaded.storageKey, /round-trip\.txt/);
    const read = await store.read({
      ...uploaded,
      maxBytes: 1_024,
      signal: AbortSignal.timeout(30_000),
    });
    assert.deepEqual(read, bytes);
  } finally {
    if (uploaded) await store.delete(uploaded);
  }
});
