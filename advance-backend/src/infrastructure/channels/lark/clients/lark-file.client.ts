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

  async downloadFile(messageId: string, fileKey: string, maxBytes?: number): Promise<Buffer> {
    return this.downloadResource(messageId, fileKey, 'file', maxBytes);
  }

  async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
    return this.downloadResource(messageId, imageKey, 'image');
  }

  async openFile(messageId: string, fileKey: string): Promise<AsyncIterable<Uint8Array>> {
    return this.openResource(messageId, fileKey, 'file');
  }

  async openImage(messageId: string, imageKey: string): Promise<AsyncIterable<Uint8Array>> {
    return this.openResource(messageId, imageKey, 'image');
  }

  private async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'file' | 'image',
    maxBytes?: number,
  ): Promise<Buffer> {
    try {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of await this.openResource(messageId, fileKey, type)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += bytes.length;
        if (maxBytes !== undefined && totalBytes > maxBytes) {
          throw new Error(`Lark resource exceeds the ${maxBytes}-byte download limit`);
        }
        chunks.push(bytes);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      this.log.warn('lark.file.download.failed', { messageId, type, error: String(error) });
      throw error;
    }
  }

  private async openResource(
    messageId: string,
    fileKey: string,
    type: 'file' | 'image',
  ): Promise<AsyncIterable<Uint8Array>> {
    try {
      const response = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
      return response.getReadableStream();
    } catch (error) {
      this.log.warn('lark.file.open.failed', { messageId, type, error: String(error) });
      throw error;
    }
  }
}
