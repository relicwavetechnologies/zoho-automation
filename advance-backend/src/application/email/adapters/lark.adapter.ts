import type { LarkFileClient } from '../../../infrastructure/channels/lark/clients/lark-file.client';
import type {
  AttachmentRef,
  AttachmentResolveContext,
  AttachmentSourceAdapter,
  ResolvedAttachment,
} from '../attachment.types';

export class LarkAttachmentAdapter implements AttachmentSourceAdapter {
  readonly source = 'lark' as const;

  constructor(private readonly larkFileClient: Pick<LarkFileClient, 'downloadFile'>) {}

  async resolve(ref: AttachmentRef, _ctx: AttachmentResolveContext): Promise<ResolvedAttachment> {
    if (ref.source !== 'lark') {
      throw new Error('LarkAttachmentAdapter received an incompatible attachment ref');
    }

    const content = await this.larkFileClient.downloadFile(ref.messageId, ref.fileKey);
    return {
      fileName: ref.fileName ?? ref.fileKey,
      mimeType: 'application/octet-stream',
      sizeBytes: content.length,
      content,
      source: this.source,
    };
  }
}
