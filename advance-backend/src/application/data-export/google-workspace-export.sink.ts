import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { google } from 'googleapis';
import type { DataExportCompletion, DataExportSource } from './data-export.types';
import type {
  DataExportDestinationSink,
  DataExportDestinationWriteInput,
  DataExportDestinationWriteProgress,
  DataExportArtifactAccess,
  GoogleExportAuth,
} from './data-export.destination';
import { normalizeExportCell } from './data-export-cell';
import {
  buildDataExportPresentation,
  type DataExportPresentation,
} from './data-export-presentation';
import { writeXlsxArtifact } from './xlsx-export-file';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
    const access = artifactAccess(input.auth, input.readerEmail);
    const recovered = await recoverCompletedExport(
      drive,
      input.exportKey,
      access,
      input.signal,
    );
    if (recovered) return recovered;

    const tempDirectory = await mkdtemp(join(tmpdir(), 'divo-export-'));
    const rowsPath = join(tempDirectory, 'rows.ndjson');
    const csvPath = join(tempDirectory, 'export.csv');
    const xlsxPath = join(tempDirectory, 'export.xlsx');
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
        && input.destination.format !== 'xlsx'
        && rowCount <= SHEET_ROW_LIMIT
        && rowCount * Math.max(1, columns.length) <= SHEET_CELL_LIMIT;
      let format: 'google_sheet' | 'csv' | 'xlsx';
      if (input.destination.format === 'xlsx') format = 'xlsx';
      else if (input.destination.format === 'google_sheet') format = 'google_sheet';
      else if (input.destination.format === 'csv' || !sheetEligible) format = 'csv';
      else format = 'google_sheet';
      if (format === 'google_sheet' && !sheetEligible) {
        throw new Error('Dataset is too large for the requested Google Sheet; use format=auto or csv');
      }
      return format === 'google_sheet'
        ? await this.createSheet({
            auth: input.auth,
            access,
            exportKey: input.exportKey,
            ...(input.source ? { source: input.source } : {}),
            title: input.destination.title,
            columns,
            rowsPath,
            rowCount,
            sourceTruncated: input.sourceTruncated(),
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          })
        : format === 'xlsx'
          ? await this.createAndUploadXlsx({
              auth: input.auth,
              access,
              exportKey: input.exportKey,
              ...(input.source ? { source: input.source } : {}),
              title: input.destination.title,
              rowsPath,
              xlsxPath,
              columns,
              rowCount,
              sourceTruncated: input.sourceTruncated(),
              ...(input.signal ? { signal: input.signal } : {}),
              ...(input.onProgress ? { onProgress: input.onProgress } : {}),
            })
          : await this.createAndUploadCsv({
            auth: input.auth,
            access,
            exportKey: input.exportKey,
            ...(input.source ? { source: input.source } : {}),
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
    readonly access: DataExportArtifactAccess;
    readonly exportKey: string;
    readonly source?: DataExportSource;
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
    const presentation = buildDataExportPresentation({
      title: input.title,
      columns: input.columns,
      ...(input.source ? { source: input.source } : {}),
      rowCount: input.rowCount,
      sourceTruncated: input.sourceTruncated,
    });
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

      let values: unknown[][] = [[...presentation.mainColumns]];
      let writtenRows = 0;
      for await (const row of readRows(input.rowsPath)) {
        input.signal?.throwIfAborted();
        values.push([...presentation.mainRow(row)]);
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
      const formatted = await formatSheet({
        sheets,
        spreadsheetId,
        presentation,
        rowCount: input.rowCount,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (formatted.trendsSheetTitle && presentation.trends) {
        let trendValues: unknown[][] = [[...presentation.trends.columns]];
        for await (const row of readRows(input.rowsPath)) {
          trendValues.push([...presentation.trendRow(row)]);
          if (trendValues.length < SHEET_APPEND_ROWS) continue;
          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `'${formatted.trendsSheetTitle}'!A1`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: trendValues },
          }, requestOptions(input.signal));
          trendValues = [];
        }
        if (trendValues.length > 0) {
          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `'${formatted.trendsSheetTitle}'!A1`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: trendValues },
          }, requestOptions(input.signal));
        }
      }
      await ensureArtifactAccess(drive, spreadsheetId, input.access, input.signal);
      const verified = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${formatted.dataSheetTitle.replaceAll("'", "''")}'!1:1`,
      }, requestOptions(input.signal));
      if ((verified.data.values?.[0]?.length ?? 0) !== presentation.mainColumns.length) {
        throw new Error('Google Sheet verification failed: header width differs from export');
      }
      if (formatted.trendsSheetTitle && presentation.trends) {
        const verifiedTrends = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `'${formatted.trendsSheetTitle.replaceAll("'", "''")}'!1:1`,
        }, requestOptions(input.signal));
        if ((verifiedTrends.data.values?.[0]?.length ?? 0) !== presentation.trends.columns.length) {
          throw new Error('Google Sheet verification failed: trend header width differs from export');
        }
      }
      await verifyArtifactAccess(drive, spreadsheetId, input.access, input.signal);
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
        sharedWith: accessLabel(input.access),
        verified: true,
      };
    } catch (error) {
      if (spreadsheetId) await drive.files.delete({ fileId: spreadsheetId }).catch(() => undefined);
      throw error;
    }
  }

  private async createAndUploadCsv(input: {
    readonly auth: GoogleExportAuth;
    readonly access: DataExportArtifactAccess;
    readonly exportKey: string;
    readonly source?: DataExportSource;
    readonly title: string;
    readonly rowsPath: string;
    readonly csvPath: string;
    readonly columns: readonly string[];
    readonly rowCount: number;
    readonly sourceTruncated: boolean;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: DataExportDestinationWriteProgress) => Promise<void>;
  }): Promise<DataExportCompletion> {
    const presentation = buildDataExportPresentation({
      title: input.title,
      columns: input.columns,
      ...(input.source ? { source: input.source } : {}),
      rowCount: input.rowCount,
      sourceTruncated: input.sourceTruncated,
    });
    const csvStream = createWriteStream(input.csvPath, { encoding: 'utf8' });
    try {
      await writeLine(csvStream, presentation.flatColumns.map(escapeCsvCell).join(','));
      let writtenRows = 0;
      for await (const row of readRows(input.rowsPath)) {
        input.signal?.throwIfAborted();
        await writeLine(
          csvStream,
          presentation.flatRow(row).map(escapeCsvCell).join(','),
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
      await ensureArtifactAccess(drive, fileId, input.access, input.signal);
      const localSize = (await stat(input.csvPath)).size;
      const verified = await drive.files.get(
        { fileId, fields: 'id,size,webViewLink' },
        requestOptions(input.signal),
      );
      if (Number(verified.data.size ?? -1) !== localSize) {
        throw new Error('Google Drive verification failed: uploaded CSV size differs from source');
      }
      await verifyArtifactAccess(drive, fileId, input.access, input.signal);
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
        sharedWith: accessLabel(input.access),
        verified: true,
      };
    } catch (error) {
      if (fileId) await drive.files.delete({ fileId }).catch(() => undefined);
      throw error;
    }
  }

  private async createAndUploadXlsx(input: {
    readonly auth: GoogleExportAuth;
    readonly access: DataExportArtifactAccess;
    readonly exportKey: string;
    readonly source?: DataExportSource;
    readonly title: string;
    readonly rowsPath: string;
    readonly xlsxPath: string;
    readonly columns: readonly string[];
    readonly rowCount: number;
    readonly sourceTruncated: boolean;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: DataExportDestinationWriteProgress) => Promise<void>;
  }): Promise<DataExportCompletion> {
    await writeXlsxArtifact({
      path: input.xlsxPath,
      title: input.title,
      columns: input.columns,
      ...(input.source ? { source: input.source } : {}),
      sourceTruncated: input.sourceTruncated,
      rows: readRows(input.rowsPath),
      rowCount: input.rowCount,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    });

    const drive = google.drive({ version: 'v3', auth: oauth(input.auth.accessToken) });
    let fileId: string | undefined;
    let contentAndAccessVerified = false;
    try {
      const created = await drive.files.create({
        ignoreDefaultVisibility: true,
        requestBody: {
          name: `${safeTitle(input.title)}.xlsx`,
          mimeType: XLSX_MIME_TYPE,
          appProperties: writingProperties(input.exportKey),
        },
        media: {
          mimeType: XLSX_MIME_TYPE,
          body: createReadStream(input.xlsxPath),
        },
        fields: 'id,webViewLink,size,mimeType',
      }, requestOptions(input.signal));
      fileId = created.data.id ?? undefined;
      if (!fileId) throw new Error('Google Drive did not return a file ID');
      await ensureArtifactAccess(drive, fileId, input.access, input.signal);
      const localSize = (await stat(input.xlsxPath)).size;
      const verified = await drive.files.get(
        { fileId, fields: 'id,size,mimeType,webViewLink' },
        requestOptions(input.signal),
      );
      if (Number(verified.data.size ?? -1) !== localSize) {
        throw new Error('Google Drive verification failed: uploaded Excel size differs from source');
      }
      if (verified.data.mimeType !== XLSX_MIME_TYPE) {
        throw new Error('Google Drive verification failed: uploaded Excel MIME type changed');
      }
      await verifyArtifactAccess(drive, fileId, input.access, input.signal);
      contentAndAccessVerified = true;
      await markCompletedExport(drive, fileId, {
        exportKey: input.exportKey,
        artifactType: 'xlsx',
        rowCount: input.rowCount,
        sourceTruncated: input.sourceTruncated,
      }, input.signal);
      return {
        success: true,
        artifactId: fileId,
        artifactUrl: verified.data.webViewLink
          ?? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`,
        artifactType: 'xlsx',
        rowCount: input.rowCount,
        sourceTruncated: input.sourceTruncated,
        sharedWith: accessLabel(input.access),
        verified: true,
      };
    } catch (error) {
      if (fileId && !contentAndAccessVerified) {
        await drive.files.delete({ fileId }).catch(() => undefined);
      }
      throw error;
    }
  }
}

async function formatSheet(input: {
  readonly sheets: ReturnType<typeof google.sheets>;
  readonly spreadsheetId: string;
  readonly presentation: DataExportPresentation;
  readonly rowCount: number;
  readonly signal?: AbortSignal;
}): Promise<{ readonly dataSheetTitle: string; readonly trendsSheetTitle?: string }> {
  const metadata = await input.sheets.spreadsheets.get({
    spreadsheetId: input.spreadsheetId,
    fields: 'sheets(properties(sheetId,title,index))',
  }, requestOptions(input.signal));
  const dataSheet = metadata.data.sheets?.[0]?.properties;
  if (typeof dataSheet?.sheetId !== 'number') {
    throw new Error('Google Sheet formatting failed: default worksheet is missing');
  }
  const presentation = input.presentation;
  const overviewReplyIndex = presentation.overviewRows ? 1 : undefined;
  const trendsReplyIndex = presentation.trends
    ? 1 + (presentation.overviewRows ? 1 : 0)
    : undefined;
  const structure = await input.sheets.spreadsheets.batchUpdate({
    spreadsheetId: input.spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId: dataSheet.sheetId,
              title: presentation.dataSheetTitle,
              gridProperties: {
                frozenRowCount: 1,
                hideGridlines: true,
              },
            },
            fields: 'title,gridProperties.frozenRowCount,gridProperties.hideGridlines',
          },
        },
        ...(presentation.overviewRows
          ? [{ addSheet: { properties: { title: 'Overview', index: 0 } } }]
          : []),
        ...(presentation.trends
          ? [{
              addSheet: {
                properties: {
                  title: presentation.trends.title,
                  index: presentation.overviewRows ? 2 : 1,
                  gridProperties: { frozenRowCount: 1, hideGridlines: true },
                },
              },
            }]
          : []),
      ],
    },
  }, requestOptions(input.signal));
  const overviewSheetId = overviewReplyIndex !== undefined
    ? structure.data.replies?.[overviewReplyIndex]?.addSheet?.properties?.sheetId
    : undefined;
  const trendsSheetId = trendsReplyIndex !== undefined
    ? structure.data.replies?.[trendsReplyIndex]?.addSheet?.properties?.sheetId
    : undefined;
  if (presentation.overviewRows && typeof overviewSheetId !== 'number') {
    throw new Error('Google Sheet formatting failed: overview worksheet was not created');
  }
  if (presentation.overviewRows) {
    await input.sheets.spreadsheets.values.update({
      spreadsheetId: input.spreadsheetId,
      range: "'Overview'!A1:B20",
      valueInputOption: 'RAW',
      requestBody: { values: presentation.overviewRows.map(row => [...row]) },
    }, requestOptions(input.signal));
  }
  if (presentation.trends && typeof trendsSheetId !== 'number') {
    throw new Error('Google Sheet formatting failed: trends worksheet was not created');
  }

  const requests = tableFormatRequests({
    sheetId: dataSheet.sheetId,
    columns: presentation.mainColumns,
    rowCount: input.rowCount,
    presentation,
  });
  if (typeof trendsSheetId === 'number' && presentation.trends) {
    requests.push(...tableFormatRequests({
      sheetId: trendsSheetId,
      columns: presentation.trends.columns,
      rowCount: input.rowCount,
      presentation,
    }));
  }
  if (typeof overviewSheetId === 'number' && presentation.overviewRows) {
    requests.push(
      {
        updateSheetProperties: {
          properties: {
            sheetId: overviewSheetId,
            gridProperties: { hideGridlines: true },
          },
          fields: 'gridProperties.hideGridlines',
        },
      },
      {
        mergeCells: {
          range: {
            sheetId: overviewSheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 2,
          },
          mergeType: 'MERGE_ALL',
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: overviewSheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 2,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.075, green: 0.19, blue: 0.42 },
              textFormat: {
                foregroundColor: { red: 1, green: 1, blue: 1 },
                bold: true,
                fontSize: 14,
              },
              verticalAlignment: 'MIDDLE',
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)',
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: overviewSheetId,
            startRowIndex: 1,
            endRowIndex: presentation.overviewRows.length,
            startColumnIndex: 0,
            endColumnIndex: 1,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.91, green: 0.94, blue: 0.99 },
              textFormat: { bold: true },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      },
      ...[180, 440].map((pixelSize, index) => ({
        updateDimensionProperties: {
          range: {
            sheetId: overviewSheetId,
            dimension: 'COLUMNS',
            startIndex: index,
            endIndex: index + 1,
          },
          properties: { pixelSize },
          fields: 'pixelSize',
        },
      })),
    );
  }
  if (requests.length > 0) {
    await input.sheets.spreadsheets.batchUpdate({
      spreadsheetId: input.spreadsheetId,
      requestBody: { requests },
    }, requestOptions(input.signal));
  }
  return {
    dataSheetTitle: presentation.dataSheetTitle,
    ...(presentation.trends ? { trendsSheetTitle: presentation.trends.title } : {}),
  };
}

function tableFormatRequests(input: {
  readonly sheetId: number;
  readonly columns: readonly string[];
  readonly rowCount: number;
  readonly presentation: DataExportPresentation;
}): Record<string, unknown>[] {
  if (input.columns.length === 0) return [];
  const requests: Record<string, unknown>[] = [
    {
      setBasicFilter: {
        filter: {
          range: {
            sheetId: input.sheetId,
            startRowIndex: 0,
            endRowIndex: input.rowCount + 1,
            startColumnIndex: 0,
            endColumnIndex: input.columns.length,
          },
        },
      },
    },
    {
      repeatCell: {
        range: {
          sheetId: input.sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: input.columns.length,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.075, green: 0.19, blue: 0.42 },
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
            verticalAlignment: 'MIDDLE',
            wrapStrategy: 'WRAP',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId: input.sheetId,
          dimension: 'ROWS',
          startIndex: 0,
          endIndex: 1,
        },
        properties: { pixelSize: 34 },
        fields: 'pixelSize',
      },
    },
  ];
  for (const [index, column] of input.columns.entries()) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId: input.sheetId,
          dimension: 'COLUMNS',
          startIndex: index,
          endIndex: index + 1,
        },
        properties: { pixelSize: input.presentation.columnWidths[column] ?? 140 },
        fields: 'pixelSize',
      },
    });
    const pattern = input.presentation.numberFormats[column];
    if (!pattern || input.rowCount === 0) continue;
    requests.push({
      repeatCell: {
        range: {
          sheetId: input.sheetId,
          startRowIndex: 1,
          endRowIndex: input.rowCount + 1,
          startColumnIndex: index,
          endColumnIndex: index + 1,
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'NUMBER', pattern },
            horizontalAlignment: 'RIGHT',
          },
        },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    });
  }
  return requests;
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
  access: DataExportArtifactAccess,
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
      (artifactType === 'google_sheet' || artifactType === 'csv' || artifactType === 'xlsx')
      && (artifactType !== 'xlsx' || completed.mimeType === XLSX_MIME_TYPE)
      && Number.isSafeInteger(rowCount)
      && rowCount >= 0
    ) {
      for (const file of files) {
        if (file.id && file.id !== completed.id) {
          await drive.files.delete({ fileId: file.id }, requestOptions(signal));
        }
      }
      await ensureArtifactAccess(drive, completed.id, access, signal);
      await verifyArtifactAccess(drive, completed.id, access, signal);
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
        sharedWith: accessLabel(access),
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

function artifactAccess(
  auth: GoogleExportAuth,
  readerEmail: string,
): DataExportArtifactAccess {
  return 'ownerEmail' in auth
    ? { kind: 'owner', email: auth.ownerEmail }
    : { kind: 'reader', email: readerEmail };
}

function accessLabel(access: DataExportArtifactAccess): string {
  return `${access.email} (${access.kind})`;
}

async function ensureArtifactAccess(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  access: DataExportArtifactAccess,
  signal?: AbortSignal,
): Promise<void> {
  if (access.kind === 'reader') {
    await ensureUserReader(drive, fileId, access.email, signal);
  }
}

async function verifyArtifactAccess(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  access: DataExportArtifactAccess,
  signal?: AbortSignal,
): Promise<void> {
  if (access.kind === 'reader') {
    await verifyUserReader(drive, fileId, access.email, signal);
    return;
  }
  const permissions = await drive.permissions.list({
    fileId,
    fields: 'permissions(type,role,emailAddress)',
  }, requestOptions(signal));
  const found = permissions.data.permissions?.some(permission =>
    permission.type === 'user'
    && permission.role === 'owner'
    && permission.emailAddress?.toLowerCase() === access.email.toLowerCase(),
  );
  if (!found) throw new Error('Google Drive verification failed: selected account is not the export owner');
  const broad = permissions.data.permissions?.some(permission =>
    permission.type === 'anyone'
    || permission.type === 'domain'
    || permission.type === 'group'
    || (
      permission.type === 'user'
      && !(
        permission.role === 'owner'
        && permission.emailAddress?.toLowerCase() === access.email.toLowerCase()
      )
    ),
  );
  if (broad) throw new Error('Google Drive verification failed: export has access beyond its owner');
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
    readonly artifactType: 'google_sheet' | 'csv' | 'xlsx';
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

function escapeCsvCell(value: unknown): string {
  const normalized = String(normalizeExportCell(value));
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
