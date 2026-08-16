import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConversationAttachmentAssetService,
  type ConversationAttachmentAsset,
  type ConversationAttachmentAssetCreate,
  type ConversationAttachmentAssetStore,
  type ConversationAttachmentObjectStore,
} from '../../src/application/conversation-attachments/conversation-attachment-asset.service.ts';
import { WebConversationAttachmentSource } from '../../src/infrastructure/zoho/web-conversation-attachment.source.ts';
import type { Logger } from '../../src/shared/logger.ts';

const testLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => testLogger,
};

class MemoryAssetStore implements ConversationAttachmentAssetStore {
  readonly rows: ConversationAttachmentAssetCreate[] = [];

  async create(asset: ConversationAttachmentAssetCreate): Promise<void> {
    this.rows.push(asset);
  }

  async listLive(input: {
    companyId: string;
    userId: string;
    channel: string;
    chatId: string;
    now: Date;
  }): Promise<readonly ConversationAttachmentAsset[]> {
    return this.rows.filter(row =>
      row.companyId === input.companyId
      && row.userId === input.userId
      && row.channel === input.channel
      && row.chatId === input.chatId
      && row.expiresAt > input.now
    );
  }

  async listExpired(input: { now: Date; limit: number }): Promise<readonly ConversationAttachmentAsset[]> {
    return this.rows
      .filter(row => row.expiresAt <= input.now)
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
      .slice(0, input.limit);
  }

  async markConsumed(input: { companyId: string; id: string; now: Date }): Promise<void> {
    const row = this.rows.find(item => item.companyId === input.companyId && item.id === input.id);
    if (row) this.rows[this.rows.indexOf(row)] = { ...row, consumedAt: input.now };
  }

  async markUncertain(input: { companyId: string; id: string; now: Date }): Promise<void> {
    const row = this.rows.find(item => item.companyId === input.companyId && item.id === input.id);
    if (row) this.rows[this.rows.indexOf(row)] = { ...row, uncertainAt: input.now };
  }

  async delete(input: { companyId: string; id: string }): Promise<boolean> {
    const index = this.rows.findIndex(item => item.companyId === input.companyId && item.id === input.id);
    if (index === -1) return false;
    this.rows.splice(index, 1);
    return true;
  }
}

class MemoryObjectStore implements ConversationAttachmentObjectStore {
  readonly provider = 'memory';
  readonly isAvailable = true;
  readonly objects = new Map<string, Buffer>();

  async upload(input: {
    buffer: Buffer;
    companyId: string;
    assetId: string;
    fileName: string;
    mimeType: string;
  }) {
    const storageKey = `${input.companyId}/${input.assetId}`;
    this.objects.set(storageKey, input.buffer);
    return {
      storageKey,
      resourceType: 'raw',
      deliveryType: 'authenticated' as const,
      bytes: input.buffer.length,
    };
  }

  async read(input: { storageKey: string }): Promise<Buffer> {
    const found = this.objects.get(input.storageKey);
    if (!found) throw new Error('missing');
    return found;
  }

  async delete(input: { storageKey: string }): Promise<void> {
    this.objects.delete(input.storageKey);
  }
}

const serviceFixture = () => {
  const assets = new MemoryAssetStore();
  const objects = new MemoryObjectStore();
  const now = new Date('2026-08-17T00:00:00.000Z');
  const service = new ConversationAttachmentAssetService({
    assets,
    objects,
    logger: testLogger,
    maxBytes: 10 * 1024 * 1024,
    now: () => now,
  });
  return { service, assets, objects };
};

describe('ConversationAttachmentAssetService', () => {
  it('stores a web upload and reads the original bytes back by filename', async () => {
    const { service, assets } = serviceFixture();

    await service.record({
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'web',
      conversationKey: 'web_thread_1',
      chatId: 'web_thread_1',
      files: [{ fileName: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') }],
    });

    const lookup = await service.lookup({
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'web',
      chatId: 'web_thread_1',
      fileName: 'Invoice.pdf',
    });

    assert.equal(lookup.kind, 'found');
    if (lookup.kind !== 'found') return;
    assert.equal(assets.rows.length, 1);
    assert.equal((await service.read(lookup.asset)).toString(), '%PDF-1.4\n');
  });

  it('does not guess between different web uploads with the same filename', async () => {
    const { service } = serviceFixture();
    const common = {
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'web',
      conversationKey: 'web_thread_1',
      chatId: 'web_thread_1',
    };

    await service.record({
      ...common,
      files: [
        { fileName: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF one\n') },
        { fileName: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF two\n') },
      ],
    });

    const lookup = await service.lookup({ ...common, fileName: 'invoice.pdf' });

    assert.equal(lookup.kind, 'ambiguous');
  });

  it('does not fail the chat run when private storage cannot keep a provider copy', async () => {
    const assets = new MemoryAssetStore();
    const service = new ConversationAttachmentAssetService({
      assets,
      objects: {
        provider: 'broken',
        isAvailable: true,
        upload: async () => { throw new Error('storage down'); },
        read: async () => { throw new Error('missing'); },
        delete: async () => undefined,
      },
      logger: testLogger,
      maxBytes: 10 * 1024 * 1024,
      now: () => new Date('2026-08-17T00:00:00.000Z'),
    });

    const recorded = await service.record({
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'web',
      conversationKey: 'web_thread_1',
      chatId: 'web_thread_1',
      files: [{ fileName: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') }],
    });

    assert.deepEqual(recorded, []);
    assert.equal(assets.rows.length, 0);
  });

  it('resolves web-held assets for Zoho without exposing storage keys to the model', async () => {
    const { service } = serviceFixture();
    await service.record({
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'web',
      conversationKey: 'web_thread_1',
      chatId: 'web_thread_1',
      files: [{ fileName: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') }],
    });
    const source = new WebConversationAttachmentSource(service, testLogger);

    const resolved = await source.resolve({
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'web',
      chatId: 'web_thread_1',
      fileName: 'source.pdf',
    });

    assert.equal(resolved.kind, 'resolved');
    if (resolved.kind !== 'resolved') return;
    assert.equal(resolved.fileName, 'source.pdf');
    assert.equal(resolved.content.toString(), '%PDF-1.4\n');
    assert.equal('storageKey' in resolved, false);
  });

  it('removes expired rows only after the private object is deleted', async () => {
    const { service, assets, objects } = serviceFixture();
    await service.record({
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'web',
      conversationKey: 'web_thread_1',
      chatId: 'web_thread_1',
      files: [{ fileName: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') }],
    });
    const row = assets.rows[0]!;
    assets.rows[0] = { ...row, expiresAt: new Date('2026-08-16T23:59:59.000Z') };

    const deleted = await service.cleanupExpired();

    assert.equal(deleted, 1);
    assert.equal(assets.rows.length, 0);
    assert.equal(objects.objects.has(row.storageKey), false);
  });

  it('keeps expired rows retryable when private object deletion fails', async () => {
    const assets = new MemoryAssetStore();
    const objects = new MemoryObjectStore();
    const service = new ConversationAttachmentAssetService({
      assets,
      objects: {
        provider: objects.provider,
        isAvailable: objects.isAvailable,
        upload: input => objects.upload(input),
        read: input => objects.read(input),
        delete: async () => { throw new Error('cloudinary unavailable'); },
      },
      logger: testLogger,
      maxBytes: 10 * 1024 * 1024,
      now: () => new Date('2026-08-17T00:00:00.000Z'),
    });
    await service.record({
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'web',
      conversationKey: 'web_thread_1',
      chatId: 'web_thread_1',
      files: [{ fileName: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') }],
    });
    const row = assets.rows[0]!;
    assets.rows[0] = { ...row, expiresAt: new Date('2026-08-16T23:59:59.000Z') };

    const deleted = await service.cleanupExpired();

    assert.equal(deleted, 0);
    assert.equal(assets.rows.length, 1);
    assert.equal(objects.objects.has(row.storageKey), true);
  });
});
