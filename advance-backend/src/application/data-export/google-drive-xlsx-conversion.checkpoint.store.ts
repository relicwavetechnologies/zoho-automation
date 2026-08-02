import { sha256CanonicalJson } from '../../shared/hash';
import type { CachePort } from '../../shared/cache';
import type {
  GoogleDriveXlsxConversionCheckpointStore as GoogleDriveXlsxConversionCheckpointStorePort,
  GoogleDriveXlsxConversionCompletion,
  GoogleDriveXlsxConversionJob,
} from './google-drive-xlsx-conversion.worker';

export const GOOGLE_DRIVE_XLSX_CONVERSION_LEASE_TTL_SECONDS = 70;
export const GOOGLE_DRIVE_XLSX_CONVERSION_COMPLETION_TTL_SECONDS = 7 * 24 * 60 * 60;

type StoredCheckpoint = LeaseCheckpoint | CompletedCheckpoint;

interface LeaseCheckpoint {
  readonly version: 1;
  readonly status: 'leased';
  readonly requestFingerprint: string;
  readonly completionBinding: string;
}

interface CompletedCheckpoint {
  readonly version: 1;
  readonly status: 'completed';
  readonly completionBinding: string;
  readonly completionFingerprint: string;
  readonly completion: GoogleDriveXlsxConversionCompletion;
}

/**
 * Redis is the authority for conversion completion. A process-local map would
 * duplicate a Sheet after a restart, so it is deliberately not used here.
 */
export class GoogleDriveXlsxConversionCheckpointStore
  implements GoogleDriveXlsxConversionCheckpointStorePort {
  constructor(
    private readonly cache: CachePort,
    private readonly options: {
      readonly leaseTtlSeconds?: number;
      readonly completionTtlSeconds?: number;
    } = {},
  ) {}

  async claim(input: GoogleDriveXlsxConversionJob): Promise<
    | { readonly status: 'claimed' }
    | { readonly status: 'in_progress' }
    | { readonly status: 'completed'; readonly completion: GoogleDriveXlsxConversionCompletion }
  > {
    const key = checkpointKey(input.jobKey);
    const requestFingerprint = jobFingerprint(input);
    const completionBinding = completionBindingForJob(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.read(key);
      if (existing) return claimFromExisting(existing, requestFingerprint, completionBinding);
      const created = await this.cache.setNx(key, {
        version: 1,
        status: 'leased',
        requestFingerprint,
        completionBinding,
      } satisfies LeaseCheckpoint, this.options.leaseTtlSeconds ?? GOOGLE_DRIVE_XLSX_CONVERSION_LEASE_TTL_SECONDS);
      if (!created.ok) throw created.error;
      if (created.value) return { status: 'claimed' };
    }
    throw new Error('Could not acquire the workbook conversion checkpoint.');
  }

  async complete(input: GoogleDriveXlsxConversionCompletion): Promise<GoogleDriveXlsxConversionCompletion> {
    const key = checkpointKey(input.jobKey);
    const completionBinding = completionBindingFromCompletion(input);
    const fingerprint = completionFingerprint(input);
    const existing = await this.read(key);
    if (existing?.status === 'completed') {
      if (existing.completionBinding !== completionBinding || existing.completionFingerprint !== fingerprint) {
        throw new Error('Workbook conversion completion does not match its existing checkpoint.');
      }
      return existing.completion;
    }
    if (existing?.status === 'leased' && existing.completionBinding !== completionBinding) {
      throw new Error('Workbook conversion completion does not match its active checkpoint.');
    }
    const stored = await this.cache.set(key, {
      version: 1,
      status: 'completed',
      completionBinding,
      completionFingerprint: fingerprint,
      completion: input,
    } satisfies CompletedCheckpoint, this.options.completionTtlSeconds ?? GOOGLE_DRIVE_XLSX_CONVERSION_COMPLETION_TTL_SECONDS);
    if (!stored.ok) throw stored.error;
    return input;
  }

  private async read(key: string): Promise<StoredCheckpoint | null> {
    const result = await this.cache.get<StoredCheckpoint>(key);
    if (!result.ok) throw result.error;
    if (!result.value) return null;
    if (
      result.value.version !== 1
      || (result.value.status !== 'leased' && result.value.status !== 'completed')
    ) throw new Error('Workbook conversion checkpoint is invalid.');
    if (result.value.status === 'leased') {
      if (
        typeof result.value.requestFingerprint !== 'string'
        || typeof result.value.completionBinding !== 'string'
      ) throw new Error('Workbook conversion checkpoint is invalid.');
    } else if (
      typeof result.value.completionBinding !== 'string'
      || typeof result.value.completionFingerprint !== 'string'
      || !validCompletion(result.value.completion)
    ) {
      throw new Error('Workbook conversion completion checkpoint is invalid.');
    }
    return result.value;
  }
}

export function googleDriveXlsxConversionCheckpointKey(jobKey: string): string {
  if (!jobKey.trim()) throw new Error('Workbook conversion job key is required.');
  return `data-export:workbook-conversion:${sha256CanonicalJson(jobKey)}`;
}

function checkpointKey(jobKey: string): string {
  return googleDriveXlsxConversionCheckpointKey(jobKey);
}

function claimFromExisting(
  existing: StoredCheckpoint,
  requestFingerprint: string,
  completionBinding: string,
):
  | { readonly status: 'in_progress' }
  | { readonly status: 'completed'; readonly completion: GoogleDriveXlsxConversionCompletion } {
  if (existing.status === 'leased') {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new Error('Workbook conversion job key is already bound to a different request.');
    }
    return { status: 'in_progress' };
  }
  if (
    existing.completionBinding !== completionBinding
    || existing.completionFingerprint !== completionFingerprint(existing.completion)
  ) {
    throw new Error('Workbook conversion completion checkpoint is invalid.');
  }
  return { status: 'completed', completion: existing.completion };
}

function jobFingerprint(input: GoogleDriveXlsxConversionJob): string {
  return sha256CanonicalJson({
    jobKey: input.jobKey,
    companyId: input.companyId,
    userId: input.userId,
    sourceConnectionId: input.sourceConnectionId,
    sourceFileId: input.sourceFileId,
    sourceTitle: input.sourceTitle,
  });
}

function completionBindingForJob(input: GoogleDriveXlsxConversionJob): string {
  return sha256CanonicalJson({
    jobKey: input.jobKey,
    sourceFileId: input.sourceFileId,
  });
}

function completionBindingFromCompletion(input: GoogleDriveXlsxConversionCompletion): string {
  return sha256CanonicalJson({
    jobKey: input.jobKey,
    sourceFileId: input.sourceFileId,
  });
}

function completionFingerprint(input: GoogleDriveXlsxConversionCompletion): string {
  return sha256CanonicalJson(input);
}

function validCompletion(value: GoogleDriveXlsxConversionCompletion): boolean {
  return value.verified === true
    && typeof value.jobKey === 'string'
    && typeof value.sourceFileId === 'string'
    && typeof value.spreadsheetId === 'string'
    && typeof value.artifactUrl === 'string'
    && typeof value.ownerEmail === 'string';
}
