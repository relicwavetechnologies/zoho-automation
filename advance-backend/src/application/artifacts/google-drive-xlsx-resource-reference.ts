export interface GoogleDriveXlsxReference {
  readonly provider: 'google';
  readonly kind: 'excel_workbook';
  readonly resourceId: string;
  readonly canonicalUrl: string;
}

export type GoogleDriveXlsxReferenceParseResult =
  | { readonly ok: true; readonly reference: GoogleDriveXlsxReference }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid_url'
        | 'unsupported_protocol'
        | 'unsupported_host'
        | 'unsupported_path'
        | 'invalid_file_id';
    };

const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;

export function parseGoogleDriveXlsxReference(input: string): GoogleDriveXlsxReferenceParseResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'unsupported_protocol' };
  if (
    url.hostname !== 'drive.google.com'
    || url.port
    || url.username
    || url.password
  ) return { ok: false, reason: 'unsupported_host' };

  const parts = url.pathname.split('/').filter(Boolean);
  let resourceId: string | undefined;
  if (parts.length === 4 && parts[0] === 'file' && parts[1] === 'd' && parts[3] === 'view') {
    resourceId = parts[2];
  } else if (parts.length === 1 && parts[0] === 'open' && url.searchParams.getAll('id').length === 1) {
    resourceId = url.searchParams.get('id') ?? undefined;
  } else {
    return { ok: false, reason: 'unsupported_path' };
  }

  if (!resourceId || !DRIVE_FILE_ID.test(resourceId)) {
    return { ok: false, reason: 'invalid_file_id' };
  }

  return {
    ok: true,
    reference: {
      provider: 'google',
      kind: 'excel_workbook',
      resourceId,
      canonicalUrl: `https://drive.google.com/file/d/${resourceId}/view`,
    },
  };
}
