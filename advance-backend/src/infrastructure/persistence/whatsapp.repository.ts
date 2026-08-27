import type { PrismaClient } from '../../generated/prisma';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';
import type { NormalizedWhatsappMessage } from '../../application/whatsapp/whatsapp-message.normalize';

export interface WhatsappSessionRow {
  readonly id: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly label: string;
  readonly openwaSessionId: string;
  readonly phoneE164: string | null;
  readonly status: string;
  readonly lastSeenAt: Date | null;
  /** Set while an unresolved gap exists. Null means nothing known to be missing. */
  readonly darkSince: Date | null;
}

export interface StoreMessageResult {
  readonly stored: boolean;
  readonly chatId: string;
  /** True when this message opened a chat Divo had not seen before. */
  readonly chatIsNew: boolean;
  /**
   * True when the chat is owned by a different session than the one that
   * delivered this message — the same room seen from a second handset.
   */
  readonly deferredToOwner: boolean;
}

export interface WhatsappRepoPort {
  findSessionByOpenwaId(openwaSessionId: string): Promise<Result<WhatsappSessionRow | null, InfraError>>;
  listSessions(scope: { companyId: string; departmentId: string }): Promise<Result<readonly WhatsappSessionRow[], InfraError>>;
  createSession(input: {
    companyId: string;
    departmentId: string;
    label: string;
    openwaSessionId: string;
  }): Promise<Result<WhatsappSessionRow, InfraError>>;
  updateSessionStatus(input: {
    sessionId: string;
    status: string;
    phoneE164?: string | null;
  }): Promise<Result<void, InfraError>>;
  touchSession(sessionId: string, seenAt: Date): Promise<Result<void, InfraError>>;
  markDark(sessionId: string, since: Date): Promise<Result<void, InfraError>>;
  clearDark(sessionId: string): Promise<Result<void, InfraError>>;
  listStaleSessions(quietSince: Date): Promise<Result<readonly WhatsappSessionRow[], InfraError>>;
  listLinkedSessions(): Promise<Result<readonly WhatsappSessionRow[], InfraError>>;
  storeMessage(input: {
    session: WhatsappSessionRow;
    message: NormalizedWhatsappMessage;
  }): Promise<Result<StoreMessageResult, InfraError>>;
  renameChat(input: {
    companyId: string;
    waChatId: string;
    name: string;
    isGroup: boolean;
  }): Promise<Result<void, InfraError>>;
  pruneMessagesBefore(cutoff: Date, limit: number): Promise<Result<number, InfraError>>;
}

export class WhatsappRepository implements WhatsappRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async findSessionByOpenwaId(
    openwaSessionId: string,
  ): Promise<Result<WhatsappSessionRow | null, InfraError>> {
    try {
      // Deliberately not scoped by company: the webhook arrives with nothing but
      // a gateway session id, and this lookup is how the event *acquires* its
      // tenant. Every write after it is scoped by what this returns.
      const row = await this.db.whatsappSession.findFirst({
        where: { openwaSessionId },
        select: SESSION_SELECT,
      });
      return ok(row);
    } catch (cause) {
      return err(wrapInfra('prisma', 'whatsapp.findSessionByOpenwaId', cause));
    }
  }

  async listSessions(
    scope: { companyId: string; departmentId: string },
  ): Promise<Result<readonly WhatsappSessionRow[], InfraError>> {
    try {
      const rows = await this.db.whatsappSession.findMany({
        where: { companyId: scope.companyId, departmentId: scope.departmentId },
        orderBy: { createdAt: 'asc' },
        select: SESSION_SELECT,
      });
      return ok(rows);
    } catch (cause) {
      return err(wrapInfra('prisma', 'whatsapp.listSessions', cause));
    }
  }

  async createSession(input: {
    companyId: string;
    departmentId: string;
    label: string;
    openwaSessionId: string;
  }): Promise<Result<WhatsappSessionRow, InfraError>> {
    try {
      const row = await this.db.whatsappSession.create({
        data: { ...input, status: 'pending' },
        select: SESSION_SELECT,
      });
      return ok(row);
    } catch (cause) {
      if ((cause as { code?: string }).code === 'P2002') {
        try {
          const existing = await this.db.whatsappSession.findUnique({
            where: { openwaSessionId: input.openwaSessionId },
            select: SESSION_SELECT,
          });
          if (
            existing
            && existing.companyId === input.companyId
            && existing.departmentId === input.departmentId
          ) return ok(existing);
        } catch (lookupCause) {
          return err(wrapInfra('prisma', 'whatsapp.findIdempotentSession', lookupCause));
        }
      }
      return err(wrapInfra('prisma', 'whatsapp.createSession', cause));
    }
  }

  async updateSessionStatus(input: {
    sessionId: string;
    status: string;
    phoneE164?: string | null;
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.whatsappSession.update({
        where: { id: input.sessionId },
        data: {
          status: input.status,
          ...(input.phoneE164 === undefined ? {} : { phoneE164: input.phoneE164 }),
        },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'whatsapp.updateSessionStatus', cause));
    }
  }

  async touchSession(sessionId: string, seenAt: Date): Promise<Result<void, InfraError>> {
    try {
      await this.db.whatsappSession.update({
        where: { id: sessionId },
        data: { lastSeenAt: seenAt },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'whatsapp.touchSession', cause));
    }
  }

  /**
   * Record that this handset is dark, without moving the mark if it already is.
   *
   * `darkSince: null` in the filter is the whole method: a sweep runs every five
   * minutes, and overwriting the timestamp each time would keep resetting the
   * gap to "just now" — so a handset dark for two days would report two days of
   * outage as five minutes of it, which is worse than not recording it at all.
   */
  async markDark(sessionId: string, since: Date): Promise<Result<void, InfraError>> {
    try {
      await this.db.whatsappSession.updateMany({
        where: { id: sessionId, darkSince: null },
        data: { darkSince: since },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'whatsapp.markDark', cause));
    }
  }

  /**
   * Forget the gap, because somebody has now filled it.
   *
   * Only the history re-read calls this. The handset reconnecting is explicitly
   * not enough: the stream resuming says nothing about the messages sent while
   * it was down, and clearing on reconnect would erase the only record that
   * they are missing.
   */
  async clearDark(sessionId: string): Promise<Result<void, InfraError>> {
    try {
      await this.db.whatsappSession.update({
        where: { id: sessionId },
        data: { darkSince: null },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'whatsapp.clearDark', cause));
    }
  }

  /**
   * Linked handsets that have gone quiet.
   *
   * The imported agent had no equivalent, and that is the gap this closes: its
   * webhook could stop arriving — a logged-out session, a replaced webhook, a
   * gateway restart — and nothing anywhere would say so. Follow-ups would simply
   * stop appearing for that number, which reads exactly like a quiet week.
   *
   * A session that has never been seen is included once it is `linked`, because
   * "linked but never delivered a message" is the same failure wearing a
   * different face.
   */
  async listStaleSessions(quietSince: Date): Promise<Result<readonly WhatsappSessionRow[], InfraError>> {
    try {
      const rows = await this.db.whatsappSession.findMany({
        where: {
          OR: [
            {
              status: 'linked',
              OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: quietSince } }],
            },
            // A disconnected row stays probeable so a recovered gateway session
            // can restore it without somebody reopening the pairing dialog.
            { status: 'disconnected' },
          ],
        },
        select: SESSION_SELECT,
      });
      return ok(rows);
    } catch (cause) {
      return err(wrapInfra('prisma', 'whatsapp.listStaleSessions', cause));
    }
  }

  /**
   * Every handset currently linked, across all tenants.
   *
   * Unscoped because its callers are background sweeps that work through the
   * gateway session by session. Anything reached from a request must go through
   * `listSessions`, which is scoped by department.
   */
  async listLinkedSessions(): Promise<Result<readonly WhatsappSessionRow[], InfraError>> {
    try {
      const rows = await this.db.whatsappSession.findMany({
        where: { status: 'linked' },
        select: SESSION_SELECT,
      });
      return ok(rows);
    } catch (cause) {
      return err(wrapInfra('prisma', 'whatsapp.listLinkedSessions', cause));
    }
  }

  /**
   * Persist one message, and the chat it belongs to.
   *
   * The chat write is an upsert whose `update` branch never touches
   * `owningSessionId`. That is the de-duplication rule in code: the first
   * session to observe a room keeps it, and the other nine handsets that can see
   * the same supplier group defer to it. Without that, ten copies of one
   * conversation would each be analysed and each be paid for.
   *
   * The message insert tolerates its own unique violation. The idempotency
   * receipt already stops most repeats, but a webhook redelivered after a
   * reconcile read has legitimately arrived twice by two different routes, and
   * the second one is a no-op rather than an error.
   */
  async storeMessage(input: {
    session: WhatsappSessionRow;
    message: NormalizedWhatsappMessage;
  }): Promise<Result<StoreMessageResult, InfraError>> {
    const { session, message } = input;
    try {
      const existing = await this.db.whatsappChat.findUnique({
        where: {
          companyId_waChatId: { companyId: session.companyId, waChatId: message.waChatId },
        },
        select: { id: true, owningSessionId: true, name: true },
      });

      let chatId: string;
      let chatIsNew = false;
      let deferredToOwner = false;

      if (existing) {
        chatId = existing.id;
        deferredToOwner = existing.owningSessionId !== session.id;
        await this.db.whatsappChat.update({
          where: { id: existing.id },
          data: {
            lastMessageAt: message.occurredAt,
            // Only fill a name in, never overwrite one. A payload that carries
            // no subject would otherwise blank a good name on every message.
            ...(message.chatName && !existing.name ? { name: message.chatName } : {}),
          },
        });
      } else {
        const created = await this.db.whatsappChat.create({
          data: {
            companyId: session.companyId,
            departmentId: session.departmentId,
            waChatId: message.waChatId,
            owningSessionId: session.id,
            isGroup: message.isGroup,
            lastMessageAt: message.occurredAt,
            ...(message.chatName ? { name: message.chatName } : {}),
            // Every chat is analysed, direct messages included.
            //
            // Groups-only was the safer default and the wrong one for this team:
            // an event business does most of its real client work one-to-one, so
            // skipping DMs would silently drop the majority of the very leads
            // this exists to catch.
            //
            // The privacy cost is real, and is handled per chat rather than per
            // kind — `muted` switches an individual conversation off, and these
            // are ten work handsets whose owners are told what is read. A blanket
            // rule cannot tell a client thread from a personal one; a person
            // looking at the chat list can.
            analysisEnabled: true,
          },
          select: { id: true },
        });
        chatId = created.id;
        chatIsNew = true;
      }

      try {
        await this.db.whatsappMessage.create({
          data: {
            companyId: session.companyId,
            chatId,
            waMessageId: message.waMessageId,
            senderName: message.senderName,
            fromMe: message.fromMe,
            body: message.body,
            type: message.type,
            quotedText: message.quotedText,
            occurredAt: message.occurredAt,
          },
        });
      } catch (cause) {
        if ((cause as { code?: string }).code !== 'P2002') throw cause;
        return ok({ stored: false, chatId, chatIsNew, deferredToOwner });
      }

      return ok({ stored: true, chatId, chatIsNew, deferredToOwner });
    } catch (cause) {
      return err(wrapInfra('prisma', 'whatsapp.storeMessage', cause));
    }
  }

  /**
   * Fill in a chat's display name from the live chat list.
   *
   * Webhook payloads never carry a group's subject, so without this every group
   * would show up in the digest as a bare `…@g.us` id.
   */
  async renameChat(input: {
    companyId: string;
    waChatId: string;
    name: string;
    isGroup: boolean;
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.whatsappChat.updateMany({
        where: { companyId: input.companyId, waChatId: input.waChatId },
        data: { name: input.name, isGroup: input.isGroup },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'whatsapp.renameChat', cause));
    }
  }

  /**
   * Drop transcript older than the retention window.
   *
   * Batched rather than a single sweeping delete: these tables hold the busiest
   * rows in the feature, and one unbounded `DELETE` on a shared database is how
   * a housekeeping job becomes an outage.
   */
  async pruneMessagesBefore(cutoff: Date, limit: number): Promise<Result<number, InfraError>> {
    try {
      const doomed = await this.db.whatsappMessage.findMany({
        where: { occurredAt: { lt: cutoff } },
        orderBy: { occurredAt: 'asc' },
        take: limit,
        select: { id: true },
      });
      if (doomed.length === 0) return ok(0);
      const removed = await this.db.whatsappMessage.deleteMany({
        where: { id: { in: doomed.map(row => row.id) } },
      });
      return ok(removed.count);
    } catch (cause) {
      return err(wrapInfra('prisma', 'whatsapp.pruneMessagesBefore', cause));
    }
  }
}

const SESSION_SELECT = {
  id: true,
  companyId: true,
  departmentId: true,
  label: true,
  openwaSessionId: true,
  phoneE164: true,
  status: true,
  lastSeenAt: true,
  darkSince: true,
} as const;
