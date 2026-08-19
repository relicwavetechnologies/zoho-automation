import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from '../../shared/logger';
import { validateAttachmentPolicy } from '../email/attachment-policy';
import type { KnowledgeFileThreatScanner } from '../knowledge/knowledge-file-threat-scanner';
import { CONVERSATION_ATTACHMENT_TTL_MS, normalizeFileName } from './conversation-attachment.service';

export interface ConversationAttachmentAsset {
  readonly id:                 string;
  readonly companyId:          string;
  readonly userId:             string;
  readonly channel:            string;
  readonly conversationKey:    string;
  readonly chatId:             string;
  readonly fileName:           string;
  readonly mimeType:           string;
  readonly sizeBytes:          number;
  readonly sha256:             string;
  readonly storageProvider:    string;
  readonly storageKey:         string;
  readonly resourceType:       string;
  readonly deliveryType:       'authenticated';
  readonly receivedAt:         Date;
  readonly expiresAt:          Date;
  readonly consumedAt:         Date | null;
  readonly uncertainAt:        Date | null;
}

export interface ConversationAttachmentAssetStore {
  create(asset: ConversationAttachmentAssetCreate): Promise<void>;
  listLive(input: {
    readonly companyId: string;
    readonly userId:    string;
    readonly channel:   string;
    readonly chatId:    string;
    readonly now:       Date;
  }): Promise<readonly ConversationAttachmentAsset[]>;
  listExpired(input: {
    readonly now:   Date;
    readonly limit: number;
  }): Promise<readonly ConversationAttachmentAsset[]>;
  markConsumed(input: {
    readonly companyId: string;
    readonly id:        string;
    readonly now:       Date;
  }): Promise<void>;
  markUncertain(input: {
    readonly companyId: string;
    readonly id:        string;
    readonly now:       Date;
  }): Promise<void>;
  delete(input: {
    readonly companyId: string;
    readonly id:        string;
  }): Promise<boolean>;
}

export interface ConversationAttachmentObjectStore {
  readonly provider: string;
  readonly isAvailable: boolean;
  upload(input: {
    readonly buffer: Buffer;
    readonly companyId: string;
    readonly assetId: string;
    readonly fileName: string;
    readonly mimeType: string;
  }): Promise<{
    readonly storageKey: string;
    readonly resourceType: string;
    readonly deliveryType: 'authenticated';
    readonly bytes: number;
  }>;
  read(input: {
    readonly storageKey: string;
    readonly resourceType: string;
    readonly deliveryType: 'authenticated';
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<Buffer>;
  delete(input: {
    readonly storageKey: string;
    readonly resourceType: string;
    readonly deliveryType: 'authenticated';
  }): Promise<void>;
}

export type AttachmentAssetLookup =
  | { readonly kind: 'found'; readonly asset: ConversationAttachmentAsset }
  | { readonly kind: 'not_found'; readonly available: readonly string[] }
  | { readonly kind: 'ambiguous'; readonly matches: readonly ConversationAttachmentAsset[] };

export interface ConversationAttachmentAssetCreate extends ConversationAttachmentAsset {
  readonly threatScanProvider: string | null;
  readonly threatScanVersion:  string | null;
  readonly threatScannedAt:    Date | null;
}

export class ConversationAttachmentAssetService {
  private readonly log: Logger;

  constructor(private readonly deps: {
    readonly assets: ConversationAttachmentAssetStore;
    readonly objects: ConversationAttachmentObjectStore;
    readonly logger: Logger;
    readonly maxBytes: number;
    readonly threatScanner?: KnowledgeFileThreatScanner | null;
    readonly threatScanRequired?: boolean;
    readonly threatScanTimeoutMs?: number;
    readonly now?: () => Date;
  }) {
    this.log = deps.logger.child({ service: 'conversation-attachment-assets' });
  }

  async record(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly channel: string;
    readonly conversationKey: string;
    readonly chatId: string;
    readonly files: readonly { readonly fileName: string; readonly mimeType: string; readonly buffer: Buffer }[];
  }): Promise<readonly { readonly id: string; readonly fileName: string }[]> {
    if (input.files.length === 0) return [];
    if (!this.deps.objects.isAvailable) {
      this.log.warn('conversation_attachment_asset.storage_unavailable', {
        companyId: input.companyId,
        channel: input.channel,
      });
      return [];
    }
    const recorded: { id: string; fileName: string }[] = [];
    for (const file of input.files) {
      let created: { readonly id: string; readonly fileName: string } | null = null;
      try {
        created = await this.stageOne({ ...input, file });
      } catch (error) {
        this.log.warn('conversation_attachment_asset.record_failed', {
          companyId: input.companyId,
          channel: input.channel,
          fileName: file.fileName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (created) recorded.push(created);
    }
    return recorded;
  }

  async lookup(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly channel: string;
    readonly chatId: string;
    readonly fileName: string;
  }): Promise<AttachmentAssetLookup> {
    const rows = await this.deps.assets.listLive({
      companyId: input.companyId,
      userId: input.userId,
      channel: input.channel,
      chatId: input.chatId,
      now: this.now(),
    });
    const wanted = normalizeFileName(input.fileName);
    const matches = rows
      .filter(row => normalizeFileName(row.fileName) === wanted)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    if (matches.length === 0) {
      return { kind: 'not_found', available: [...new Set(rows.map(row => row.fileName))] };
    }
    const distinct = new Set(matches.map(row => row.sha256));
    if (distinct.size > 1) return { kind: 'ambiguous', matches };
    return { kind: 'found', asset: matches[0]! };
  }

  async read(asset: ConversationAttachmentAsset): Promise<Buffer> {
    return this.deps.objects.read({
      storageKey: asset.storageKey,
      resourceType: asset.resourceType,
      deliveryType: asset.deliveryType,
      maxBytes: this.deps.maxBytes,
      signal: AbortSignal.timeout(60_000),
    });
  }

  markConsumed(asset: ConversationAttachmentAsset): Promise<void> {
    return this.deps.assets.markConsumed({ companyId: asset.companyId, id: asset.id, now: this.now() });
  }

  markUncertain(asset: ConversationAttachmentAsset): Promise<void> {
    return this.deps.assets.markUncertain({ companyId: asset.companyId, id: asset.id, now: this.now() });
  }

  async cleanupExpired(limit = 100): Promise<number> {
    if (!this.deps.objects.isAvailable) return 0;

    const expired = await this.deps.assets.listExpired({ now: this.now(), limit });
    const results = await Promise.all(expired.map(async asset => {
      if (asset.storageProvider !== this.deps.objects.provider) {
        this.log.warn('conversation_attachment_asset.cleanup_provider_mismatch', {
          assetId: asset.id,
          storageProvider: asset.storageProvider,
          configuredProvider: this.deps.objects.provider,
        });
        return false;
      }

      try {
        await this.deps.objects.delete({
          storageKey: asset.storageKey,
          resourceType: asset.resourceType,
          deliveryType: asset.deliveryType,
        });
      } catch (error) {
        this.log.warn('conversation_attachment_asset.cleanup_delete_failed', {
          assetId: asset.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }

      let removed = false;
      try {
        removed = await this.deps.assets.delete({ companyId: asset.companyId, id: asset.id });
      } catch (error) {
        this.log.warn('conversation_attachment_asset.cleanup_row_delete_failed', {
          assetId: asset.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      if (!removed) {
        this.log.warn('conversation_attachment_asset.cleanup_completion_lost', { assetId: asset.id });
      }
      return removed;
    }));

    return results.filter(Boolean).length;
  }

  private async stageOne(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly channel: string;
    readonly conversationKey: string;
    readonly chatId: string;
    readonly file: { readonly fileName: string; readonly mimeType: string; readonly buffer: Buffer };
  }): Promise<{ readonly id: string; readonly fileName: string } | null> {
    const fileName = input.file.fileName.trim() || 'attachment';
    const mimeType = input.file.mimeType.trim() || 'application/octet-stream';
    const policy = validateAttachmentPolicy([{
      fileName,
      mimeType,
      sizeBytes: input.file.buffer.length,
      content: input.file.buffer,
      source: 'cloudinary',
    }]);
    if (!policy.ok || input.file.buffer.length > this.deps.maxBytes) {
      this.log.warn('conversation_attachment_asset.policy_rejected', {
        companyId: input.companyId,
        fileName,
        reason: policy.ok ? 'max_bytes' : policy.error.code,
      });
      return null;
    }
    if (this.deps.threatScanRequired && !this.deps.threatScanner) {
      this.log.warn('conversation_attachment_asset.scan_unavailable', { companyId: input.companyId, fileName });
      return null;
    }

    let threatScanProvider: string | null = null;
    let threatScanVersion: string | null = null;
    let threatScannedAt: Date | null = null;
    if (this.deps.threatScanner) {
      const verdict = await this.deps.threatScanner.scan({
        buffer: input.file.buffer,
        fileName,
        mimeType,
        signal: AbortSignal.timeout(this.deps.threatScanTimeoutMs ?? 30_000),
      });
      if (verdict.status === 'infected') {
        this.log.warn('conversation_attachment_asset.threat_rejected', {
          companyId: input.companyId,
          fileName,
          threat: verdict.threat,
        });
        return null;
      }
      threatScanProvider = verdict.provider;
      threatScanVersion = verdict.engineVersion ?? null;
      threatScannedAt = this.now();
    }

    const id = randomUUID();
    const sha256 = createHash('sha256').update(input.file.buffer).digest('hex');
    const uploaded = await this.deps.objects.upload({
      buffer: input.file.buffer,
      companyId: input.companyId,
      assetId: id,
      fileName,
      mimeType,
    });
    if (uploaded.bytes !== input.file.buffer.length) {
      await this.deps.objects.delete({
        storageKey: uploaded.storageKey,
        resourceType: uploaded.resourceType,
        deliveryType: uploaded.deliveryType,
      }).catch(() => undefined);
      this.log.warn('conversation_attachment_asset.size_mismatch', { companyId: input.companyId, fileName });
      return null;
    }

    try {
      await this.deps.assets.create({
        id,
        companyId: input.companyId,
        userId: input.userId,
        channel: input.channel,
        conversationKey: input.conversationKey,
        chatId: input.chatId,
        fileName,
        mimeType,
        sizeBytes: input.file.buffer.length,
        sha256,
        storageProvider: this.deps.objects.provider,
        storageKey: uploaded.storageKey,
        resourceType: uploaded.resourceType,
        deliveryType: uploaded.deliveryType,
        threatScanProvider,
        threatScanVersion,
        threatScannedAt,
        receivedAt: this.now(),
        expiresAt: new Date(this.now().getTime() + CONVERSATION_ATTACHMENT_TTL_MS),
        consumedAt: null,
        uncertainAt: null,
      });
      return { id, fileName };
    } catch (error) {
      await this.deps.objects.delete({
        storageKey: uploaded.storageKey,
        resourceType: uploaded.resourceType,
        deliveryType: uploaded.deliveryType,
      }).catch(() => undefined);
      throw error;
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
