import { google } from 'googleapis';
import type {
  GoogleDriveFileMetadata,
  GoogleSheetResourceProbe,
  GoogleSheetsMetadata,
} from '../../application/data-export/google-sheet-resource-resolver';

export type ResolveGoogleSheetAccessToken = (connectionId: string) => Promise<string>;

/** One instance is used for one resource-resolution request. */
export class GoogleSheetResourceProbeClient implements GoogleSheetResourceProbe {
  private readonly accessTokens = new Map<string, Promise<string>>();

  constructor(private readonly resolveAccessToken: ResolveGoogleSheetAccessToken) {}

  async getDriveFile(input: {
    readonly connectionId: string;
    readonly fileId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<GoogleDriveFileMetadata | null> {
    const drive = google.drive({ version: 'v3', auth: await this.auth(input.connectionId) });
    try {
      const response = await drive.files.get({
        fileId: input.fileId,
        supportsAllDrives: true,
        fields: 'id,name,mimeType,trashed,capabilities(canEdit,canCopy,canDownload)',
      }, input.abortSignal ? { signal: input.abortSignal } : undefined);
      return {
        ...(response.data.id ? { id: response.data.id } : {}),
        ...(response.data.name ? { name: response.data.name } : {}),
        ...(response.data.mimeType ? { mimeType: response.data.mimeType } : {}),
        ...(typeof response.data.trashed === 'boolean' ? { trashed: response.data.trashed } : {}),
        ...(response.data.capabilities
          ? {
              capabilities: {
                canEdit: response.data.capabilities.canEdit === true,
                canCopy: response.data.capabilities.canCopy === true,
                canDownload: response.data.capabilities.canDownload === true,
              },
            }
          : {}),
      };
    } catch (error) {
      if (isInaccessible(error)) return null;
      throw error;
    }
  }

  async getSpreadsheet(input: {
    readonly connectionId: string;
    readonly spreadsheetId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<GoogleSheetsMetadata | null> {
    const sheets = google.sheets({ version: 'v4', auth: await this.auth(input.connectionId) });
    try {
      const response = await sheets.spreadsheets.get({
        spreadsheetId: input.spreadsheetId,
        fields: 'spreadsheetId',
      }, input.abortSignal ? { signal: input.abortSignal } : undefined);
      return response.data.spreadsheetId ? { spreadsheetId: response.data.spreadsheetId } : {};
    } catch (error) {
      if (isInaccessible(error)) return null;
      throw error;
    }
  }

  private auth(connectionId: string) {
    let token = this.accessTokens.get(connectionId);
    if (!token) {
      token = this.resolveAccessToken(connectionId).catch(error => {
        this.accessTokens.delete(connectionId);
        throw error;
      });
      this.accessTokens.set(connectionId, token);
    }
    return token.then(accessToken => {
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: accessToken });
      return auth;
    });
  }
}

function isInaccessible(error: unknown): boolean {
  const status = error && typeof error === 'object'
    ? (error as { response?: { status?: unknown } }).response?.status
    : undefined;
  return status === 403 || status === 404;
}
