import type { Logger } from '../../shared/logger';
import type { ConversationAttachmentAssetService } from '../../application/conversation-attachments/conversation-attachment-asset.service';
import type { ZohoAttachmentSourcePort } from '../../application/zoho/zoho-attachment.service';

const MAX_PREVIEW_NAMES = 10;

function renamedSuggestion(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0
    ? `${fileName.slice(0, dot)}-2${fileName.slice(dot)}`
    : `${fileName}-2`;
}

export class WebConversationAttachmentSource implements ZohoAttachmentSourcePort {
  constructor(
    private readonly assets: ConversationAttachmentAssetService,
    private readonly logger: Logger,
  ) {}

  async resolve(input: {
    companyId: string;
    userId:    string;
    channel:   string;
    chatId:    string;
    fileName:  string;
  }) {
    const lookup = await this.assets.lookup(input);

    if (lookup.kind === 'not_found') {
      const available = lookup.available.slice(0, MAX_PREVIEW_NAMES);
      return {
        kind: 'unavailable' as const,
        message: available.length > 0
          ? `No file called "${input.fileName}" is held for this web conversation. `
            + `Files available here: ${available.join(', ')}. Use one of those names exactly, or ask the member to upload the file again.`
          : `No file called "${input.fileName}" is held for this web conversation. Ask the member to upload it again.`,
      };
    }

    if (lookup.kind === 'ambiguous') {
      const when = lookup.matches
        .map(row => row.receivedAt.toISOString())
        .join(', ');
      return {
        kind: 'unavailable' as const,
        message: `More than one different file called "${input.fileName}" was uploaded in this web conversation (received ${when}). `
          + 'Divo will not guess which one belongs on this record. Ask the member to upload the file again under a '
          + `distinct name, such as "${renamedSuggestion(input.fileName)}", and use that name.`,
      };
    }

    try {
      const content = await this.assets.read(lookup.asset);
      return {
        kind: 'resolved' as const,
        fileName: lookup.asset.fileName,
        mimeType: lookup.asset.mimeType || 'application/octet-stream',
        content,
        onAttached: () => this.assets.markConsumed(lookup.asset),
        onUnconfirmed: () => this.assets.markUncertain(lookup.asset),
      };
    } catch (error) {
      this.logger.warn('conversation_attachment_asset.read_failed', {
        companyId: input.companyId,
        fileName: input.fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        kind: 'unavailable' as const,
        message: `Divo found "${lookup.asset.fileName}" in this web conversation but could not reopen it from private storage. `
          + 'The record was not changed. Ask the member to upload the file again.',
      };
    }
  }
}
