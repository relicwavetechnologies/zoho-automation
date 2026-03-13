import { parseLarkIngressPayload } from './src/company/channels/lark/lark-ingress.contract';
import { parseLarkAttachmentKeys } from './src/company/channels/lark/lark-message-content';
import { LarkChannelAdapter } from './src/company/channels/lark/lark.adapter';

const mockImageEvent = {
  schema: "2.0",
  header: {
    event_id: "test-event-123",
    event_type: "im.message.receive_v1",
    tenant_key: "test-tenant"
  },
  event: {
    sender: {
      sender_id: {
        open_id: "ou_12345",
        user_id: "u_12345"
      }
    },
    message: {
      message_id: "om_12345",
      chat_id: "oc_12345",
      msg_type: "image",
      content: JSON.stringify({ image_key: "img_v2_1234567890" })
    }
  }
};

console.log("1. Parsing ingress payload...");
const parsed = parseLarkIngressPayload(mockImageEvent);
console.log("Parsed result kind:", parsed.kind);

if (parsed.kind === 'event_callback_message') {
  const msgType = (parsed.envelope as any)?.event?.message?.msg_type;
  const msgContent = (parsed.envelope as any)?.event?.message?.content;
  console.log("2. Extracted msgType:", msgType);
  console.log("3. Extracted msgContent:", msgContent);
  
  const attachmentKeys = parseLarkAttachmentKeys(msgContent, msgType);
  console.log("4. Parsed attachment keys:", attachmentKeys);
  const adapter = new LarkChannelAdapter({ tokenService: { getAccessToken: async () => 'test_token' } } as any);
  const normalized = adapter.normalizeIncomingEvent(parsed.envelope);
  console.log("5. Normalized output:", normalized);
} else {
  console.log("Failed to parse as event_callback_message! Reason:", (parsed as any).reason);
}
