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
  /**
   * Where this turn sits in the conversation, and the cursor a page is asked
   * for by. Monotonic per thread and never reused, so it addresses a position
   * even after a turn either side of it is deleted — which an offset does not.
   */
  readonly sequence: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly at: string;
  /** Present on an assistant turn that came from a run with a work log. */
  readonly run?: WebThreadRunRecord;
}

export interface WebThreadDetail extends WebThreadSummary {
  /**
   * The most recent turns, oldest first — not the whole conversation.
   *
   * This used to be every message a thread had ever held, each assistant turn
   * carrying its full work log, in one query with no `take`. A year-old chat
   * answered its own open with every word it had ever contained, and the reader
   * saw a blank column until all of it arrived.
   */
  readonly turns: readonly WebThreadTurn[];
  /**
   * There is older conversation above the first turn here.
   *
   * Stated rather than inferred from `turns.length === limit`, which is wrong
   * exactly when the thread's length is a multiple of the page size — the one
   * case that offers a reader a control that fetches nothing.
   */
  readonly hasEarlier: boolean;
}

/** How much of a conversation one read returns. */
export const WEB_THREAD_PAGE = 40;

/** One stored turn, as much of it as assembling a page needs. */
export interface WebThreadPageRow {
  readonly id: string;
  readonly sequence: number;
  readonly role: string;
  readonly contentText: string | null;
  readonly contentJson: unknown;
  readonly createdAt: Date;
}

/**
 * Rows off the store, as a page a reader can be shown.
 *
 * Kept apart from the query that fetched them because this is the part that can
 * be wrong. The store is asked for `WEB_THREAD_PAGE + 1` rows, newest first; the
 * extra row is never shown and exists only so "is there more above this?" is
 * known rather than guessed from a full page — a guess that is wrong exactly
 * when a thread's length is a multiple of the page size, which is the one case
 * that offers a reader a control fetching nothing.
 *
 * Reversed on the way out. A page is counted back from the end of a
 * conversation and read from its start.
 */
export function webThreadPage(rows: readonly WebThreadPageRow[]): {
  turns: WebThreadTurn[];
  hasEarlier: boolean;
} {
  const turns = rows
    .slice(0, WEB_THREAD_PAGE)
    .reverse()
    .map((row): WebThreadTurn => {
      const run = webThreadRun(row.contentJson);
      return {
        id: row.id,
        sequence: row.sequence,
        role: row.role === 'user' ? 'user' : 'assistant',
        text: row.contentText ?? '',
        at: row.createdAt.toISOString(),
        ...(run ? { run } : {}),
      };
    });
  return { turns, hasEarlier: rows.length > WEB_THREAD_PAGE };
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
