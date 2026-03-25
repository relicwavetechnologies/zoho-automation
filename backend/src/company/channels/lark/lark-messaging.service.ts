import type { LarkCredentialMode } from './lark-runtime-client';
import {
  larkRuntimeClient,
  LarkRuntimeClientError,
  readLarkRecord,
  readLarkString,
} from './lark-runtime-client';

type LarkMessagingAuthInput = {
  companyId?: string;
  larkTenantKey?: string;
  appUserId?: string;
  credentialMode?: LarkCredentialMode;
};

type SendDirectMessageInput = LarkMessagingAuthInput & {
  recipientOpenId: string;
  text: string;
};

export type LarkDirectMessageResult = {
  messageId?: string;
  recipientOpenId: string;
  raw: Record<string, unknown>;
};

class LarkMessagingService {
  async sendDirectTextMessage(input: SendDirectMessageInput): Promise<LarkDirectMessageResult> {
    const trimmedRecipientOpenId = input.recipientOpenId.trim();
    const trimmedText = input.text.trim();
    const { data, payload } = await larkRuntimeClient.requestJson({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
      appUserId: input.appUserId,
      credentialMode: input.credentialMode ?? 'tenant',
      method: 'POST',
      path: '/open-apis/im/v1/messages',
      query: {
        receive_id_type: 'open_id',
      },
      body: {
        receive_id: trimmedRecipientOpenId,
        msg_type: 'text',
        content: JSON.stringify({ text: trimmedText }),
      },
    });

    const messageId = readLarkString(data.message_id)
      ?? readLarkString(readLarkRecord(data.message)?.message_id)
      ?? readLarkString(readLarkRecord(payload)?.message_id);
    if (!messageId) {
      throw new LarkRuntimeClientError(
        'Lark direct message send returned no message id',
        'lark_runtime_invalid_response',
      );
    }

    return {
      messageId,
      recipientOpenId: trimmedRecipientOpenId,
      raw: readLarkRecord(payload) ?? {},
    };
  }
}

export const larkMessagingService = new LarkMessagingService();
