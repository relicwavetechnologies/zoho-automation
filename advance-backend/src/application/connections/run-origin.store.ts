import type { CachePort } from '../../shared/cache';
import type { ChatType, GroupReplyMode } from '../../domain/channel/incoming-message';
import type { ProviderKey } from '../../domain/connections/scope-gap';

const RUN_ORIGIN_TTL_SECONDS = 30 * 60;
const RUN_ORIGIN_PREFIX = 'run-origin:v1:';

/**
 * An ask longer than this is not stored at all.
 *
 * A deferred OAuth continuation re-runs the original request verbatim, so a
 * truncated copy would silently act on something the member did not say. When
 * the ask does not fit, the caller gets no origin and the tool falls through to
 * the honest "authorize it yourself in Settings" path instead.
 */
const MAX_ORIGINAL_REQUEST_CHARS = 16_000;

/**
 * Where a runtime run came from, in the terms a deferred authorization needs to
 * resume it: who asked, in which chat, replying to which message, and what they
 * actually asked for.
 */
interface RunOriginBase {
  readonly version: 1;
  readonly companyId: string;
  readonly userId: string;
  readonly channel: 'lark' | 'web';
  readonly originalRequest: string;
  readonly conversationKey: string;
  readonly pendingAuthorization?: {
    readonly provider: ProviderKey;
    readonly intentId: string;
    readonly authorizeUrl: string;
  };
}

export interface LarkRunOriginFields {
  readonly larkOpenId: string;
  readonly larkTenantKey: string;
  readonly chatId: string;
  readonly chatType: ChatType;
  readonly originalMessageId: string;
  readonly rootMessageId?: string;
  readonly replyInThread: boolean;
  readonly groupReplyMode?: GroupReplyMode;
}

export interface WebRunOriginFields {
  readonly threadId: string;
  readonly userExternalId: string;
  /** The exact web sign-in the run must resume under. */
  readonly sessionId: string;
  readonly timestamp: string;
}

export type RunOrigin =
  | (RunOriginBase & { readonly channel: 'lark'; readonly lark: LarkRunOriginFields })
  | (RunOriginBase & { readonly channel: 'web'; readonly web: WebRunOriginFields });

interface LegacyLarkRunOrigin {
  readonly version: 1;
  readonly companyId: string;
  readonly userId: string;
  readonly larkOpenId: string;
  readonly larkTenantKey: string;
  readonly chatId: string;
  readonly chatType: ChatType;
  readonly originalMessageId: string;
  readonly rootMessageId?: string;
  readonly replyInThread: boolean;
  readonly groupReplyMode?: GroupReplyMode;
  readonly originalRequest: string;
  readonly googleAuthorization?: {
    readonly intentId: string;
    readonly authorizeUrl: string;
  };
}

/**
 * Run-scoped channel origin, held only as long as the run that produced it can
 * plausibly still be executing.
 *
 * Pi runs inside a container and calls tools back through the gateway, so by
 * the time a tool discovers it needs OAuth, the inbound Lark event is long out
 * of scope. This is how that context survives the trip: written once at the
 * ingress that issues the runtime lease, read at most once per authorization
 * prompt.
 *
 * The key is a backend-issued run ID, and every read is re-bound to the calling
 * member — a lease cannot recall a run belonging to somebody else, or to
 * another company, even if it learns the ID.
 */
export class RunOriginStore {
  constructor(private readonly cache: CachePort) {}

  /**
   * Returns false when the ask is too long to store faithfully. Callers should
   * treat that as "no continuation is available for this run", not as an error.
   */
  async remember(runId: string, origin: RunOrigin): Promise<boolean> {
    if (origin.originalRequest.length > MAX_ORIGINAL_REQUEST_CHARS) return false;
    const key = runOriginKey(runId);
    const current = await this.cache.get<RunOrigin | LegacyLarkRunOrigin>(key);
    if (!current.ok) throw current.error;
    const currentOrigin = normalizeOrigin(current.value);
    const retainedAuthorization = currentOrigin
      && currentOrigin.companyId === origin.companyId
      && currentOrigin.userId === origin.userId
      && currentOrigin.channel === origin.channel
      && currentOrigin.conversationKey === origin.conversationKey
      ? currentOrigin.pendingAuthorization
      : undefined;
    const stored = await this.cache.set(
      key,
      retainedAuthorization ? { ...origin, pendingAuthorization: retainedAuthorization } : origin,
      RUN_ORIGIN_TTL_SECONDS,
    );
    if (!stored.ok) throw stored.error;
    return true;
  }

  async recall(input: {
    readonly runId: string;
    readonly companyId: string;
    readonly userId: string;
  }): Promise<RunOrigin | undefined> {
    const read = await this.cache.get<RunOrigin>(runOriginKey(input.runId));
    if (!read.ok) throw read.error;
    const origin = normalizeOrigin(read.value);
    if (!origin) return undefined;
    if (origin.companyId !== input.companyId) return undefined;
    if (origin.userId !== input.userId) return undefined;
    return origin;
  }

  async attachPendingAuthorization(input: {
    readonly runId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly provider: ProviderKey;
    readonly intentId: string;
    readonly authorizeUrl: string;
  }): Promise<boolean> {
    const origin = await this.recall(input);
    if (!origin) return false;
    const stored = await this.cache.set(
      runOriginKey(input.runId),
      {
        ...origin,
        pendingAuthorization: {
          provider: input.provider,
          intentId: input.intentId,
          authorizeUrl: input.authorizeUrl,
        },
      },
      RUN_ORIGIN_TTL_SECONDS,
    );
    if (!stored.ok) throw stored.error;
    return true;
  }

  /**
   * Forget an authorization the member has finished with.
   *
   * A run that is still waiting for a Connect ask has nothing of its own to
   * say, so the runtime replaces its final answer with the card text and a
   * Connect button. That is right up to the moment the member connects, and
   * wrong immediately after: the run then goes on to do the actual work, and
   * leaving this attached throws that answer away and offers a button for an
   * account that is already connected.
   *
   * The mirror of `attachPendingAuthorization`, and the same idea as
   * withdrawing the card: once the ask is answered, take back everything that
   * still advertises it.
   */
  async clearPendingAuthorization(input: {
    readonly runId: string;
    readonly companyId: string;
    readonly userId: string;
  }): Promise<boolean> {
    const origin = await this.recall(input);
    if (!origin?.pendingAuthorization) return false;
    const { pendingAuthorization: _resolved, ...withoutAuthorization } = origin;
    const stored = await this.cache.set(
      runOriginKey(input.runId),
      withoutAuthorization,
      RUN_ORIGIN_TTL_SECONDS,
    );
    if (!stored.ok) throw stored.error;
    return true;
  }
}

function runOriginKey(runId: string): string {
  return `${RUN_ORIGIN_PREFIX}${runId}`;
}

function normalizeOrigin(value: unknown): RunOrigin | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate['version'] !== 1) return undefined;
  if (candidate['channel'] === 'lark' && candidate['lark']) return value as RunOrigin;
  if (candidate['channel'] === 'web' && candidate['web']) return value as RunOrigin;

  // Preserve a pending Lark authorization written by the previous flat shape
  // while the short origin TTL drains. New writes always use the discriminated
  // channel shape above.
  if (
    typeof candidate['companyId'] === 'string'
    && typeof candidate['userId'] === 'string'
    && typeof candidate['larkOpenId'] === 'string'
    && typeof candidate['larkTenantKey'] === 'string'
    && typeof candidate['chatId'] === 'string'
    && typeof candidate['chatType'] === 'string'
    && typeof candidate['originalMessageId'] === 'string'
    && typeof candidate['replyInThread'] === 'boolean'
    && typeof candidate['originalRequest'] === 'string'
  ) {
    const legacy = value as LegacyLarkRunOrigin;
    return {
      version: 1,
      companyId: legacy.companyId,
      userId: legacy.userId,
      channel: 'lark',
      originalRequest: legacy.originalRequest,
      conversationKey: legacy.chatId,
      lark: {
        larkOpenId: legacy.larkOpenId,
        larkTenantKey: legacy.larkTenantKey,
        chatId: legacy.chatId,
        chatType: legacy.chatType,
        originalMessageId: legacy.originalMessageId,
        ...(legacy.rootMessageId ? { rootMessageId: legacy.rootMessageId } : {}),
        replyInThread: legacy.replyInThread,
        ...(legacy.groupReplyMode ? { groupReplyMode: legacy.groupReplyMode } : {}),
      },
      ...(legacy.googleAuthorization
        ? {
            pendingAuthorization: {
              provider: 'google_workspace' as const,
              intentId: legacy.googleAuthorization.intentId,
              authorizeUrl: legacy.googleAuthorization.authorizeUrl,
            },
          }
        : {}),
    };
  }
  return undefined;
}
