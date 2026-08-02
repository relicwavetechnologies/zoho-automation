import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { google } from 'googleapis';
import type { DataExportCompletion } from './data-export.types';
import type {
  DataExportDestinationSink,
  DataExportDestinationWriteInput,
  DataExportDestinationWriteProgress,
  GoogleExportAuth,
} from './data-export.destination';

const SHEET_ROW_LIMIT = 50_000;
const SHEET_CELL_LIMIT = 2_000_000;
const SHEET_APPEND_ROWS = 500;
const MAX_EXPORT_ROWS = 1_000_000;
const MAX_SPOOL_BYTES = 1_024 * 1024 * 1_024;
const EXPORT_KEY_PROPERTY = 'divoExportKey';
const EXPORT_STATE_PROPERTY = 'divoExportState';
const EXPORT_ROW_COUNT_PROPERTY = 'divoExportRowCount';
const EXPORT_TRUNCATED_PROPERTY = 'divoExportTruncated';
const EXPORT_TYPE_PROPERTY = 'divoExportType';

export class GoogleWorkspaceExportSink implements DataExportDestinationSink {
  async write(input: DataExportDestinationWriteInput): Promise<DataExportCompletion> {
    const drive = google.drive({ version: 'v3', auth: oauth(input.auth.accessToken) });
    const recovered = await recoverCompletedExport(
      drive,
      input.exportKey,
      input.readerEmail,
      input.signal,
    );
    if (recovered) return recovered;

    const tempDirectory = await mkdtemp(join(tmpdir(), 'divo-export-'));
    const rowsPath = join(tempDirectory, 'rows.ndjson');
    const csvPath = join(tempDirectory, 'export.csv');
    const rowStream = createWriteStream(rowsPath, { encoding: 'utf8' });
    const configuredColumns = input.destination.columns
      ? [...input.destination.columns]
      : undefined;
    const discoveredColumns = new Set<string>(configuredColumns ?? []);
    let rowCount = 0;
    let spooledBytes = 0;

    try {
      for await (const page of input.rows) {
        input.signal?.throwIfAborted();
        for (const row of page) {
          if (!configuredColumns) {
            for (const column of Object.keys(row)) discoveredColumns.add(column);
          }
          const line = JSON.stringify(row);
          const lineBytes = Buffer.byteLength(line, 'utf8') + 2;
          if (rowCount >= MAX_EXPORT_ROWS || spooledBytes + lineBytes > MAX_SPOOL_BYTES) {
            throw new Error('Data export exceeds the 1,000,000-row or 1 GB safety ceiling');
          }
          await writeLine(rowStream, line);
          spooledBytes += lineBytes;
          rowCount += 1;
        }
      }
      rowStream.end();
      await once(rowStream, 'close');

      const columns = [...discoveredColumns];
      const sheetEligible = input.destination.format !== 'csv'
        && rowCount <= SHEET_ROW_LIMIT
        && rowCount * Math.max(1, columns.length) <= SHEET_CELL_LIMIT;
      const format = input.destination.format === 'google_sheet'
        ? 'google_sheet'
        : input.destination.format === 'csv' || !sheetEligible
          ? 'csv'
          : 'google_sheet';
      if (format === 'google_sheet' && !sheetEligible) {
        throw new Error('Dataset is too large for the requested Google Sheet; use format=auto or csv');
      }
      return format === 'google_sheet'
        ? await this.createSheet({
            auth: input.auth,
            readerEmail: input.readerEmail,
            exportKey: input.exportKey,
            title: input.destination.title,
            columns,
            rowsPath,
            rowCount,
            sourceTruncated: input.sourceTruncated(),
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          })
        : await this.createAndUploadCsv({
            auth: input.auth,
            readerEmail: input.readerEmail,
            exportKey: input.exportKey,
            title: input.destination.title,
            rowsPath,
            csvPath,
            columns,
            rowCount,
            sourceTruncated: input.sourceTruncated(),
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          });
    } finally {
      if (!rowStream.closed) rowStream.destroy();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private async createSheet(input: {
    readonly auth: GoogleExportAuth;
    readonly readerEmail: string;
    readonly exportKey: string;
    readonly title: string;
    readonly columns: readonly string[];
    readonly rowsPath: string;
    readonly rowCount: number;
    readonly sourceTruncated: boolean;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: DataExportDestinationWriteProgress) => Promise<void>;
  }): Promise<DataExportCompletion> {
    const auth = oauth(input.auth.accessToken);
    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    let spreadsheetId: string | undefined;
    try {
      const created = await drive.files.create({
        ignoreDefaultVisibility: true,
        requestBody: {
          name: safeTitle(input.title),
          mimeType: 'application/vnd.google-apps.spreadsheet',
          appProperties: writingProperties(input.exportKey),
        },
        fields: 'id',
      }, requestOptions(input.signal));
      spreadsheetId = created.data.id ?? undefined;
      if (!spreadsheetId) throw new Error('Google Sheets did not return a spreadsheet ID');

      let values: unknown[][] = [[...input.columns]];
      let writtenRows = 0;
      for await (const row of readRows(input.rowsPath)) {
        input.signal?.throwIfAborted();
        values.push(input.columns.map((column) => normalizeCell(row[column])));
        if (values.length < SHEET_APPEND_ROWS) continue;
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: 'Sheet1!A1',
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values },
        }, requestOptions(input.signal));
        writtenRows += values.length - (writtenRows === 0 ? 1 : 0);
        await input.onProgress?.({ stage: 'writing', rowsProcessed: writtenRows });
        values = [];
      }
      if (values.length > 0) {
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: 'Sheet1!A1',
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values },
        }, requestOptions(input.signal));
        writtenRows += values.length - (writtenRows === 0 ? 1 : 0);
        await input.onProgress?.({ stage: 'writing', rowsProcessed: writtenRows });
      }
      await shareUserReader(drive, spreadsheetId, input.readerEmail, input.signal);
      const verified = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Sheet1!1:1',
      }, requestOptions(input.signal));
      if ((verified.data.values?.[0]?.length ?? 0) !== input.columns.length) {
        throw new Error('Google Sheet verification failed: header width differs from export');
      }
      await verifyUserReader(drive, spreadsheetId, input.readerEmail, input.signal);
      await markCompletedExport(drive, spreadsheetId, {
        exportKey: input.exportKey,
        artifactType: 'google_sheet',
        rowCount: input.rowCount,
        sourceTruncated: input.sourceTruncated,
      }, input.signal);
      return {
        success: true,
        artifactId: spreadsheetId,
        artifactUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`,
        artifactType: 'google_sheet',
        rowCount: input.rowCount,
        sourceTruncated: input.sourceTruncated,
        sharedWith: `${input.readerEmail} (reader)`,
        verified: true,
      };
    } catch (error) {
      if (spreadsheetId) await drive.files.delete({ fileId: spreadsheetId }).catch(() => undefined);
      throw error;
    }
  }

  private async createAndUploadCsv(input: {
    readonly auth: GoogleExportAuth;
    readonly readerEmail: string;
    readonly exportKey: string;
    readonly title: string;
    readonly rowsPath: string;
    readonly csvPath: string;
    readonly columns: readonly string[];
    readonly rowCount: number;
    readonly sourceTruncated: boolean;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: DataExportDestinationWriteProgress) => Promise<void>;
  }): Promise<DataExportCompletion> {
    const csvStream = createWriteStream(input.csvPath, { encoding: 'utf8' });
    try {
      await writeLine(csvStream, input.columns.map(escapeCsvCell).join(','));
      let writtenRows = 0;
      for await (const row of readRows(input.rowsPath)) {
        input.signal?.throwIfAborted();
        await writeLine(
          csvStream,
          input.columns.map((column) => escapeCsvCell(row[column])).join(','),
        );
        writtenRows += 1;
        if (writtenRows % 1_000 === 0) {
          await input.onProgress?.({ stage: 'writing', rowsProcessed: writtenRows });
        }
      }
      await input.onProgress?.({ stage: 'writing', rowsProcessed: writtenRows });
      csvStream.end();
      await once(csvStream, 'close');
    } finally {
      if (!csvStream.closed) csvStream.destroy();
    }

    const drive = google.drive({ version: 'v3', auth: oauth(input.auth.accessToken) });
    let fileId: string | undefined;
    try {
      const created = await drive.files.create({
        ignoreDefaultVisibility: true,
        requestBody: {
          name: `${safeTitle(input.title)}.csv`,
          mimeType: 'text/csv',
          appProperties: writingProperties(input.exportKey),
        },
        media: {
          mimeType: 'text/csv',
          body: createReadStream(input.csvPath),
        },
        fields: 'id,webViewLink,size',
      }, requestOptions(input.signal));
      fileId = created.data.id ?? undefined;
      if (!fileId) throw new Error('Google Drive did not return a file ID');
      await shareUserReader(drive, fileId, input.readerEmail, input.signal);
      const localSize = (await stat(input.csvPath)).size;
      const verified = await drive.files.get(
        { fileId, fields: 'id,size,webViewLink' },
        requestOptions(input.signal),
      );
      if (Number(verified.data.size ?? -1) !== localSize) {
        throw new Error('Google Drive verification failed: uploaded CSV size differs from source');
      }
      await verifyUserReader(drive, fileId, input.readerEmail, input.signal);
      await markCompletedExport(drive, fileId, {
        exportKey: input.exportKey,
        artifactType: 'csv',
        rowCount: input.rowCount,
        sourceTruncated: input.sourceTruncated,
      }, input.signal);
      return {
        success: true,
        artifactId: fileId,
        artifactUrl: verified.data.webViewLink ?? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`,
        artifactType: 'csv',
        rowCount: input.rowCount,
        sourceTruncated: input.sourceTruncated,
        sharedWith: `${input.readerEmail} (reader)`,
        verified: true,
      };
    } catch (error) {
      if (fileId) await drive.files.delete({ fileId }).catch(() => undefined);
      throw error;
    }
  }
}

function oauth(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

async function shareUserReader(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  emailAddress: string,
  signal?: AbortSignal,
): Promise<void> {
  await drive.permissions.create({
    fileId,
    requestBody: {
      type: 'user',
      role: 'reader',
      emailAddress,
    },
    fields: 'id',
    sendNotificationEmail: false,
  }, requestOptions(signal));
}

async function verifyUserReader(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  emailAddress: string,
  signal?: AbortSignal,
): Promise<void> {
  const permissions = await drive.permissions.list({
    fileId,
    fields: 'permissions(type,role,emailAddress)',
  }, requestOptions(signal));
  const found = permissions.data.permissions?.some((permission) =>
    permission.type === 'user'
    && permission.role === 'reader'
    && permission.emailAddress?.toLowerCase() === emailAddress.toLowerCase(),
  );
  if (!found) throw new Error('Google Drive verification failed: invoker reader permission is missing');
  const broad = permissions.data.permissions?.some((permission) =>
    permission.type === 'anyone'
    || permission.type === 'domain'
    || permission.type === 'group'
    || (
      permission.type === 'user'
      && permission.role !== 'owner'
      && permission.emailAddress?.toLowerCase() !== emailAddress.toLowerCase()
    ),
  );
  if (broad) throw new Error('Google Drive verification failed: export has access beyond the invoker');
}

export async function recoverCompletedExport(
  drive: ReturnType<typeof google.drive>,
  exportKey: string,
  readerEmail: string,
  signal?: AbortSignal,
): Promise<DataExportCompletion | null> {
  const listed = await drive.files.list({
    q: `appProperties has { key='${EXPORT_KEY_PROPERTY}' and value='${escapeDriveQueryValue(exportKey)}' } and trashed = false`,
    fields: 'files(id,mimeType,webViewLink,appProperties)',
    pageSize: 10,
  }, requestOptions(signal));
  const files = listed.data.files ?? [];
  const completed = files.find((file) => file.appProperties?.[EXPORT_STATE_PROPERTY] === 'complete');
  if (completed?.id) {
    const artifactType = completed.appProperties?.[EXPORT_TYPE_PROPERTY];
    const rowCount = Number(completed.appProperties?.[EXPORT_ROW_COUNT_PROPERTY]);
    if (
      (artifactType === 'google_sheet' || artifactType === 'csv')
      && Number.isSafeInteger(rowCount)
      && rowCount >= 0
    ) {
      for (const file of files) {
        if (file.id && file.id !== completed.id) {
          await drive.files.delete({ fileId: file.id }, requestOptions(signal));
        }
      }
      await ensureUserReader(drive, completed.id, readerEmail, signal);
      await verifyUserReader(drive, completed.id, readerEmail, signal);
      return {
        success: true,
        artifactId: completed.id,
        artifactUrl: completed.webViewLink
          ?? (artifactType === 'google_sheet'
            ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(completed.id)}/edit`
            : `https://drive.google.com/file/d/${encodeURIComponent(completed.id)}/view`),
        artifactType,
        rowCount,
        sourceTruncated: completed.appProperties?.[EXPORT_TRUNCATED_PROPERTY] === 'true',
        sharedWith: `${readerEmail} (reader)`,
        verified: true,
      };
    }
  }
  for (const file of files) {
    if (!file.id) continue;
    await drive.files.delete({ fileId: file.id }, requestOptions(signal));
  }
  return null;
}

async function ensureUserReader(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  emailAddress: string,
  signal?: AbortSignal,
): Promise<void> {
  const permissions = await drive.permissions.list({
    fileId,
    fields: 'permissions(type,role,emailAddress)',
  }, requestOptions(signal));
  const found = permissions.data.permissions?.some((permission) =>
    permission.type === 'user'
    && permission.role === 'reader'
    && permission.emailAddress?.toLowerCase() === emailAddress.toLowerCase(),
  );
  if (!found) await shareUserReader(drive, fileId, emailAddress, signal);
}

async function markCompletedExport(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  input: {
    readonly exportKey: string;
    readonly artifactType: 'google_sheet' | 'csv';
    readonly rowCount: number;
    readonly sourceTruncated: boolean;
  },
  signal?: AbortSignal,
): Promise<void> {
  await drive.files.update({
    fileId,
    requestBody: {
      appProperties: {
        ...writingProperties(input.exportKey),
        [EXPORT_STATE_PROPERTY]: 'complete',
        [EXPORT_ROW_COUNT_PROPERTY]: String(input.rowCount),
        [EXPORT_TRUNCATED_PROPERTY]: String(input.sourceTruncated),
        [EXPORT_TYPE_PROPERTY]: input.artifactType,
      },
    },
    fields: 'id',
  }, requestOptions(signal));
}

function writingProperties(exportKey: string): Record<string, string> {
  return {
    [EXPORT_KEY_PROPERTY]: exportKey,
    [EXPORT_STATE_PROPERTY]: 'writing',
  };
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function requestOptions(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}

async function writeLine(stream: ReturnType<typeof createWriteStream>, line: string): Promise<void> {
  if (!stream.write(`${line}\r\n`)) await once(stream, 'drain');
}

function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value;
  }
  return JSON.stringify(value);
}

function escapeCsvCell(value: unknown): string {
  const normalized = String(normalizeCell(value));
  return /[",\r\n]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
}

function safeTitle(value: string): string {
  const title = value.trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120);
  return title || `Divo export ${new Date().toISOString().slice(0, 10)}`;
}

async function* readRows(path: string): AsyncIterable<Record<string, unknown>> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line) continue;
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Data export spool contained a non-object row');
    }
    yield parsed as Record<string, unknown>;
  }
}
