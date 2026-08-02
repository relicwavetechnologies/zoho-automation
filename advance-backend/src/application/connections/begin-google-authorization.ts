import type { Logger } from '../../shared/logger';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { BeginGoogleWorkspaceAuthorization } from '../tools/families/google-workspace-mcp.tool';
import type { GoogleConnectionAuthorizationService } from './google-connection-authorization.service';
import type { RunOriginStore } from './run-origin.store';

export interface DeliverGoogleConnectCard {
  (input: {
    url: string;
    reason: string;
    chatId: string;
    replyToMessageId: string;
    replyInThread: boolean;
  }): Promise<boolean>;
}

export interface BeginGoogleAuthorizationDeps {
  readonly runOrigins: Pick<RunOriginStore, 'recall'>;
  readonly authorization: Pick<GoogleConnectionAuthorizationService, 'issue'>;
  /**
   * Resolved per call, not captured: the Lark adapter that delivers the card is
   * built long after this closure, and a card that cannot be delivered is the
   * same outcome as having nowhere to deliver it.
   */
  readonly deliverConnectCard: () => DeliverGoogleConnectCard | undefined;
  readonly logger: Logger;
}

/**
 * Ask a member to connect Google, and arrange for their request to be re-run
 * once they have.
 *
 * This lived inline in composition for a long time and was dead the whole time:
 * it read a run-context field that nothing ever wrote, so every production call
 * returned `unavailable` and the Connect card the skills promise was never
 * sent. It is a standalone unit now because the only test that covered it stubbed
 * this exact seam, which is why nobody noticed.
 */
export function createBeginGoogleAuthorization(
  deps: BeginGoogleAuthorizationDeps,
): BeginGoogleWorkspaceAuthorization {
  return async (input) => {
    const companyId = String(input.runContext.companyId);
    const userId = String(input.runContext.userId);
    const deliver = deps.deliverConnectCard();
    // The inbound request that started this run, recovered by the run ID on the
    // signed runtime lease. Without it there is no conversation to send a card
    // into and no ask to resume, so there is no continuation to offer.
    const origin = await recallOrigin(deps, input.runContext, companyId, userId);
    if (!origin || !deliver) {
      return { status: 'unavailable' as const };
    }

    const issued = await deps.authorization.issue({
      companyId,
      userId,
      ...(input.runContext.departmentId
        ? { departmentId: String(input.runContext.departmentId) }
        : {}),
      larkOpenId: origin.larkOpenId,
      larkTenantKey: origin.larkTenantKey,
      chatId: origin.chatId,
      chatType: origin.chatType,
      originalMessageId: origin.originalMessageId,
      ...(origin.rootMessageId ? { rootMessageId: origin.rootMessageId } : {}),
      replyInThread: origin.replyInThread,
      ...(origin.groupReplyMode ? { groupReplyMode: origin.groupReplyMode } : {}),
      originalRequest: origin.originalRequest,
      requestedToolIds: [input.toolId],
    });
    // A card for this exact request is already out. Sending a second one would
    // only give the member two links to the same thing.
    if (issued.outcome === 'already_pending') {
      return { status: 'already_pending' as const, intentId: issued.intentId };
    }

    const delivered = await deliver({
      url: issued.authorizeUrl,
      reason: input.reason,
      chatId: origin.chatId,
      replyToMessageId: origin.originalMessageId,
      replyInThread: origin.replyInThread,
    });
    if (!delivered) {
      deps.logger.error('google.authorization.card_delivery_failed', {
        intentId: issued.intentId,
        companyId,
        userId,
      });
      return { status: 'unavailable' as const };
    }
    return { status: 'sent' as const, intentId: issued.intentId };
  };
}

/**
 * A run with no origin is an ordinary outcome, not a fault — a desktop session
 * never had a channel request behind it. A run that carries an ID and still
 * finds nothing is worth a line: the record aged out or the cache is
 * unreachable, and the member is about to be told to connect Google with no
 * card to do it from.
 */
async function recallOrigin(
  deps: BeginGoogleAuthorizationDeps,
  runContext: RunContext,
  companyId: string,
  userId: string,
) {
  const runId = runContext.runtimeRunId;
  if (!runId) return undefined;
  try {
    const origin = await deps.runOrigins.recall({ runId, companyId, userId });
    if (!origin) {
      deps.logger.warn('google.authorization.run_origin_missing', {
        runId,
        companyId,
      });
    }
    return origin;
  } catch (error) {
    deps.logger.error('google.authorization.run_origin_unreadable', {
      runId,
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
