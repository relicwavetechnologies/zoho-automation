/**
 * lark-file-ingestion.ts
 *
 * Downloads files/images from Lark's API and ingests them into our standard
 * Cloudinary + Qdrant pipeline via FileUploadService.
 * Returns a NormalizedAttachedFile[] that can be appended to the normalized
 * incoming message DTO before enqueuing the AI task.
 */
import { logger } from '../../../utils/logger';
import type { LarkChannelAdapter } from './lark.adapter';
import type { LarkAttachmentKey } from './lark-message-content';
import type { NormalizedAttachedFile } from '../../contracts';
import { larkRecentFilesStore } from './lark-recent-files.store';
import * as fs from 'fs';

// Lazily required to avoid circular deps at module load time.
const getFileUploadService = (): typeof import('../../../modules/file-upload/file-upload.service')['fileUploadService'] => {
  const mod = require('../../../modules/file-upload/file-upload.service') as typeof import('../../../modules/file-upload/file-upload.service');
  return mod.fileUploadService;
};

/**
 * Guess MIME type from Lark's file_type string, HTTP content-type header, or broad type.
 * Lark sends file_type values like "pdf", "docx", "txt", "xlsx" etc for files.
 * For images, we fall back to image/jpeg if the header is generic octet-stream.
 */
const resolveMimeType = (contentType: string, larkFileType?: string, broadType?: 'image' | 'file'): string => {
  // Prefer content-type from the download headers if it's specific
  if (contentType && contentType !== 'application/octet-stream') {
    // Strip parameters like charset
    return contentType.split(';')[0].trim();
  }

  const map: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    md: 'text/markdown',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };

  if (larkFileType && map[larkFileType.toLowerCase()]) {
    return map[larkFileType.toLowerCase()];
  }

  // Final fallback: if we know it was sent as an 'image' msg_type but headers failed us
  if (broadType === 'image') return 'image/jpeg';

  return 'application/octet-stream';
};

const resolveFileName = (attachmentKey: LarkAttachmentKey): string => {
  if (attachmentKey.fileName) return attachmentKey.fileName;
  const ext = attachmentKey.larkFileType ? `.${attachmentKey.larkFileType}` : '';
  return `lark_attachment_${attachmentKey.key.slice(-8)}${ext}`;
};

export const ingestLarkAttachments = async (input: {
  messageId: string;
  chatId: string;
  attachmentKeys: LarkAttachmentKey[];
  adapter: Pick<LarkChannelAdapter, 'downloadFile'>;
  companyId: string;
  uploaderUserId: string;
}): Promise<NormalizedAttachedFile[]> => {
  if (input.attachmentKeys.length === 0) return [];

  const results: NormalizedAttachedFile[] = [];

  fs.appendFileSync('/tmp/lark-ingest-trace.log', `\n[${new Date().toISOString()}] ENTERING ingestLarkAttachments for messageId: ${input.messageId}, chatId: ${input.chatId}\nKeys: ${JSON.stringify(input.attachmentKeys)}\n`);

  for (const attachment of input.attachmentKeys) {
    fs.appendFileSync('/tmp/lark-ingest-trace.log', `Processing attachment: ${attachment.key}\n`);
    try {
      logger.info('lark.file.ingestion.start', {
        messageId: input.messageId,
        fileKey: attachment.key,
        fileType: attachment.fileType,
        larkFileType: attachment.larkFileType,
      });

      // 1. Download bytes from Lark
      const downloaded = await input.adapter.downloadFile({
        messageId: input.messageId,
        fileKey: attachment.key,
        fileType: attachment.fileType,
      });

      if (!downloaded) {
        fs.appendFileSync('/tmp/lark-ingest-trace.log', `FAILED: downloadFile returned null for ${attachment.key}\n`);
        logger.warn('lark.file.ingestion.download_failed', {
          messageId: input.messageId,
          fileKey: attachment.key,
        });
        continue;
      }
      fs.appendFileSync('/tmp/lark-ingest-trace.log', `SUCCESS: downloaded ${downloaded.buffer.length} bytes for ${attachment.key}\n`);

      const mimeType = resolveMimeType(downloaded.contentType, attachment.larkFileType, attachment.fileType);
      const fileName = resolveFileName(attachment);

      // 2. Upload via standard FileUploadService (Cloudinary + Qdrant)
      const fileUploadService = getFileUploadService();
      const result = await fileUploadService.upload({
        buffer: downloaded.buffer,
        mimeType,
        fileName,
        sizeBytes: downloaded.buffer.length,
        companyId: input.companyId,
        uploaderUserId: input.uploaderUserId,
        uploaderChannel: 'lark',
        allowedRoles: ['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN'],
      });

      fs.appendFileSync('/tmp/lark-ingest-trace.log', `SUCCESS: fileUploadService uploaded to ${result.cloudinaryUrl}\n`);

      results.push({
        fileAssetId: result.fileAssetId,
        cloudinaryUrl: result.cloudinaryUrl,
        mimeType,
        fileName,
      });

      logger.info('lark.file.ingestion.success', {
        messageId: input.messageId,
        fileKey: attachment.key,
        fileAssetId: result.fileAssetId,
        cloudinaryUrl: result.cloudinaryUrl,
        mimeType,
      });
    } catch (error) {
      fs.appendFileSync('/tmp/lark-ingest-trace.log', `CATCH: error processing ${attachment.key}: ${error instanceof Error ? error.stack : error}\n`);
      logger.warn('lark.file.ingestion.error', {
        messageId: input.messageId,
        fileKey: attachment.key,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    }
  }

  // Save to per-chat recent files store so follow-up text messages can reference these files
  if (results.length > 0) {
    larkRecentFilesStore.add(input.chatId, results);
  }

  fs.appendFileSync('/tmp/lark-ingest-trace.log', `EXITING: returning ${results.length} normalized files\n`);
  return results;
};
