import type { ZohoBooksPaginatedClient } from '../../infrastructure/zoho/zoho-books-paginated.client';
import { mapZohoError } from './zoho-error.utils';
import {
  summarizeZohoWrite,
  unwrapZohoRecord,
  zohoRecordUrl,
  type ZohoWriteModule,
  type ZohoWriteSummary,
} from './zoho-books-write-result';

export interface ZohoBooksWriteVerification {
  readonly record: Record<string, unknown>;
  readonly summary: ZohoWriteSummary;
  /** True only when a post-write GET returned the same record id. */
  readonly verified: boolean;
  readonly message: string;
}

const label: Record<ZohoWriteModule, string> = {
  invoices:         'invoice',
  purchaseorders:   'purchase order',
  bills:            'bill',
  expenses:         'expense',
  contacts:         'contact',
  customerpayments: 'payment',
};

const withFallbackIdentity = (
  summary: ZohoWriteSummary,
  input: {
    readonly module: ZohoWriteModule;
    readonly recordId: string;
    readonly appBaseUrl: string;
    readonly organizationId?: string | undefined;
  },
): ZohoWriteSummary => {
  const recordUrl = summary.recordUrl ?? zohoRecordUrl({
    appBaseUrl: input.appBaseUrl,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    module: input.module,
    recordId: input.recordId,
  });
  return {
    ...summary,
    id: summary.id || input.recordId,
    ...(recordUrl ? { recordUrl } : {}),
  };
};

function unverifiedMessage(input: {
  readonly module: ZohoWriteModule;
  readonly recordId: string;
  readonly reason: string;
}): string {
  return `Zoho accepted the ${label[input.module]} create and returned id ${input.recordId}, `
    + `but Divo could not verify the stored record by read-back: ${input.reason}. `
    + 'Treat status, totals, balance, tax details, and attachments as unverified until the record can be read from Zoho.';
}

export async function verifyZohoBooksWrite(input: {
  readonly booksClient: ZohoBooksPaginatedClient;
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly organizationId?: string | undefined;
  readonly module: ZohoWriteModule;
  readonly verb: string;
  readonly recordId: string;
  readonly fallbackRecord?: Record<string, unknown>;
  readonly appBaseUrl: string;
  readonly signal?: AbortSignal;
}): Promise<ZohoBooksWriteVerification> {
  const fallbackRecord = input.fallbackRecord ?? {};
  const fallbackSummary = withFallbackIdentity(
    summarizeZohoWrite({
      module: input.module,
      verb: input.verb,
      record: fallbackRecord,
      appBaseUrl: input.appBaseUrl,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    }),
    input,
  );

  try {
    const payload = await input.booksClient.getEndpoint({
      companyId: input.companyId,
      userId: input.userId,
      connectionId: input.connectionId,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      path: `/${input.module}/${encodeURIComponent(input.recordId)}`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const record = unwrapZohoRecord(payload, input.module);
    const summary = summarizeZohoWrite({
      module: input.module,
      verb: input.verb,
      record,
      appBaseUrl: input.appBaseUrl,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    });
    if (!summary.id) {
      return {
        record: fallbackRecord,
        summary: fallbackSummary,
        verified: false,
        message: unverifiedMessage({
          module: input.module,
          recordId: input.recordId,
          reason: 'Zoho returned the record wrapper without a usable id',
        }),
      };
    }
    if (summary.id !== input.recordId) {
      return {
        record: fallbackRecord,
        summary: fallbackSummary,
        verified: false,
        message: unverifiedMessage({
          module: input.module,
          recordId: input.recordId,
          reason: `Zoho read-back returned a different id (${summary.id})`,
        }),
      };
    }
    return {
      record,
      summary,
      verified: true,
      message: summary.message,
    };
  } catch (error) {
    return {
      record: fallbackRecord,
      summary: fallbackSummary,
      verified: false,
      message: unverifiedMessage({
        module: input.module,
        recordId: input.recordId,
        reason: mapZohoError(error),
      }),
    };
  }
}
