import { GOOGLE_SCOPE, hasGoogleScopeGroups } from '../../domain/google/google-workspace-scope';

const GOOGLE_SHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DEFAULT_MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const FAILURE_MESSAGE =
  'Divo could not convert this Excel workbook. The original file was not changed. Please try again shortly.';

/**
 * Durable conversion work. Its key must be the exact confirmed offer/job key,
 * rather than a user-provided file name or URL.
 */
export interface GoogleDriveXlsxConversionJob {
  readonly jobKey: string;
  readonly companyId: string;
  readonly userId: string;
  readonly sourceConnectionId: string;
  readonly sourceFileId: string;
  readonly sourceTitle: string;
}

export interface GoogleDriveXlsxConversionCompletion {
  readonly jobKey: string;
  readonly sourceFileId: string;
  readonly spreadsheetId: string;
  readonly artifactUrl: string;
  readonly ownerEmail: string;
  readonly verified: true;
}

export type GoogleDriveXlsxConversionResult =
  | { readonly disposition: 'completed'; readonly completion: GoogleDriveXlsxConversionCompletion }
  | { readonly disposition: 'in_progress' };

export interface GoogleDriveXlsxConversionIdentity {
  readonly companyId: string;
  readonly userId: string;
  readonly active: boolean;
}

export interface GoogleDriveXlsxConversionConnection {
  readonly connectionId: string;
  readonly companyId: string;
  readonly ownerType: 'user' | 'company';
  readonly ownerUserId?: string;
  readonly status: 'connected' | 'revoked' | 'expired';
  readonly accountEmail?: string;
  readonly scopes: readonly string[];
}

export interface GoogleDriveXlsxSourceMetadata {
  readonly id?: string;
  readonly mimeType?: string;
  readonly trashed?: boolean;
  readonly capabilities?: {
    readonly canDownload?: boolean;
    readonly canCopy?: boolean;
  };
}

export interface GoogleDriveXlsxCreatedSheetMetadata {
  readonly id?: string;
  readonly mimeType?: string;
  readonly trashed?: boolean;
  readonly ownerEmail?: string;
  readonly webViewLink?: string;
}

export interface GoogleDriveXlsxConversionCheckpointStore {
  /**
   * Acquires a durable, expiring execution lease for this exact conversion.
   * Implementations must return `in_progress` for a competing live lease.
   */
  claim(input: GoogleDriveXlsxConversionJob): Promise<
    | { readonly status: 'claimed' }
    | { readonly status: 'in_progress' }
    | { readonly status: 'completed'; readonly completion: GoogleDriveXlsxConversionCompletion }
  >;
  complete(input: GoogleDriveXlsxConversionCompletion): Promise<GoogleDriveXlsxConversionCompletion>;
}

export interface GoogleDriveXlsxConversionWorkerDeps {
  readonly checkpoints: GoogleDriveXlsxConversionCheckpointStore;
  readonly identity: {
    resolve(input: Pick<GoogleDriveXlsxConversionJob, 'companyId' | 'userId'>): Promise<GoogleDriveXlsxConversionIdentity | null>;
  };
  readonly permissions: {
    canReadDriveXlsx(input: Pick<GoogleDriveXlsxConversionJob, 'companyId' | 'userId'>): Promise<boolean>;
    canCreateGoogleSheet(input: Pick<GoogleDriveXlsxConversionJob, 'companyId' | 'userId'>): Promise<boolean>;
  };
  /** This port resolves server-side OAuth only; no credential crosses this worker boundary. */
  readonly connections: {
    resolve(input: Pick<GoogleDriveXlsxConversionJob, 'companyId' | 'userId' | 'sourceConnectionId'>): Promise<GoogleDriveXlsxConversionConnection | null>;
  };
  readonly drive: {
    getSourceMetadata(input: Pick<GoogleDriveXlsxConversionJob, 'sourceConnectionId' | 'sourceFileId'>): Promise<GoogleDriveXlsxSourceMetadata | null>;
    downloadXlsx(input: Pick<GoogleDriveXlsxConversionJob, 'sourceConnectionId' | 'sourceFileId'>): Promise<AsyncIterable<Uint8Array>>;
    /**
     * Must search only for a prior Divo-created resource tagged with this
     * exact idempotency key. It must not search by title.
     */
    findCreatedSheet(input: {
      readonly connectionId: string;
      readonly idempotencyKey: string;
    }): Promise<{ readonly spreadsheetId: string } | null>;
    /**
     * Creates a new native Sheet from the supplied XLSX bytes. Implementations
     * must persist idempotencyKey as private Drive metadata before returning.
     */
    importXlsxAsNewSheet(input: {
      readonly connectionId: string;
      readonly sourceFileId: string;
      readonly sourceTitle: string;
      readonly idempotencyKey: string;
      readonly content: AsyncIterable<Uint8Array>;
    }): Promise<{ readonly spreadsheetId: string }>;
    getCreatedSheetMetadata(input: {
      readonly connectionId: string;
      readonly spreadsheetId: string;
    }): Promise<GoogleDriveXlsxCreatedSheetMetadata | null>;
  };
  /** Persists a verified, requester-scoped continuation handle; never OAuth material. */
  readonly continuity: {
    record(input: {
      readonly job: GoogleDriveXlsxConversionJob;
      readonly completion: GoogleDriveXlsxConversionCompletion;
    }): Promise<void>;
  };
  /** Every method must be idempotent by jobKey. */
  readonly delivery: {
    progress(input: { readonly jobKey: string; readonly content: string }): Promise<void>;
    completed(input: { readonly jobKey: string; readonly completion: GoogleDriveXlsxConversionCompletion }): Promise<void>;
    failed(input: { readonly jobKey: string; readonly content: string }): Promise<void>;
  };
  readonly maxSourceBytes?: number;
}

/**
 * Core only: a BullMQ adapter supplies attempts/finalAttempt and retries
 * thrown failures. The user receives only the fixed safe failure copy.
 */
export class GoogleDriveXlsxConversionWorker {
  constructor(private readonly deps: GoogleDriveXlsxConversionWorkerDeps) {}

  async process(
    job: GoogleDriveXlsxConversionJob,
    options: { readonly finalAttempt: boolean },
  ): Promise<GoogleDriveXlsxConversionResult> {
    try {
      const claimed = await this.deps.checkpoints.claim(job);
      if (claimed.status === 'in_progress') return { disposition: 'in_progress' };
      if (claimed.status === 'completed') {
        await this.deps.delivery.completed({ jobKey: job.jobKey, completion: claimed.completion });
        return { disposition: 'completed', completion: claimed.completion };
      }

      await this.revalidate(job);
      await this.deps.delivery.progress({
        jobKey: job.jobKey,
        content: 'Divo is creating a new Google Sheets copy. Your original Excel file will not be changed.',
      });

      const existing = await this.deps.drive.findCreatedSheet({
        connectionId: job.sourceConnectionId,
        idempotencyKey: job.jobKey,
      });
      const spreadsheetId = existing?.spreadsheetId ?? await this.importNewSheet(job);
      const completion = await this.verifyCompletion(job, spreadsheetId);
      const persisted = await this.deps.checkpoints.complete(completion);
      await this.deps.continuity.record({ job, completion: persisted });
      await this.deps.delivery.completed({ jobKey: job.jobKey, completion: persisted });
      return { disposition: 'completed', completion: persisted };
    } catch (error) {
      if (options.finalAttempt) {
        await this.deps.delivery.failed({ jobKey: job.jobKey, content: FAILURE_MESSAGE });
      }
      throw error;
    }
  }

  private async revalidate(job: GoogleDriveXlsxConversionJob): Promise<void> {
    const identity = await this.deps.identity.resolve(job);
    if (!identity || !identity.active || identity.companyId !== job.companyId || identity.userId !== job.userId) {
      throw new GoogleDriveXlsxConversionError('The requester no longer has active company access.', true);
    }
    const [canRead, canCreate] = await Promise.all([
      this.deps.permissions.canReadDriveXlsx(job),
      this.deps.permissions.canCreateGoogleSheet(job),
    ]);
    if (!canRead || !canCreate) {
      throw new GoogleDriveXlsxConversionError('Google conversion permission was revoked.', true);
    }
    const connection = await this.deps.connections.resolve(job);
    if (
      !connection
      || connection.connectionId !== job.sourceConnectionId
      || connection.companyId !== job.companyId
      || connection.ownerType !== 'user'
      || connection.ownerUserId !== job.userId
      || connection.status !== 'connected'
      || !normalizedEmail(connection.accountEmail)
      || !hasGoogleScopeGroups(connection.scopes, [[GOOGLE_SCOPE.driveFull], [GOOGLE_SCOPE.sheetsFull]])
    ) {
      throw new GoogleDriveXlsxConversionError('The selected personal Google account is no longer eligible.', true);
    }
    const source = await this.deps.drive.getSourceMetadata(job);
    if (
      !source
      || source.id !== job.sourceFileId
      || source.mimeType !== XLSX_MIME_TYPE
      || source.trashed === true
      || source.capabilities?.canDownload !== true
      || source.capabilities?.canCopy !== true
    ) {
      throw new GoogleDriveXlsxConversionError('The Excel source is no longer available for conversion.', true);
    }
  }

  private async importNewSheet(job: GoogleDriveXlsxConversionJob): Promise<string> {
    const source = await this.deps.drive.downloadXlsx(job);
    const result = await this.deps.drive.importXlsxAsNewSheet({
      connectionId: job.sourceConnectionId,
      sourceFileId: job.sourceFileId,
      sourceTitle: job.sourceTitle,
      idempotencyKey: job.jobKey,
      content: limitBytes(source, this.deps.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES),
    });
    if (!isResourceId(result.spreadsheetId)) {
      throw new GoogleDriveXlsxConversionError('Google did not identify the converted Sheet.');
    }
    return result.spreadsheetId;
  }

  private async verifyCompletion(
    job: GoogleDriveXlsxConversionJob,
    spreadsheetId: string,
  ): Promise<GoogleDriveXlsxConversionCompletion> {
    const connection = await this.deps.connections.resolve(job);
    const expectedOwner = normalizedEmail(connection?.accountEmail);
    if (
      !connection
      || connection.connectionId !== job.sourceConnectionId
      || connection.companyId !== job.companyId
      || connection.ownerType !== 'user'
      || connection.ownerUserId !== job.userId
      || connection.status !== 'connected'
      || !expectedOwner
      || !hasGoogleScopeGroups(connection.scopes, [[GOOGLE_SCOPE.driveFull], [GOOGLE_SCOPE.sheetsFull]])
    ) throw new GoogleDriveXlsxConversionError('The selected personal Google account is no longer eligible.', true);
    const created = await this.deps.drive.getCreatedSheetMetadata({
      connectionId: job.sourceConnectionId,
      spreadsheetId,
    });
    const owner = normalizedEmail(created?.ownerEmail);
    const artifactUrl = canonicalGoogleSheetUrl(created?.webViewLink, spreadsheetId);
    if (
      !created
      || created.id !== spreadsheetId
      || created.mimeType !== GOOGLE_SHEET_MIME_TYPE
      || created.trashed === true
      || !owner
      || owner !== expectedOwner
      || !artifactUrl
    ) {
      throw new GoogleDriveXlsxConversionError('The converted Google Sheet could not be verified.');
    }
    return {
      jobKey: job.jobKey,
      sourceFileId: job.sourceFileId,
      spreadsheetId,
      artifactUrl,
      ownerEmail: owner,
      verified: true,
    };
  }
}

export class GoogleDriveXlsxConversionError extends Error {
  constructor(message: string, readonly unrecoverable = false) {
    super(message);
    this.name = 'GoogleDriveXlsxConversionError';
  }
}

async function* limitBytes(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncIterable<Uint8Array> {
  let bytes = 0;
  let chunks = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new GoogleDriveXlsxConversionError('Drive returned invalid Excel content.');
    bytes += chunk.byteLength;
    chunks += 1;
    if (bytes > maxBytes) {
      throw new GoogleDriveXlsxConversionError('The Excel workbook is too large for safe conversion.', true);
    }
    yield chunk;
  }
  if (chunks === 0) throw new GoogleDriveXlsxConversionError('The Excel workbook was empty.');
}

function canonicalGoogleSheetUrl(value: string | undefined, spreadsheetId: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'docs.google.com'
      || url.port
      || url.username
      || url.password
    ) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (
      parts[0] !== 'spreadsheets'
      || parts[1] !== 'd'
      || parts[2] !== spreadsheetId
      || !isResourceId(spreadsheetId)
    ) return null;
    return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  } catch {
    return null;
  }
}

function normalizedEmail(value: string | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email && /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}

function isResourceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,256}$/.test(value);
}
