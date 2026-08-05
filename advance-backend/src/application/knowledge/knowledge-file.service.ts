import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from '../../shared/logger';
import { asCompanyId, asToolId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { ChannelKey } from '../../domain/channel/incoming-message';
import type { PermissionService } from '../permissions/permission.service';
import type { KnowledgeFileAssetReader, KnowledgeFileAssetSnapshot } from './knowledge-content-validator';
import { KnowledgeMutationError } from './knowledge-mutation.errors';
import { inspectKnowledgeFile } from './knowledge-file-inspection';
import type { KnowledgeFileThreatScanner } from './knowledge-file-threat-scanner';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/markdown',
  'text/plain',
]);

export interface StagedKnowledgeFile extends KnowledgeFileAssetSnapshot {
  readonly provider: string;
  readonly storageKey: string;
  readonly resourceType: string;
  readonly deliveryType: 'private' | 'authenticated';
  readonly threatScanVersion: string | null;
  /** Opaque owner token for an in-flight object deletion. Never model-controlled. */
  readonly deletionLeaseToken: string | null;
}

export interface ReadableKnowledgeFile extends StagedKnowledgeFile {
  /** Attached files are readable only while they are the resource's live version. */
  readonly isCurrentVersion: boolean;
  readonly resource: null | {
    readonly companyId: string;
    readonly scope: 'personal' | 'department' | 'company';
    readonly ownerUserId: string | null;
    readonly departmentId: string | null;
    readonly status: 'draft' | 'active' | 'archived' | 'deleted';
  };
}

export interface KnowledgeFileAssetRepository extends KnowledgeFileAssetReader {
  create(input: Omit<StagedKnowledgeFile, 'knowledgeResourceId' | 'status'>): Promise<StagedKnowledgeFile>;
  getForAccess(input: { assetId: string; companyId: string }): Promise<ReadableKnowledgeFile | null>;
  isActiveDepartmentMember(input: { companyId: string; departmentId: string; userId: string }): Promise<boolean>;
  claimStagedDeletion(input: { assetId: string; companyId: string; uploadedById: string }): Promise<StagedKnowledgeFile | null>;
  completeStagedDeletion(input: { assetId: string; companyId: string; deletionLeaseToken: string }): Promise<boolean>;
  releaseStagedDeletion(input: { assetId: string; companyId: string; deletionLeaseToken: string }): Promise<boolean>;
  claimExpired(input: {
    limit: number;
    now: Date;
    staleDeletionBefore: Date;
  }): Promise<readonly StagedKnowledgeFile[]>;
  listDeletableForResource(input: { companyId: string; resourceId: string }): Promise<readonly StagedKnowledgeFile[]>;
  claimAttachedDeletion(input: {
    companyId: string;
    assetId: string;
    resourceId: string;
    staleDeletionBefore: Date;
  }): Promise<StagedKnowledgeFile | null>;
  completeAttachedDeletion(input: {
    companyId: string;
    assetId: string;
    resourceId: string | null;
    deletionLeaseToken: string;
  }): Promise<boolean>;
  releaseAttachedDeletion(input: {
    companyId: string;
    assetId: string;
    resourceId: string | null;
    deletionLeaseToken: string;
  }): Promise<boolean>;
  claimRetiredDeletion(input: {
    limit: number;
    staleDeletionBefore: Date;
  }): Promise<readonly StagedKnowledgeFile[]>;
}

export interface KnowledgePrivateObjectStore {
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
  signedDownloadUrl(input: {
    readonly storageKey: string;
    readonly resourceType: string;
    readonly deliveryType: 'private' | 'authenticated';
    readonly expiresInSeconds: number;
  }): string;
  read(input: {
    readonly storageKey: string;
    readonly resourceType: string;
    readonly deliveryType: 'private' | 'authenticated';
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<Buffer>;
  delete(input: {
    readonly storageKey: string;
    readonly resourceType: string;
    readonly deliveryType: 'private' | 'authenticated';
  }): Promise<void>;
}

export interface KnowledgeFileIdentity {
  readonly companyId: string;
  readonly userId: string;
  readonly companyRole: string;
  readonly channel: ChannelKey;
}

/** Private staging and read authorization for governed file knowledge. */
export class KnowledgeFileService {
  private readonly log: Logger;

  constructor(private readonly deps: {
    readonly assets: KnowledgeFileAssetRepository;
    readonly objects: KnowledgePrivateObjectStore;
    readonly permissions: Pick<PermissionService, 'canInvoke'>;
    readonly logger: Logger;
    readonly maxBytes: number;
    readonly stagingTtlMs: number;
    readonly deletionLeaseMs?: number;
    readonly threatScanner?: KnowledgeFileThreatScanner | null;
    readonly threatScanRequired?: boolean;
    readonly threatScanTimeoutMs?: number;
  }) {
    this.log = deps.logger.child({ service: 'knowledge-file' });
  }

  async stage(input: {
    readonly identity: KnowledgeFileIdentity;
    readonly fileName: string;
    readonly mimeType: string;
    readonly buffer: Buffer;
  }): Promise<Pick<StagedKnowledgeFile, 'id' | 'fileName' | 'mimeType' | 'sizeBytes' | 'sha256' | 'expiresAt'>> {
    await this.requirePermission(input.identity, 'create');
    if (!this.deps.objects.isAvailable) {
      throw new KnowledgeMutationError('storage_failure', 'Private governed-file storage is not configured.');
    }
    const fileName = normalizeFileName(input.fileName);
    const mimeType = normalizeMimeType(input.mimeType);
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new KnowledgeMutationError('invalid_request', 'This file type is not allowed in governed knowledge.');
    }
    if (input.buffer.length < 1 || input.buffer.length > this.deps.maxBytes) {
      throw new KnowledgeMutationError(
        'invalid_request',
        `File size must be between 1 byte and ${this.deps.maxBytes} bytes.`,
      );
    }
    inspectKnowledgeFile({ fileName, mimeType, buffer: input.buffer });
    if (this.deps.threatScanRequired && !this.deps.threatScanner) {
      throw new KnowledgeMutationError(
        'storage_failure',
        'Governed-file malware scanning is required but unavailable.',
      );
    }
    let threatScanProvider: string | null = null;
    let threatScanVersion: string | null = null;
    let threatScannedAt: Date | null = null;
    if (this.deps.threatScanner) {
      let verdict;
      try {
        verdict = await this.deps.threatScanner.scan({
          buffer: input.buffer,
          fileName,
          mimeType,
          signal: AbortSignal.timeout(this.deps.threatScanTimeoutMs ?? 30_000),
        });
      } catch (cause) {
        throw new KnowledgeMutationError(
          'storage_failure',
          'Governed-file malware scanning could not produce a verdict.',
          cause,
        );
      }
      if (verdict.status === 'infected') {
        this.log.warn('knowledge_file.threat_rejected', {
          companyId: input.identity.companyId,
          userId: input.identity.userId,
          provider: verdict.provider,
          threat: verdict.threat,
          sha256: createHash('sha256').update(input.buffer).digest('hex'),
        });
        throw new KnowledgeMutationError(
          'invalid_request',
          'The file was rejected by the governed-file security scanner.',
        );
      }
      threatScanProvider = verdict.provider;
      threatScanVersion = verdict.engineVersion ?? null;
      threatScannedAt = new Date();
    }

    const assetId = randomUUID();
    const sha256 = createHash('sha256').update(input.buffer).digest('hex');
    const uploaded = await this.deps.objects.upload({
      buffer: input.buffer,
      companyId: input.identity.companyId,
      assetId,
      fileName,
      mimeType,
    });
    if (uploaded.bytes !== input.buffer.length) {
      await this.deps.objects.delete({
        storageKey: uploaded.storageKey,
        resourceType: uploaded.resourceType,
        deliveryType: uploaded.deliveryType,
      }).catch(() => undefined);
      throw new KnowledgeMutationError('storage_failure', 'Private storage returned a different file size.');
    }

    try {
      const created = await this.deps.assets.create({
        id: assetId,
        companyId: input.identity.companyId,
        uploadedById: input.identity.userId,
        provider: this.deps.objects.provider,
        storageKey: uploaded.storageKey,
        resourceType: uploaded.resourceType,
        deliveryType: uploaded.deliveryType,
        fileName,
        mimeType,
        sizeBytes: input.buffer.length,
        sha256,
        threatScanProvider,
        threatScanVersion,
        threatScannedAt,
        deletionLeaseToken: null,
        expiresAt: new Date(Date.now() + this.deps.stagingTtlMs),
      });
      return {
        id: created.id,
        fileName: created.fileName,
        mimeType: created.mimeType,
        sizeBytes: created.sizeBytes,
        sha256: created.sha256,
        expiresAt: created.expiresAt,
      };
    } catch (cause) {
      await this.deps.objects.delete({
        storageKey: uploaded.storageKey,
        resourceType: uploaded.resourceType,
        deliveryType: uploaded.deliveryType,
      }).catch(() => undefined);
      throw cause;
    }
  }

  async createDownload(input: {
    readonly identity: KnowledgeFileIdentity;
    readonly assetId: string;
  }): Promise<{ readonly url: string; readonly fileName: string; readonly expiresInSeconds: number }> {
    await this.requirePermission(input.identity, 'read');
    const asset = await this.deps.assets.getForAccess({
      assetId: input.assetId,
      companyId: input.identity.companyId,
    });
    if (!asset || asset.status === 'deleted' || asset.status === 'deleting') {
      throw new KnowledgeMutationError('not_found', 'Governed file not found.');
    }
    if (!await this.canRead(asset, input.identity)) {
      throw new KnowledgeMutationError('permission_denied', 'You cannot access this governed file.');
    }
    const expiresInSeconds = 5 * 60;
    return {
      url: this.deps.objects.signedDownloadUrl({
        storageKey: asset.storageKey,
        resourceType: asset.resourceType,
        deliveryType: asset.deliveryType,
        expiresInSeconds,
      }),
      fileName: asset.fileName,
      expiresInSeconds,
    };
  }

  async discardStaged(input: {
    readonly identity: KnowledgeFileIdentity;
    readonly assetId: string;
  }): Promise<boolean> {
    await this.requirePermission(input.identity, 'delete');
    const asset = await this.deps.assets.claimStagedDeletion({
      assetId: input.assetId,
      companyId: input.identity.companyId,
      uploadedById: input.identity.userId,
    });
    if (!asset) return false;
    try {
      await this.deps.objects.delete(asset);
      if (!await this.deps.assets.completeStagedDeletion({
        assetId: asset.id,
        companyId: asset.companyId,
        deletionLeaseToken: requireDeletionLease(asset),
      })) {
        throw new Error('Staged file deletion lease was lost.');
      }
    } catch (cause) {
      await this.deps.assets.releaseStagedDeletion({
        assetId: asset.id,
        companyId: asset.companyId,
        deletionLeaseToken: requireDeletionLease(asset),
      }).catch(() => undefined);
      throw cause;
    }
    return true;
  }

  async cleanupExpired(limit = 100): Promise<number> {
    const now = new Date();
    const assets = await this.deps.assets.claimExpired({
      limit,
      now,
      staleDeletionBefore: new Date(now.getTime() - (this.deps.deletionLeaseMs ?? 5 * 60_000)),
    });
    const results = await Promise.all(assets.map(async asset => {
      try {
        await this.deps.objects.delete(asset);
      } catch (cause) {
        this.log.warn('knowledge_file.cleanup_delete_failed', {
          assetId: asset.id,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        await this.deps.assets.releaseStagedDeletion({
          assetId: asset.id,
          companyId: asset.companyId,
          deletionLeaseToken: requireDeletionLease(asset),
        });
        return false;
      }
      const completed = await this.deps.assets.completeStagedDeletion({
        assetId: asset.id,
        companyId: asset.companyId,
        deletionLeaseToken: requireDeletionLease(asset),
      });
      if (!completed) {
        this.log.warn('knowledge_file.cleanup_completion_lost', { assetId: asset.id });
      }
      return completed;
    }));
    const retired = await this.deps.assets.claimRetiredDeletion({
      limit,
      staleDeletionBefore: new Date(now.getTime() - (this.deps.deletionLeaseMs ?? 5 * 60_000)),
    });
    const retiredResults = await Promise.all(retired.map(async asset => {
      try {
        await this.deps.objects.delete(asset);
        return await this.deps.assets.completeAttachedDeletion({
          companyId: asset.companyId,
          assetId: asset.id,
          resourceId: asset.knowledgeResourceId,
          deletionLeaseToken: requireDeletionLease(asset),
        });
      } catch (cause) {
        this.log.warn('knowledge_file.retired_cleanup_delete_failed', {
          assetId: asset.id,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        await this.deps.assets.releaseAttachedDeletion({
          companyId: asset.companyId,
          assetId: asset.id,
          resourceId: asset.knowledgeResourceId,
          deletionLeaseToken: requireDeletionLease(asset),
        }).catch(() => undefined);
        return false;
      }
    }));
    return results.filter(Boolean).length + retiredResults.filter(Boolean).length;
  }

  /** Projection-only hard deletion after an approved resource delete. */
  async purgeResource(input: { readonly companyId: string; readonly resourceId: string }): Promise<number> {
    const assets = await this.deps.assets.listDeletableForResource(input);
    let deleted = 0;
    for (const asset of assets) {
      const claimed = await this.deps.assets.claimAttachedDeletion({
        companyId: input.companyId,
        assetId: asset.id,
        resourceId: input.resourceId,
        staleDeletionBefore: new Date(Date.now() - (this.deps.deletionLeaseMs ?? 5 * 60_000)),
      });
      if (!claimed) continue;
      try {
        await this.deps.objects.delete(claimed);
      } catch (cause) {
        await this.deps.assets.releaseAttachedDeletion({
          companyId: input.companyId,
          assetId: claimed.id,
          resourceId: input.resourceId,
          deletionLeaseToken: requireDeletionLease(claimed),
        }).catch(() => undefined);
        throw cause;
      }
      if (!await this.deps.assets.completeAttachedDeletion({
        companyId: input.companyId,
        assetId: claimed.id,
        resourceId: input.resourceId,
        deletionLeaseToken: requireDeletionLease(claimed),
      })) {
        throw new Error('Attached file deletion lease was lost.');
      }
      deleted += 1;
    }
    return deleted;
  }

  private async canRead(asset: ReadableKnowledgeFile, identity: KnowledgeFileIdentity): Promise<boolean> {
    if (asset.uploadedById === identity.userId && asset.status === 'staged') {
      return asset.expiresAt.getTime() > Date.now();
    }
    const resource = asset.resource;
    if (
      !resource
      || resource.status !== 'active'
      || asset.status !== 'attached'
      || !asset.isCurrentVersion
    ) return false;
    if (resource.scope === 'personal') return resource.ownerUserId === identity.userId;
    if (resource.scope === 'company') return true;
    return Boolean(resource.departmentId) && this.deps.assets.isActiveDepartmentMember({
      companyId: identity.companyId,
      departmentId: resource.departmentId!,
      userId: identity.userId,
    });
  }

  private async requirePermission(
    identity: KnowledgeFileIdentity,
    action: 'read' | 'create' | 'delete',
  ): Promise<void> {
    const permission = await this.deps.permissions.canInvoke({
      companyId: asCompanyId(identity.companyId),
      userId: asUserId(identity.userId),
      companyRole: asCompanyRoleSlug(identity.companyRole),
      channel: identity.channel,
    }, { toolId: asToolId('knowledge'), action });
    if (!permission.ok) throw permission.error;
  }
}

function requireDeletionLease(asset: StagedKnowledgeFile): string {
  if (!asset.deletionLeaseToken) throw new Error('Knowledge file deletion lease is missing.');
  return asset.deletionLeaseToken;
}

function normalizeFileName(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
  if (!normalized || normalized.length > 500) {
    throw new KnowledgeMutationError('invalid_request', 'File name is invalid.');
  }
  return normalized;
}

function normalizeMimeType(value: string): string {
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!mimeType || mimeType.length > 200) {
    throw new KnowledgeMutationError('invalid_request', 'File MIME type is invalid.');
  }
  return mimeType;
}
