export const DATA_EXPORT_RESOURCE_TOOL = 'dataExportResource';
export const DATA_EXPORT_RESOURCE_TTL_MS = 7 * 24 * 60 * 60_000;

export interface DataExportResourceRecord {
  readonly version: 1;
  readonly kind: 'data_export_resource';
  readonly resourceRef: string;
  readonly ownerUserId: string;
  readonly artifactId: string;
  readonly artifactUrl: string;
  readonly artifactType: 'google_sheet' | 'csv' | 'xlsx';
  readonly rowCount?: number;
  readonly connectionId?: string;
  readonly spreadsheetId?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export function parseDataExportResourceRecord(value: unknown): DataExportResourceRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record['version'] !== 1
    || record['kind'] !== 'data_export_resource'
    || typeof record['resourceRef'] !== 'string'
    || typeof record['ownerUserId'] !== 'string'
    || typeof record['artifactId'] !== 'string'
    || typeof record['artifactUrl'] !== 'string'
    || !['google_sheet', 'csv', 'xlsx'].includes(String(record['artifactType']))
    || (record['rowCount'] !== undefined && typeof record['rowCount'] !== 'number')
    || typeof record['createdAt'] !== 'string'
    || typeof record['expiresAt'] !== 'string'
  ) return null;
  return record as unknown as DataExportResourceRecord;
}
