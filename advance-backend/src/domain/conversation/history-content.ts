import type { IncomingMessage } from '../channel/incoming-message';

/**
 * Shared group histories need speaker attribution because any participant may
 * continue the thread. Direct conversations already have one implicit user.
 */
export const userHistoryContent = (
  incoming: IncomingMessage,
  content = incoming.text,
): string => incoming.chatType === 'group'
  ? `[Lark sender: ${incoming.senderName ?? incoming.userExternalId}]\n${content}`
  : content;
