import type { LanguageModel } from 'ai';
import type { Logger } from '../../shared/logger';
import type { FollowUpsRepoPort } from '../../infrastructure/persistence/follow-ups.repository';
import { analyzeChat } from './follow-up-analysis';
import { reconcileAnalysis } from './follow-up-reconcile';
import { newDigestClaimToken } from './follow-up-digest.runner';
import type { ClaimedDigest } from '../../infrastructure/persistence/follow-ups.repository';

/**
 * The sweep that spends money.
 *
 * It polls Divo's own Postgres, never WhatsApp — the question it asks is "which
 * chats have moved since I last read them", and both sides of that comparison
 * are our columns. That is why it can run every five minutes without a bill: the
 * cost is one model call per *eligible* chat, and eligibility is deliberately
 * hard to earn.
 *
 * The gates live in `claimChatsForAnalysis`. The numbers below are the ones the
 * imported agent settled on, and they are load-bearing rather than arbitrary:
 * the cooldown alone caps a chat at two calls an hour no matter how much traffic
 * it carries.
 */

export interface FollowUpAnalysisDeps {
  readonly repo: FollowUpsRepoPort;
  /**
   * The model this chat's company runs on, resolved per sweep rather than
   * fixed at boot.
   *
   * A single client built once carried both the provider and the credential
   * for the whole install: moving Divo's default to Spark left this on
   * DeepSeek, and when that account ran dry every chat failed with
   * `Insufficient Balance` while a funded Meta key sat on the Guardrails page.
   * Resolving per company means the key an admin manages there is the key this
   * spends, and each company pays for its own reading.
   */
  readonly resolveModel: (input: {
    modelId: string;
    companyId: string;
  }) => Promise<LanguageModel>;
  /** Which model to ask for. The resolver turns it into a client. */
  readonly modelId: string;
  readonly logger: Logger;
  readonly timeZone?: string;
  readonly scanIntervalMs?: number;
  /** Leave a chat alone until it has been quiet this long. */
  readonly quietMs?: number;
  /** Never re-analyse the same chat within this. The hard ceiling on spend. */
  readonly cooldownMs?: number;
  /** How far back a transcript reaches. */
  readonly windowDays?: number;
  readonly maxMessages?: number;
  readonly maxChatsPerSweep?: number;
  readonly confidenceFloor?: number;
  /**
   * Sends one due digest. Absent where no Lark delivery is configured, in which
   * case the analysis half still runs and the tab still fills — the group simply
   * is not told, which the boot log says out loud.
   */
  readonly runDigest?: (claim: ClaimedDigest) => Promise<void>;
  readonly maxDigestsPerSweep?: number;
}

const DEFAULTS = {
  scanIntervalMs: 5 * 60_000,
  quietMs: 3 * 60_000,
  cooldownMs: 30 * 60_000,
  windowDays: 5,
  maxMessages: 60,
  maxChatsPerSweep: 8,
  maxDigestsPerSweep: 5,
  confidenceFloor: 0.55,
  timeZone: 'Asia/Kolkata',
} as const;

export class FollowUpAnalysisWorker {
  private readonly log: Logger;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly deps: FollowUpAnalysisDeps) {
    this.log = deps.logger.child({ service: 'follow-up-analysis' });
  }

  start(): void {
    const tick = () => {
      void this.runOnce().catch((error: unknown) => {
        this.log.error('follow_up_analysis.tick_failed', { error: errorText(error) });
      });
    };
    tick();
    this.timer = setInterval(tick, this.deps.scanIntervalMs ?? DEFAULTS.scanIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const candidates = await this.deps.repo.claimChatsForAnalysis({
        quietBefore: new Date(now - (this.deps.quietMs ?? DEFAULTS.quietMs)),
        cooldownBefore: new Date(now - (this.deps.cooldownMs ?? DEFAULTS.cooldownMs)),
        limit: this.deps.maxChatsPerSweep ?? DEFAULTS.maxChatsPerSweep,
      });
      // Digests first, and unconditionally. They are due on a clock rather than
      // on traffic, so a quiet department with nothing to analyse must still be
      // told — including that one of its numbers has gone dark, which is exactly
      // the state that produces no traffic.
      await this.runDueDigests();

      if (!candidates.ok) {
        this.log.error('follow_up_analysis.claim_failed', { error: candidates.error.message });
        return;
      }
      if (candidates.value.length === 0) return;

      let analysed = 0;
      let created = 0;
      let resolved = 0;

      for (const candidate of candidates.value) {
        const outcome = await this.analyseOne(candidate);
        if (outcome) {
          analysed += 1;
          created += outcome.created;
          resolved += outcome.resolved;
        }
      }

      // Saturation is reported, not inferred. A sweep filling its cap every round
      // means more chats are due than it can carry; with fair ordering that shows
      // up as delay rather than loss, but it is still the signal that the cap
      // needs raising, and it must not be silent.
      const cap = this.deps.maxChatsPerSweep ?? DEFAULTS.maxChatsPerSweep;
      const saturated = candidates.value.length >= cap;
      if (saturated) this.log.warn('follow_up_analysis.sweep_saturated', { cap });

      this.log.info('follow_up_analysis.tick', {
        candidates: candidates.value.length, analysed, created, resolved, saturated,
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Send any digests whose slot has come.
   *
   * Runs on the same timer as the analysis sweep rather than its own. The two
   * are the same shape — poll our own Postgres, claim what is due, do it — and a
   * second `setInterval` would buy one more thing to start, stop and reason
   * about for no behaviour a five-minute granularity does not already give. A
   * digest a few minutes late is invisible; a digest that never fires is not,
   * and that is a claim problem rather than a timer problem.
   */
  private async runDueDigests(): Promise<void> {
    if (!this.deps.runDigest) return;

    const claimed = await this.deps.repo.claimDueDigests({
      now: new Date(),
      claimToken: newDigestClaimToken(),
      limit: this.deps.maxDigestsPerSweep ?? DEFAULTS.maxDigestsPerSweep,
    });
    if (!claimed.ok) {
      this.log.error('follow_up_digest.claim_failed', { error: claimed.error.message });
      return;
    }

    for (const claim of claimed.value) {
      // The runner owns its own failure handling and always releases its claim,
      // so one failing digest cannot strand the others behind it.
      await this.deps.runDigest(claim);
    }
  }

  private async analyseOne(candidate: {
    chatId: string; companyId: string; departmentId: string;
    chatName: string | null; isGroup: boolean; lastMessageAt: Date | null;
  }): Promise<{ created: number; resolved: number } | null> {
    const windowDays = this.deps.windowDays ?? DEFAULTS.windowDays;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60_000);

    const transcript = await this.deps.repo.transcriptFor({
      chatId: candidate.chatId,
      since,
      limit: this.deps.maxMessages ?? DEFAULTS.maxMessages,
    });
    if (!transcript.ok) {
      this.log.error('follow_up_analysis.transcript_failed', {
        chatId: candidate.chatId, error: transcript.error.message,
      });
      return null;
    }

    if (transcript.value.length === 0) {
      // An empty window is the only thing skipped without reading.
      //
      // The imported agent required two messages, and that quietly lost leads:
      // one inbound "can you send the quote?" with no reply is the purest
      // follow-up there is, and once stamped the chat never moved again, so it
      // was never looked at. The reverse case is just as real — a window holding
      // only our own "I'll send it tomorrow" is a commitment we owe.
      //
      // A floor cannot tell noise from an ask without reading the message, so
      // there is no floor. The cooldown already caps a chat at two calls an
      // hour, and that is the actual spend control.
      //
      // Stamped even so: an unstamped chat stays permanently due and crowds out
      // chats that do have something in them.
      await this.deps.repo.markAnalyzed({
        chatId: candidate.chatId,
        analyzedThrough: candidate.lastMessageAt,
      });
      return null;
    }

    const tracked = await this.deps.repo.trackedFor(candidate.chatId);
    if (!tracked.ok) {
      this.log.error('follow_up_analysis.tracked_failed', {
        chatId: candidate.chatId, error: tracked.error.message,
      });
      return null;
    }

    /*
     * Resolved here rather than held on the worker: the key is per company and
     * an admin can rotate it without a restart. A company with no key for the
     * model is a configuration gap, not a chat problem — say so once and leave
     * the chat unstamped so it is read again when somebody fixes it.
     */
    let model: LanguageModel;
    try {
      model = await this.deps.resolveModel({
        modelId: this.deps.modelId,
        companyId: candidate.companyId,
      });
    } catch (cause) {
      this.log.error('follow_up_analysis.model_unavailable', {
        chatId: candidate.chatId,
        companyId: candidate.companyId,
        modelId: this.deps.modelId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return null;
    }

    const result = await analyzeChat({
      chatName: candidate.chatName ?? 'Unnamed chat',
      isGroup: candidate.isGroup,
      timeZone: this.deps.timeZone ?? DEFAULTS.timeZone,
      messages: transcript.value,
      tracked: tracked.value,
    }, { model, logger: this.log });

    if (!result.ok) {
      // Deliberately not stamped. A model failure says nothing about the chat,
      // and marking it read would skip a real conversation until its next
      // message arrives — which for a stalled thread could be never.
      this.log.error('follow_up_analysis.model_failed', {
        chatId: candidate.chatId, error: result.error.message,
      });
      return null;
    }

    const plan = reconcileAnalysis(
      result.value.analysis,
      new Set(tracked.value.map(item => item.id)),
      { confidenceFloor: this.deps.confidenceFloor ?? DEFAULTS.confidenceFloor },
    );

    if (plan.unknownIds.length > 0) {
      this.log.warn('follow_up_analysis.unknown_ids', {
        chatId: candidate.chatId, ids: plan.unknownIds,
      });
    }

    const applied = await this.deps.repo.applyPlan({
      chatId: candidate.chatId,
      companyId: candidate.companyId,
      departmentId: candidate.departmentId,
      create: plan.create,
      update: plan.update,
      resolve: plan.resolve,
    });
    if (!applied.ok) {
      this.log.error('follow_up_analysis.apply_failed', {
        chatId: candidate.chatId, error: applied.error.message,
      });
      return null;
    }

    await this.deps.repo.markAnalyzed({
      chatId: candidate.chatId,
      // The newest message this pass actually read — not "now". A message that
      // arrived mid-analysis must still count as unread, or it is skipped
      // forever.
      analyzedThrough: transcript.value[transcript.value.length - 1]?.occurredAt
        ?? candidate.lastMessageAt,
    });

    return { created: plan.create.length, resolved: plan.resolve.length };
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
