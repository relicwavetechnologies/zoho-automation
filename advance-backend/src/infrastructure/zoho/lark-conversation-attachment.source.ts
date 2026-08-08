/**
 * Turns a filename the member used into the bytes Zoho needs.
 *
 * Every failure here is reported as a refusal with a reason, never as an empty
 * success — the caller is about to tell someone whether a document is on their
 * invoice, and "we could not find it" and "it is attached" must never be
 * confusable.
 */

import type { Logger } from '../../shared/logger';
import type { ConversationAttachmentService } from '../../application/conversation-attachments/conversation-attachment.service';
import type { ZohoAttachmentSourcePort } from '../../application/tools/families/zoho-books.tool';
import type { LarkFileClient } from '../channels/lark/clients/lark-file.client';

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class LarkConversationAttachmentSource implements ZohoAttachmentSourcePort {
  constructor(
    private readonly attachments: ConversationAttachmentService,
    private readonly files: Pick<LarkFileClient, 'downloadFile'>,
    private readonly logger: Logger,
  ) {}

  async resolve(input: {
    companyId:       string;
    userId:          string;
    channel:         string;
    conversationKey: string;
    fileName:        string;
  }) {
    const lookup = await this.attachments.lookup(input);

    if (lookup.kind === 'not_found') {
      return {
        kind: 'unavailable' as const,
        message: lookup.available.length > 0
          ? `No file called "${input.fileName}" was sent in this conversation. `
            + `Files available here: ${lookup.available.join(', ')}. Use one of those names exactly, or ask the member to send the file again.`
          : `No file called "${input.fileName}" was sent in this conversation, and Divo is not holding any file here. Ask the member to send it.`,
      };
    }

    if (lookup.kind === 'ambiguous') {
      const when = lookup.matches
        .map(row => row.receivedAt.toISOString())
        .join(', ');
      return {
        kind: 'unavailable' as const,
        message: `More than one different file called "${input.fileName}" was sent in this conversation (received ${when}). `
          + 'Divo will not guess which one belongs on this record — ask the member to re-send the exact file, or rename it.',
      };
    }

    try {
      const content = await this.files.downloadFile(
        lookup.row.larkMessageId,
        lookup.row.larkFileKey,
        MAX_DOWNLOAD_BYTES,
      );
      return {
        kind: 'resolved' as const,
        fileName: lookup.row.fileName,
        mimeType: lookup.row.mimeType || 'application/octet-stream',
        content,
      };
    } catch (error) {
      this.logger.warn('conversation_attachment.download_failed', {
        companyId: input.companyId,
        fileName: input.fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        kind: 'unavailable' as const,
        message: `Divo found "${lookup.row.fileName}" in this conversation but could not download it from Lark. `
          + 'The record was not changed. Ask the member to send the file again.',
      };
    }
  }
}
