import { WriteNotDispatchedError } from '../../shared/errors';
import type { ZohoBooksPaginatedClient } from '../../infrastructure/zoho/zoho-books-paginated.client';
import {
  summarizeZohoWrite,
  unwrapZohoRecord,
  type ZohoWriteModule,
  type ZohoWriteSummary,
} from './zoho-books-write-result';
import { verifyZohoBooksWrite } from './zoho-books-write-verification';

export type ZohoBooksWriteFailure =
  | { readonly kind: 'not_dispatched'; readonly why: string }
  | { readonly kind: 'rejected'; readonly status: number; readonly why: string }
  | { readonly kind: 'unknown'; readonly why: string };

export interface ZohoBooksMutationRequest {
  readonly method: 'POST' | 'PUT';
  readonly path: string;
  readonly params?: Record<string, string>;
  readonly body?: Record<string, unknown>;
  readonly multipart?: {
    readonly field: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly content: Buffer;
  };
  readonly connectionId?: string;
  readonly organizationId?: string | undefined;
}

export interface ZohoBooksWrittenRecord {
  readonly organizationId: string;
  readonly record: Record<string, unknown>;
  readonly summary: ZohoWriteSummary;
}

export function classifyZohoBooksWriteFailure(
  error: unknown,
  options: { readonly receivedObject?: string } = {},
): ZohoBooksWriteFailure {
  const message = error instanceof Error ? error.message : String(error);
  const receivedObject = options.receivedObject ?? 'the write';

  if (error instanceof WriteNotDispatchedError) {
    return { kind: 'not_dispatched', why: message };
  }

  const status = /Zoho Books (\d{3})/.exec(message)?.[1];
  if (!status) {
    return { kind: 'unknown', why: 'the connection to Zoho failed before it answered' };
  }

  const code = Number(status);
  if (code === 408) {
    return { kind: 'unknown', why: 'Zoho timed out, which does not say whether it finished writing first' };
  }
  if (code === 429) {
    return { kind: 'unknown', why: 'Zoho rate-limited the request, which does not prove it was never processed' };
  }
  if (code >= 500) {
    return { kind: 'unknown', why: `Zoho returned a ${code} after receiving ${receivedObject}` };
  }
  if (code >= 400) {
    return { kind: 'rejected', status: code, why: `Zoho refused ${receivedObject} with a ${code} and wrote nothing` };
  }
  return { kind: 'unknown', why: `Zoho answered with an unexpected ${code}` };
}

export function createZohoBooksWriteRunner(input: {
  readonly booksClient: ZohoBooksPaginatedClient;
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly organizationId?: string | undefined;
  readonly signal?: AbortSignal;
  readonly appBaseUrl: string;
}) {
  const mutate = async (request: ZohoBooksMutationRequest) => {
    const organizationId = request.organizationId ?? input.organizationId;
    return input.booksClient.mutate({
      companyId: input.companyId,
      userId: input.userId,
      connectionId: request.connectionId ?? input.connectionId,
      method: request.method,
      path: request.path,
      ...(organizationId ? { organizationId } : {}),
      ...(request.params ? { params: request.params } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(request.multipart ? { multipart: request.multipart } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  };

  const writeRecord = async (
    request: ZohoBooksMutationRequest & {
      readonly module: ZohoWriteModule;
      readonly verb: string;
    },
  ): Promise<ZohoBooksWrittenRecord> => {
    const { module, verb, ...mutation } = request;
    const { organizationId, payload } = await mutate(mutation);
    const record = unwrapZohoRecord(payload, module);
    const summary = summarizeZohoWrite({
      module,
      verb,
      record,
      appBaseUrl: input.appBaseUrl,
      organizationId,
    });
    return { organizationId, record, summary };
  };

  const verifyRecord = async (request: {
    readonly module: ZohoWriteModule;
    readonly verb: string;
    readonly recordId: string;
    readonly fallbackRecord?: Record<string, unknown>;
    readonly connectionId?: string;
    readonly organizationId?: string | undefined;
  }) => verifyZohoBooksWrite({
    booksClient: input.booksClient,
    companyId: input.companyId,
    userId: input.userId,
    connectionId: request.connectionId ?? input.connectionId,
    ...(request.organizationId ?? input.organizationId
      ? { organizationId: request.organizationId ?? input.organizationId }
      : {}),
    module: request.module,
    verb: request.verb,
    recordId: request.recordId,
    ...(request.fallbackRecord ? { fallbackRecord: request.fallbackRecord } : {}),
    appBaseUrl: input.appBaseUrl,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  return { mutate, writeRecord, verifyRecord };
}
