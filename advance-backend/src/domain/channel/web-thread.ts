import type { ChannelLedgerRow } from './outbound';

/**
 * A conversation on the web, as the person who owns it sees it.
 *
 * This is deliberately a different shape from `Turn`, which is the agent's
 * memory — what the model is given to read. A reader needs things the model has
 * no use for (when it happened, what it was called, whether it is still going)
 * and none of the things memory needs (summaries, sequence numbers, tool
 * plumbing). Collapsing the two would mean every change to what a person sees
 * became a change to what the model reads.
 *
 * Both are stored in the same rows. One table, two readers, and the difference
 * between them is a mapping rather than a copy.
 */

export interface WebThreadSummary {
  /** The id in the URL. Stable for the life of the conversation. */
  readonly threadId: string;
  /** Taken from the opening ask unless the reader has renamed it. */
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Enough of the last thing said to recognise the thread by. */
  readonly preview: string;
  readonly messageCount: number;
}

/**
 * What a run left behind, in the shape the work log draws.
 *
 * Carried on the answer rather than as its own turn: the log belongs to the
 * answer it produced, and a reader scrolling back should find them together or
 * not at all.
 */
export interface WebThreadRunRecord {
  readonly ledger: readonly ChannelLedgerRow[];
  /** Wall time the run took, in milliseconds. */
  readonly elapsedMs: number;
  /** Set when the run ended without an answer, carrying what the reader saw. */
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface WebThreadTurn {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly at: string;
  /** Present on an assistant turn that came from a run with a work log. */
  readonly run?: WebThreadRunRecord;
}

export interface WebThreadDetail extends WebThreadSummary {
  readonly turns: readonly WebThreadTurn[];
}

/** How a run's record travels on a turn. Read back by `webThreadRun`. */
export const WEB_RUN_CONTENT_KIND = 'web_run' as const;

/**
 * Read a run record off a stored turn, or nothing.
 *
 * Anything unrecognised is dropped rather than guessed at: an answer with no
 * work log reads as an answer, which is true, while an invented one would be a
 * claim about work that may never have happened.
 */
export function webThreadRun(contentJson: unknown): WebThreadRunRecord | undefined {
  if (typeof contentJson !== 'object' || contentJson === null) return undefined;
  const value = contentJson as Record<string, unknown>;
  if (value['kind'] !== WEB_RUN_CONTENT_KIND) return undefined;
  const ledger = Array.isArray(value['ledger']) ? value['ledger'] as ChannelLedgerRow[] : [];
  const elapsedMs = typeof value['elapsedMs'] === 'number' ? value['elapsedMs'] : 0;
  const failure = value['failure'];
  const record: WebThreadRunRecord = {
    ledger,
    elapsedMs,
    ...(typeof failure === 'object' && failure !== null
      ? {
        failure: {
          code: String((failure as Record<string, unknown>)['code'] ?? 'run_failed'),
          message: String((failure as Record<string, unknown>)['message'] ?? ''),
        },
      }
      : {}),
  };
  return record;
}

/**
 * A thread's name, from the ask that opened it.
 *
 * Cut on a word boundary where there is one within reach of the limit, because
 * a title severed mid-word reads as damage rather than as brevity.
 */
export function webThreadTitle(firstMessage: string): string {
  const clean = firstMessage.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  if (clean.length <= 60) return clean;
  const cut = clean.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
