export interface GoogleSheetReference {
  readonly provider: 'google';
  readonly kind: 'spreadsheet';
  readonly resourceId: string;
  readonly subresourceId?: string;
  readonly canonicalUrl: string;
}

export type GoogleSheetReferenceParseResult =
  | { readonly ok: true; readonly reference: GoogleSheetReference }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid_url'
        | 'unsupported_protocol'
        | 'unsupported_host'
        | 'unsupported_path'
        | 'invalid_spreadsheet_id'
        | 'invalid_gid';
    };

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{1,256}$/;
const SHEET_GID = /^(?:0|[1-9][0-9]{0,19})$/;

export function parseGoogleSheetReference(input: string): GoogleSheetReferenceParseResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'unsupported_protocol' };
  if (
    url.hostname !== 'docs.google.com'
    || url.port
    || url.username
    || url.password
  ) return { ok: false, reason: 'unsupported_host' };

  const parts = url.pathname.split('/').filter(Boolean);
  if (
    parts[0] !== 'spreadsheets'
    || parts[1] !== 'd'
    || parts.length < 3
    || parts.length > 4
    || (parts.length === 4 && parts[3] !== 'edit')
  ) return { ok: false, reason: 'unsupported_path' };

  const resourceId = parts[2]!;
  if (!SPREADSHEET_ID.test(resourceId)) {
    return { ok: false, reason: 'invalid_spreadsheet_id' };
  }

  const queryGids = url.searchParams.getAll('gid');
  const fragmentGids = new URLSearchParams(url.hash.slice(1)).getAll('gid');
  if (queryGids.length > 1 || fragmentGids.length > 1) {
    return { ok: false, reason: 'invalid_gid' };
  }
  const queryGid = queryGids[0];
  const fragmentGid = fragmentGids[0];
  if (queryGid !== undefined && fragmentGid !== undefined && queryGid !== fragmentGid) {
    return { ok: false, reason: 'invalid_gid' };
  }
  const subresourceId = fragmentGid ?? queryGid ?? undefined;
  if (
    subresourceId !== undefined
    && (
      !SHEET_GID.test(subresourceId)
      || !Number.isSafeInteger(Number(subresourceId))
    )
  ) {
    return { ok: false, reason: 'invalid_gid' };
  }

  const canonicalUrl = `https://docs.google.com/spreadsheets/d/${resourceId}/edit${
    subresourceId === undefined ? '' : `#gid=${subresourceId}`
  }`;
  return {
    ok: true,
    reference: {
      provider: 'google',
      kind: 'spreadsheet',
      resourceId,
      ...(subresourceId === undefined ? {} : { subresourceId }),
      canonicalUrl,
    },
  };
}
