import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type {
  WebThreadDetail,
  WebThreadSummary,
} from '../../domain/channel/web-thread';
import {
  WEB_THREAD_LIST_MAX,
  WEB_THREAD_LIST_PAGE,
  WEB_THREAD_PAGE,
  webThreadPage,
} from '../../domain/channel/web-thread';

/**
 * The web's own view of the conversations it holds.
 *
 * Reads the same rows `ConversationRepository` writes, and deliberately does not
 * extend it: that port is the agent's memory, answering "what should the model
 * read". This one answers "what has this person got, and may they have it" —
 * a different question, with an authorization check the memory port has no
 * business carrying.
 *
 * Every method is scoped by company *and* by the member who opened the thread.
 * A thread is one person's workroom; there is no sharing at level 1, and a
 * missing owner (a row written before threads had one) is treated as not
 * theirs rather than as everyone's.
 */

const CHANNEL = 'web';
/** Enough of a thread to recognise it by in a list, and no more. */
const PREVIEW_CHARS = 140;

export interface WebThreadQuery {
  readonly companyId: string;
  readonly userId: string;
}

/**
 * One window of the list, and whether anything is behind it.
 *
 * `hasMore` is a fact off the store rather than a guess from a full window —
 * the same reason the turn pager asks for one row it never shows. Guessed from
 * a full page it is wrong exactly when the count is a multiple of the page
 * size, which offers a reader a "Show more" that loads nothing.
 */
export interface WebThreadListPage {
  readonly threads: readonly WebThreadSummary[];
  readonly hasMore: boolean;
}

export interface WebThreadRepoPort {
  list(query: WebThreadQuery, limit?: number): Promise<Result<WebThreadListPage, InfraError>>;
  get(query: WebThreadQuery & { threadId: string }): Promise<Result<WebThreadDetail | null, InfraError>>;
  rename(query: WebThreadQuery & { threadId: string; title: string }): Promise<Result<boolean, InfraError>>;
  /** Deletes the conversation and every turn under it. Cascades in the schema. */
  remove(query: WebThreadQuery & { threadId: string }): Promise<Result<boolean, InfraError>>;
}

function preview(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= PREVIEW_CHARS ? clean : `${clean.slice(0, PREVIEW_CHARS).trimEnd()}…`;
}

export class WebThreadRepository implements WebThreadRepoPort {
  constructor(private readonly db: PrismaClient) {}

  /**
   * The newest `limit` conversations, and whether there are older ones.
   *
   * Ordered by `updatedAt` and then by id. The tiebreak is not decoration: two
   * threads touched in the same millisecond have no defined order without it,
   * so a reader who grows the window can see one of them twice and the other
   * not at all.
   */
  async list(
    query: WebThreadQuery,
    limit = WEB_THREAD_LIST_PAGE,
  ): Promise<Result<WebThreadListPage, InfraError>> {
    const window = Math.max(1, Math.min(limit, WEB_THREAD_LIST_MAX));
    try {
      const rows = await this.db.runtimeConversation.findMany({
        where: {
          companyId: query.companyId,
          channel: CHANNEL,
          createdByUserId: query.userId,
          status: 'active',
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        // One more than the window, never shown, so "is there more?" is known.
        take: window + 1,
        select: {
          channelConversationKey: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          lastMessageSequence: true,
          // The newest turn, for the one line of preview a list row shows.
          messages: {
            orderBy: { sequence: 'desc' },
            take: 1,
            select: { contentText: true },
          },
        },
      });
      return ok({
        threads: rows.slice(0, window).map(row => ({
          threadId: row.channelConversationKey,
          title: row.title ?? 'New chat',
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          preview: preview(row.messages[0]?.contentText ?? ''),
          messageCount: row.lastMessageSequence,
        })),
        hasMore: rows.length > window,
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'listWebThreads', e));
    }
  }

  /**
   * One page of a conversation, newest last.
   *
   * `before` is a sequence, exclusive — the caller passes the sequence of the
   * oldest turn it already has and gets the turns above it. A sequence rather
   * than an offset because turns can be deleted underneath a reader, and an
   * offset silently skips a turn when they are.
   *
   * The role filter is in the query, not after it, so a page of `limit` rows is
   * `limit` turns a reader will actually see. Filtering afterwards made a page
   * that happened to hold mostly tool bookkeeping arrive nearly empty, with a
   * "load earlier" control below it that was the only way to see anything.
   */
  async get(
    query: WebThreadQuery & { threadId: string; before?: number },
  ): Promise<Result<WebThreadDetail | null, InfraError>> {
    try {
      const row = await this.db.runtimeConversation.findUnique({
        where: {
          companyId_channel_channelConversationKey: {
            companyId: query.companyId,
            channel: CHANNEL,
            channelConversationKey: query.threadId,
          },
        },
        select: {
          channelConversationKey: true,
          createdByUserId: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          lastMessageSequence: true,
          messages: {
            // A tool turn is the model's own bookkeeping. The work log a reader
            // sees travels on the answer instead, so showing these too would
            // print the same run twice, once in a shape nobody asked for.
            where: {
              role: { in: ['user', 'assistant'] },
              ...(query.before !== undefined ? { sequence: { lt: query.before } } : {}),
            },
            // Newest first, because a page is counted back from the end of the
            // conversation. Reversed below into the order it is read in.
            orderBy: { sequence: 'desc' },
            // One more than a page. Its presence is how `hasEarlier` is known
            // for certain rather than guessed from a full page, which is wrong
            // exactly when the thread's length is a multiple of the page size.
            take: WEB_THREAD_PAGE + 1,
            select: {
              id: true,
              sequence: true,
              role: true,
              contentText: true,
              contentJson: true,
              createdAt: true,
            },
          },
        },
      });
      // Not found and not yours are answered the same way on purpose: telling
      // one apart from the other tells a stranger which thread ids exist.
      if (!row || row.createdByUserId !== query.userId) return ok(null);

      const { turns, hasEarlier } = webThreadPage(row.messages);

      return ok({
        threadId: row.channelConversationKey,
        title: row.title ?? 'New chat',
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        preview: preview(turns[turns.length - 1]?.text ?? ''),
        messageCount: row.lastMessageSequence,
        turns,
        hasEarlier,
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'getWebThread', e));
    }
  }

  /**
   * Name a thread, whether or not anything has been said in it yet.
   *
   * The naming and the saying race, and the caller cannot referee it. A browser
   * names a new chat from a small model as soon as the ask is sent, which takes
   * about two seconds; the row itself is not written until the run persists its
   * first turn. Measured on real chats, the name won every time — by 1.5s at the
   * worst — so an update that required the row to exist matched nothing, 404'd,
   * and the generated name was dropped on the floor. Every chat in the rail was
   * called "hi there" while the model that named it ran, was paid for, and was
   * audited.
   *
   * So the ordering stops being the caller's problem. Naming a thread nobody has
   * spoken in yet writes the row; the run's own `upsert` then adds turns to it
   * and leaves the title alone, because its defaults only apply on create.
   *
   * Ownership survives all of it. The unique key carries no owner, so an upsert
   * keyed on it alone would let one member rename another member's thread by
   * guessing an id. An owned update is tried first and a row that exists but is
   * not theirs is refused exactly as before — creation is reached only when the
   * thread does not exist at all.
   */
  async rename(
    query: WebThreadQuery & { threadId: string; title: string },
  ): Promise<Result<boolean, InfraError>> {
    try {
      if (await this.applyTitle(query)) return ok(true);

      // Either it is not theirs, or it is not there yet. Only the second is
      // ours to fix, and the difference is one read.
      const existing = await this.db.runtimeConversation.findUnique({
        where: {
          companyId_channel_channelConversationKey: {
            companyId: query.companyId,
            channel: CHANNEL,
            channelConversationKey: query.threadId,
          },
        },
        select: { id: true },
      });
      if (existing) return ok(false);

      try {
        await this.db.runtimeConversation.create({
          data: {
            companyId: query.companyId,
            channel: CHANNEL,
            channelConversationKey: query.threadId,
            rawChannelKey: query.threadId,
            createdByUserId: query.userId,
            title: query.title,
          },
        });
        return ok(true);
      } catch {
        /* The run got there in the gap between the read and the write, which is
           the ordinary outcome rather than a rare one — the two are seconds
           apart by design. Its row is the real one, so the name is applied to
           it. A second failure means it is genuinely not this member's. */
        return ok(await this.applyTitle(query));
      }
    } catch (e) {
      return err(wrapInfra('prisma', 'renameWebThread', e));
    }
  }

  /** Sets the title on a row this member owns. False when they own no such row. */
  private async applyTitle(
    query: WebThreadQuery & { threadId: string; title: string },
  ): Promise<boolean> {
    const { count } = await this.db.runtimeConversation.updateMany({
      where: {
        companyId: query.companyId,
        channel: CHANNEL,
        channelConversationKey: query.threadId,
        createdByUserId: query.userId,
      },
      data: { title: query.title },
    });
    return count > 0;
  }

  async remove(
    query: WebThreadQuery & { threadId: string },
  ): Promise<Result<boolean, InfraError>> {
    try {
      // `deleteMany` rather than `delete`, so ownership is part of the statement
      // rather than a check that happened a moment earlier.
      const { count } = await this.db.runtimeConversation.deleteMany({
        where: {
          companyId: query.companyId,
          channel: CHANNEL,
          channelConversationKey: query.threadId,
          createdByUserId: query.userId,
        },
      });
      return ok(count > 0);
    } catch (e) {
      return err(wrapInfra('prisma', 'deleteWebThread', e));
    }
  }
}
