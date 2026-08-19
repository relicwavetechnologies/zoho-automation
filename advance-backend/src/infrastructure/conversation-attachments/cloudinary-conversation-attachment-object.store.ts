import type {
  ConversationAttachmentObjectStore,
} from '../../application/conversation-attachments/conversation-attachment-asset.service';
import {
  CloudinaryAdapter,
  type CloudinaryResourceType,
} from '../cloudinary/cloudinary.adapter';

export class CloudinaryConversationAttachmentObjectStore implements ConversationAttachmentObjectStore {
  constructor(private readonly cloudinary: CloudinaryAdapter) {}

  readonly provider = 'cloudinary';

  get isAvailable(): boolean {
    return this.cloudinary.isAvailable;
  }

  async upload(input: {
    buffer: Buffer;
    companyId: string;
    assetId: string;
    fileName: string;
    mimeType: string;
  }) {
    const uploaded = await this.cloudinary.uploadBuffer({
      ...input,
      folder: 'conversation_attachments',
      assetId: input.assetId,
      tags: ['conversation_attachment', `conversation_asset:${input.assetId}`],
      deliveryType: 'authenticated',
    });
    return {
      storageKey: uploaded.publicId,
      resourceType: uploaded.resourceType,
      deliveryType: 'authenticated' as const,
      bytes: uploaded.bytes,
    };
  }

  async read(input: {
    storageKey: string;
    resourceType: string;
    deliveryType: 'authenticated';
    maxBytes: number;
    signal: AbortSignal;
  }): Promise<Buffer> {
    const response = await fetch(this.cloudinary.getSignedAssetUrl({
      publicId: input.storageKey,
      resourceType: parseResourceType(input.resourceType),
      deliveryType: input.deliveryType,
      expiresInSeconds: 60,
      attachment: false,
    }), { signal: input.signal, redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`Conversation attachment download failed (${response.status}).`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > input.maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new Error('Conversation attachment exceeds the permitted size.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > input.maxBytes) throw new Error('Conversation attachment exceeds the permitted size.');
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total);
  }

  async delete(input: {
    storageKey: string;
    resourceType: string;
    deliveryType: 'authenticated';
  }): Promise<void> {
    await this.cloudinary.deleteAssetStrict(
      input.storageKey,
      parseResourceType(input.resourceType),
      input.deliveryType,
    );
  }
}

function parseResourceType(value: string): CloudinaryResourceType {
  if (value === 'image' || value === 'video' || value === 'raw' || value === 'auto') return value;
  throw new Error('Conversation attachment has an unsupported Cloudinary resource type.');
}
