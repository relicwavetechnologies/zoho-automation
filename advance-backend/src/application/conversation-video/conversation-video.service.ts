/**
 * A video attached to a conversation, from arrival to answer.
 *
 * Two callers and one promise between them. The upload route hands over bytes
 * and gets an id back immediately; reading starts there and then, while the
 * person is still typing their question. The run asks for the same id and waits
 * on the reading that is already under way — so the wait a member experiences
 * is only the part that had not finished yet, not the whole of it.
 *
 * The in-flight promise is deliberately in memory. Losing it to a restart costs
 * one re-read of a video that is still on disk, and the alternative — a queue,
 * a worker, a row and a state machine — is a great deal of machinery to avoid
 * repeating work that takes a minute and happens rarely. If reading ever needs
 * to survive a deploy or run on another instance, that is the moment to add
 * them, and the interface here does not change when it comes.
 */

import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Logger } from '../../shared/logger';
import type { VideoUnderstanding } from '../video-understanding/video-understanding.types';
import type { VideoUnderstandingService } from '../video-understanding/video-understanding.service';
import {
  ConversationVideoStore,
  isSupportedConversationVideoMime,
  type ConversationVideoOwner,
  type ConversationVideoRecord,
} from './conversation-video.store';

export class ConversationVideoError extends Error {
  constructor(
    readonly code:
      | 'unsupported_video'
      | 'video_not_found'
      | 'video_unreadable'
      | 'video_budget_reached',
    message: string,
  ) {
    super(message);
    this.name = 'ConversationVideoError';
  }
}

export interface ConversationVideoProgress {
  /** 0–100 of the reading itself. */
  readonly percent: number;
  readonly step: 'watching' | 'transcribing' | 'reading_screens' | 'ready';
}

export interface ConversationVideoServiceDeps {
  readonly store: ConversationVideoStore;
  readonly understanding: VideoUnderstandingService;
  readonly logger: Logger;
  /**
   * How many videos may be read at once, across everybody.
   *
   * Teach runs this same reader behind a BullMQ worker with its own
   * concurrency; reading straight out of the API process would have dropped
   * that backpressure silently. ffmpeg plus a fan-out of vision calls is not
   * something ten members should be able to start simultaneously by dragging
   * files into a chat.
   */
  readonly maxConcurrentReads?: number;
  /**
   * How much unread and unswept video one company may be holding.
   *
   * The per-request cap alone bounds nothing: recordings arrive faster than two
   * readers drain them and are only deleted once read or swept, so a member in
   * a loop fills the volume everything else writes to. This is the ceiling that
   * actually stops that.
   */
  readonly maxCompanyBytes?: number;
  /**
   * Readings one company may start in `readWindowMs`.
   *
   * A byte budget alone bounds disk and nothing else. Every accepted upload
   * spends an ffmpeg run, a transcription and up to forty vision calls the
   * moment it lands — no ask required — so a loop of one-second clips costs
   * real money while never approaching a gigabyte.
   */
  readonly maxReadsPerWindow?: number;
  readonly readWindowMs?: number;
  /**
   * How much unread video the whole deployment may hold, across all tenants.
   *
   * The per-company budget bounds one tenant; nothing bounded their sum. These
   * files land on the same filesystem as Postgres and Redis, so "8 GB each" is
   * only a limit while the number of companies is small.
   */
  readonly maxTotalBytes?: number;
}

/*
 * The named steps a member sees, and where each one starts.
 *
 * Taken from the reader's own progress scale so the two never drift: it reports
 * frames taken at 20 and the transcript at 45, and a label that disagreed with
 * the bar underneath it would be worse than no label.
 */
const STEP_TRANSCRIBING = 20;
const STEP_READING_SCREENS = 45;

export class ConversationVideoService {
  private readonly log: Logger;
  /** videoId → the reading currently under way, if any. */
  private readonly inFlight = new Map<string, Promise<VideoUnderstanding>>();
  private readonly progress = new Map<string, ConversationVideoProgress>();
  /** Readings waiting for a slot. Resolved in arrival order as slots free up. */
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  /**
   * Bytes an upload could still turn out to occupy, per company.
   *
   * Reserved at the worst case for the whole of a stream and released when it
   * ends. Reading the disk alone bounds nothing: thirty simultaneous uploads
   * all read the same zero before any of them has written a byte, and every one
   * of them passes.
   */
  private readonly reserved = new Map<string, number>();
  /** When each company's recent readings started, oldest first. */
  private readonly started = new Map<string, number[]>();

  constructor(private readonly deps: ConversationVideoServiceDeps) {
    this.log = deps.logger.child({ service: 'conversation-video' });
  }

  /**
   * Take the recording, and start reading it.
   *
   * Returns as soon as the bytes are safely on disk. Reading runs on its own
   * from there; nothing awaits it here, because the point of starting now is
   * that the member's question is still being typed.
   */
  async accept(input: {
    readonly owner: ConversationVideoOwner;
    readonly fileName: string;
    readonly mimeType: string;
    readonly body: Readable;
    /**
     * What the client says it is about to send, when it says.
     *
     * Only ever used to size the reservation, and clamped to the hard cap — a
     * lie makes the reservation too small, never the write. Without it every
     * upload reserved the 2 GB ceiling, which turned a byte budget into a
     * concurrency limit: six colleagues sending 4 MB clips at once had the
     * sixth refused for disk pressure while the workspace held twenty
     * megabytes.
     */
    readonly declaredBytes?: number;
  }): Promise<ConversationVideoRecord> {
    const mimeType = input.mimeType.toLowerCase();
    if (!isSupportedConversationVideoMime(mimeType)) {
      throw new ConversationVideoError('unsupported_video', 'Divo reads MP4, MOV and WebM video');
    }

    /* Claimed up front and given back if this upload never starts a reading.
       Checking now and spending later leaves a window in which every request in
       a burst reads the same count and passes — so the claim happens here, in
       one synchronous step with the check. */
    const releaseToken = this.claimReadToken(input.owner.companyId);
    const total = this.deps.maxTotalBytes;
    if (total !== undefined) {
      const heldEverywhere = await this.deps.store.bytesHeldInTotal();
      if (heldEverywhere + this.pendingEverywhere() >= total) {
        releaseToken();
        this.log.warn('conversation_video.total_budget_reached', { heldBytes: heldEverywhere });
        throw new ConversationVideoError(
          'video_budget_reached',
          'Divo is still working through the recordings it has been sent. Try again shortly.',
        );
      }
    }

    const limit = this.deps.maxCompanyBytes;
    const worstCase = Math.min(
      Number.isFinite(input.declaredBytes) && (input.declaredBytes ?? 0) > 0
        ? input.declaredBytes!
        : this.deps.store.maxBytes,
      this.deps.store.maxBytes,
    );
    if (limit !== undefined) {
      const held = await this.deps.store.bytesHeldBy(input.owner.companyId);
      const pending = this.reserved.get(input.owner.companyId) ?? 0;
      if (held + pending >= limit) {
        releaseToken();
        this.log.warn('conversation_video.company_budget_reached', {
          companyId: input.owner.companyId,
          heldBytes: held,
          pendingBytes: pending,
        });
        throw new ConversationVideoError(
          'video_budget_reached',
          'Divo is still working through the recordings this workspace has sent. Try again shortly.',
        );
      }
      this.reserve(input.owner.companyId, worstCase);
    } else if (total !== undefined) {
      // Reserved even without a per-company budget, so the global check sees
      // what is already in flight rather than only what has landed.
      this.reserve(input.owner.companyId, worstCase);
    }

    const record: ConversationVideoRecord = {
      ...input.owner,
      videoId: randomUUID(),
      fileName: input.fileName,
      mimeType,
      sizeBytes: 0,
      receivedAt: new Date().toISOString(),
    };
    let sizeBytes: number;
    try {
      sizeBytes = await this.deps.store.saveSource({ record, body: input.body });
    } catch (error) {
      // Nothing was read, so the token goes back: a refused or cancelled upload
      // must not count against an hour's worth of real work.
      releaseToken();
      throw error;
    } finally {
      if (limit !== undefined || total !== undefined) {
        this.reserve(input.owner.companyId, -worstCase);
      }
    }
    const saved = { ...record, sizeBytes };

    // Started, not awaited — the point of starting now is that the question is
    // still being typed. The `catch` is on this reference only: the promise
    // kept in `inFlight` still rejects, so whoever asks for the reading later
    // gets the real failure. Without it, a video that fails before anybody asks
    // takes the process down as an unhandled rejection.
    this.begin(saved).catch(() => undefined);
    return saved;
  }

  /**
   * The reading for a video this person owns, waiting for it if it is not done.
   *
   * Ownership is checked against what was recorded at upload rather than
   * against the caller's claim: an id is a bearer token otherwise, and these
   * ids travel through a browser.
   */
  async understandingFor(input: {
    readonly owner: ConversationVideoOwner;
    readonly videoId: string;
    /**
     * Abandons the wait when the member stops the run.
     *
     * The reading itself carries on to completion — it is shared, already paid
     * for, and the next ask in the thread will want it. What this cancels is
     * *waiting*, which is the part that was holding the run open.
     */
    readonly signal?: AbortSignal;
  }): Promise<VideoUnderstanding> {
    const record = await this.ownedRecord(input.owner, input.videoId);
    const done = await this.deps.store.readUnderstanding(record.companyId, record.videoId);
    if (done) return done;
    const running = this.inFlight.get(record.videoId) ?? this.begin(record);
    if (!input.signal) return running;
    return Promise.race([running, abortion(input.signal)]);
  }

  /**
   * What is known about a video, if it belongs to this conversation.
   *
   * Public because the run needs the name to say "Divo is watching X" before it
   * has anything else, and the browser's copy of that name is not the one that
   * was stored.
   */
  async recordFor(input: {
    readonly owner: ConversationVideoOwner;
    readonly videoId: string;
  }): Promise<ConversationVideoRecord> {
    return this.ownedRecord(input.owner, input.videoId);
  }

  /**
   * How far along a reading is, right now.
   *
   * A snapshot to poll rather than a subscription to manage. The only thing
   * watching is a run that is already looping to yield events, and handing it a
   * callback would mean handing it an unsubscribe to remember on a path that
   * can be abandoned halfway through.
   */
  progressFor(videoId: string): ConversationVideoProgress | null {
    return this.progress.get(videoId) ?? null;
  }

  /** What has already been read, without starting or waiting for anything. */
  async settledUnderstanding(input: {
    readonly owner: ConversationVideoOwner;
    readonly videoId: string;
  }): Promise<VideoUnderstanding | null> {
    const record = await this.ownedRecord(input.owner, input.videoId);
    return this.deps.store.readUnderstanding(record.companyId, record.videoId);
  }

  async prune(olderThanMs: number): Promise<number> {
    // The rate window ages out with it. Nothing else revisits a company that
    // stopped uploading, so without this the map only grows.
    const since = Date.now() - (this.deps.readWindowMs ?? 3_600_000);
    for (const [companyId, times] of this.started) {
      const recent = times.filter(at => at > since);
      if (recent.length === 0) this.started.delete(companyId);
      else this.started.set(companyId, recent);
    }
    return this.deps.store.prune(olderThanMs);
  }

  /**
   * Refuse a company starting readings faster than agreed.
   *
   * A plain sliding window, kept in memory: this is a spend guard rather than a
   * security control, and one process forgetting its history on restart costs
   * at most one extra window's worth.
   */
  private claimReadToken(companyId: string): () => void {
    const cap = this.deps.maxReadsPerWindow;
    if (cap === undefined) return () => undefined;
    const windowMs = this.deps.readWindowMs ?? 3_600_000;
    const now = Date.now();
    const recent = (this.started.get(companyId) ?? []).filter(at => at > now - windowMs);
    if (recent.length >= cap) {
      this.started.set(companyId, recent);
      this.log.warn('conversation_video.read_rate_reached', { companyId, recent: recent.length });
      throw new ConversationVideoError(
        'video_budget_reached',
        'Divo is still working through the recordings this workspace has sent. Try again shortly.',
      );
    }
    recent.push(now);
    this.started.set(companyId, recent);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const held = this.started.get(companyId);
      if (!held) return;
      const at = held.indexOf(now);
      if (at >= 0) held.splice(at, 1);
      if (held.length === 0) this.started.delete(companyId);
    };
  }

  private pendingEverywhere(): number {
    let total = 0;
    for (const bytes of this.reserved.values()) total += bytes;
    return total;
  }

  private reserve(companyId: string, delta: number): void {
    const next = (this.reserved.get(companyId) ?? 0) + delta;
    if (next <= 0) this.reserved.delete(companyId);
    else this.reserved.set(companyId, next);
  }

  private async ownedRecord(
    owner: ConversationVideoOwner,
    videoId: string,
  ): Promise<ConversationVideoRecord> {
    const record = await this.deps.store.metaFor(owner.companyId, videoId);
    if (
      !record
      || record.companyId !== owner.companyId
      || record.userId !== owner.userId
      || record.channel !== owner.channel
      || record.threadId !== owner.threadId
    ) {
      throw new ConversationVideoError('video_not_found', 'That video is not part of this conversation');
    }
    return record;
  }

  /**
   * Start reading, once per video.
   *
   * The promise is registered before the first await so two callers arriving in
   * the same tick share one reading rather than racing to start two, and it is
   * removed on failure so a retry is possible — but only after the failure has
   * been delivered to everyone already waiting on it.
   */
  private begin(record: ConversationVideoRecord): Promise<VideoUnderstanding> {
    const existing = this.inFlight.get(record.videoId);
    if (existing) return existing;

    const running = this.read(record)
      .then(async understanding => {
        await this.deps.store.commitUnderstanding(record.companyId, record.videoId, understanding);
        this.inFlight.delete(record.videoId);
        return understanding;
      })
      .catch(error => {
        this.inFlight.delete(record.videoId);
        this.progress.delete(record.videoId);
        this.log.warn('conversation_video.read_failed', {
          videoId: record.videoId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new ConversationVideoError(
          'video_unreadable',
          'Divo could not read that video',
        );
      });

    this.inFlight.set(record.videoId, running);
    return running;
  }

  private async read(record: ConversationVideoRecord): Promise<VideoUnderstanding> {
    await this.takeSlot();
    try {
      return await this.readNow(record);
    } finally {
      this.releaseSlot();
      /* Cleared the moment reading stops, not after the result is committed.
         `progressFor` means "a reading is under way"; leaving the entry in
         place across the write left a window where a finished reading still
         reported 90%, and holding it forever would be a map that only grows. */
      this.progress.delete(record.videoId);
    }
  }

  /** Waits for a reading slot, in arrival order. */
  private async takeSlot(): Promise<void> {
    const limit = this.deps.maxConcurrentReads ?? 2;
    if (this.active < limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>(resolve => { this.waiting.push(resolve); });
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  private async readNow(record: ConversationVideoRecord): Promise<VideoUnderstanding> {
    const source = await this.deps.store.sourcePath(
      record.companyId,
      record.videoId,
      record.mimeType,
    );
    if (!source) {
      throw new ConversationVideoError('video_not_found', 'That recording is no longer available');
    }
    this.progress.set(record.videoId, { percent: 0, step: 'watching' });
    return this.deps.understanding.understand({
      videoPath: source,
      workDir: this.deps.store.framesDir(record.companyId, record.videoId),
      onProgress: async percent => {
        this.progress.set(record.videoId, { percent, step: stepFor(percent) });
      },
    });
  }
}

function stepFor(percent: number): ConversationVideoProgress['step'] {
  if (percent >= STEP_READING_SCREENS) return 'reading_screens';
  if (percent >= STEP_TRANSCRIBING) return 'transcribing';
  return 'watching';
}

/** Rejects when the signal aborts, and never otherwise. */
function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new ConversationVideoError('video_unreadable', 'Waiting for the video was cancelled'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(new ConversationVideoError('video_unreadable', 'Waiting for the video was cancelled')),
      { once: true },
    );
  });
}
