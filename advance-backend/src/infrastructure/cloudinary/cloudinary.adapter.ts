/**
 * CloudinaryAdapter — streaming uploads, signed-URL generation, asset deletion.
 *
 * Ported from old backend: modules/file-upload/cloudinary.adapter.ts
 * Extended with:
 *   - uploadCsvBuffer() — upload a CSV buffer as a raw/temp export asset
 *   - getSignedDownloadUrl() — 24-hour expiry by default (for exported CSVs)
 *   - scheduleDelete() — stores publicId in Redis with TTL for deferred cleanup
 *
 * All methods are no-ops when Cloudinary credentials are not configured,
 * so the service degrades gracefully in local dev without Cloudinary keys.
 */

import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../../shared/logger';
import type { CachePort } from '../../shared/cache';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CloudinaryResourceType = 'image' | 'video' | 'raw' | 'auto';
export type CloudinaryDeliveryType = 'upload' | 'private' | 'authenticated';

export interface CloudinaryUploadResult {
  readonly publicId:         string;
  readonly secureUrl:        string;
  readonly resourceType:     CloudinaryResourceType;
  readonly format:           string;
  readonly bytes:            number;
  readonly originalFilename: string;
}

export interface TempExportLink {
  readonly publicId:   string;
  readonly signedUrl:  string;
  readonly expiresAt:  string;  // ISO-8601
}

export interface CloudinaryCleanupResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly failed:  number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mimeToResourceType(mimeType: string): CloudinaryResourceType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'raw';  // CSVs, PDFs, DOCX → raw preserves original binary
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class CloudinaryAdapter {
  private readonly configured: boolean;

  constructor(
    private readonly config: {
      cloudName:  string;
      apiKey:     string;
      apiSecret:  string;
    } | null,
    private readonly cache:  CachePort,
    private readonly logger: Logger,
  ) {
    this.configured = config !== null;
    if (config) {
      cloudinary.config({
        cloud_name: config.cloudName,
        api_key:    config.apiKey,
        api_secret: config.apiSecret,
        secure:     true,
      });
    }
  }

  get isAvailable(): boolean { return this.configured; }

  // ─── General upload ─────────────────────────────────────────────────────────

  async uploadBuffer(input: {
    buffer:    Buffer;
    mimeType:  string;
    fileName:  string;
    folder:    string;
    companyId: string;
    assetId?:  string;
    tags?:     string[];
    deliveryType?: CloudinaryDeliveryType;
  }): Promise<CloudinaryUploadResult> {
    this.assertConfigured();
    const resourceType = mimeToResourceType(input.mimeType);
    const publicId     = (input.assetId?.trim() || input.fileName).replace(/[^a-zA-Z0-9._-]/g, '_');

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id:       publicId,
          resource_type:   resourceType,
          overwrite:       false,
          use_filename:    true,
          unique_filename: true,
          folder:          `${input.folder}/${input.companyId}`,
          tags:            [`company:${input.companyId}`, ...(input.tags ?? [])],
          type:            input.deliveryType ?? 'upload',
        },
        (err, result) => {
          if (err || !result) {
            this.logger.error('cloudinary.upload.failed', {
              error:     err?.message ?? 'no_result',
              fileName:  input.fileName,
              companyId: input.companyId,
            });
            reject(err ?? new Error('Cloudinary upload returned no result'));
            return;
          }
          this.logger.info('cloudinary.upload.success', {
            publicId:  result.public_id,
            bytes:     result.bytes,
            companyId: input.companyId,
          });
          resolve({
            publicId:         result.public_id,
            secureUrl:        result.secure_url,
            resourceType:     result.resource_type as CloudinaryResourceType,
            format:           result.format ?? '',
            bytes:            result.bytes,
            originalFilename: result.original_filename ?? input.fileName,
          });
        },
      );

      Readable.from(input.buffer).pipe(stream);
    });
  }

  // ─── CSV temp export ────────────────────────────────────────────────────────

  /**
   * Upload a CSV buffer to the temp-exports folder, generate a signed URL
   * that expires in `ttlSeconds` (default 24 h), and register the publicId
   * in Redis for deferred deletion.
   *
   * Returns null when Cloudinary is not configured — callers must handle this
   * gracefully (e.g. return inline data instead).
   */
  async uploadCsvBuffer(input: {
    buffer:     Buffer;
    fileName:   string;   // e.g. 'overdue_invoices_2026-04-24.csv'
    companyId:  string;
    ttlSeconds?: number;  // default 86400 (24 h)
  }): Promise<TempExportLink | null> {
    if (!this.configured) return null;

    const ttl      = input.ttlSeconds ?? 86_400;
    const expireAt = Math.floor(Date.now() / 1000) + ttl;
    const fileName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');

    let uploaded: CloudinaryUploadResult;
    try {
      const uniqueAssetId = fileName.replace(/\.csv$/i, '') + `-${randomUUID()}.csv`;
      uploaded = await this.uploadBuffer({
        buffer:    input.buffer,
        mimeType:  'text/csv',
        fileName,
        folder:    'temp_exports',
        companyId: input.companyId,
        assetId:   uniqueAssetId,
        tags:      ['temp_export'],
        deliveryType: 'authenticated',
      });
    } catch (e) {
      this.logger.error('cloudinary.csv_upload.failed', {
        companyId: input.companyId,
        fileName:  input.fileName,
        error:     String(e),
      });
      return null;
    }

    // Authenticated delivery makes the asset itself private; this API URL is
    // signed and checked on every download rather than exposing a public CDN
    // URL with a signature-looking path.
    const signedUrl = cloudinary.utils.private_download_url(uploaded.publicId, 'csv', {
      resource_type: 'raw',
      type:          'authenticated',
      expires_at:    expireAt,
      attachment:    true,
    });

    // Register in Redis for background cleanup (TTL = same as link TTL + 1 min buffer)
    const redisKey = `cloudinary:temp_export:${uploaded.publicId.replace(/\//g, ':')}`;
    await this.cache.set(redisKey, uploaded.publicId, ttl + 60).catch(() => {
      // Non-fatal — worst case we orphan one asset
      this.logger.warn('cloudinary.cleanup_register.failed', { publicId: uploaded.publicId });
    });

    const expiresAt = new Date((expireAt) * 1000).toISOString();

    this.logger.info('cloudinary.csv_export.created', {
      publicId:  uploaded.publicId,
      bytes:     uploaded.bytes,
      companyId: input.companyId,
      expiresAt,
    });

    return { publicId: uploaded.publicId, signedUrl, expiresAt };
  }

  // ─── Deletion ───────────────────────────────────────────────────────────────

  async deleteAsset(
    publicId: string,
    resourceType: CloudinaryResourceType = 'raw',
    deliveryType: CloudinaryDeliveryType = 'upload',
  ): Promise<void> {
    if (!this.configured) return;
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
        type: deliveryType,
      });
      this.logger.info('cloudinary.delete.success', { publicId });
    } catch (err) {
      this.logger.warn('cloudinary.delete.failed', {
        publicId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async deleteAssetStrict(
    publicId: string,
    resourceType: CloudinaryResourceType = 'raw',
    deliveryType: CloudinaryDeliveryType = 'upload',
  ): Promise<void> {
    this.assertConfigured();
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      type: deliveryType,
    }) as { result?: string };
    if (result.result !== 'ok' && result.result !== 'not found') {
      throw new Error(`Cloudinary deletion returned ${result.result ?? 'an unknown result'}.`);
    }
    this.logger.info('cloudinary.delete.success', { publicId });
  }

  /**
   * Delete expired temp exports from Cloudinary itself. Redis TTL only removes
   * tracking keys; it does not remove the uploaded raw assets.
   */
  async cleanupExpiredExports(input: {
    ttlSeconds?: number;
    now?: Date;
    maxPages?: number;
  } = {}): Promise<CloudinaryCleanupResult> {
    if (!this.configured) return { scanned: 0, deleted: 0, failed: 0 };

    const ttlSeconds = input.ttlSeconds ?? 86_400;
    const nowMs = (input.now ?? new Date()).getTime();
    const maxPages = input.maxPages ?? 20;
    let scanned = 0;
    let deleted = 0;
    let failed = 0;

    // Include legacy public exports until they have aged out, while all new
    // exports use authenticated delivery.
    for (const deliveryType of ['authenticated', 'upload'] as const) {
      let nextCursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const response = await cloudinary.api.resources_by_tag('temp_export', {
          resource_type: 'raw',
          type: deliveryType,
          max_results:  500,
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
        }) as {
          resources?: Array<{ public_id?: string; created_at?: string }>;
          next_cursor?: string;
        };

        const resources = Array.isArray(response.resources) ? response.resources : [];
        scanned += resources.length;
        const expiredIds = resources
          .filter((resource) => {
            if (!resource.public_id || !resource.created_at) return false;
            const createdAtMs = new Date(resource.created_at).getTime();
            return Number.isFinite(createdAtMs) && createdAtMs + ttlSeconds * 1000 <= nowMs;
          })
          .map(resource => resource.public_id as string);

        if (expiredIds.length > 0) {
          try {
            const result = await cloudinary.api.delete_resources(expiredIds, {
              resource_type: 'raw',
              type: deliveryType,
            }) as {
              deleted?: Record<string, string>;
            };
            const deletedMap = result.deleted ?? {};
            const deletedCount = Object.values(deletedMap).filter(status => status === 'deleted' || status === 'not_found').length;
            deleted += deletedCount;
            failed += expiredIds.length - deletedCount;
          } catch (error) {
            failed += expiredIds.length;
            this.logger.warn('cloudinary.cleanup.delete_failed', {
              count: expiredIds.length,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        nextCursor = response.next_cursor;
        if (!nextCursor) break;
      }
    }

    this.logger.info('cloudinary.cleanup.temp_exports.done', { scanned, deleted, failed });
    return { scanned, deleted, failed };
  }

  // ─── Signed URL ─────────────────────────────────────────────────────────────

  getSignedDownloadUrl(
    publicId:         string,
    resourceType:     CloudinaryResourceType = 'raw',
    expiresInSeconds = 300,
  ): string {
    this.assertConfigured();
    return cloudinary.url(publicId, {
      resource_type: resourceType,
      sign_url:      true,
      type:          'upload',
      expires_at:    Math.floor(Date.now() / 1000) + expiresInSeconds,
    });
  }

  getSignedAssetUrl(input: {
    publicId: string;
    resourceType: CloudinaryResourceType;
    deliveryType: Extract<CloudinaryDeliveryType, 'private' | 'authenticated'>;
    expiresInSeconds: number;
    attachment?: boolean;
  }): string {
    this.assertConfigured();
    return cloudinary.url(input.publicId, {
      resource_type: input.resourceType,
      sign_url: true,
      secure: true,
      type: input.deliveryType,
      expires_at: Math.floor(Date.now() / 1000) + input.expiresInSeconds,
      ...(input.attachment === false ? {} : { flags: 'attachment' }),
    });
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private assertConfigured(): void {
    if (!this.configured) {
      throw new Error('CloudinaryAdapter: credentials not configured (CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET missing)');
    }
  }
}
