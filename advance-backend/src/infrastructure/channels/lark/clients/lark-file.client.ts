/** Lark message-resource downloads through the official Node SDK. */
import { Client as LarkSdkClient, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';
import type { TypedEnv } from '../../../../config/env';
import type { Logger } from '../../../../shared/logger';

export class LarkFileClient {
  private readonly client: LarkSdkClient;
  private readonly log: Logger;

  constructor(env: TypedEnv, logger: Logger) {
    this.log = logger.child({ larkClient: 'file' });
    this.client = new LarkSdkClient({
      appId: env.LARK_APP_ID,
      appSecret: env.LARK_APP_SECRET,
      domain: env.LARK_API_BASE_URL?.replace(/\/$/, '') || Domain.Lark,
      loggerLevel: LoggerLevel.warn,
      source: 'divo',
    });
  }

  async downloadFile(messageId: string, fileKey: string): Promise<Buffer> {
    return this.downloadResource(messageId, fileKey, 'file');
  }

  async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
    return this.downloadResource(messageId, imageKey, 'image');
  }

  private async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'file' | 'image',
  ): Promise<Buffer> {
    try {
      const response = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
      const chunks: Buffer[] = [];
      for await (const chunk of response.getReadableStream()) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      this.log.warn('lark.file.download.failed', { messageId, type, error: String(error) });
      throw error;
    }
  }
}
