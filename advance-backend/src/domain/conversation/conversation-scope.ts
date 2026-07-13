export interface ConversationScope {
  readonly companyId: string;
  readonly channel: string;
}

export const conversationCacheKey = (
  chatId: string,
  scope?: ConversationScope,
): string => scope
  ? `history:v3:${scope.companyId}:${scope.channel}:${chatId}`
  : `history:v2:${chatId}`;

export const conversationUniqueKey = (
  chatId: string,
  scope: ConversationScope,
) => ({
  companyId: scope.companyId,
  channel: scope.channel,
  channelConversationKey: chatId,
});
