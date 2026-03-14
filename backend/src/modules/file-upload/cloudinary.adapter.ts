import { v2 as cloudinary } from 'cloudinary';
import type { UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

import config from '../../config';
import { logger } from '../../utils/logger';

/**
 * Configures and wraps Cloudinary v2 SDK (latest 2026 - v2.9.x)
 * Handles upload of raw files, images, and PDFs to Cloudinary.
 * Uses upload_stream for memory-efficient streaming uploads.
 */

cloudinary.config({
  cloud_name: config.CLOUDINARY_CLOUD_NAME,
  api_key: config.CLOUDINARY_API_KEY,
  api_secret: config.CLOUDINARY_API_SECRET,
  secure: true,
});

export type CloudinaryUploadResult = {
  publicId: string;
  secureUrl: string;
  resourceType: 'image' | 'video' | 'raw' | 'auto';
  format: string;
  bytes: number;
  originalFilename: string;
};

export type CloudinaryResourceType = 'image' | 'raw' | 'auto';

const mimeToResourceType = (mimeType: string): CloudinaryResourceType => {
  if (mimeType.startsWith('image/')) return 'image';
  // PDFs, DOCX, etc. — must be 'raw' on Cloudinary to preserve original binary
  return 'raw';
};

class CloudinaryAdapter {
  /**
   * Upload a Buffer to Cloudinary via streaming (memory efficient).
   * Automatically sets resource_type based on MIME type.
   */
  async uploadBuffer(input: {
    buffer: Buffer;
    mimeType: string;
    fileName: string;
    folder: string;
    companyId: string;
    assetId?: string;
  }): Promise<CloudinaryUploadResult> {
    const resourceType = mimeToResourceType(input.mimeType);
    const publicId = input.assetId?.trim() || input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: resourceType,
          overwrite: false,
          use_filename: true,
          unique_filename: true,
          folder: `${input.folder}/${input.companyId}`,
          // Tag with company for easy cleanup
          tags: [`company:${input.companyId}`, 'file_document'],
        },
        (error, result) => {
          if (error || !result) {
            logger.error('cloudinary.upload.failed', {
              error: error?.message ?? 'no_result',
              fileName: input.fileName,
              companyId: input.companyId,
            });
            reject(error ?? new Error('Cloudinary upload returned no result'));
            return;
          }

          logger.info('cloudinary.upload.success', {
            publicId: result.public_id,
            bytes: result.bytes,
            companyId: input.companyId,
          });

          resolve({
            publicId: result.public_id,
            secureUrl: result.secure_url,
            resourceType: result.resource_type as CloudinaryUploadResult['resourceType'],
            format: result.format ?? '',
            bytes: result.bytes,
            originalFilename: result.original_filename ?? input.fileName,
          });
        },
      );

      const readable = Readable.from(input.buffer);
      readable.pipe(uploadStream);
    });
  }

  /**
   * Delete a Cloudinary asset by publicId — used on FileAsset deletion.
   */
  async deleteAsset(publicId: string, resourceType: CloudinaryResourceType = 'raw'): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
      logger.info('cloudinary.delete.success', { publicId });
    } catch (error) {
      logger.warn('cloudinary.delete.failed', {
        publicId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /**
   * Get a short-lived authenticated URL for a raw Cloudinary asset.
   * Useful for server-side downloading of private files for ingestion.
   */
  getSignedUrl(publicId: string, resourceType: CloudinaryResourceType = 'raw', expiresInSeconds = 300): string {
    return cloudinary.url(publicId, {
      resource_type: resourceType,
      sign_url: true,
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    });
  }
}

export const cloudinaryAdapter = new CloudinaryAdapter();
