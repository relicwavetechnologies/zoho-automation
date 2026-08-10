import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { google } from 'googleapis';
import type { Logger } from '../../shared/logger';
import { PermanentDataExportError } from './data-export.errors';
import type {
  DataExportCompletion,
  DataExportCoverage,
  DataExportCoverageCause,
  DataExportSource,
} from './data-export.types';
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
import {
  dataExportPresentationCellCount,
  dataExportPresentationRowLimit,
  writeMultiTabXlsxArtifact,
  writeXlsxArtifact,
} from './xlsx-export-file';
import {
  DATA_EXPORT_CSV_ROW_LIMIT,
  DATA_EXPORT_GENERIC_SPOOL_BYTE_LIMIT,
  DATA_EXPORT_GOOGLE_SHEET_CELL_LIMIT,
  DATA_EXPORT_GOOGLE_SHEET_ROW_LIMIT,
  DATA_EXPORT_MENHOOD_SPOOL_BYTE_LIMIT,
  DATA_EXPORT_XLSX_CELL_LIMIT,
} from './data-export-limits';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SHEET_APPEND_ROWS = 500;
const EXPORT_KEY_PROPERTY = 'divoExportKey';
const EXPORT_STATE_PROPERTY = 'divoExportState';
const EXPORT_ROW_COUNT_PROPERTY = 'divoExportRowCount';
const EXPORT_TRUNCATED_PROPERTY = 'divoExportTruncated';
const EXPORT_COVERAGE_PROPERTY = 'divoExportCoverage';
const EXPORT_TYPE_PROPERTY = 'divoExportType';
const VERIFIED_EXPORT_STATE = 'verified';

type PersistedArtifact = {
  readonly exportKey: string;
  readonly artifactType: 'google_sheet' | 'csv' | 'xlsx';
  readonly rowCount: number;
  readonly coverage: DataExportCoverage;
  readonly sourceTruncated: boolean;
};

export class GoogleWorkspaceExportSink implements DataExportDestinationSink {
  constructor(private readonly options: {
    readonly menhoodSpoolByteLimit?: number;
    readonly temporaryDirectoryRoot?: string;
    readonly logger?: Logger | undefined;
  } = {}) {}

  async write(input: DataExportDestinationWriteInput): Promise<DataExportCompletion> {
    if (input.workbookTabs && input.workbookTabs.length > 0) {
      return this.writeWorkbookTabs(input);
    }
    const existingSheet = input.destination.target?.kind === 'existing_google_sheet'
      ? input.destination.target
      : undefined;
    const access = artifactAccess(input.auth, input.readerEmail);
    if (!existingSheet) {
      const drive = google.drive({ version: 'v3', auth: oauth(input.auth.accessToken) });
      const recovered = await recoverCompletedExport(
        drive,
        input.exportKey,
        access,
        input.signal,
        this.options.logger,
      );
      if (recovered) return recovered;
    }

    const tempDirectory = await mkdtemp(join(
      this.options.temporaryDirectoryRoot ?? tmpdir(),
      'divo-export-',
    ));
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
    let spoolTruncated = false;
    const spoolByteLimit = input.source?.kind === 'menhood_query'
      ? this.options.menhoodSpoolByteLimit ?? DATA_EXPORT_MENHOOD_SPOOL_BYTE_LIMIT
      : DATA_EXPORT_GENERIC_SPOOL_BYTE_LIMIT;

    try {
      spoolPages: for await (const page of input.rows) {
        input.signal?.throwIfAborted();
        for (const row of page) {
          const line = JSON.stringify(row);
          const lineBytes = Buffer.byteLength(line, 'utf8') + 2;
          if (
            input.source?.kind === 'menhood_query'
            && spooledBytes + lineBytes > spoolByteLimit
          ) {
            spoolTruncated = true;
            break spoolPages;
          }
          if (
            rowCount >= DATA_EXPORT_CSV_ROW_LIMIT
            || spooledBytes + lineBytes > spoolByteLimit
          ) {
            throw new Error('Data export exceeds the 1,000,000-row or 1 GB safety ceiling');
          }
          if (!configuredColumns) {
            for (const column of Object.keys(row)) discoveredColumns.add(column);
          }
          await writeLine(rowStream, line);
          spooledBytes += lineBytes;
          rowCount += 1;
        }
      }
      rowStream.end();
      await once(rowStream, 'close');

      const columns = [...discoveredColumns];
      const presentation = buildDataExportPresentation({
        title: input.destination.title,
        columns,
        ...(input.source ? { source: input.source } : {}),
        rowCount,
        sourceTruncated: false,
      });
      const sheetEligible = input.destination.format !== 'csv'
        && input.destination.format !== 'xlsx'
        && rowCount <= DATA_EXPORT_GOOGLE_SHEET_ROW_LIMIT
        && dataExportPresentationCellCount(presentation, rowCount)
          <= DATA_EXPORT_GOOGLE_SHEET_CELL_LIMIT;
      let format: 'google_sheet' | 'csv' | 'xlsx';
      if (existingSheet) format = 'google_sheet';
      else if (input.destination.format === 'xlsx') format = 'xlsx';
      else if (input.destination.format === 'google_sheet') format = 'google_sheet';
      else if (input.destination.format === 'csv' || !sheetEligible) format = 'csv';
      else format = 'google_sheet';
      if (format === 'google_sheet' && rowCount > DATA_EXPORT_GOOGLE_SHEET_ROW_LIMIT) {
        throw new Error('Dataset is too large for the requested Google Sheet; use format=auto or csv');
      }
      const destinationCellRowLimit = cellRowLimitFor(
        format,
        input.destination.title,
        columns,
        input.source,
        rowCount,
      );
      const rowsWritten = Math.min(rowCount, destinationCellRowLimit);
      const cellTruncated = rowsWritten < rowCount;
      const sourceCoverage = input.coverage?.(rowsWritten) ?? {
        inputRowsRead: rowsWritten,
        rowsWritten,
        outcome: input.sourceTruncated() ? 'partial' as const : 'complete' as const,
        ...(input.sourceTruncated() ? { cause: 'provider_limit' as const } : {}),
      } satisfies DataExportCoverage;
      const coverage: DataExportCoverage = spoolTruncated
        ? {
            ...sourceCoverage,
            rowsWritten,
            outcome: 'partial',
            cause: 'spool_cap',
          }
        : cellTruncated
          ? {
              ...sourceCoverage,
              rowsWritten,
              outcome: 'partial',
              cause: 'destination_cell_cap',
            }
          : sourceCoverage;
      const sourceTruncated = coverage.outcome === 'partial';
      return existingSheet
        ? await this.writeExistingSheet({
            auth: input.auth,
            target: existingSheet,
            exportKey: input.exportKey,
            ...(input.source ? { source: input.source } : {}),
            title: input.destination.title,
            columns,
            rowsPath,
            rowCount: rowsWritten,
            coverage,
            sourceTruncated,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          })
        : format === 'google_sheet'
        ? await this.createSheet({
            auth: input.auth,
            access,
            exportKey: input.exportKey,
            ...(input.source ? { source: input.source } : {}),
            title: input.destination.title,
            columns,
            rowsPath,
            rowCount: rowsWritten,
            coverage,
            sourceTruncated,
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
              rowCount: rowsWritten,
              coverage,
              sourceTruncated,
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
            rowCount: rowsWritten,
            coverage,
            sourceTruncated,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          });
    } finally {
      if (!rowStream.closed) rowStream.destroy();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private async writeExistingSheet(input: {
    readonly auth: GoogleExportAuth;
    readonly target: Extract<
      NonNullable<DataExportDestinationWriteInput['destination']['target']>,
      { readonly kind: 'existing_google_sheet' }
    >;
    readonly exportKey: string;
    readonly source?: DataExportSource;
    readonly title: string;
    readonly columns: readonly string[];
    readonly rowsPath: string;
    readonly rowCount: number;
    readonly coverage: DataExportCoverage;
    readonly sourceTruncated: boolean;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: DataExportDestinationWriteProgress) => Promise<void>;
  }): Promise<DataExportCompletion> {
    if (!('ownerEmail' in input.auth)) {
      throw new Error('An existing Google Sheet requires the requester-owned Google account');
    }
    const auth = oauth(input.auth.accessToken);
    const drive = google.drive({ version: 'v3', auth });
    const sheets = google.sheets({ version: 'v4', auth });
    const file = await drive.files.get({
      fileId: input.target.spreadsheetId,
      fields: 'id,mimeType,trashed,capabilities(canEdit)',
    }, requestOptions(input.signal));
    if (
      file.data.id !== input.target.spreadsheetId
      || file.data.mimeType !== 'application/vnd.google-apps.spreadsheet'
      || file.data.trashed === true
      || file.data.capabilities?.canEdit !== true
    ) {
      throw new Error('The selected Google Sheet is no longer an editable spreadsheet');
    }

    const presentation = buildDataExportPresentation({
      title: input.title,
      columns: input.columns,
      ...(input.source ? { source: input.source } : {}),
      rowCount: input.rowCount,
      coverage: input.coverage,
      sourceTruncated: input.sourceTruncated,
    });
    const tabTitle = existingSheetTabTitle(input.title, input.exportKey);
    const metadata = await sheets.spreadsheets.get({
      spreadsheetId: input.target.spreadsheetId,
      fields: 'sheets(properties(sheetId,title))',
    }, requestOptions(input.signal));
    const prior = metadata.data.sheets?.find(sheet => sheet.properties?.title === tabTitle)?.properties;
    let sheetId = prior?.sheetId;
    let existingValues: readonly (readonly unknown[])[] = [];
    if (typeof sheetId === 'number') {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: input.target.spreadsheetId,
        range: quoteSheetTitle(tabTitle),
      }, requestOptions(input.signal));
      existingValues = existing.data.values ?? [];
    } else {
      const created = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: input.target.spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: tabTitle } } }] },
      }, requestOptions(input.signal));
      sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId ?? undefined;
      if (typeof sheetId !== 'number') {
        throw new Error('Google Sheets did not return the new export tab ID');
      }
    }

    const writtenRows = await appendMissingExistingSheetRows({
      sheets,
      spreadsheetId: input.target.spreadsheetId,
      tabTitle,
      presentation,
      rowsPath: input.rowsPath,
      rowCount: input.rowCount,
      existingValues,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    });
    if (writtenRows !== input.rowCount) {
      throw new Error('Google Sheet write count differs from the export row count');
    }
    const requests = tableFormatRequests({
      sheetId,
      columns: presentation.flatColumns,
      rowCount: input.rowCount,
      presentation,
    });
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: input.target.spreadsheetId,
      requestBody: { requests },
    }, requestOptions(input.signal));
    await verifyExistingSheetTab({
      sheets,
      spreadsheetId: input.target.spreadsheetId,
      tabTitle,
      presentation,
      rowsPath: input.rowsPath,
      rowCount: input.rowCount,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return existingSheetCompletion(input, sheetId);
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
    readonly coverage: DataExportCoverage;
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
      coverage: input.coverage,
      sourceTruncated: input.sourceTruncated,
    });
    let spreadsheetId: string | undefined;
    let contentAndAccessVerified = false;
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
      for await (const row of readRows(input.rowsPath, input.rowCount)) {
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
        for await (const row of readRows(input.rowsPath, input.rowCount)) {
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
      contentAndAccessVerified = true;
      const artifact: PersistedArtifact = {
        exportKey: input.exportKey,
        artifactType: 'google_sheet',
        rowCount: input.rowCount,
        coverage: input.coverage,
        sourceTruncated: input.sourceTruncated,
      };
      await markVerifiedExport(drive, spreadsheetId, artifact, input.signal);
      await markCompletedExport(drive, spreadsheetId, {
        ...artifact,
      }, input.signal);
      this.options.logger?.info('data_export.artifact.completed', {
        exportKey: input.exportKey,
        artifactType: artifact.artifactType,
        rowCount: artifact.rowCount,
        coverageOutcome: artifact.coverage?.outcome ?? null,
        coverageCause: artifact.coverage?.cause ?? null,
      });
      return {
        success: true,
        artifactId: spreadsheetId,
        artifactUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`,
        artifactType: 'google_sheet',
        rowCount: input.rowCount,
        coverage: input.coverage,
        sourceTruncated: input.sourceTruncated,
        sharedWith: accessLabel(input.access),
        verified: true,
      };
    } catch (error) {
      if (spreadsheetId && !contentAndAccessVerified) {
        await cleanupArtifact(drive, spreadsheetId, {
          exportKey: input.exportKey,
          artifactType: 'google_sheet',
          reason: 'write_failed',
          logger: this.options.logger,
        });
      }
      throw error;
    }
  }

  private async writeWorkbookTabs(input: DataExportDestinationWriteInput): Promise<DataExportCompletion> {
    const tabs = input.workbookTabs ?? [];
    if (tabs.length === 0) {
      throw new Error('Workbook export requires at least one tab');
    }
    const format = input.destination.format;
    if (format === 'csv') {
      throw new Error('CSV exports can contain one dataset. Use Google Sheet or Excel for a workbook.');
    }
    const access = artifactAccess(input.auth, input.readerEmail);
    const drive = google.drive({ version: 'v3', auth: oauth(input.auth.accessToken) });
    const recovered = await recoverCompletedExport(
      drive,
      input.exportKey,
      access,
      input.signal,
      this.options.logger,
    );
    if (recovered) return recovered;

    const tempDirectory = await mkdtemp(join(
      this.options.temporaryDirectoryRoot ?? tmpdir(),
      'divo-export-wb-',
    ));
    const spooledTabs: Array<{
      readonly tabName: string;
      readonly source: DataExportSource;
      readonly rowsPath: string;
      readonly columns: readonly string[];
      readonly rowCount: number;
    }> = [];

    try {
      for (const [index, tab] of tabs.entries()) {
        const rowsPath = join(tempDirectory, `tab-${index}.ndjson`);
        const rowStream = createWriteStream(rowsPath, { encoding: 'utf8' });
        const discoveredColumns = new Set<string>();
        let rowCount = 0;
        let spooledBytes = 0;
        const spoolByteLimit = tab.source.kind === 'menhood_query'
          ? this.options.menhoodSpoolByteLimit ?? DATA_EXPORT_MENHOOD_SPOOL_BYTE_LIMIT
          : DATA_EXPORT_GENERIC_SPOOL_BYTE_LIMIT;

        spoolPages: for await (const page of tab.rows) {
          input.signal?.throwIfAborted();
          for (const row of page) {
            const line = JSON.stringify(row);
            const lineBytes = Buffer.byteLength(line, 'utf8') + 2;
            if (
              tab.source.kind === 'menhood_query'
              && spooledBytes + lineBytes > spoolByteLimit
            ) {
              break spoolPages;
            }
            if (
              rowCount >= DATA_EXPORT_CSV_ROW_LIMIT
              || spooledBytes + lineBytes > spoolByteLimit
            ) {
              throw new Error('Data export exceeds the 1,000,000-row or 1 GB safety ceiling');
            }
            for (const column of Object.keys(row)) discoveredColumns.add(column);
            await writeLine(rowStream, line);
            spooledBytes += lineBytes;
            rowCount += 1;
          }
        }
        rowStream.end();
        await once(rowStream, 'close');
        spooledTabs.push({
          tabName: safeWorkbookTabName(tab.tabName, index),
          source: tab.source,
          rowsPath,
          columns: [...discoveredColumns],
          rowCount,
        });
      }

      const totalRows = spooledTabs.reduce((sum, tab) => sum + tab.rowCount, 0);
      const coverage = input.coverage?.(totalRows) ?? {
        inputRowsRead: totalRows,
        rowsWritten: totalRows,
        outcome: 'complete' as const,
      };
      const sourceTruncated = input.sourceTruncated();

      if (format === 'xlsx') {
        const xlsxPath = join(tempDirectory, 'workbook.xlsx');
        try {
          await writeMultiTabXlsxArtifact({
            path: xlsxPath,
            tabs: spooledTabs.map(tab => ({
              tabName: tab.tabName,
              columns: tab.columns,
              source: tab.source,
              rows: readRows(tab.rowsPath, tab.rowCount),
              rowCount: tab.rowCount,
            })),
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          });
        } catch (error) {
          this.options.logger?.error('data_export.workbook.xlsx_write_failed', {
            exportKey: input.exportKey,
            tabCount: spooledTabs.length,
            tabs: spooledTabs.map(tab => ({
              tabName: tab.tabName,
              rowCount: tab.rowCount,
              columnCount: tab.columns.length,
            })),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        return await this.uploadPreparedXlsx({
          auth: input.auth,
          access,
          exportKey: input.exportKey,
          title: input.destination.title,
          xlsxPath,
          rowCount: totalRows,
          coverage,
          sourceTruncated,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      }

      return await this.createMultiTabSheet({
        auth: input.auth,
        access,
        exportKey: input.exportKey,
        title: input.destination.title,
        tabs: spooledTabs,
        rowCount: totalRows,
        coverage,
        sourceTruncated,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private async createMultiTabSheet(input: {
    readonly auth: GoogleExportAuth;
    readonly access: DataExportArtifactAccess;
    readonly exportKey: string;
    readonly title: string;
    readonly tabs: readonly {
      readonly tabName: string;
      readonly source: DataExportSource;
      readonly rowsPath: string;
      readonly columns: readonly string[];
      readonly rowCount: number;
    }[];
    readonly rowCount: number;
    readonly coverage: DataExportCoverage;
    readonly sourceTruncated: boolean;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: DataExportDestinationWriteProgress) => Promise<void>;
  }): Promise<DataExportCompletion> {
    const auth = oauth(input.auth.accessToken);
    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    let spreadsheetId: string | undefined;
    let contentAndAccessVerified = false;
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

      const metadata = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties',
      }, requestOptions(input.signal));
      const sheetIds = metadata.data.sheets?.map(sheet => sheet.properties?.sheetId) ?? [];
      const requests: Array<Record<string, unknown>> = [];
      if (sheetIds[0] !== undefined) {
        requests.push({
          updateSheetProperties: {
            properties: {
              sheetId: sheetIds[0],
              title: input.tabs[0]!.tabName,
            },
            fields: 'title',
          },
        });
      }
      for (const [index, tab] of input.tabs.slice(1).entries()) {
        requests.push({
          addSheet: {
            properties: { title: tab.tabName, index: index + 1 },
          },
        });
      }
      if (requests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests },
        }, requestOptions(input.signal));
      }

      let rowsProcessed = 0;
      for (const tab of input.tabs) {
        const presentation = buildDataExportPresentation({
          title: tab.tabName,
          columns: tab.columns,
          source: tab.source,
          rowCount: tab.rowCount,
          coverage: input.coverage,
          sourceTruncated: input.sourceTruncated,
        });
        const quotedTitle = quoteSheetTitle(tab.tabName);
        let values: unknown[][] = [[...presentation.mainColumns]];
        let writtenRows = 0;
        for await (const row of readRows(tab.rowsPath, tab.rowCount)) {
          input.signal?.throwIfAborted();
          values.push([...presentation.mainRow(row)]);
          if (values.length < SHEET_APPEND_ROWS) continue;
          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${quotedTitle}!A1`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values },
          }, requestOptions(input.signal));
          writtenRows += values.length - (writtenRows === 0 ? 1 : 0);
          rowsProcessed += values.length - (writtenRows === values.length ? 1 : 0);
          await input.onProgress?.({ stage: 'writing', rowsProcessed });
          values = [];
        }
        if (values.length > 0) {
          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${quotedTitle}!A1`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values },
          }, requestOptions(input.signal));
          writtenRows += values.length - (writtenRows === 0 ? 1 : 0);
          rowsProcessed += values.length;
          await input.onProgress?.({ stage: 'writing', rowsProcessed });
        }
        const verified = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${quotedTitle}!1:1`,
        }, requestOptions(input.signal));
        if ((verified.data.values?.[0]?.length ?? 0) !== presentation.mainColumns.length) {
          throw new Error(`Google Sheet verification failed: header width differs for tab "${tab.tabName}"`);
        }
      }

      await ensureArtifactAccess(drive, spreadsheetId, input.access, input.signal);
      await verifyArtifactAccess(drive, spreadsheetId, input.access, input.signal);
      contentAndAccessVerified = true;
      const artifact: PersistedArtifact = {
        exportKey: input.exportKey,
        artifactType: 'google_sheet',
        rowCount: input.rowCount,
        coverage: input.coverage,
        sourceTruncated: input.sourceTruncated,
      };
      await markVerifiedExport(drive, spreadsheetId, artifact, input.signal);
      await markCompletedExport(drive, spreadsheetId, artifact, input.signal);
      this.options.logger?.info('data_export.artifact.completed', {
        exportKey: input.exportKey,
        artifactType: artifact.artifactType,
        rowCount: artifact.rowCount,
        coverageOutcome: artifact.coverage?.outcome ?? null,
        coverageCause: artifact.coverage?.cause ?? null,
      });
      return {
        success: true,
        artifactId: spreadsheetId,
        artifactUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`,
        artifactType: 'google_sheet',
        rowCount: input.rowCount,
        coverage: input.coverage,
        sourceTruncated: input.sourceTruncated,
        sharedWith: accessLabel(input.access),
        verified: true,
      };
    } catch (error) {
      if (spreadsheetId && !contentAndAccessVerified) {
        await cleanupArtifact(drive, spreadsheetId, {
          exportKey: input.exportKey,
          artifactType: 'google_sheet',
          reason: 'write_failed',
          logger: this.options.logger,
        });
      }
      throw error;
    }
  }

  private async uploadPreparedXlsx(input: {
    readonly auth: GoogleExportAuth;
    readonly access: DataExportArtifactAccess;
    readonly exportKey: string;
    readonly title: string;
    readonly xlsxPath: string;
    readonly rowCount: number;
    readonly coverage: DataExportCoverage;
    readonly sourceTruncated: boolean;
    readonly signal?: AbortSignal;
  }): Promise<DataExportCompletion> {
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
      const artifact: PersistedArtifact = {
        exportKey: input.exportKey,
        artifactType: 'xlsx',
        rowCount: input.rowCount,
        coverage: input.coverage,
        sourceTruncated: input.sourceTruncated,
      };
      await markVerifiedExport(drive, fileId, artifact, input.signal);
      await markCompletedExport(drive, fileId, artifact, input.signal);
      this.options.logger?.info('data_export.artifact.completed', {
        exportKey: input.exportKey,
        artifactType: artifact.artifactType,
        rowCount: artifact.rowCount,
        coverageOutcome: artifact.coverage?.outcome ?? null,
        coverageCause: artifact.coverage?.cause ?? null,
      });
      return {
        success: true,
        artifactId: fileId,
        artifactUrl: verified.data.webViewLink
          ?? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`,
        artifactType: 'xlsx',
        rowCount: input.rowCount,
        coverage: input.coverage,
        sourceTruncated: input.sourceTruncated,
        sharedWith: accessLabel(input.access),
        verified: true,
      };
    } catch (error) {
      if (fileId && !contentAndAccessVerified) {
        await cleanupArtifact(drive, fileId, {
          exportKey: input.exportKey,
          artifactType: 'xlsx',
          reason: 'write_failed',
          logger: this.options.logger,
        });
      }
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
    readonly coverage: DataExportCoverage;
    readonly sourceTruncated: boolean;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: DataExportDestinationWriteProgress) => Promise<void>;
  }): Promise<DataExportCompletion> {
    const presentation = buildDataExportPresentation({
      title: input.title,
      columns: input.columns,
      ...(input.source ? { source: input.source } : {}),
      rowCount: input.rowCount,
      coverage: input.coverage,
      sourceTruncated: input.sourceTruncated,
    });
    const csvStream = createWriteStream(input.csvPath, { encoding: 'utf8' });
    try {
      await writeLine(csvStream, presentation.flatColumns.map(escapeCsvCell).join(','));
      let writtenRows = 0;
      for await (const row of readRows(input.rowsPath, input.rowCount)) {
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
    let contentAndAccessVerified = false;
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
      contentAndAccessVerified = true;
      const artifact: PersistedArtifact = {
        exportKey: input.exportKey,
        artifactType: 'csv',
        rowCount: input.rowCount,
        coverage: input.coverage,
        sourceTruncated: input.sourceTruncated,
      };
      await markVerifiedExport(drive, fileId, artifact, input.signal);
      await markCompletedExport(drive, fileId, {
        ...artifact,
      }, input.signal);
      this.options.logger?.info('data_export.artifact.completed', {
        exportKey: input.exportKey,
        artifactType: artifact.artifactType,
        rowCount: artifact.rowCount,
        coverageOutcome: artifact.coverage?.outcome ?? null,
        coverageCause: artifact.coverage?.cause ?? null,
      });
      return {
        success: true,
        artifactId: fileId,
        artifactUrl: verified.data.webViewLink ?? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`,
        artifactType: 'csv',
        rowCount: input.rowCount,
        coverage: input.coverage,
        sourceTruncated: input.sourceTruncated,
        sharedWith: accessLabel(input.access),
        verified: true,
      };
    } catch (error) {
      if (fileId && !contentAndAccessVerified) {
        await cleanupArtifact(drive, fileId, {
          exportKey: input.exportKey,
          artifactType: 'csv',
          reason: 'write_failed',
          logger: this.options.logger,
        });
      }
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
    readonly coverage: DataExportCoverage;
    readonly sourceTruncated: boolean;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: DataExportDestinationWriteProgress) => Promise<void>;
  }): Promise<DataExportCompletion> {
    await writeXlsxArtifact({
      path: input.xlsxPath,
      title: input.title,
      columns: input.columns,
      ...(input.source ? { source: input.source } : {}),
      coverage: input.coverage,
      sourceTruncated: input.sourceTruncated,
      rows: readRows(input.rowsPath, input.rowCount),
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
      const artifact: PersistedArtifact = {
        exportKey: input.exportKey,
        artifactType: 'xlsx',
        rowCount: input.rowCount,
        coverage: input.coverage,
        sourceTruncated: input.sourceTruncated,
      };
      await markVerifiedExport(drive, fileId, artifact, input.signal);
      await markCompletedExport(drive, fileId, {
        ...artifact,
      }, input.signal);
      this.options.logger?.info('data_export.artifact.completed', {
        exportKey: input.exportKey,
        artifactType: artifact.artifactType,
        rowCount: artifact.rowCount,
        coverageOutcome: artifact.coverage?.outcome ?? null,
        coverageCause: artifact.coverage?.cause ?? null,
      });
      return {
        success: true,
        artifactId: fileId,
        artifactUrl: verified.data.webViewLink
          ?? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`,
        artifactType: 'xlsx',
        rowCount: input.rowCount,
        coverage: input.coverage,
        sourceTruncated: input.sourceTruncated,
        sharedWith: accessLabel(input.access),
        verified: true,
      };
    } catch (error) {
      if (fileId && !contentAndAccessVerified) {
        await cleanupArtifact(drive, fileId, {
          exportKey: input.exportKey,
          artifactType: 'xlsx',
          reason: 'write_failed',
          logger: this.options.logger,
        });
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

async function appendMissingExistingSheetRows(input: {
  readonly sheets: ReturnType<typeof google.sheets>;
  readonly spreadsheetId: string;
  readonly tabTitle: string;
  readonly presentation: DataExportPresentation;
  readonly rowsPath: string;
  readonly rowCount: number;
  readonly existingValues: readonly (readonly unknown[])[];
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DataExportDestinationWriteProgress) => Promise<void>;
}): Promise<number> {
  if (
    input.existingValues.length > 0
    && !sameSheetRow(input.existingValues[0], input.presentation.flatColumns)
  ) {
    throw new Error('Google Sheet retry stopped: the Divo export tab header was changed');
  }
  const existingRowCount = Math.max(0, input.existingValues.length - 1);
  let pending: unknown[][] = input.existingValues.length === 0
    ? [[...input.presentation.flatColumns]]
    : [];
  let sourceRowCount = 0;
  for await (const row of readRows(input.rowsPath, input.rowCount)) {
    input.signal?.throwIfAborted();
    const flatRow = [...input.presentation.flatRow(row)];
    if (sourceRowCount < existingRowCount) {
      if (!sameSheetRow(input.existingValues[sourceRowCount + 1], flatRow)) {
        throw new Error('Google Sheet retry stopped: the Divo export tab rows were changed');
      }
    } else {
      pending.push(flatRow);
    }
    sourceRowCount += 1;
    if (pending.length < SHEET_APPEND_ROWS) continue;
    await appendExistingSheetValues(
      input.sheets,
      input.spreadsheetId,
      input.tabTitle,
      pending,
      input.signal,
    );
    pending = [];
    await input.onProgress?.({ stage: 'writing', rowsProcessed: sourceRowCount });
  }
  if (existingRowCount > sourceRowCount) {
    throw new Error('Google Sheet retry stopped: the Divo export tab has unexpected extra rows');
  }
  if (pending.length > 0) {
    await appendExistingSheetValues(
      input.sheets,
      input.spreadsheetId,
      input.tabTitle,
      pending,
      input.signal,
    );
    await input.onProgress?.({ stage: 'writing', rowsProcessed: sourceRowCount });
  }
  return sourceRowCount;
}

async function appendExistingSheetValues(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabTitle: string,
  values: readonly (readonly unknown[])[],
  signal?: AbortSignal,
): Promise<void> {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteSheetTitle(tabTitle)}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: values.map(row => [...row]) },
  }, requestOptions(signal));
}

async function verifyExistingSheetTab(input: {
  readonly sheets: ReturnType<typeof google.sheets>;
  readonly spreadsheetId: string;
  readonly tabTitle: string;
  readonly presentation: DataExportPresentation;
  readonly rowsPath: string;
  readonly rowCount: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const header = await input.sheets.spreadsheets.values.get({
    spreadsheetId: input.spreadsheetId,
    range: `${quoteSheetTitle(input.tabTitle)}!1:1`,
  }, requestOptions(input.signal));
  if (!sameSheetRow(header.data.values?.[0], input.presentation.flatColumns)) {
    throw new Error('Google Sheet verification failed: export tab header differs from source');
  }
  if (input.rowCount === 0) return;

  let expectedLast: readonly unknown[] | undefined;
  for await (const row of readRows(input.rowsPath, input.rowCount)) {
    expectedLast = input.presentation.flatRow(row);
  }
  if (!expectedLast) throw new Error('Google Sheet verification failed: final source row is missing');
  const finalRowNumber = input.rowCount + 1;
  const finalRow = await input.sheets.spreadsheets.values.get({
    spreadsheetId: input.spreadsheetId,
    range: `${quoteSheetTitle(input.tabTitle)}!${finalRowNumber}:${finalRowNumber}`,
  }, requestOptions(input.signal));
  if (!sameSheetRow(finalRow.data.values?.[0], expectedLast)) {
    throw new Error('Google Sheet verification failed: final export row differs from source');
  }
}

function existingSheetCompletion(
  input: {
    readonly auth: GoogleExportAuth;
    readonly target: { readonly spreadsheetId: string };
    readonly rowCount: number;
    readonly coverage: DataExportCoverage;
    readonly sourceTruncated: boolean;
  },
  sheetId: number,
): DataExportCompletion {
  if (!('ownerEmail' in input.auth)) {
    throw new Error('An existing Google Sheet requires a verified owner');
  }
  return {
    success: true,
    artifactId: input.target.spreadsheetId,
    artifactUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(input.target.spreadsheetId)}/edit#gid=${sheetId}`,
    artifactType: 'google_sheet',
    rowCount: input.rowCount,
    coverage: input.coverage,
    sourceTruncated: input.sourceTruncated,
    sharedWith: `${input.auth.ownerEmail} (owner)`,
    verified: true,
  };
}

function cellRowLimitFor(
  format: 'google_sheet' | 'csv' | 'xlsx',
  title: string,
  columns: readonly string[],
  source: DataExportSource | undefined,
  rowCount: number,
): number {
  if (format === 'csv') return Number.POSITIVE_INFINITY;
  const cellLimit = format === 'google_sheet'
    ? DATA_EXPORT_GOOGLE_SHEET_CELL_LIMIT
    : DATA_EXPORT_XLSX_CELL_LIMIT;
  let candidateRowCount = rowCount;
  while (true) {
    const presentation = buildDataExportPresentation({
      title,
      columns,
      ...(source ? { source } : {}),
      rowCount: candidateRowCount,
      sourceTruncated: false,
    });
    const rowLimit = dataExportPresentationRowLimit(presentation, cellLimit);
    if (rowLimit >= candidateRowCount) return rowLimit;
    candidateRowCount = rowLimit;
  }
}

function existingSheetTabTitle(title: string, exportKey: string): string {
  const suffix = createHash('sha256').update(exportKey).digest('hex').slice(0, 16);
  const base = safeTitle(title).replace(/[\[\]]+/g, '-').slice(0, 80).trim();
  return `${base || 'Divo export'} · ${suffix}`;
}

function quoteSheetTitle(title: string): string {
  return `'${title.replaceAll("'", "''")}'`;
}

function sameSheetRow(actual: readonly unknown[] | undefined, expected: readonly unknown[]): boolean {
  return JSON.stringify(trimTrailingEmpty(actual ?? [])) === JSON.stringify(trimTrailingEmpty(expected));
}

function trimTrailingEmpty(values: readonly unknown[]): unknown[] {
  const normalized = values.map(normalizeExportCell);
  while (normalized.at(-1) === '') normalized.pop();
  return normalized;
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
  ownerEmail: string,
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
  if (!found) {
    throw exportPrivacyVerificationError(
      'Google Drive verification failed: invoker reader permission is missing',
    );
  }
  const ownerFound = permissions.data.permissions?.some((permission) =>
    permission.type === 'user'
    && permission.role === 'owner'
    && permission.emailAddress?.toLowerCase() === ownerEmail.toLowerCase(),
  );
  if (!ownerFound) {
    throw exportPrivacyVerificationError(
      'Google Drive verification failed: configured company owner permission is missing',
    );
  }
  const unexpected = permissions.data.permissions?.some((permission) => {
    if (permission.type !== 'user') return true;
    const email = permission.emailAddress?.toLowerCase();
    return !(
      (permission.role === 'owner' && email === ownerEmail.toLowerCase())
      || (permission.role === 'reader' && email === emailAddress.toLowerCase())
    );
  });
  if (unexpected) {
    throw exportPrivacyVerificationError(
      'Google Drive verification failed: export access is not limited to the company owner and invoker reader',
    );
  }
}

export async function recoverCompletedExport(
  drive: ReturnType<typeof google.drive>,
  exportKey: string,
  access: DataExportArtifactAccess,
  signal?: AbortSignal,
  logger?: Logger,
): Promise<DataExportCompletion | null> {
  const listed = await drive.files.list({
    q: `appProperties has { key='${EXPORT_KEY_PROPERTY}' and value='${escapeDriveQueryValue(exportKey)}' } and trashed = false`,
    fields: 'files(id,mimeType,webViewLink,appProperties)',
    pageSize: 10,
  }, requestOptions(signal));
  const files = listed.data.files ?? [];
  const completed = files.find(file =>
    file.appProperties?.[EXPORT_STATE_PROPERTY] === 'complete'
    && persistedArtifactFrom(file),
  );
  const verified = completed
    ? undefined
    : files.find(file =>
      file.appProperties?.[EXPORT_STATE_PROPERTY] === VERIFIED_EXPORT_STATE
      && persistedArtifactFrom(file)?.coverage,
    );
  const recovered = completed ?? verified;
  if (recovered?.id) {
    const artifact = persistedArtifactFrom(recovered);
    if (!artifact) throw new Error('Validated recovered export was missing its artifact receipt');
    for (const file of files) {
      if (file.id && file.id !== recovered.id) {
        if (
          (file.appProperties?.[EXPORT_STATE_PROPERTY] === 'complete'
            || file.appProperties?.[EXPORT_STATE_PROPERTY] === VERIFIED_EXPORT_STATE)
          && persistedArtifactFrom(file)
        ) {
          logger?.warn('data_export.artifact.duplicate_preserved', {
            exportKey,
            artifactType: persistedArtifactFrom(file)?.artifactType,
          });
          continue;
        }
        await cleanupArtifact(drive, file.id, {
          exportKey,
          artifactType: artifact.artifactType,
          reason: 'recovery_duplicate',
          logger,
        });
      }
    }
    try {
      await ensureArtifactAccess(drive, recovered.id, access, signal);
      await verifyArtifactAccess(drive, recovered.id, access, signal);
    } catch (error) {
      if (error instanceof PermanentDataExportError) {
        const removed = await cleanupArtifact(drive, recovered.id, {
          exportKey,
          artifactType: artifact.artifactType,
          reason: 'privacy_violation',
          logger,
        });
        if (!removed) throw privacyCleanupPendingError();
      }
      throw error;
    }
    if (verified) {
      if (!artifact.coverage) throw new Error('Verified export receipt was missing coverage');
      await markCompletedExport(drive, recovered.id, {
        exportKey,
        artifactType: artifact.artifactType,
        rowCount: artifact.rowCount,
        coverage: artifact.coverage,
        sourceTruncated: artifact.sourceTruncated,
      }, signal);
    }
    logger?.info('data_export.artifact.recovered', {
      exportKey,
      recoveryState: verified ? VERIFIED_EXPORT_STATE : 'complete',
      artifactType: artifact.artifactType,
      rowCount: artifact.rowCount,
      coverageOutcome: artifact.coverage?.outcome ?? null,
      coverageCause: artifact.coverage?.cause ?? null,
    });
    return completionFromArtifact(recovered.id, recovered.webViewLink, artifact, access);
  }
  const ambiguousWriting = files.find(file =>
    file.id && file.appProperties?.[EXPORT_STATE_PROPERTY] === 'writing',
  );
  if (ambiguousWriting?.id) {
    try {
      await ensureArtifactAccess(drive, ambiguousWriting.id, access, signal);
      await verifyArtifactAccess(drive, ambiguousWriting.id, access, signal);
    } catch (error) {
      if (error instanceof PermanentDataExportError) {
        const removed = await cleanupArtifact(drive, ambiguousWriting.id, {
          exportKey,
          artifactType: 'unknown',
          reason: 'privacy_violation',
          logger,
        });
        if (!removed) throw privacyCleanupPendingError();
      }
      throw error;
    }
    logger?.warn('data_export.artifact.ambiguous_preserved', { exportKey });
    throw new PermanentDataExportError(
      'Divo found an earlier export attempt that it could not safely verify. It remains private; please run a new export.',
      'Unverified Divo export artifact blocks automatic recovery',
    );
  }
  for (const file of files) {
    if (!file.id) continue;
    await cleanupArtifact(drive, file.id, {
      exportKey,
      artifactType: 'unknown',
      reason: 'recovery_incomplete',
      logger,
    });
  }
  return null;
}

type RecoveredArtifact = Omit<PersistedArtifact, 'exportKey' | 'coverage'> & {
  readonly coverage?: DataExportCoverage;
};

function persistedArtifactFrom(file: {
  readonly mimeType?: string | null;
  readonly appProperties?: Record<string, string | null | undefined> | null;
}): RecoveredArtifact | null {
  const artifactType = file.appProperties?.[EXPORT_TYPE_PROPERTY];
  const rowCount = Number(file.appProperties?.[EXPORT_ROW_COUNT_PROPERTY]);
  if (
    (artifactType !== 'google_sheet' && artifactType !== 'csv' && artifactType !== 'xlsx')
    || (artifactType === 'xlsx' && file.mimeType !== XLSX_MIME_TYPE)
    || !Number.isSafeInteger(rowCount)
    || rowCount < 0
  ) return null;
  const coverage = parsePersistedCoverage(file.appProperties?.[EXPORT_COVERAGE_PROPERTY] ?? undefined);
  return {
    artifactType,
    rowCount,
    ...(coverage ? { coverage } : {}),
    sourceTruncated: coverage?.outcome === 'partial'
      || (!coverage && file.appProperties?.[EXPORT_TRUNCATED_PROPERTY] === 'true'),
  };
}

function completionFromArtifact(
  artifactId: string,
  webViewLink: string | null | undefined,
  artifact: RecoveredArtifact,
  access: DataExportArtifactAccess,
): DataExportCompletion {
  return {
    success: true,
    artifactId,
    artifactUrl: webViewLink
      ?? (artifact.artifactType === 'google_sheet'
        ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(artifactId)}/edit`
        : `https://drive.google.com/file/d/${encodeURIComponent(artifactId)}/view`),
    artifactType: artifact.artifactType,
    rowCount: artifact.rowCount,
    ...(artifact.coverage ? { coverage: artifact.coverage } : {}),
    sourceTruncated: artifact.sourceTruncated,
    sharedWith: accessLabel(access),
    verified: true,
  };
}

function exportPrivacyVerificationError(logMessage: string): PermanentDataExportError {
  return new PermanentDataExportError(
    'Divo could not verify that this export is private to your selected Google account. Reconnect that account or ask an administrator to restore the export sharing policy.',
    logMessage,
  );
}

async function cleanupArtifact(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  input: {
    readonly exportKey: string;
    readonly artifactType: 'google_sheet' | 'csv' | 'xlsx' | 'unknown';
    readonly reason: 'write_failed' | 'recovery_duplicate' | 'recovery_incomplete' | 'privacy_violation';
    readonly logger?: Logger | undefined;
  },
): Promise<boolean> {
  try {
    await drive.files.delete({ fileId });
    input.logger?.info('data_export.artifact_cleanup.completed', {
      exportKey: input.exportKey,
      artifactType: input.artifactType,
      reason: input.reason,
    });
    return true;
  } catch (error) {
    input.logger?.warn('data_export.artifact_cleanup.failed', {
      exportKey: input.exportKey,
      artifactType: input.artifactType,
      reason: input.reason,
      errorType: dataExportErrorType(error),
    });
    return false;
  }
}

function dataExportErrorType(error: unknown): 'permanent' | 'error' | 'non_error' {
  if (error instanceof PermanentDataExportError) return 'permanent';
  return error instanceof Error ? 'error' : 'non_error';
}

function privacyCleanupPendingError(): Error & { readonly code: 'data_export_privacy_cleanup_pending' } {
  return Object.assign(
    new Error('Divo could not remove an artifact that violates export privacy'),
    { code: 'data_export_privacy_cleanup_pending' as const },
  );
}

function artifactAccess(
  auth: GoogleExportAuth,
  readerEmail: string,
): DataExportArtifactAccess {
  return 'ownerEmail' in auth
    ? { kind: 'owner', email: auth.ownerEmail }
    : {
        kind: 'reader',
        email: readerEmail,
        ownerEmail: auth.companyOwnerEmail,
      };
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
    await verifyUserReader(drive, fileId, access.email, access.ownerEmail, signal);
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
  if (!found) {
    throw exportPrivacyVerificationError(
      'Google Drive verification failed: selected account is not the export owner',
    );
  }
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
  if (broad) {
    throw exportPrivacyVerificationError(
      'Google Drive verification failed: export has access beyond its owner',
    );
  }
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

async function markVerifiedExport(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  input: PersistedArtifact,
  signal?: AbortSignal,
): Promise<void> {
  await markExportState(drive, fileId, input, VERIFIED_EXPORT_STATE, signal);
}

async function markCompletedExport(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  input: PersistedArtifact,
  signal?: AbortSignal,
): Promise<void> {
  await markExportState(drive, fileId, input, 'complete', signal);
}

async function markExportState(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  input: PersistedArtifact,
  state: 'complete' | typeof VERIFIED_EXPORT_STATE,
  signal?: AbortSignal,
): Promise<void> {
  await drive.files.update({
    fileId,
    requestBody: {
      appProperties: {
        ...writingProperties(input.exportKey),
        [EXPORT_STATE_PROPERTY]: state,
        [EXPORT_ROW_COUNT_PROPERTY]: String(input.rowCount),
        [EXPORT_TRUNCATED_PROPERTY]: String(input.sourceTruncated),
        [EXPORT_COVERAGE_PROPERTY]: JSON.stringify(input.coverage),
        [EXPORT_TYPE_PROPERTY]: input.artifactType,
      },
    },
    fields: 'id',
  }, requestOptions(signal));
}

function parsePersistedCoverage(value: string | undefined): DataExportCoverage | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Record<string, unknown>;
    const outcome = candidate['outcome'];
    const cause = candidate['cause'];
    const validOutcome = outcome === 'complete'
      || outcome === 'requested_window_satisfied'
      || outcome === 'partial';
    const validCause = cause === undefined
      || cause === 'provider_limit'
      || cause === 'export_row_cap'
      || cause === 'destination_row_cap'
      || cause === 'destination_cell_cap'
      || cause === 'spool_cap';
    if (
      !validOutcome
      || !validCause
      || (outcome === 'partial' && cause === undefined)
      || (outcome !== 'partial' && cause !== undefined)
      || !isNonnegativeSafeInteger(candidate['inputRowsRead'])
      || !isNonnegativeSafeInteger(candidate['rowsWritten'])
      || (candidate['requestedRows'] !== undefined && !isNonnegativeSafeInteger(candidate['requestedRows']))
      || (candidate['knownOmittedRows'] !== undefined && !isNonnegativeSafeInteger(candidate['knownOmittedRows']))
      || (outcome !== 'partial' && candidate['knownOmittedRows'] !== undefined)
    ) return undefined;
    return {
      ...(candidate['requestedRows'] === undefined ? {} : { requestedRows: candidate['requestedRows'] }),
      inputRowsRead: candidate['inputRowsRead'],
      rowsWritten: candidate['rowsWritten'],
      outcome,
      ...(cause === undefined ? {} : { cause: cause as DataExportCoverageCause }),
      ...(candidate['knownOmittedRows'] === undefined ? {} : { knownOmittedRows: candidate['knownOmittedRows'] }),
    };
  } catch {
    return undefined;
  }
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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

function safeWorkbookTabName(value: string, index: number): string {
  const title = value.trim().replace(/[\\/*?:[\]]+/g, '-').slice(0, 31).trim();
  return title || `Tab ${index + 1}`;
}

async function* readRows(
  path: string,
  maxRows = Number.POSITIVE_INFINITY,
): AsyncIterable<Record<string, unknown>> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let rowCount = 0;
  for await (const line of lines) {
    if (!line) continue;
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Data export spool contained a non-object row');
    }
    yield parsed as Record<string, unknown>;
    rowCount += 1;
    if (rowCount >= maxRows) return;
  }
}
