import { createHash } from 'node:crypto';
import type { Logger } from '../../shared/logger';
import { sha256 } from '../../shared/hash';
import { InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';
import {
  describeRefusal,
  estimateSeconds,
  isTerminal,
  normalizeBatchStatus,
  normalizeResultStatus,
  refuseBroadcast,
  renderBody,
  summarizeReach,
  type BroadcastReach,
  type BroadcastRecipientInput,
  type BroadcastRefusal,
} from '../../domain/follow-ups/broadcast';
import type { OpenWaClient } from '../../infrastructure/whatsapp/openwa.client';
import type {
  BroadcastCandidate,
  BroadcastRecipientRow,
  BroadcastRow,
  BroadcastsRepoPort,
  PollableBroadcast,
} from '../../infrastructure/persistence/broadcasts.repository';
import type { WhatsappSessionService } from './whatsapp-session.service';

/**
 * Sending, from the web app.
 *
 * This is the only place Divo writes to WhatsApp, and everything about its shape
 * follows from that. The message was typed by a person and reviewed by a person;
 * nothing here composes text, and the follow-up analyser has no route into it.
 *
 * The order of operations is the load-bearing part. A broadcast row and all its
 * recipient rows are written *before* the gateway is asked to send anything, so
 * that a crash, a timeout, or a gateway that answers slowly can never produce a
 * send Divo cannot account for. The batch id is minted here rather than by the
 * gateway for the same reason: it is the idempotency key, and a key the caller
 * chose is one it can still use after it stops hearing back.
 *
 * Progress is polled, not pushed. The gateway publishes twenty-three webhook
 * events and none of them is about a batch, so `poll` is the only way anybody
 * finds out what happened — which is why it runs on a worker as well as being
 * triggered by the screen, and why a broadcast nobody is watching still reaches
 * a terminal state.
 */

/**
 * Milliseconds between sends. The floor the gateway accepts is 1000.
 *
 * Exported so the composition can log the effective value at boot rather than
 * leaving the pacing of every outbound message as a number nobody can see
 * without reading this file.
 */
export const BROADCAST_DELAY_MS = 3000;

/** How stale a live broadcast's reading may get before the worker re-reads it. */
export const POLL_INTERVAL_MS = 5000;
/** Give OpenWA time to publish a batch whose POST response was lost. */
export const BATCH_DISCOVERY_GRACE_MS = 30_000;

const REFUSED_OP = 'whatsapp.broadcastRefused';

/**
 * A refusal the caller can fix, as distinct from a gateway that fell over.
 *
 * The typed refusal travels with the error rather than being flattened into its
 * message. Fail Loudly rule 5: a seam's error modes are part of its interface,
 * and callers and tests should be able to branch on them. Collapsing five
 * distinct refusals — over the cap, empty body, duplicate recipient — into one
 * prose string meant the only way to tell them apart downstream was to match on
 * English, which is not an interface.
 *
 * `cause` is the carrier because `InfraError`'s payload is fixed at
 * `{layer, op, cause, message}`; `op` identifies the *kind* of failure and
 * `cause` holds its structure.
 */
export const refusalOf = (error: InfraError): BroadcastRefusal | null => {
  if (error.payload.op !== REFUSED_OP) return null;
  const cause = error.payload.cause;
  return isBroadcastRefusal(cause) ? cause : null;
};

/** Whether this failure is the caller's to fix. Kept for the 400-vs-502 branch. */
export const isRefusal = (error: InfraError): boolean =>
  error.payload.op === REFUSED_OP;

const isBroadcastRefusal = (value: unknown): value is BroadcastRefusal =>
  typeof value === 'object' && value !== null && 'reason' in value;

const refused = (refusal: BroadcastRefusal): InfraError =>
  // `http` rather than `prisma`: nothing failed in the database, the request
  // itself was not one Divo will act on. The layer is only ever read for
  // grouping in logs, and grouping a refusal with a dead connection pool would
  // make both harder to find.
  new InfraError({
    layer: 'http',
    op: REFUSED_OP,
    cause: refusal,
    message: describeRefusal(refusal),
  });

/** One row in the recipient picker. */
export interface CandidateView {
  readonly waChatId: string;
  readonly name: string;
  readonly isGroup: boolean;
  readonly lastMessageAt: Date | null;
  readonly sessionId: string;
  readonly sessionLabel: string;
  readonly openFollowUps: number;
  /** True when there is an open follow-up on this chat that we owe them. */
  readonly weOwe: boolean;
  /** True when there is an open follow-up on this chat we are waiting on. */
  readonly waitingOn: boolean;
}

/** What the review step is told before anything is sent. */
export interface BroadcastPreview {
  readonly reach: BroadcastReach;
  /** Upper bound in seconds, at the paced rate. */
  readonly estimatedSeconds: number;
  /**
   * Recipients that are not registered on WhatsApp, by chat id.
   *
   * Only ever populated for hand-typed numbers. A tracked chat has exchanged
   * messages by definition, so checking one would spend a request to confirm
   * something the transcript already proves.
   */
  readonly unreachable: readonly string[];
  /** Set when the send would be refused, so the button can say why. */
  readonly refusal: string | null;
}

export interface BroadcastDetail {
  readonly broadcast: BroadcastRow;
  readonly recipients: readonly BroadcastRecipientRow[];
}

interface Scope {
  readonly companyId: string;
  readonly departmentId: string;
}

/** A recipient as the caller names it, before Divo has resolved anything. */
export interface RequestedRecipient {
  readonly waChatId: string;
  readonly displayName: string;
  readonly isGroup: boolean;
}

export class WhatsappBroadcastService {
  private readonly log: Logger;

  constructor(
    private readonly deps: {
      readonly repo: BroadcastsRepoPort;
      readonly sessions: WhatsappSessionService;
      readonly gateway: OpenWaClient;
      readonly logger: Logger;
      readonly delayMs?: number;
    },
  ) {
    this.log = deps.logger.child({ service: 'whatsapp-broadcast' });
  }

  private get delayMs(): number {
    return this.deps.delayMs ?? BROADCAST_DELAY_MS;
  }

  /**
   * Everyone this department could send to, newest conversation first.
   *
   * Asks for one more row than the caller wanted, so a full page can be
   * reported as truncated rather than silently presented as the whole list.
   * Fail Loudly rule 6 — and it matters more here than on a read-only list: a
   * person picking recipients from a list that quietly stopped at 200 would
   * conclude a client is not in WhatsApp at all.
   */
  async candidates(scope: Scope & { sessionId?: string; limit: number }): Promise<
    Result<{ candidates: readonly CandidateView[]; truncated: boolean }, InfraError>
  > {
    const rows = await this.deps.repo.listCandidates({ ...scope, limit: scope.limit + 1 });
    if (!rows.ok) return rows;

    const truncated = rows.value.length > scope.limit;
    if (truncated) {
      this.log.warn('broadcast.candidatesTruncated', {
        limit: scope.limit,
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      });
    }
    return ok({
      candidates: rows.value.slice(0, scope.limit).map(toCandidateView),
      truncated,
    });
  }

  /**
   * What this send would actually do, without doing it.
   *
   * Runs the same refusal check the send does. Two copies of that rule is the
   * duplicate-authority problem and the copy that drifts is always the one
   * guarding the send — so both call `refuseBroadcast`, and this one is allowed
   * to return the refusal as text rather than as an error because nobody has
   * asked for anything to happen yet.
   */
  async preview(input: Scope & {
    readonly recipients: readonly RequestedRecipient[];
    readonly body: string;
  }): Promise<Result<BroadcastPreview, InfraError>> {
    const resolved = await this.resolve(input);
    if (!resolved.ok) return resolved;

    const refusal = refuseBroadcast({ recipients: resolved.value, body: input.body });
    return ok({
      reach: summarizeReach(resolved.value),
      estimatedSeconds: estimateSeconds(resolved.value.length, this.delayMs),
      unreachable: [],
      refusal: refusal ? describeRefusal(refusal) : null,
    });
  }

  /**
   * Send.
   *
   * Cold recipients are checked against WhatsApp first, one request each. The
   * send itself cannot answer that question — the gateway returns a real message
   * id for a number nobody has ever registered — so without this a broadcast to
   * a mistyped list reports a hundred successes and delivers nothing. Only
   * hand-typed numbers pay the cost; a tracked chat has proven it exists by
   * having spoken to us.
   */
  async send(input: Scope & {
    readonly sessionId: string;
    readonly requestId: string;
    readonly label: string;
    readonly body: string;
    readonly requestedById: string;
    readonly recipients: readonly RequestedRecipient[];
  }): Promise<Result<{
    readonly broadcastId: string;
    /** Cold recipients dropped because WhatsApp says they do not exist. */
    readonly skipped: readonly string[];
    /** Cold recipients sent to without a completed check — reported, not hidden. */
    readonly unverified: readonly string[];
    /** False when the durable row exists but OpenWA's POST response was lost. */
    readonly gatewayAcknowledged: boolean;
  }, InfraError>> {
    const session = await this.deps.sessions.findInScope(input.sessionId, input);
    if (!session.ok) return session;

    const gatewayBatchId = broadcastBatchId(input);
    const existing = await this.deps.repo.findIdempotent({
      sessionId: input.sessionId,
      gatewayBatchId,
    });
    if (!existing.ok) return existing;
    if (existing.value) {
      return ok({
        broadcastId: existing.value,
        skipped: [],
        unverified: [],
        gatewayAcknowledged: false,
      });
    }

    const resolved = await this.resolve(input);
    if (!resolved.ok) return resolved;

    const screened = await this.screenCold(session.value.openwaSessionId, resolved.value);
    if (!screened.ok) return screened;

    const refusal = refuseBroadcast({ recipients: screened.value.keep, body: input.body });
    if (refusal) {
      // Logged before it is returned. A refusal is not an error in the system,
      // but it *is* a send that did not happen, and the operator reading logs
      // after "why did nothing go out" should find the reason here.
      this.log.info('broadcast.refused', {
        reason: refusal.reason,
        recipients: screened.value.keep.length,
        detail: describeRefusal(refusal),
      });
      return err(refused(refusal));
    }

    const body = input.body.trim();
    const recipients = screened.value.keep.map(recipient => ({
      waChatId: recipient.waChatId,
      displayName: recipient.displayName,
      isGroup: recipient.isGroup,
      renderedBody: renderBody(body, recipient),
    }));

    // Stable for one reviewed request. A repeated HTTP request, double click, or
    // response-loss retry reaches the same unique `(sessionId, gatewayBatchId)`
    // row and never hands OpenWA a second batch.
    const created = await this.deps.repo.create({
      companyId: input.companyId,
      departmentId: input.departmentId,
      sessionId: input.sessionId,
      gatewayBatchId,
      label: input.label.trim() || body.slice(0, 60),
      body,
      requestedById: input.requestedById,
      recipients,
    });
    if (!created.ok) return created;
    if (!created.value.created) {
      return ok({
        broadcastId: created.value.broadcastId,
        skipped: screened.value.skipped,
        unverified: screened.value.unverified,
        gatewayAcknowledged: false,
      });
    }

    const accepted = await this.deps.gateway.sendBulk(session.value.openwaSessionId, {
      batchId: gatewayBatchId,
      delayMs: this.delayMs,
      messages: recipients.map(recipient => ({
        chatId: recipient.waChatId,
        text: recipient.renderedBody,
      })),
    });

    if (!accepted.ok) {
      // A failed response is not proof that the gateway rejected the request.
      // Keep `queued` pollable and hand the caller the durable id so it watches
      // this batch instead of retrying a second one.
      this.log.warn('broadcast.acceptance_unknown', {
        broadcastId: created.value.broadcastId,
        gatewayBatchId,
        sessionId: input.sessionId,
        error: accepted.error.message,
      });
      return ok({
        broadcastId: created.value.broadcastId,
        skipped: screened.value.skipped,
        unverified: screened.value.unverified,
        gatewayAcknowledged: false,
      });
    }

    const started = await this.deps.repo.markStatus({
      broadcastId: created.value.broadcastId, status: 'sending', startedAt: new Date(),
    });
    if (!started.ok) {
      // OpenWA accepted the batch. The row is still `queued`, which is live and
      // will be reconciled by the poller; returning an error would invite a retry.
      this.log.error('broadcast.markSendingFailed', {
        broadcastId: created.value.broadcastId,
        error: started.error.message,
      });
    }

    this.log.info('broadcast.sent', {
      broadcastId: created.value.broadcastId,
      gatewayBatchId,
      sessionId: input.sessionId,
      requestedById: input.requestedById,
      recipients: recipients.length,
      groups: recipients.filter(r => r.isGroup).length,
      cold: screened.value.keep.filter(r => r.cold).length,
      skipped: screened.value.skipped.length,
      unverified: screened.value.unverified.length,
      delayMs: this.delayMs,
    });

    return ok({
      broadcastId: created.value.broadcastId,
      skipped: screened.value.skipped,
      unverified: screened.value.unverified,
      gatewayAcknowledged: true,
    });
  }

  /** The history list, with the same truncation honesty as the picker. */
  async list(scope: Scope & { sessionId?: string; limit: number }): Promise<
    Result<{ broadcasts: readonly BroadcastRow[]; truncated: boolean }, InfraError>
  > {
    const rows = await this.deps.repo.list({ ...scope, limit: scope.limit + 1 });
    if (!rows.ok) return rows;
    return ok({
      broadcasts: rows.value.slice(0, scope.limit),
      truncated: rows.value.length > scope.limit,
    });
  }

  /**
   * One broadcast, freshly read from the gateway when it is still running.
   *
   * The screen polls this rather than the gateway directly, so the reading it
   * shows is the same one the database keeps. A poll that fails is logged and
   * swallowed: a momentarily unreachable gateway should show a slightly stale
   * progress bar, not an error page over a send that is going fine.
   */
  async detail(scope: Scope & { broadcastId: string }): Promise<
    Result<BroadcastDetail | null, InfraError>
  > {
    const found = await this.deps.repo.findForScope(scope);
    if (!found.ok) return found;
    if (!found.value) return ok(null);

    if (!isTerminal(normalizeBatchStatus(gatewayWordFor(found.value.status)))) {
      const polled = await this.poll(found.value);
      if (!polled.ok) {
        this.log.warn('broadcast.pollFailed', {
          broadcastId: found.value.id, error: polled.error.message,
        });
      }
    }
    return this.deps.repo.get(scope);
  }

  /**
   * Stop the remainder of a running broadcast.
   *
   * Messages already handed to WhatsApp are gone. This stops the ones that have
   * not gone yet, and the immediate re-poll is what turns the recipients still
   * marked `pending` into `cancelled` so nobody is left reading a list that
   * claims work is queued when nothing will run.
   */
  async cancel(scope: Scope & { broadcastId: string }): Promise<
    Result<{ stopped: boolean } | null, InfraError>
  > {
    const found = await this.deps.repo.findForScope(scope);
    if (!found.ok) return found;
    if (!found.value) return ok(null);

    const cancelled = await this.deps.gateway.cancelBatch(
      found.value.openwaSessionId, found.value.gatewayBatchId,
    );
    if (!cancelled.ok) return cancelled;

    const polled = await this.poll(found.value);
    if (!polled.ok) return polled;

    return ok({ stopped: !cancelled.value.alreadyFinished });
  }

  /** Broadcasts the worker should read, oldest reading first. */
  async pollable(limit: number): Promise<Result<readonly PollableBroadcast[], InfraError>> {
    return this.deps.repo.claimPollable({
      limit,
      olderThan: new Date(Date.now() - POLL_INTERVAL_MS),
    });
  }

  /**
   * Read one batch from the gateway and fold it into the stored broadcast.
   *
   * A batch the gateway has forgotten — 404, most often because it was
   * abandoned by a gateway restart, which it does deliberately rather than
   * risk re-sending — is recorded as `failed` rather than left running. The
   * recipient rows keep saying which messages had already gone out, which is the
   * only record of that split there is.
   */
  async poll(broadcast: PollableBroadcast): Promise<Result<void, InfraError>> {
    const status = await this.deps.gateway.batchStatus(
      broadcast.openwaSessionId, broadcast.gatewayBatchId,
    );

    if (!status.ok) {
      if (!/-> 404:/.test(status.error.message)) return status;
      const youngQueued = broadcast.status === 'queued'
        && Date.now() - broadcast.createdAt.getTime() < BATCH_DISCOVERY_GRACE_MS;
      if (youngQueued) {
        this.log.info('broadcast.batchNotVisibleYet', {
          broadcastId: broadcast.id,
          gatewayBatchId: broadcast.gatewayBatchId,
        });
        return this.deps.repo.touchPoll(broadcast.id);
      }
      this.log.warn('broadcast.batchGone', {
        broadcastId: broadcast.id, gatewayBatchId: broadcast.gatewayBatchId,
      });
      return this.deps.repo.markStatus({
        broadcastId: broadcast.id, status: 'failed', completedAt: new Date(),
      });
    }

    const remote = status.value;
    const normalized = normalizeBatchStatus(remote.status);
    return this.deps.repo.applyBatchStatus({
      broadcastId: broadcast.id,
      status: normalized,
      sent: remote.progress?.sent ?? 0,
      failed: remote.progress?.failed ?? 0,
      completedAt: isTerminal(normalized) ? readDate(remote.completedAt) ?? new Date() : null,
      results: (remote.results ?? []).map(result => ({
        waChatId: result.chatId,
        status: normalizeResultStatus(result.status),
        ...(result.messageId ? { waMessageId: result.messageId } : {}),
        ...(result.error?.message ? { error: result.error.message } : {}),
        ...(readDate(result.sentAt) ? { sentAt: readDate(result.sentAt)! } : {}),
      })),
    });
  }

  /**
   * Turn the caller's recipient list into one Divo can reason about.
   *
   * The only thing added is `cold`, and it is decided here rather than trusted
   * from the request: the client computes the same flag to draw its warning, and
   * a client that got it wrong — or lied — would otherwise skip the extra
   * screening that flag triggers.
   */
  private async resolve(input: Scope & {
    readonly sessionId?: string;
    readonly recipients: readonly RequestedRecipient[];
  }): Promise<Result<readonly BroadcastRecipientInput[], InfraError>> {
    const known = await this.deps.repo.resolveKnownChats({
      companyId: input.companyId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      waChatIds: input.recipients.map(recipient => recipient.waChatId),
    });
    if (!known.ok) return known;

    return ok(input.recipients.map(recipient => ({
      waChatId: recipient.waChatId,
      displayName: recipient.displayName,
      isGroup: recipient.isGroup,
      cold: !known.value.has(recipient.waChatId),
    })));
  }

  /**
   * Drop cold recipients that are not on WhatsApp.
   *
   * Dropped rather than failed, and reported back by name. A number that was
   * mistyped is not a delivery failure to investigate later — it is a mistake
   * somebody can still fix — and letting it into the batch would spend one of
   * the account's cold-contact allowance on a message nobody receives.
   *
   * A check that cannot be completed keeps the recipient. The gateway answers
   * 503 for "WhatsApp did not answer the lookup" precisely so that it is not
   * mistaken for "this number does not exist", and silently dropping a real
   * client because a lookup timed out is the worse of the two errors.
   */
  private async screenCold(
    openwaSessionId: string,
    recipients: readonly BroadcastRecipientInput[],
  ): Promise<Result<{
    keep: readonly BroadcastRecipientInput[];
    skipped: readonly string[];
    unverified: readonly string[];
  }, InfraError>> {
    const cold = recipients.filter(recipient => recipient.cold);
    if (cold.length === 0) return ok({ keep: recipients, skipped: [], unverified: [] });

    const missing = new Set<string>();
    const unverified: string[] = [];
    for (const recipient of cold) {
      const check = await this.deps.gateway.checkNumber(
        openwaSessionId, recipient.waChatId.split('@')[0]!,
      );
      if (!check.ok) {
        // Kept, but never silently. Fail Loudly rule 3: this is a
        // catch-and-continue, and it is only defensible because the caller is
        // told which recipients went out unchecked rather than being handed a
        // result indistinguishable from one where every number was verified.
        this.log.warn('broadcast.numberCheckFailed', {
          waChatIdHash: sha256(recipient.waChatId).slice(0, 16),
          error: check.error.message,
        });
        unverified.push(recipient.waChatId);
        continue;
      }
      if (!check.value.exists) missing.add(recipient.waChatId);
    }

    return ok({
      keep: recipients.filter(recipient => !missing.has(recipient.waChatId)),
      skipped: [...missing],
      unverified,
    });
  }
}

/** A content-bound idempotency key for one client request. */
function broadcastBatchId(input: {
  readonly requestId: string;
  readonly sessionId: string;
  readonly body: string;
  readonly recipients: readonly RequestedRecipient[];
}): string {
  const recipients = [...input.recipients]
    .map(recipient => ({
      waChatId: recipient.waChatId,
      displayName: recipient.displayName,
      isGroup: recipient.isGroup,
    }))
    .sort((a, b) => a.waChatId.localeCompare(b.waChatId));
  const digest = createHash('sha256')
    .update(JSON.stringify({
      requestId: input.requestId,
      sessionId: input.sessionId,
      body: input.body.trim(),
      recipients,
    }))
    .digest('hex')
    .slice(0, 24);
  return `divo_${digest}`;
}

const toCandidateView = (row: BroadcastCandidate): CandidateView => ({
  waChatId: row.waChatId,
  // The picker must show something clickable even for a chat WhatsApp never
  // gave a subject for; the id is at least recognisable to whoever runs the
  // number.
  name: row.name ?? row.waChatId.split('@')[0]!,
  isGroup: row.isGroup,
  lastMessageAt: row.lastMessageAt,
  sessionId: row.sessionId,
  sessionLabel: row.sessionLabel,
  openFollowUps: row.openFollowUps,
  weOwe: row.followUpOwners.includes('us'),
  waitingOn: row.followUpOwners.includes('them'),
});

/**
 * Divo's stored word, back in the gateway's vocabulary.
 *
 * `detail` needs to know whether a stored broadcast is finished, and the only
 * "is this terminal" rule lives in the domain, keyed by the gateway's words.
 * Translating back is a two-entry map rather than a second terminality rule,
 * because two rules is how one of them ends up disagreeing.
 */
const gatewayWordFor = (stored: string): string =>
  stored === 'queued' ? 'pending' : stored === 'sending' ? 'processing' : stored;

const readDate = (raw: string | null | undefined): Date | null => {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
