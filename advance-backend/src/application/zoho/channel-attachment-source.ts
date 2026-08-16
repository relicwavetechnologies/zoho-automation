import type { ZohoAttachmentSourcePort } from './zoho-attachment.service';

export class ChannelAttachmentSource implements ZohoAttachmentSourcePort {
  constructor(private readonly sources: Record<string, ZohoAttachmentSourcePort | undefined>) {}

  resolve(input: {
    companyId: string;
    userId: string;
    channel: string;
    chatId: string;
    fileName: string;
  }) {
    const source = this.sources[input.channel];
    if (!source) {
      return Promise.resolve({
        kind: 'unavailable' as const,
        message: `Divo cannot attach files from the ${input.channel} channel yet.`,
      });
    }
    return source.resolve(input);
  }
}
