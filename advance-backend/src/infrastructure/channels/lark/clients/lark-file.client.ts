/**
 * Lark message-resource download client.
 *
 * Downloads files and images that were sent inside chat messages using the
 * message-resource endpoint (requires message_id):
 *   GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}?type=image|file
 *
 * The standalone image endpoint (im/v1/images/{key}) is for images uploaded
 * via the Lark image-upload API, NOT for message attachments — using it for
 * message images returns error 234001 "Invalid request param".
 */
import type { TypedEnv } from '../../../../config/env';
import type { Logger } from '../../../../shared/logger';

export class LarkFileClient {
  private readonly appId:     string;
  private readonly appSecret: string;
  private readonly baseUrl:   string;
  private readonly log:       Logger;
  private tenantToken?:       string;
  private tokenExpiresAt = 0;

  constructor(env: TypedEnv, logger: Logger) {
    this.appId     = env.LARK_APP_ID;
    this.appSecret = env.LARK_APP_SECRET;
    this.baseUrl   = env.LARK_API_BASE_URL;
    this.log       = logger.child({ larkClient: 'file' });
  }

  async downloadFile(messageId: string, fileKey: string): Promise<Buffer> {
    return this.downloadResource(messageId, fileKey, 'file');
  }

  async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
    return this.downloadResource(messageId, imageKey, 'image');
  }

  private async downloadResource(messageId: string, key: string, type: 'file' | 'image'): Promise<Buffer> {
    const token = await this.getTenantToken();
    const url   = `${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}?type=${type}`;
    const res   = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LarkFileClient.downloadResource failed: ${res.status} type=${type} url=${url} body=${body}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private async getTenantToken(): Promise<string> {
    if (this.tenantToken && Date.now() < this.tokenExpiresAt) {
      return this.tenantToken;
    }
    const res = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const data = await res.json() as Record<string, unknown>;
    this.tenantToken = data['tenant_access_token'] as string;
    this.tokenExpiresAt = Date.now() + ((data['expire'] as number ?? 7200) - 60) * 1000;
    this.log.debug('lark.file.token_refreshed');
    return this.tenantToken;
  }
}
