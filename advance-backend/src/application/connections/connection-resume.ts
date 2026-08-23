import type { Logger } from '../../shared/logger';
import type { Result } from '../../shared/result';
import { grantedGoogleScopeGroups } from './google-granted-scopes';
import type { ConnectionContinuationClaim } from '../../infrastructure/persistence/connection-authorization.repository';

export interface ConnectionSummaryForResume {
  readonly connectionId: string;
  readonly ownerType: string;
  readonly ownerUserId?: string | null;
  readonly scopes?: readonly string[];
}

export interface ConnectionResumeDeps {
  readonly intentRepo: {
    claimContinuation(intentId: string): Promise<Result<ConnectionContinuationClaim | null, Error>>;
    finishContinuation(
      intentId: string,
      outcome: { runId?: string; failureCode?: string },
    ): Promise<Result<void, Error>>;
  };
  readonly connectionRepo: {
    listAccessibleGoogleConnections(input: {
      companyId: string;
      userId: string;
    }): Promise<Result<readonly ConnectionSummaryForResume[], Error>>;
  };
  /** Takes the Connect card back, since the question it asks has been answered. */
  readonly decisions?: {
    withdraw(input: { idempotencyKey: string; reason: string }): Promise<number>;
  };
  /**
   * Lets the run speak for itself again.
   *
   * While an authorization is pending the runtime replaces the run's final
   * answer with the Connect card text. That is correct while the member still
   * has to act, and wrong the moment they have, because the run then goes on to
   * produce the real answer this would discard.
   */
  readonly runOrigins?: {
    clearPendingAuthorization(input: {
      runId: string;
      companyId: string;
      userId: string;
    }): Promise<boolean>;
  };
  readonly logger: Logger;
}

export type ConnectionResumeOutcome =
  | {
      readonly status: 'connected';
      readonly provider: 'google_workspace';
      readonly grantedScopeGroups: readonly string[];
      readonly originalRequest: string;
    }
  | { readonly status: 'not_pending' }
  | { readonly status: 'not_yours' }
  | { readonly status: 'connection_missing' };

/**
 * Pick a run back up where it stopped.
 *
 * The whole flow leans on this being one step rather than a rebuild. Nothing
 * here reconstructs a run, resolves an identity or starts anything: the run is
 * still going, still holding its own conversation and permissions, and all it
 * needs from this module is the answer to what the member actually granted.
 *
 * Claiming is atomic, so a duplicate resume reads `not_pending` rather than
 * telling one run two different stories.
 */
export class ConnectionResumeService {
  private readonly log: Logger;

  constructor(private readonly deps: ConnectionResumeDeps) {
    this.log = deps.logger.child({ service: 'connection-resume' });
  }

  async resume(input: {
    readonly askId: string;
    readonly companyId: string;
    readonly userId: string;
  }): Promise<ConnectionResumeOutcome> {
    const claimed = await this.deps.intentRepo.claimContinuation(input.askId);
    if (!claimed.ok) throw claimed.error;
    const intent = claimed.value;
    if (!intent) return { status: 'not_pending' };

    /* The ask belongs to whoever was asked. A run resuming someone else's
       authorization would read another member's granted scopes back to a model
       acting for this one, so this is checked before anything is loaded. */
    if (intent.companyId !== input.companyId || intent.userId !== input.userId) {
      await this.release(intent.intentId, 'resume_identity_mismatch');
      this.log.error('connection.resume.identity_mismatch', {
        askId: input.askId,
        companyId: input.companyId,
      });
      return { status: 'not_yours' };
    }

    const listed = await this.deps.connectionRepo.listAccessibleGoogleConnections({
      companyId: intent.companyId,
      userId: intent.userId,
    });
    if (!listed.ok) throw listed.error;
    const connection = listed.value.find(
      candidate => candidate.connectionId === intent.connectionId
        && candidate.ownerType === 'user'
        && candidate.ownerUserId === intent.userId,
    );
    if (!connection) {
      await this.release(intent.intentId, 'resume_connection_missing');
      return { status: 'connection_missing' };
    }

    await this.settle(intent);

    return {
      status: 'connected',
      provider: 'google_workspace',
      grantedScopeGroups: grantedGoogleScopeGroups(
        intent.requestedToolIds,
        connection.scopes,
      ),
      originalRequest: intent.originalRequest,
    };
  }

  /**
   * Nobody was waiting, so close the ask rather than leave it open.
   *
   * The worker this replaced used to sweep intents that reached `connected`
   * with their continuation still pending. Without a sweeper, an ask whose run
   * gave up first would sit pending for good, and the member would keep a card
   * offering to connect an account they already connected.
   *
   * Returns false when there was nothing to close, which is the ordinary case
   * for a callback that arrives after the run already resumed.
   */
  async abandon(askId: string, reason: string): Promise<boolean> {
    const claimed = await this.deps.intentRepo.claimContinuation(askId);
    if (!claimed.ok) throw claimed.error;
    if (!claimed.value) return false;
    await this.release(claimed.value.intentId, reason);
    return true;
  }

  /**
   * The run carried on, so everything that still asks the member to connect is
   * taken back: the durable intent, the card, and the runtime's own standing
   * instruction to answer with the card instead of with the run.
   */
  private async settle(intent: ConnectionContinuationClaim): Promise<void> {
    const finished = await this.deps.intentRepo.finishContinuation(intent.intentId, {
      runId: `connection-resume:${intent.intentId}`,
    });
    if (!finished.ok) throw finished.error;
    await this.withdrawCard(intent.intentId, 'google_connected');
    /* Best effort, like the card. The run has its answer either way, and the
       origin expires on its own short TTL. */
    try {
      await this.deps.runOrigins?.clearPendingAuthorization({
        runId: intent.originalMessageId,
        companyId: intent.companyId,
        userId: intent.userId,
      });
    } catch (error) {
      this.log.warn('connection.resume.origin_clear_failed', {
        intentId: intent.intentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async release(intentId: string, failureCode: string): Promise<void> {
    const finished = await this.deps.intentRepo.finishContinuation(intentId, { failureCode });
    if (!finished.ok) {
      this.log.error('connection.resume.release_failed', { intentId, failureCode });
      return;
    }
    await this.withdrawCard(intentId, failureCode);
  }

  private async withdrawCard(intentId: string, reason: string): Promise<void> {
    /* Best effort on purpose. The run has already moved on, and failing it now
       over a button that is merely stale would undo work the member watched
       succeed. */
    try {
      await this.deps.decisions?.withdraw({ idempotencyKey: intentId, reason });
    } catch (error) {
      this.log.warn('connection.resume.card_withdraw_failed', {
        intentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
