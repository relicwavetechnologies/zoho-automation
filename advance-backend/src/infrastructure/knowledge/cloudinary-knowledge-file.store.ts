import type { KnowledgePrivateObjectStore } from '../../application/knowledge/knowledge-file.service';
import {
  CloudinaryAdapter,
  type CloudinaryResourceType,
} from '../cloudinary/cloudinary.adapter';

export class CloudinaryKnowledgeFileStore implements KnowledgePrivateObjectStore {
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
      folder: 'knowledge_files',
      assetId: input.assetId,
      tags: ['governed_knowledge_file', `uploader_asset:${input.assetId}`],
      deliveryType: 'authenticated',
    });
    return {
      storageKey: uploaded.publicId,
      resourceType: uploaded.resourceType,
      deliveryType: 'authenticated' as const,
      bytes: uploaded.bytes,
    };
  }

  signedDownloadUrl(input: {
    storageKey: string;
    resourceType: string;
    deliveryType: 'private' | 'authenticated';
    expiresInSeconds: number;
  }): string {
    return this.cloudinary.getSignedAssetUrl({
      publicId: input.storageKey,
      resourceType: parseResourceType(input.resourceType),
      deliveryType: input.deliveryType,
      expiresInSeconds: input.expiresInSeconds,
    });
  }

  async read(input: {
    storageKey: string;
    resourceType: string;
    deliveryType: 'private' | 'authenticated';
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
      throw new Error(`Private object download failed (${response.status}).`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > input.maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new Error('Private object exceeds the permitted processing size.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > input.maxBytes) throw new Error('Private object exceeds the permitted processing size.');
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
    deliveryType: 'private' | 'authenticated';
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
  throw new Error('Knowledge file has an unsupported Cloudinary resource type.');
}
