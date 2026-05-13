/**
 * ChatMessageSerializer — per-chat sequential processing with no Redis locks.
 *
 * Each chatId gets a Promise chain. Incoming tasks queue behind whatever is
 * currently running — like a single-threaded queue per chat.
 *
 * Features:
 * • Per-chat serialization   — different chats run in parallel (up to maxConcurrent).
 * • AbortSignal on timeout   — timed-out tasks are aborted, not just abandoned.
 * • Global backpressure      — maxConcurrent caps total parallel engine.run() calls.
 * • Graceful error isolation — if task N throws, task N+1 still runs.
 * • Self-cleaning            — map entries are deleted when the chain is idle.
 *
 * Limitation: single-process only. At horizontal scale, replace with Redis FIFO.
 */

export interface SerializerOptions {
  /**
   * Max milliseconds a single task may run before it is considered timed out.
   * The task is aborted via AbortSignal and the queue slot is freed.
   *
   * Default: 120_000 ms (2 minutes).
   */
  timeoutMs?: number;

  /**
   * Called when a task exceeds `timeoutMs`. Receives the chatId so the caller
   * can send an error reply to the user.
   */
  onTimeout?: (chatId: string) => void;

  /**
   * Maximum number of engine.run() calls allowed across all chats.
   * Additional tasks wait until a slot opens.
   * Default: Infinity (no limit).
   */
  maxConcurrent?: number;
}

export class ChatMessageSerializer {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly timeoutMs: number;
  private readonly onTimeout: ((chatId: string) => void) | undefined;
  private readonly maxConcurrent: number;
  private activeTasks = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(opts: SerializerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.onTimeout = opts.onTimeout;
    this.maxConcurrent = opts.maxConcurrent ?? Infinity;
  }

  private acquireSlot(): Promise<void> {
    if (this.activeTasks < this.maxConcurrent) {
      this.activeTasks++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => this.waitQueue.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.activeTasks--;
    }
  }

  /**
   * Enqueue `task` for the given `chatId`. Returns immediately — the task will
   * run after any currently-queued tasks for the same chat complete.
   *
   * The task receives an AbortSignal that fires when the timeout expires.
   * Tasks for different chatIds run fully in parallel (up to maxConcurrent).
   */
  run(chatId: string, task: (signal: AbortSignal) => Promise<void>): void {
    const prev = this.chains.get(chatId) ?? Promise.resolve();

    const guarded = async (): Promise<void> => {
      await this.acquireSlot();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        (timer as ReturnType<typeof setTimeout>).unref?.();

        try {
          await task(controller.signal);
        } catch (e) {
          if (controller.signal.aborted) {
            try { this.onTimeout?.(chatId); } catch { /* non-fatal */ }
          }
          // Swallow — caller handles errors internally.
        } finally {
          clearTimeout(timer);
        }
      } finally {
        this.releaseSlot();
      }
    };

    // Chain: wait for prev to settle (resolve OR reject) before starting next.
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

  /** Number of engine.run() calls currently executing across all chats. */
  get runningTasks(): number {
    return this.activeTasks;
  }

  /**
   * Returns true if the given chatId has a task running or queued.
   * Useful for logging / health checks.
   */
  isActive(chatId: string): boolean {
    return this.chains.has(chatId);
  }
}
