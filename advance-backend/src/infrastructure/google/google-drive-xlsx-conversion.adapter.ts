import { Readable } from 'node:stream';
import { google } from 'googleapis';
import type { GoogleDriveXlsxConversionWorkerDeps } from '../../application/artifacts/google-drive-xlsx-conversion.worker';

const GOOGLE_SHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CONVERSION_JOB_KEY_PROPERTY = 'divoXlsxConversionJobKey';

type GoogleDriveXlsxConversionDrive = GoogleDriveXlsxConversionWorkerDeps['drive'];

export type ResolveGoogleDriveXlsxConversionAccessToken = (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId: string;
}) => Promise<string>;

/**
 * Google Drive adapter for the XLSX conversion worker. It only reads the
 * source and creates a separately tagged native Google Sheet.
 */
export class GoogleDriveXlsxConversionAdapter implements GoogleDriveXlsxConversionDrive {
  constructor(private readonly resolveAccessToken: ResolveGoogleDriveXlsxConversionAccessToken) {}

  async getSourceMetadata(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly sourceConnectionId: string;
    readonly sourceFileId: string;
  }) {
    const drive = await this.drive(input.companyId, input.userId, input.sourceConnectionId);
    const response = await drive.files.get({
      fileId: input.sourceFileId,
      supportsAllDrives: true,
      fields: 'id,mimeType,trashed,capabilities(canDownload,canCopy)',
    });
    return {
      ...(response.data.id ? { id: response.data.id } : {}),
      ...(response.data.mimeType ? { mimeType: response.data.mimeType } : {}),
      ...(typeof response.data.trashed === 'boolean' ? { trashed: response.data.trashed } : {}),
      ...(response.data.capabilities
        ? {
            capabilities: {
              ...(typeof response.data.capabilities.canDownload === 'boolean'
                ? { canDownload: response.data.capabilities.canDownload }
                : {}),
              ...(typeof response.data.capabilities.canCopy === 'boolean'
                ? { canCopy: response.data.capabilities.canCopy }
                : {}),
            },
          }
        : {}),
    };
  }

  async downloadXlsx(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly sourceConnectionId: string;
    readonly sourceFileId: string;
  }): Promise<AsyncIterable<Uint8Array>> {
    const drive = await this.drive(input.companyId, input.userId, input.sourceConnectionId);
    const response = await drive.files.get({
      fileId: input.sourceFileId,
      alt: 'media',
      supportsAllDrives: true,
    }, { responseType: 'stream' });
    if (!isAsyncIterable(response.data)) throw new Error('Google Drive did not return a readable Excel stream');
    return streamBytes(response.data);
  }

  async findCreatedSheet(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly spreadsheetId: string } | null> {
    const drive = await this.drive(input.companyId, input.userId, input.connectionId);
    const response = await drive.files.list({
      q: `appProperties has { key='${CONVERSION_JOB_KEY_PROPERTY}' and value='${escapeDriveQueryValue(input.idempotencyKey)}' } and trashed = false`,
      pageSize: 2,
      fields: 'files(id,mimeType,trashed,appProperties)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const matches = (response.data.files ?? []).filter(file =>
      file.id
      && file.mimeType === GOOGLE_SHEET_MIME_TYPE
      && file.trashed !== true
      && file.appProperties?.[CONVERSION_JOB_KEY_PROPERTY] === input.idempotencyKey,
    );
    if (matches.length > 1) {
      throw new Error('Google Drive returned multiple converted Sheets for one conversion job');
    }
    const found = matches[0];
    return found?.id ? { spreadsheetId: found.id } : null;
  }

  async importXlsxAsNewSheet(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly sourceFileId: string;
    readonly sourceTitle: string;
    readonly idempotencyKey: string;
    readonly content: AsyncIterable<Uint8Array>;
  }): Promise<{ readonly spreadsheetId: string }> {
    const drive = await this.drive(input.companyId, input.userId, input.connectionId);
    const response = await drive.files.create({
      ignoreDefaultVisibility: true,
      supportsAllDrives: true,
      requestBody: {
        name: sheetTitle(input.sourceTitle),
        mimeType: GOOGLE_SHEET_MIME_TYPE,
        appProperties: { [CONVERSION_JOB_KEY_PROPERTY]: input.idempotencyKey },
      },
      media: {
        mimeType: XLSX_MIME_TYPE,
        body: Readable.from(input.content),
      },
      fields: 'id',
    });
    if (!response.data.id) throw new Error('Google Drive did not return the converted Sheet ID');
    return { spreadsheetId: response.data.id };
  }

  async getCreatedSheetMetadata(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly spreadsheetId: string;
  }) {
    const drive = await this.drive(input.companyId, input.userId, input.connectionId);
    const response = await drive.files.get({
      fileId: input.spreadsheetId,
      supportsAllDrives: true,
      fields: 'id,mimeType,trashed,owners(emailAddress),webViewLink',
    });
    const ownerEmail = response.data.owners?.[0]?.emailAddress;
    return {
      ...(response.data.id ? { id: response.data.id } : {}),
      ...(response.data.mimeType ? { mimeType: response.data.mimeType } : {}),
      ...(typeof response.data.trashed === 'boolean' ? { trashed: response.data.trashed } : {}),
      ...(ownerEmail ? { ownerEmail } : {}),
      ...(response.data.webViewLink ? { webViewLink: response.data.webViewLink } : {}),
    };
  }

  private async drive(companyId: string, userId: string, connectionId: string) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: await this.resolveAccessToken({ companyId, userId, connectionId }) });
    return google.drive({ version: 'v3', auth });
  }
}

async function* streamBytes(source: AsyncIterable<unknown>): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Google Drive returned invalid Excel stream content');
    yield chunk;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object'
    && value !== null
    && Symbol.asyncIterator in value;
}

function escapeDriveQueryValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function sheetTitle(sourceTitle: string): string {
  const title = sourceTitle.trim().replace(/\.xlsx$/iu, '');
  return title || 'Converted Excel workbook';
}
