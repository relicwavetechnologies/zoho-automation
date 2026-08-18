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

/**
 * A file that went with an ask, as the person who sent it should see it named.
 *
 * The reader's own message is the one place a file has to be acknowledged, and
 * it is the one place it was not: a PDF handed over with a question reached the
 * container, was read, was answered from — and the transcript showed a bare
 * sentence, so re-reading the thread gave no sign the file had ever existed.
 *
 * Deliberately a description rather than a handle. Nothing here can be opened
 * or fetched by the browser or model. Provider tools may have a separate,
 * backend-only asset scoped to the same conversation; what survives here is
 * only what a person needs to recognise their own message by.
 */
export interface AskAttachment {
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
  /**
   * What became of it.
   *
   * `refused` is carried rather than dropped on purpose: a file the container
   * had no skill for is exactly the one a reader will come back puzzled about,
   * and a transcript that quietly omits it answers their question with silence.
   * `audio` was heard and folded into the words — the recording itself is not
   * staged, so this is the only record that it was ever attached. `video` is the
   * same bargain one step further on: it was watched, what was understood went
   * into the ask, and the recording was deleted the moment that was written.
   */
  readonly outcome: 'file' | 'audio' | 'refused' | 'video';
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
  /** Present on an ask that carried files. */
  readonly attachments?: readonly AskAttachment[];
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

/**
 * How many conversations one read of the list returns.
 *
 * The rail shows a window, not a history. Everything older is a "Show more"
 * away rather than absent — which is what it used to be, silently, at eight.
 */
export const WEB_THREAD_LIST_PAGE = 25;

/**
 * The most a single read of the list may ask for.
 *
 * A ceiling rather than a promise of everything: the window grows a page at a
 * time as a reader asks for it, and a client that asks for a hundred thousand
 * rows gets a bounded answer instead of a slow one.
 */
export const WEB_THREAD_LIST_MAX = 500;

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
      const ask = webAsk(row.contentJson);
      return {
        id: row.id,
        sequence: row.sequence,
        role: row.role === 'user' ? 'user' : 'assistant',
        /* The person's own sentence where one was kept — the stored text is
           what the model reads, which for an ask carrying a recording is the
           transcript with their question underneath it. */
        text: ask?.text ?? row.contentText ?? '',
        at: row.createdAt.toISOString(),
        ...(run ? { run } : {}),
        ...(ask?.attachments.length ? { attachments: ask.attachments } : {}),
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

/** How an ask's own form travels on its turn. Read back by `webAsk`. */
export const WEB_ASK_CONTENT_KIND = 'web_ask' as const;

/**
 * The ask as the person made it, written alongside the turn rather than into it.
 *
 * A turn's `contentText` is the model's memory, and it is not the message: a
 * recording's transcript and a refused file's notice are folded in ahead of the
 * words, because that is what the model has to read on the next turn to know
 * what was said. Overwriting it with the person's typed sentence would show the
 * reader the right thing at the cost of the agent forgetting the recording
 * entirely. So both are kept, and this is the reader's half.
 */
export interface WebAsk {
  /** What the person typed, when it differs from what the model was given. */
  readonly text?: string;
  readonly attachments: readonly AskAttachment[];
}

/**
 * What is worth writing beside a turn, if anything.
 *
 * The common case is nothing: somebody typed a sentence and sent it, the stored
 * text already is the message, and a JSON blob restating it would be stored on
 * every turn of every conversation to say what the row next to it says. Only a
 * message the reader would not otherwise get back — one carrying files, or one
 * whose words were rewritten on the way to the model — has a second half.
 */
export function askFor(
  ask: { readonly text: string; readonly attachments: readonly AskAttachment[] } | undefined,
  storedText: string,
): WebAsk | undefined {
  if (!ask) return undefined;
  const typed = ask.text.trim();
  const rewritten = typed !== '' && typed !== storedText.trim();
  if (!rewritten && ask.attachments.length === 0) return undefined;
  return {
    ...(rewritten ? { text: typed } : {}),
    attachments: ask.attachments,
  };
}

export function askContent(ask: WebAsk): unknown {
  return {
    kind: WEB_ASK_CONTENT_KIND,
    ...(ask.text !== undefined ? { text: ask.text } : {}),
    attachments: ask.attachments,
  };
}

/**
 * Read an ask off a stored turn, or nothing.
 *
 * Same rule as `webThreadRun`, for the same reason: anything unrecognised is
 * dropped rather than guessed at. An entry missing a name is skipped rather
 * than shown as an unnamed chip, because a chip nobody can identify is worse
 * than the message reading as though nothing was attached.
 */
export function webAsk(contentJson: unknown): WebAsk | undefined {
  if (typeof contentJson !== 'object' || contentJson === null) return undefined;
  const value = contentJson as Record<string, unknown>;
  if (value['kind'] !== WEB_ASK_CONTENT_KIND) return undefined;
  const listed = Array.isArray(value['attachments']) ? value['attachments'] : [];
  const OUTCOMES = new Set(['file', 'audio', 'refused', 'video']);
  const text = value['text'];
  return {
    ...(typeof text === 'string' && text.trim() ? { text } : {}),
    attachments: listed.flatMap((entry): AskAttachment[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const item = entry as Record<string, unknown>;
      const name = typeof item['name'] === 'string' ? item['name'] : '';
      if (!name) return [];
      const outcome = String(item['outcome']);
      return [{
        name,
        mime: typeof item['mime'] === 'string' ? item['mime'] : '',
        bytes: typeof item['bytes'] === 'number' ? item['bytes'] : 0,
        outcome: (OUTCOMES.has(outcome) ? outcome : 'file') as AskAttachment['outcome'],
      }];
    }),
  };
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
