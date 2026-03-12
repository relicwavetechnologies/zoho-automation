import { logger } from '../../../utils/logger';
import { channelIdentityRepository } from '../../channels/channel-identity.repository';
import { fileUploadService } from '../../../modules/file-upload/file-upload.service';

/**
 * Lark File Ingestion Service
 *
 * Downloads a file or image from Lark (using the Lark Message Download API)
 * and pipes it through the FileUploadService for Cloudinary upload + vector ingestion.
 *
 * Called from the Lark webhook when a file/image msg_type is detected.
 */

const LARK_FILE_DOWNLOAD_TIMEOUT_MS = 30000;

type LarkFileIngestInput = {
  larkTenantKey: string;
  companyId: string;
  messageId: string;
  fileKey: string;
  fileName?: string;
  mimeType: string;
  uploaderLarkUserId: string;
  chatId: string;
  /** AI role of the uploader — used to set default allowedRoles */
  uploaderAiRole?: string;
};

type LarkFileIngestResult = {
  fileAssetId: string;
  fileName: string;
  ingestionStatus: string;
};

export class LarkFileIngestionService {
  /**
   * Downloads a file from Lark using tenant access token, then forwards to file-upload service.
   */
  async ingestLarkFile(
    input: LarkFileIngestInput,
    tenantAccessToken: string,
    apiBaseUrl: string,
  ): Promise<LarkFileIngestResult> {
    const fileName = input.fileName || `lark_file_${input.fileKey.slice(0, 12)}`;

    logger.info('lark.file.ingestion.start', {
      companyId: input.companyId,
      messageId: input.messageId,
      fileKey: input.fileKey,
      mimeType: input.mimeType,
    });

    // Download from Lark API
    const downloadUrl = `${apiBaseUrl}/open-apis/im/v1/messages/${input.messageId}/resources/${input.fileKey}?type=file`;
    const downloadResp = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
      },
      signal: AbortSignal.timeout(LARK_FILE_DOWNLOAD_TIMEOUT_MS),
    });

    if (!downloadResp.ok) {
      throw new Error(`Lark file download failed: HTTP ${downloadResp.status}`);
    }

    const contentType = downloadResp.headers.get('content-type') || input.mimeType;
    const arrayBuffer = await downloadResp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Resolve the uploader's internal userId from their Lark userId
    // ChannelIdentity stores the mapping
    const identities = await channelIdentityRepository.findByLarkUserInfo({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      externalUserId: input.uploaderLarkUserId,
    });

    // Use the aiRole of the uploader to set default access policy
    const uploaderAiRole = identities?.aiRole ?? input.uploaderAiRole ?? 'MEMBER';
    // Default: accessible to the uploader's role and ADMIN
    const allowedRoles = uploaderAiRole === 'ADMIN' ? ['ADMIN'] : [uploaderAiRole, 'ADMIN'];

    const result = await fileUploadService.upload({
      buffer,
      mimeType: contentType.split(';')[0].trim(),
      fileName,
      sizeBytes: buffer.length,
      companyId: input.companyId,
      uploaderUserId: identities?.externalUserId ?? input.uploaderLarkUserId,
      uploaderChannel: 'lark',
      allowedRoles,
    });

    logger.info('lark.file.ingestion.complete', {
      fileAssetId: result.fileAssetId,
      companyId: input.companyId,
      allowedRoles,
    });

    return result;
  }
}

export const larkFileIngestionService = new LarkFileIngestionService();
