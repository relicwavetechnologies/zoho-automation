import type { Logger } from '../../shared/logger';
import type { WebRunEvent } from './web-run.service';

/**
 * Runs in flight, and who may watch them.
 *
 * The thing this fixes is not a bug in one file, it is an assumption: that a
 * run belongs to the HTTP connection that started it. It never did. A person
 * asks Divo to do something and then switches tab, and the work has no reason
 * to care — but the connection closing tore down the run, so coming back found
 * an empty thread and no evidence anything had been asked.
 *
 * So a run lives here instead, and a connection is a *view* onto it. Opening one
 * replays the latest state and then follows; closing one is nothing at all. Two
 * tabs on the same thread see the same run, because there is only one.
 *
 * Deliberately in memory. A run is a live thing — it holds a container, an abort
 * signal, and a generator mid-flight, none of which survive a process restart in
 * any store. What must outlive the process is the *conversation*, and that is in
 * Postgres. This holds only the part that is genuinely ephemeral, and Divo runs
 * single-instance per deployment; if that changes, this needs a real bus rather
 * than a bigger map.
 */

/** How long a finished run stays visible after it settles. */
const SETTLED_GRACE_MS = 120_000;
/** Partial prose is disposable; the terminal event remains authoritative. */
const MAX_RECONNECT_ANSWER_CHARS = 256 * 1_024;

export interface WebRunHandle {
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  /** What was asked. Shown by a reader who arrives after the run started. */
  readonly prompt: string;
  readonly startedAt: number;
  readonly settled: boolean;
}

interface Entry {
  readonly handle: { -readonly [K in keyof WebRunHandle]: WebRunHandle[K] };
  readonly controller: AbortController;
  /**
   * The latest complete timeline and answer snapshots, plus the terminal event.
   * Keeping one of each makes a reconnect immediately complete without storing
   * every token or every historical timeline frame.
   */
  latestTimeline: Extract<WebRunEvent, { type: 'timeline' }> | undefined;
  latestAnswer: Extract<WebRunEvent, { type: 'answer' }> | undefined;
  answerOverflowed: boolean;
  terminal: WebRunEvent | undefined;
  readonly listeners: Set<(event: WebRunEvent) => void>;
  sweepAt: ReturnType<typeof setTimeout> | undefined;
}

export interface WebRunStartInput {
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly controller: AbortController;
  /** The run itself. The registry drains it; the caller does not. */
  readonly events: AsyncGenerator<WebRunEvent>;
}

export class WebRunRegistry {
  private readonly runs = new Map<string, Entry>();

  constructor(private readonly deps: { readonly logger: Logger }) {}

  /**
   * Keyed by member as well as thread.
   *
   * A run can then only ever be reached by the person who started it, without a
   * separate ownership check that could be forgotten at one call site.
   */
  private static key(userId: string, threadId: string): string {
    return `${userId}\0${threadId}`;
  }

  find(userId: string, threadId: string): WebRunHandle | null {
    return this.runs.get(WebRunRegistry.key(userId, threadId))?.handle ?? null;
  }

  /** Every run this member currently has going. Used to mark a thread list. */
  activeFor(userId: string): readonly WebRunHandle[] {
    return [...this.runs.values()]
      .filter(entry => entry.handle.userId === userId && !entry.handle.settled)
      .map(entry => entry.handle);
  }

  /**
   * Begin a run, and start draining it immediately.
   *
   * Draining here rather than in the request handler is the whole point: the
   * generator is consumed at the speed the runtime produces, so no reader —
   * present, slow, or gone — can stall the work.
   */
  start(input: WebRunStartInput): WebRunHandle {
    const key = WebRunRegistry.key(input.userId, input.threadId);
    const existing = this.runs.get(key);
    // One run per thread. A second ask while the first is still going would put
    // two containers on one conversation, and whichever finished last would
    // look like the answer to whichever was asked last.
    if (existing && !existing.handle.settled) {
      throw new WebRunBusyError();
    }
    if (existing) this.forget(key);

    const entry: Entry = {
      handle: {
        runId: input.runId,
        threadId: input.threadId,
        userId: input.userId,
        prompt: input.prompt,
        startedAt: Date.now(),
        settled: false,
      },
      controller: input.controller,
      latestTimeline: undefined,
      latestAnswer: undefined,
      answerOverflowed: false,
      terminal: undefined,
      listeners: new Set(),
      sweepAt: undefined,
    };
    this.runs.set(key, entry);

    void this.drain(key, entry, input.events);
    return entry.handle;
  }

  private async drain(
    key: string,
    entry: Entry,
    events: AsyncGenerator<WebRunEvent>,
  ): Promise<void> {
    try {
      for await (const event of events) {
        let published: WebRunEvent | undefined = event;
        if (event.type === 'final' || event.type === 'error') entry.terminal = event;
        else if (event.type === 'timeline') entry.latestTimeline = event;
        else if (event.type === 'answer_delta') {
          if (entry.answerOverflowed) {
            published = undefined;
          } else {
            const text = `${entry.latestAnswer?.text ?? ''}${event.delta}`;
            if (text.length <= MAX_RECONNECT_ANSWER_CHARS) {
              entry.latestAnswer = { type: 'answer', text };
            } else {
              // A stalled view may lose animation, never correctness: clear its
              // partial prose and wait for the authoritative terminal answer.
              entry.latestAnswer = undefined;
              entry.answerOverflowed = true;
              published = { type: 'answer_reset' };
            }
          }
        } else if (event.type === 'answer_reset') {
          entry.latestAnswer = { type: 'answer', text: '' };
          entry.answerOverflowed = false;
        } else {
          if (event.text.length <= MAX_RECONNECT_ANSWER_CHARS) {
            entry.latestAnswer = event;
            entry.answerOverflowed = false;
          } else {
            entry.latestAnswer = undefined;
            entry.answerOverflowed = true;
            published = { type: 'answer_reset' };
          }
        }
        if (published) {
          for (const listener of entry.listeners) listener(published);
        }
      }
    } catch (error) {
      // The run threw rather than yielding an error event. Nobody may be
      // watching right now, so the failure is recorded on the entry for
      // whoever attaches next rather than only logged.
      this.deps.logger.error('web_run.registry.drain_failed', {
        runId: entry.handle.runId,
        error: String(error),
      });
      const failure: WebRunEvent = {
        type: 'error',
        code: 'stream_failed',
        message: 'Divo hit a temporary problem while finishing this request. Please try again.',
      };
      entry.terminal = failure;
      for (const listener of entry.listeners) listener(failure);
    } finally {
      entry.handle.settled = true;
      for (const listener of entry.listeners) listener(SETTLED);
      // Held briefly so a reader reconnecting across the moment it finished is
      // handed the answer rather than an empty thread they have to reload. The
      // durable copy is in the conversation either way.
      entry.sweepAt = setTimeout(() => this.forget(key), SETTLED_GRACE_MS);
      entry.sweepAt.unref?.();
    }
  }

  /**
   * Watch a run, from wherever it has got to.
   *
   * Yields the current state first so a reader who arrives late is not left
   * staring at a blank thread until the next frame happens to come — a run can
   * work for a minute without producing one.
   */
  async *attach(userId: string, threadId: string): AsyncGenerator<WebRunEvent> {
    const key = WebRunRegistry.key(userId, threadId);
    const entry = this.runs.get(key);
    if (!entry) return;

    const queue: WebRunEvent[] = [];
    if (entry.latestTimeline) queue.push(entry.latestTimeline);
    if (entry.latestAnswer) queue.push(entry.latestAnswer);
    if (entry.terminal) queue.push(entry.terminal);

    if (entry.handle.settled) {
      for (const event of queue) yield event;
      return;
    }

    let wake: (() => void) | undefined;
    let closed = false;
    const listener = (event: WebRunEvent): void => {
      if (event === SETTLED) closed = true;
      else enqueueViewEvent(queue, event);
      wake?.();
      wake = undefined;
    };
    entry.listeners.add(listener);
    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally {
      entry.listeners.delete(listener);
    }
  }

  /** Ask a run to stop. The reply still arrives on every attached view. */
  stop(userId: string, threadId: string): boolean {
    const entry = this.runs.get(WebRunRegistry.key(userId, threadId));
    if (!entry || entry.handle.settled) return false;
    entry.controller.abort('User stopped the run');
    return true;
  }

  private forget(key: string): void {
    const entry = this.runs.get(key);
    if (!entry) return;
    if (entry.sweepAt) clearTimeout(entry.sweepAt);
    this.runs.delete(key);
  }

  /** Stops every run and clears the registry. Used on shutdown and in tests. */
  clear(): void {
    for (const key of [...this.runs.keys()]) {
      const entry = this.runs.get(key);
      if (entry && !entry.handle.settled) entry.controller.abort('Shutting down');
      this.forget(key);
    }
  }
}

/**
 * A sentinel telling an attached view the run is over.
 *
 * A distinct object rather than a `type: 'settled'` event, so it can never be
 * mistaken for something to send to a browser — views compare by identity and
 * close, and nothing serialises it.
 */
const SETTLED = { type: 'error', code: '__settled__', message: '' } as const satisfies WebRunEvent;

/**
 * One browser view needs current state, not an unbounded replay of states it
 * was too slow to paint. Compact only events whose newer form is equivalent.
 */
function enqueueViewEvent(queue: WebRunEvent[], event: WebRunEvent): void {
  if (event.type === 'final') {
    queue.splice(0, queue.length, event);
    return;
  }
  if (event.type === 'error') {
    let latestTimeline: Extract<WebRunEvent, { type: 'timeline' }> | undefined;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const candidate = queue[index];
      if (candidate?.type === 'timeline') {
        latestTimeline = candidate;
        break;
      }
    }
    queue.splice(0, queue.length, ...(latestTimeline ? [latestTimeline, event] : [event]));
    return;
  }
  if (event.type === 'timeline') {
    let index = -1;
    for (let candidateIndex = queue.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      if (queue[candidateIndex]?.type === 'timeline') {
        index = candidateIndex;
        break;
      }
    }
    if (index >= 0) queue[index] = event;
    else queue.push(event);
    return;
  }
  if (event.type === 'answer_reset') {
    removeQueuedAnswerEvents(queue);
    queue.push(event);
    return;
  }
  if (event.type === 'answer') {
    removeQueuedAnswerEvents(queue);
    queue.push(event);
    return;
  }

  const last = queue.at(-1);
  if (last?.type === 'answer_delta') {
    queue[queue.length - 1] = { type: 'answer_delta', delta: `${last.delta}${event.delta}` };
  } else if (last?.type === 'answer') {
    queue[queue.length - 1] = { type: 'answer', text: `${last.text}${event.delta}` };
  } else {
    queue.push(event);
  }
}

function removeQueuedAnswerEvents(queue: WebRunEvent[]): void {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const type = queue[index]?.type;
    if (type === 'answer' || type === 'answer_delta' || type === 'answer_reset') {
      queue.splice(index, 1);
    }
  }
}

export class WebRunBusyError extends Error {
  readonly code = 'run_in_progress';
  constructor() {
    super('This conversation already has a run going.');
    this.name = 'WebRunBusyError';
  }
}
