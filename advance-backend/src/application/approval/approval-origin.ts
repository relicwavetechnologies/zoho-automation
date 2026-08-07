export type ApprovalOrigin = 'gateway' | 'lark' | 'cloud_pi';

export const GATEWAY_APPROVAL_CHAT_PREFIX = 'gateway:';

export function approvalOriginFromChatId(chatId: string): ApprovalOrigin {
  return chatId.startsWith(GATEWAY_APPROVAL_CHAT_PREFIX) ? 'gateway' : 'lark';
}

/**
 * Does approving this finish the work, or does somebody have to come back?
 *
 * A `gateway:` chat id has been carrying two separate meanings: *show this in
 * the desktop approval inbox*, and *do not resume — the requester is sitting
 * there and will retry*. The second is true of an interactive desktop action
 * and false of a request whose asker has closed the tab, and there was no way
 * to say so: a mail rule created in a browser needs the inbox and needs the
 * resume, and got only the inbox.
 *
 * So the requester declares it. Absent reads as "no", which leaves every
 * existing gateway approval behaving exactly as it did.
 */
export function approvalResumesAutomatically(metadata: unknown): boolean {
  return isRecord(metadata) && metadata['autoResume'] === true;
}

export function isGatewayApprovalMetadata(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  if (metadata['approvalOrigin'] === 'cloud_pi') return false;
  if (metadata['approvalOrigin'] === 'gateway') return true;
  const chatId = metadata['chatId'];
  return typeof chatId === 'string' && chatId.startsWith(GATEWAY_APPROVAL_CHAT_PREFIX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
