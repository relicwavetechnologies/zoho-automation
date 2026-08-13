import type { WebRunEvent } from './web-run.service';

/**
 * Small enough to feel live, large enough to avoid one application event per
 * provider token. The provider stream is still the clock: this only groups a
 * burst that arrived within one paint-sized window.
 */
export const LIVE_ANSWER_PUBLISH_MS = 32;
const LIVE_ANSWER_PUBLISH_CHARS = 1_024;

type AnswerDelta = Extract<WebRunEvent, { type: 'answer_delta' }>;

export interface LiveAnswerPublisher {
  append(delta: string): void;
  flush(): void;
  reset(): void;
}

/**
 * Coalesce raw provider fragments without turning them into fake playback.
 *
 * `flush` is synchronous by design: ordering boundaries such as a tool call,
 * retry reset, and the terminal result must never overtake prose already
 * received from the model.
 */
export function createLiveAnswerPublisher(
  publish: (event: AnswerDelta | { readonly type: 'answer_reset' }) => void,
  options: { readonly publishMs?: number; readonly publishChars?: number } = {},
): LiveAnswerPublisher {
  const publishMs = options.publishMs ?? LIVE_ANSWER_PUBLISH_MS;
  const publishChars = options.publishChars ?? LIVE_ANSWER_PUBLISH_CHARS;
  let pending = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const flush = (): void => {
    clearTimer();
    if (!pending) return;
    const delta = pending;
    pending = '';
    publish({ type: 'answer_delta', delta });
  };

  return {
    append: delta => {
      if (!delta) return;
      pending += delta;
      if (pending.length >= publishChars) {
        flush();
        return;
      }
      timer ??= setTimeout(flush, publishMs);
    },
    flush,
    reset: () => {
      flush();
      publish({ type: 'answer_reset' });
    },
  };
}
