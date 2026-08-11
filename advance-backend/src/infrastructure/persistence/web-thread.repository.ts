import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type {
  WebThreadDetail,
  WebThreadSummary,
  WebThreadTurn,
} from '../../domain/channel/web-thread';
import { webThreadRun } from '../../domain/channel/web-thread';

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

export interface WebThreadRepoPort {
  list(query: WebThreadQuery, limit?: number): Promise<Result<WebThreadSummary[], InfraError>>;
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

  async list(query: WebThreadQuery, limit = 100): Promise<Result<WebThreadSummary[], InfraError>> {
    try {
      const rows = await this.db.runtimeConversation.findMany({
        where: {
          companyId: query.companyId,
          channel: CHANNEL,
          createdByUserId: query.userId,
          status: 'active',
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
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
      return ok(rows.map(row => ({
        threadId: row.channelConversationKey,
        title: row.title ?? 'New chat',
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        preview: preview(row.messages[0]?.contentText ?? ''),
        messageCount: row.lastMessageSequence,
      })));
    } catch (e) {
      return err(wrapInfra('prisma', 'listWebThreads', e));
    }
  }

  async get(
    query: WebThreadQuery & { threadId: string },
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
            orderBy: { sequence: 'asc' },
            select: {
              id: true,
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

      const turns: WebThreadTurn[] = row.messages
        // A tool turn is the model's own bookkeeping. The work log a reader sees
        // travels on the answer instead, so showing these too would print the
        // same run twice, once in a shape nobody asked for.
        .filter(message => message.role === 'user' || message.role === 'assistant')
        .map(message => {
          const run = webThreadRun(message.contentJson);
          return {
            id: message.id,
            role: message.role as 'user' | 'assistant',
            text: message.contentText ?? '',
            at: message.createdAt.toISOString(),
            ...(run ? { run } : {}),
          };
        });

      return ok({
        threadId: row.channelConversationKey,
        title: row.title ?? 'New chat',
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        preview: preview(turns[turns.length - 1]?.text ?? ''),
        messageCount: row.lastMessageSequence,
        turns,
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'getWebThread', e));
    }
  }

  async rename(
    query: WebThreadQuery & { threadId: string; title: string },
  ): Promise<Result<boolean, InfraError>> {
    try {
      const { count } = await this.db.runtimeConversation.updateMany({
        where: {
          companyId: query.companyId,
          channel: CHANNEL,
          channelConversationKey: query.threadId,
          createdByUserId: query.userId,
        },
        data: { title: query.title },
      });
      return ok(count > 0);
    } catch (e) {
      return err(wrapInfra('prisma', 'renameWebThread', e));
    }
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
