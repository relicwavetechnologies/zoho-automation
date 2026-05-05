/**
 * ChatMessageSerializer — per-chat sequential processing with no Redis locks.
 *
 * Problem it solves
 * ─────────────────
 * When two users in a group chat (or one user sending rapidly) fire prompts at
 * the same time, both engine.run() calls start concurrently and race over the
 * same conversation history. The old backend solved this with a per-chat Redis
 * distributed lock — but lock TTL had to match worst-case job duration (120 s+),
 * so a single hung request blocked the entire chat for two minutes.
 *
 * How this works
 * ──────────────
 * Each chatId gets a Promise chain in a local Map. Incoming tasks are appended
 * to the tail of the chain with .then(), so they naturally queue behind whatever
 * is currently running — exactly like a single-threaded queue per chat.
 *
 *   msg-1 arrives → chain[chat] = run(msg-1)
 *   msg-2 arrives → chain[chat] = run(msg-1).then(run(msg-2))
 *   msg-3 arrives → chain[chat] = run(msg-1).then(run(msg-2)).then(run(msg-3))
 *
 * When the chain completes, the Map entry is deleted so memory doesn't grow.
 * A configurable timeout per-task prevents a hung engine.run() from blocking
 * the queue forever — on timeout the task is aborted and the next one starts.
 *
 * Properties
 * ──────────
 * • Per-chat serialization   — different chats run fully in parallel.
 * • No Redis                 — no lock TTL math, no orphaned locks on crash.
 * • Graceful error isolation — if task N throws, task N+1 still runs.
 * • Self-cleaning            — map entries are deleted when the chain is idle.
 * • Timeout guard            — configurable max duration; timed-out task calls
 *                              an optional onTimeout callback before releasing.
 *
 * Limitations
 * ───────────
 * Single-process only. If you horizontally scale to multiple Node.js processes,
 * each process has its own Map and messages routed to different processes will
 * run concurrently. At that scale, replace this with a per-chatId BullMQ queue
 * group or a Redis-based FIFO per chat. For a single-process deployment this is
 * strictly superior to the distributed lock approach.
 */

export interface SerializerOptions {
  /**
   * Max milliseconds a single task may run before it is considered timed out.
   * The task's Promise is raced against this deadline. The task itself is NOT
   * cancelled (JS has no pre-emptive cancellation) but the queue slot is freed
   * and `onTimeout` is called so the caller can send an error reply to the user.
   *
   * Default: 120_000 ms (2 minutes).
   */
  timeoutMs?: number;

  /**
   * Called when a task exceeds `timeoutMs`. Receives the chatId so the caller
   * can send an error reply to the user.
   */
  onTimeout?: (chatId: string) => void;
}

export class ChatMessageSerializer {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly timeoutMs: number;
  private readonly onTimeout: ((chatId: string) => void) | undefined;

  constructor(opts: SerializerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.onTimeout = opts.onTimeout;
  }

  /**
   * Enqueue `task` for the given `chatId`. Returns immediately — the task will
   * run after any currently-queued tasks for the same chat complete.
   *
   * Tasks for different chatIds run fully in parallel.
   */
  run(chatId: string, task: () => Promise<void>): void {
    const prev = this.chains.get(chatId) ?? Promise.resolve();

    const guarded = (): Promise<void> => {
      let timedOut = false;

      const work = task().catch(() => {
        // Swallow task errors — they are the caller's responsibility to handle
        // internally. We must not let them break the chain for subsequent msgs.
      });

      const deadline = new Promise<void>((_, reject) =>
        setTimeout(() => {
          timedOut = true;
          reject(new Error(`chat_serializer.timeout: chatId=${chatId}`));
        }, this.timeoutMs).unref(),
      );

      return Promise.race([work, deadline]).catch(() => {
        if (timedOut) {
          try { this.onTimeout?.(chatId); } catch { /* non-fatal */ }
        }
      });
    };

    // Chain: wait for prev to settle (resolve OR reject) before starting next.
    // Using .then(guarded, guarded) ensures guarded() always runs regardless of
    // whether prev resolved or rejected.
    const next = prev.then(guarded, guarded);

    this.chains.set(chatId, next);

    // Self-cleanup: once this task completes, remove from map if it is still
    // the tail (a later task may have already replaced it).
    void next.finally(() => {
      if (this.chains.get(chatId) === next) {
        this.chains.delete(chatId);
      }
    });
  }

  /** Number of chats that currently have active or queued work. */
  get activeChats(): number {
    return this.chains.size;
  }

  /**
   * Returns true if the given chatId has a task running or queued.
   * Useful for logging / health checks.
   */
  isActive(chatId: string): boolean {
    return this.chains.has(chatId);
  }
}
