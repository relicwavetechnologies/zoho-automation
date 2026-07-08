/**
 * GoogleDriveClient — Google Drive client backed by @googleapis/drive.
 *
 * The public methods implement GoogleDriveClientPort. The shape is intentionally
 * stable for the gateway while the SDK handles shared drives, export/download,
 * and OAuth token refresh.
 */

import { drive } from '@googleapis/drive';
import { OAuth2Client } from 'google-auth-library';
import type { GoogleDriveClientPort } from '../../application/orchestration/tools/families/google-drive.tool';

const FILE_FIELDS = [
  'id',
  'name',
  'mimeType',
  'size',
  'createdTime',
  'modifiedTime',
  'parents',
  'webViewLink',
  'driveId',
  'shared',
  'trashed',
  'description',
].join(',');

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_SLIDE_MIME = 'application/vnd.google-apps.presentation';
const GOOGLE_DRAWING_MIME = 'application/vnd.google-apps.drawing';
const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';

const DEFAULT_EXPORT_MIME_BY_SOURCE: Record<string, string> = {
  [GOOGLE_DOC_MIME]: 'text/plain',
  [GOOGLE_SHEET_MIME]: 'text/csv',
  [GOOGLE_SLIDE_MIME]: 'text/plain',
  [GOOGLE_DRAWING_MIME]: 'application/pdf',
};

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_TYPES = new Set([
  'application/csv',
  'application/json',
  'application/rtf',
  'application/xml',
  'application/xhtml+xml',
  'application/x-ndjson',
]);

type DriveFileMetadata = {
  readonly fileId?: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly createdAt?: string;
  readonly modifiedAt?: string;
  readonly webUrl?: string;
  readonly parents?: unknown;
  readonly driveId?: string;
  readonly shared?: boolean;
  readonly trashed?: boolean;
  readonly description?: string;
};

function responseDataToBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return Buffer.from(JSON.stringify(data ?? ''), 'utf8');
}

function isTextMime(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return TEXT_MIME_PREFIXES.some(prefix => lower.startsWith(prefix)) || TEXT_MIME_TYPES.has(lower);
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function toOAuth2Client(auth: OAuth2Client | string): OAuth2Client {
  if (typeof auth !== 'string') return auth;
  const client = new OAuth2Client();
  client.setCredentials({ access_token: auth });
  return client;
}

export class GoogleDriveClient implements GoogleDriveClientPort {
  private readonly client;

  constructor(auth: OAuth2Client | string) {
    this.client = drive({ version: 'v3', auth: toOAuth2Client(auth) });
  }

  private normalizeFile(file: Record<string, unknown>): DriveFileMetadata {
    const out: {
      fileId?: string;
      name?: string;
      mimeType?: string;
      sizeBytes?: number;
      createdAt?: string;
      modifiedAt?: string;
      webUrl?: string;
      parents?: unknown;
      driveId?: string;
      shared?: boolean;
      trashed?: boolean;
      description?: string;
    } = {};
    if (typeof file['id'] === 'string') out.fileId = file['id'];
    if (typeof file['name'] === 'string') out.name = file['name'];
    if (typeof file['mimeType'] === 'string') out.mimeType = file['mimeType'];
    if (typeof file['size'] === 'string') out.sizeBytes = Number(file['size']);
    if (typeof file['createdTime'] === 'string') out.createdAt = file['createdTime'];
    if (typeof file['modifiedTime'] === 'string') out.modifiedAt = file['modifiedTime'];
    if (typeof file['webViewLink'] === 'string') out.webUrl = file['webViewLink'];
    if (typeof file['parents'] !== 'undefined') out.parents = file['parents'];
    if (typeof file['driveId'] === 'string') out.driveId = file['driveId'];
    if (typeof file['shared'] === 'boolean') out.shared = file['shared'];
    if (typeof file['trashed'] === 'boolean') out.trashed = file['trashed'];
    if (typeof file['description'] === 'string') out.description = file['description'];
    return out;
  }

  async listFiles(limit = 20): Promise<unknown[]> {
    const res = await this.client.files.list({
      pageSize: Math.min(limit, 100),
      orderBy: 'modifiedTime desc',
      q: 'trashed = false',
      fields: `files(${FILE_FIELDS})`,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    return (res.data.files ?? []).map(file => this.normalizeFile(file as Record<string, unknown>));
  }

  async getFile(fileId: string): Promise<unknown> {
    const res = await this.client.files.get({
      fileId,
      fields: FILE_FIELDS,
      supportsAllDrives: true,
    });
    return this.normalizeFile(res.data as Record<string, unknown>);
  }

  async searchFiles(query: string, limit = 20): Promise<unknown[]> {
    const trimmed = query.trim();
    const q = trimmed
      ? `(name contains '${escapeDriveQuery(trimmed)}' or fullText contains '${escapeDriveQuery(trimmed)}') and trashed = false`
      : 'trashed = false';
    const res = await this.client.files.list({
      q,
      pageSize: Math.min(limit, 100),
      fields: `files(${FILE_FIELDS})`,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    return (res.data.files ?? []).map(file => this.normalizeFile(file as Record<string, unknown>));
  }

  async createFolder(name: string): Promise<{ fileId: string }> {
    const res = await this.client.files.create({
      requestBody: {
        name,
        mimeType: GOOGLE_FOLDER_MIME,
      },
      fields: 'id',
      supportsAllDrives: true,
    });

    const fileId = res.data.id ?? '';
    if (!fileId) throw new Error('Drive createFolder: response missing file id');
    return { fileId };
  }

  async readFile(fileId: string, exportMimeType?: string): Promise<unknown> {
    const file = await this.getFile(fileId) as DriveFileMetadata;
    const sourceMimeType = file.mimeType ?? 'application/octet-stream';
    const isGoogleWorkspaceFile = sourceMimeType.startsWith('application/vnd.google-apps.');
    const effectiveMimeType = exportMimeType
      ?? DEFAULT_EXPORT_MIME_BY_SOURCE[sourceMimeType]
      ?? sourceMimeType;

    if (sourceMimeType === GOOGLE_FOLDER_MIME) {
      throw new Error('Drive readFile: folders cannot be read as file content');
    }

    const bytes = isGoogleWorkspaceFile
      ? await this.exportFile(fileId, effectiveMimeType)
      : await this.downloadFile(fileId);

    const textLike = isTextMime(effectiveMimeType);
    return {
      file,
      mimeType: sourceMimeType,
      contentMimeType: effectiveMimeType,
      exported: isGoogleWorkspaceFile,
      binary: !textLike,
      sizeBytes: bytes.byteLength,
      encoding: textLike ? 'utf8' : 'base64',
      content: textLike ? bytes.toString('utf8') : bytes.toString('base64'),
    };
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const res = await this.client.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    );
    return responseDataToBuffer(res.data);
  }

  async exportFile(fileId: string, mimeType: string): Promise<Buffer> {
    const res = await this.client.files.export(
      { fileId, mimeType },
      { responseType: 'arraybuffer' },
    );
    return responseDataToBuffer(res.data);
  }
}
