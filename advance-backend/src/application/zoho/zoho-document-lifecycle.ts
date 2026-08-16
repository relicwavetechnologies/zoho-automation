import {
  classifyZohoBooksWriteFailure,
  type ZohoBooksMutationRequest,
  type ZohoBooksWriteFailure,
  type ZohoBooksWrittenRecord,
} from './zoho-books-write';
import type {
  ZohoWriteModule,
  ZohoWriteSummary,
} from './zoho-books-write-result';
import type { ZohoBooksWriteVerification } from './zoho-books-write-verification';

/**
 * The document-specific modules own staging, claims, recovery, and settlement.
 * This is the shared provider seam underneath them: one write contract and one
 * classification of what Zoho's response means.
 *
 * A rejected request is safe to release, an unknown request must be treated as
 * possibly written, and an accepted response without an id is also unknown.
 * Keeping those three outcomes here prevents invoice, bill, and purchase-order
 * paths from drifting on the one distinction that protects against duplicates.
 */
export interface ZohoDocumentWriter {
  writeRecord(
    request: ZohoBooksMutationRequest & {
      readonly module: ZohoWriteModule;
      readonly verb: string;
    },
  ): Promise<ZohoBooksWrittenRecord>;
}

export interface ZohoDocumentVerifier {
  verifyRecord(
    request: {
      readonly module: ZohoWriteModule;
      readonly verb: string;
      readonly recordId: string;
      readonly fallbackRecord?: Record<string, unknown>;
    },
  ): Promise<ZohoBooksWriteVerification>;
}

export type ZohoDocumentWriteOutcome =
  | {
      readonly kind: 'created';
      readonly written: ZohoBooksWrittenRecord;
    }
  | {
      readonly kind: 'missing_id';
      readonly written: ZohoBooksWrittenRecord;
    }
  | {
      readonly kind: 'failed';
      readonly error: unknown;
      readonly failure: ZohoBooksWriteFailure;
    };

export async function writeZohoDocument(input: {
  readonly writer: ZohoDocumentWriter;
  readonly request: ZohoBooksMutationRequest & {
    readonly module: ZohoWriteModule;
    readonly verb: string;
  };
  readonly receivedObject: string;
}): Promise<ZohoDocumentWriteOutcome> {
  try {
    const written = await input.writer.writeRecord(input.request);
    return written.summary.id
      ? { kind: 'created', written }
      : { kind: 'missing_id', written };
  } catch (error) {
    return {
      kind: 'failed',
      error,
      failure: classifyZohoBooksWriteFailure(error, {
        receivedObject: input.receivedObject,
      }),
    };
  }
}

export type ZohoDocumentAttachment = {
  readonly outcome: 'attached' | 'unconfirmed' | 'refused';
  readonly message: string;
};

export interface ZohoDocumentCompletion {
  readonly record: Record<string, unknown>;
  readonly summary: ZohoWriteSummary;
  readonly verification: ZohoBooksWriteVerification;
  readonly attachment?: ZohoDocumentAttachment;
}

/**
 * Completes the common post-write sequence. The order is deliberate:
 *
 * 1. settle the claimed draft only after Zoho returned an id;
 * 2. attach only the file the approved draft named;
 * 3. read the record back after the attachment attempt.
 *
 * Document modules still choose their own attachment wording and any extra
 * drift/recovery rules. This module owns the invariant that a success reply is
 * based on Zoho's stored record, not just the create response.
 */
export async function completeZohoDocument(input: {
  readonly writer: ZohoDocumentWriter & ZohoDocumentVerifier;
  readonly module: ZohoWriteModule;
  readonly verb: string;
  readonly written: ZohoBooksWrittenRecord;
  readonly settle: (recordId: string) => Promise<void>;
  readonly attach?: () => Promise<ZohoDocumentAttachment>;
}): Promise<ZohoDocumentCompletion> {
  const recordId = input.written.summary.id;
  await input.settle(recordId);
  const attachment = input.attach ? await input.attach() : undefined;
  const verification = await input.writer.verifyRecord({
    module: input.module,
    verb: input.verb,
    recordId,
    fallbackRecord: input.written.record,
  });
  return {
    record: verification.record,
    summary: verification.summary,
    verification,
    ...(attachment ? { attachment } : {}),
  };
}
