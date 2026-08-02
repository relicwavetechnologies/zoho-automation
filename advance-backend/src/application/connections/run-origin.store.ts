import type { CachePort } from '../../shared/cache';
import type { ChatType, GroupReplyMode } from '../../domain/channel/incoming-message';

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
export interface RunOrigin {
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
    const stored = await this.cache.set(
      runOriginKey(runId),
      origin,
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
    const origin = read.value;
    if (!origin || origin.version !== 1) return undefined;
    if (origin.companyId !== input.companyId) return undefined;
    if (origin.userId !== input.userId) return undefined;
    return origin;
  }

  async attachGoogleAuthorization(input: {
    readonly runId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly intentId: string;
    readonly authorizeUrl: string;
  }): Promise<boolean> {
    const origin = await this.recall(input);
    if (!origin) return false;
    const stored = await this.cache.set(
      runOriginKey(input.runId),
      {
        ...origin,
        googleAuthorization: {
          intentId: input.intentId,
          authorizeUrl: input.authorizeUrl,
        },
      },
      RUN_ORIGIN_TTL_SECONDS,
    );
    if (!stored.ok) throw stored.error;
    return true;
  }
}

function runOriginKey(runId: string): string {
  return `${RUN_ORIGIN_PREFIX}${runId}`;
}
