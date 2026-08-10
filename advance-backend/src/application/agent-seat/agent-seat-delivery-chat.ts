/** Env var name for the Lark chat where chat-scoped tools deliver. */
export const AGENT_SEAT_DELIVERY_CHAT_ID_ENV = 'AGENT_SEAT_DELIVERY_CHAT_ID';

const LARK_CHAT_ID_PATTERN = /^oc_[a-z0-9]+$/;

export function isAgentSeatDeliveryChatId(value: string): boolean {
  return LARK_CHAT_ID_PATTERN.test(value.trim());
}

export interface ResolveAgentSeatDeliveryChatIdInput {
  readonly cliChatId?: string;
  readonly envChatId?: string;
}

/**
 * Resolves the Lark chat id bound for the whole Agent Seat session.
 * Each teammate supplies their own DM or test group — never hardcode in git.
 */
export function resolveAgentSeatDeliveryChatId(
  input: ResolveAgentSeatDeliveryChatIdInput,
): string {
  const candidate = (input.cliChatId ?? input.envChatId ?? '').trim();
  if (!candidate) {
    throw new Error(
      'Agent Seat requires a Lark delivery chat id for runtime chat context. '
      + `Set ${AGENT_SEAT_DELIVERY_CHAT_ID_ENV} in advance-backend/.env `
      + 'or pass init --chat-id <oc_...>. '
      + 'Use your Lark DM with Divo or a dedicated test group you control. '
      + 'Do not commit personal chat ids to git.',
    );
  }
  if (!isAgentSeatDeliveryChatId(candidate)) {
    throw new Error(
      `Invalid Agent Seat delivery chat id "${candidate}". `
      + 'Expected a Lark chat id like oc_<hex>.',
    );
  }
  return candidate;
}
