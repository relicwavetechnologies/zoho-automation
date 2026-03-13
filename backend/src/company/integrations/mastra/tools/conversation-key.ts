export type ConversationKeyRequestContext = {
  get: (key: string) => unknown;
};

export const buildConversationKey = (requestContext?: ConversationKeyRequestContext): string | null => {
  const channel = requestContext?.get('channel');
  const tenant = requestContext?.get('larkTenantKey');
  const chatId = requestContext?.get('chatId');
  if (typeof channel !== 'string' || typeof chatId !== 'string') {
    return null;
  }
  return `${channel}:${typeof tenant === 'string' && tenant.trim() ? tenant.trim() : 'no_tenant'}:${chatId}`;
};
