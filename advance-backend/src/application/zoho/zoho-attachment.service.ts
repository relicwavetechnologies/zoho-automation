/**
 * Attaches member-sent files to Zoho Books records and proves the upload.
 *
 * The model names a file; it never handles provider file keys or bytes. This
 * module resolves the file from the current conversation, validates attachment
 * policy, uploads through the governed Zoho writer, and then re-reads the Zoho
 * record so "attached" only means Zoho lists the document.
 */

import type { ZohoBooksModule } from '../../infrastructure/zoho/zoho-books-paginated.client';
import { WriteNotDispatchedError } from '../../shared/errors';
import { validateAttachmentPolicy } from '../email/attachment-policy';
import type { ZohoBooksMutationRequest } from './zoho-books-write';
import { attachedDocumentNames } from './zoho-books-write-result';
import { mapZohoError } from './zoho-error.utils';

export interface ZohoAttachmentSourcePort {
  resolve(input: {
    companyId: string;
    userId: string;
    channel: string;
    chatId: string;
    fileName: string;
  }): Promise<
    | {
        readonly kind: 'resolved';
        readonly fileName: string;
        readonly mimeType: string;
        readonly content: Buffer;
        readonly onAttached?: () => Promise<void>;
        readonly onUnconfirmed?: () => Promise<void>;
      }
    | { readonly kind: 'unavailable'; readonly message: string }
  >;
}

export type ZohoAttachableRecordType = 'invoice' | 'purchase_order' | 'bill';

export type ZohoAttachmentOutcome =
  | { readonly outcome: 'attached'; readonly message: string }
  | { readonly outcome: 'unconfirmed'; readonly message: string }
  | { readonly outcome: 'refused'; readonly message: string };

const attachModule: Record<ZohoAttachableRecordType, ZohoBooksModule> = {
  invoice: 'invoices',
  purchase_order: 'purchaseorders',
  bill: 'bills',
};

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function createZohoAttachmentService(input: {
  readonly attachmentSource?: ZohoAttachmentSourcePort;
  readonly companyId: string;
  readonly userId: string;
  readonly channel: string;
  readonly chatId?: string | undefined;
  readonly readRecord: (
    moduleName: ZohoBooksModule,
    recordId: string,
    destination?: { connectionId: string; organizationId?: string | undefined },
  ) => Promise<Record<string, unknown>>;
  readonly write: (request: ZohoBooksMutationRequest) => Promise<unknown>;
  readonly onProgress?: (message: string) => void;
}) {
  const attach = async (request: {
    readonly recordType: ZohoAttachableRecordType;
    readonly recordId: string;
    readonly fileName: string;
    readonly destination?: { connectionId: string; organizationId?: string | undefined };
  }): Promise<ZohoAttachmentOutcome> => {
    const { recordType, recordId, fileName } = request;
    if (!input.attachmentSource) {
      return {
        outcome: 'refused',
        message: `Divo cannot attach files from the ${input.channel} channel yet.`,
      };
    }
    if (!input.chatId) {
      return {
        outcome: 'refused',
        message: 'Divo cannot tell which conversation this file was sent in, so it will not guess at one.',
      };
    }

    const moduleName = attachModule[recordType];
    const readDocuments = async () => {
      try {
        return attachedDocumentNames(await input.readRecord(moduleName, recordId, request.destination));
      } catch {
        return null;
      }
    };

    // Zoho appends rather than replaces, so an unchecked retry leaves the same
    // PDF on the record twice. For Lark this can stay an idempotent retry guard:
    // the source file is external and stable. Web uploads are different because
    // the member may have uploaded a corrected file with the same local name, so
    // resolve that current upload before deciding whether a same-name Zoho
    // document is safe.
    const before = await readDocuments();
    if (input.channel !== 'web' && before?.some(name => sameName(name, fileName))) {
      return { outcome: 'attached', message: `"${fileName}" was already attached; it was not uploaded again.` };
    }

    const resolved = await input.attachmentSource.resolve({
      companyId: input.companyId,
      userId: input.userId,
      channel: input.channel,
      chatId: input.chatId,
      fileName,
    });
    if (resolved.kind === 'unavailable') return { outcome: 'refused', message: resolved.message };
    if (input.channel === 'web' && before?.some(name => sameName(name, resolved.fileName))) {
      return {
        outcome: 'refused',
        message: `Zoho already has a document named "${resolved.fileName}" on this ${recordType}. Rename the uploaded file and try again so Divo can prove it attached the current upload.`,
      };
    }

    const policy = validateAttachmentPolicy([{
      fileName: resolved.fileName,
      mimeType: resolved.mimeType,
      sizeBytes: resolved.content.length,
      content: resolved.content,
      source: 'lark',
    }]);
    if (!policy.ok) return { outcome: 'refused', message: policy.error.message };

    input.onProgress?.(`Attaching ${resolved.fileName} to the ${recordType}…`);
    try {
      await input.write({
        method: 'POST',
        path: `/${moduleName}/${encodeURIComponent(recordId)}/attachment`,
        ...(request.destination
          ? {
              connectionId: request.destination.connectionId,
              ...(request.destination.organizationId ? { organizationId: request.destination.organizationId } : {}),
            }
          : {}),
        multipart: {
          field: 'attachment',
          fileName: resolved.fileName,
          mimeType: resolved.mimeType,
          content: resolved.content,
        },
      });
    } catch (error) {
      // A dispatched upload that then failed may still have landed, so this
      // cannot claim the record is untouched.
      if (error instanceof WriteNotDispatchedError) {
        return { outcome: 'refused', message: `The upload was never sent: ${error.message}` };
      }
      await resolved.onUnconfirmed?.().catch(() => undefined);
      return { outcome: 'unconfirmed', message: `Zoho did not accept the upload cleanly: ${mapZohoError(error)}` };
    }

    // Zoho's own record is the only proof the upload landed.
    const after = await readDocuments();
    if (after === null) {
      await resolved.onUnconfirmed?.().catch(() => undefined);
      return {
        outcome: 'unconfirmed',
        message: `Zoho accepted "${resolved.fileName}" but the record could not be re-read, so the attachment is unconfirmed.`,
      };
    }
    if (after.some(name => sameName(name, resolved.fileName))) {
      await resolved.onAttached?.().catch(() => undefined);
      return { outcome: 'attached', message: `Attached "${resolved.fileName}". Zoho now lists: ${after.join(', ')}.` };
    }
    await resolved.onUnconfirmed?.().catch(() => undefined);
    return {
      outcome: 'unconfirmed',
      message: `Zoho accepted the upload but does not list "${resolved.fileName}" on the ${recordType}. Treat the attachment as unconfirmed.`,
    };
  };

  return { attach };
}
