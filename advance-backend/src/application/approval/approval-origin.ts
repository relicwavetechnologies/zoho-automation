export type ApprovalOrigin = 'gateway' | 'lark';

export const GATEWAY_APPROVAL_CHAT_PREFIX = 'gateway:';

export function approvalOriginFromChatId(chatId: string): ApprovalOrigin {
  return chatId.startsWith(GATEWAY_APPROVAL_CHAT_PREFIX) ? 'gateway' : 'lark';
}

export function isGatewayApprovalMetadata(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  if (metadata['approvalOrigin'] === 'gateway') return true;
  const chatId = metadata['chatId'];
  return typeof chatId === 'string' && chatId.startsWith(GATEWAY_APPROVAL_CHAT_PREFIX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
