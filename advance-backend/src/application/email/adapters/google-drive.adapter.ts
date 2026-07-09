import type { GoogleDriveClientPort } from '../../orchestration/tools/families/google-drive.tool';
import { DRIVE_READ_SCOPES } from '../../google/google-scope-policy';
import type {
  AttachmentRef,
  AttachmentResolveContext,
  AttachmentSourceAdapter,
  ResolvedAttachment,
} from '../attachment.types';

export interface GoogleDriveAttachmentClient extends GoogleDriveClientPort {
  downloadFile(fileId: string): Promise<Buffer>;
  exportFile(fileId: string, mimeType: string): Promise<Buffer>;
}

type DriveMetadata = {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
};

const WORKSPACE_PREFIX = 'application/vnd.google-apps.';

const DEFAULT_EXPORTS: Record<string, { readonly mimeType: string; readonly extension: string }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/pdf',
    extension: '.pdf',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/pdf',
    extension: '.pdf',
  },
  'application/vnd.google-apps.drawing': {
    mimeType: 'application/pdf',
    extension: '.pdf',
  },
};

export class GoogleDriveAttachmentAdapter implements AttachmentSourceAdapter {
  readonly source = 'google_drive' as const;

  constructor(
    private readonly getClient: (input: {
      readonly companyId: string;
      readonly userId: string;
      readonly connectionId: string;
      readonly minimumAccess: 'read_only';
      readonly requiredScopes: readonly string[];
    }) => Promise<GoogleDriveAttachmentClient | null>,
  ) {}

  async resolve(ref: AttachmentRef, ctx: AttachmentResolveContext): Promise<ResolvedAttachment> {
    if (ref.source !== 'google_drive') {
      throw new Error('GoogleDriveAttachmentAdapter received an incompatible attachment ref');
    }

    const client = await this.getClient({
      companyId: ctx.companyId,
      userId: ctx.userId,
      connectionId: ref.connectionId,
      minimumAccess: 'read_only',
      requiredScopes: DRIVE_READ_SCOPES,
    });
    if (!client) throw new Error('Google Drive connection is unavailable for this user');

    const metadata = normalizeDriveMetadata(await client.getFile(ref.fileId));
    const exportInfo = defaultExportFor(metadata.mimeType, ref.exportMimeType);
    const content = exportInfo
      ? await client.exportFile(ref.fileId, exportInfo.mimeType)
      : await client.downloadFile(ref.fileId);

    return {
      fileName: exportInfo ? withExtension(metadata.name, exportInfo.extension) : metadata.name,
      mimeType: exportInfo?.mimeType ?? metadata.mimeType,
      sizeBytes: content.length || metadata.sizeBytes || 0,
      content,
      source: this.source,
    };
  }
}

function normalizeDriveMetadata(raw: unknown): DriveMetadata {
  const rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const name = typeof rec['name'] === 'string' && rec['name'].trim() ? rec['name'].trim() : 'drive-file';
  const mimeType = typeof rec['mimeType'] === 'string' && rec['mimeType'].trim()
    ? rec['mimeType'].trim()
    : 'application/octet-stream';
  const sizeBytes = typeof rec['sizeBytes'] === 'number' && Number.isFinite(rec['sizeBytes'])
    ? rec['sizeBytes']
    : undefined;
  return {
    name,
    mimeType,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

function defaultExportFor(
  mimeType: string,
  requestedMimeType?: string,
): { readonly mimeType: string; readonly extension: string } | null {
  if (!mimeType.startsWith(WORKSPACE_PREFIX)) return null;
  if (requestedMimeType) {
    return { mimeType: requestedMimeType, extension: extensionForMimeType(requestedMimeType) };
  }
  return DEFAULT_EXPORTS[mimeType] ?? { mimeType: 'application/pdf', extension: '.pdf' };
}

function withExtension(fileName: string, extension: string): string {
  if (!extension || fileName.toLowerCase().endsWith(extension.toLowerCase())) return fileName;
  return `${fileName}${extension}`;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'application/pdf':
      return '.pdf';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return '.docx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return '.xlsx';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return '.pptx';
    case 'text/csv':
      return '.csv';
    case 'text/plain':
      return '.txt';
    default:
      return '';
  }
}
