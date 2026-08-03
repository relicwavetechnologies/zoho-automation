import type { CachePort } from '../../../shared/cache';
import type { Logger } from '../../../shared/logger';

export const LARK_OAUTH_NONCE_TTL_SECONDS = 600; // 10 min

export function larkOAuthNonceKey(nonce: string): string {
  return `lark:oauth:nonce:${nonce}`;
}

export function larkOAuthReplayKey(nonce: string): string {
  return `lark:oauth:replay:${nonce}`;
}

export interface LarkOAuthState {
  companyId: string;
  userId: string;
  larkOpenId: string;
  tenantKey: string;
  nonce: string;
}

export function encodeLarkOAuthState(state: LarkOAuthState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

/** Payload stored at `lark:oauth:nonce:{nonce}` for web sign-in cards. */
export interface LarkOAuthNoncePayload {
  companyId: string;
  userId: string;
  larkOpenId: string;
  tenantKey: string;
  pendingEvent?: Record<string, unknown>;
  signInCardMessageId?: string;
  signInCardDisplayName?: string;
}

/**
 * Records the Lark message id of a sign-in card on the pending nonce so
 * `POST /link` can PATCH it to a connected state after the web hop succeeds.
 */
export async function recordSignInCardOnNonce(
  cache: CachePort,
  nonce: string,
  input: { messageId: string; displayName: string },
  logger: Logger,
): Promise<void> {
  const key = larkOAuthNonceKey(nonce);
  const stored = await cache.get<LarkOAuthNoncePayload>(key);
  if (!stored.ok) {
    logger.warn('lark.auth.sign_in_card.nonce_read_failed', {
      error: stored.error.message,
    });
    return;
  }
  if (!stored.value) {
    logger.warn('lark.auth.sign_in_card.nonce_missing', { nonce });
    return;
  }

  const written = await cache.set(
    key,
    {
      ...stored.value,
      signInCardMessageId: input.messageId,
      signInCardDisplayName: input.displayName,
    },
    LARK_OAUTH_NONCE_TTL_SECONDS,
  );
  if (!written.ok) {
    logger.warn('lark.auth.sign_in_card.nonce_write_failed', {
      error: written.error.message,
    });
  }
}
