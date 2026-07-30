import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '../../generated/prisma';
import type { OrchestrationEngine } from '../../application/orchestration/engine/core';
import type { ChatMessageSerializer } from '../../application/channels/chat-message-serializer';
import type { ApprovalGateService } from '../../application/approval/approval-gate.service';
import { createAirnoteAuthMiddleware } from './airnote-auth.middleware';
import type { LarkOAuthService } from '../../infrastructure/lark/lark-oauth.service';
import type { ChannelIdentityRepository } from '../../infrastructure/persistence/channel-identity.repository';
import { AirnoteChannelAdapter } from '../../infrastructure/channels/desktop/airnote.adapter';
import type { ConversationHandle } from '../../application/channels/channel.adapter';
import { asChatId, asCompanyId, asCorrelationId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { Logger } from '../../shared/logger';

const HEARTBEAT_INTERVAL_MS = 15_000;

export interface AirnoteRoutesDeps {
  prisma:              PrismaClient;
  larkOAuthService:    LarkOAuthService;
  channelIdentityRepo: ChannelIdentityRepository;
  logger:              Logger;
  engine:              OrchestrationEngine;
  chatSerializer:      ChatMessageSerializer;
  approvalGate:        ApprovalGateService;
}

export function createAirnoteRoutes(deps: AirnoteRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ service: 'airnote' });

  const airnoteAuth = createAirnoteAuthMiddleware({
    larkOAuthService:    deps.larkOAuthService,
    channelIdentityRepo: deps.channelIdentityRepo,
    logger:              deps.logger,
  });

  router.post('/chat', airnoteAuth, async (req: Request, res: Response) => {
    const userId     = res.locals['userId'] as string;
    const companyId  = res.locals['companyId'] as string;
    const aiRole     = res.locals['aiRole'] as string;
    const larkOpenId = res.locals['larkOpenId'] as string | null;
    const email      = res.locals['email'] as string | null;

    const body = req.body as {
      requestId?: string;
      message?: string;
      threadId?: string;
      mode?: string;
    };

    const requestId = body.requestId;
    const message   = body.message;
    const mode      = body.mode === 'fast' || body.mode === 'high' ? body.mode : undefined;

    if (!requestId || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'requestId and message are required' });
      return;
    }

    // Open SSE stream before any async work so the client gets headers immediately.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, HEARTBEAT_INTERVAL_MS);

    res.on('close', () => clearInterval(heartbeat));

    try {
      // Active department resolved by the auth middleware (from the user's Divo identity).
      const departmentId = (res.locals['departmentId'] as string | null) ?? null;

      // Resolve or create the thread.
      let threadId: string;
      if (body.threadId) {
        const existing = await deps.prisma.desktopThread.findUnique({
          where: { id: body.threadId },
          select: { id: true, userId: true, companyId: true },
        });
        if (!existing || existing.userId !== userId || existing.companyId !== companyId) {
          emitSseError(res, 'Thread not found or access denied');
          return;
        }
        threadId = existing.id;
      } else {
        const title = message.trim().replace(/\s+/g, ' ').slice(0, 60);
        const thread = await deps.prisma.desktopThread.create({
          data: {
            userId,
            companyId,
            channel: 'airnote',
            title: title || 'New conversation',
            departmentId: departmentId ?? null,
          },
        });
        threadId = thread.id;
      }

      // Emit meta frame — client must store threadId for follow-ups.
      emitSseEvent(res, 'meta', { threadId, requestId });

      // Persist user message.
      const now = new Date();
      await deps.prisma.desktopMessage.create({
        data: { threadId, role: 'user', content: message.trim() },
      });
      await deps.prisma.desktopThread.update({
        where: { id: threadId },
        data: { lastMessageAt: now },
      });

      // Ensure runtime conversation record exists (enables engine history for follow-ups).
      await deps.prisma.runtimeConversation.upsert({
        where: {
          companyId_channel_channelConversationKey: {
            companyId,
            channel: 'airnote',
            channelConversationKey: threadId,
          },
        },
        create: {
          companyId,
          channel: 'airnote',
          channelConversationKey: threadId,
          rawChannelKey: threadId,
          status: 'active',
          createdByUserId: userId,
          ...(email ? { createdByEmail: email } : {}),
          ...(departmentId ? { departmentId } : {}),
        },
        update: {
          updatedAt: new Date(),
          ...(departmentId ? { departmentId } : {}),
        },
      });

      const adapter = new AirnoteChannelAdapter({
        prisma: deps.prisma,
        res,
        requestId,
        logger: log,
      });

      const userExternalId = larkOpenId ?? userId;
      const parseResult = adapter.parseIncoming({
        requestId,
        threadId,
        message: message.trim(),
        ...(mode ? { mode } : {}),
        userExternalId,
        timestamp: now.toISOString(),
      });

      if (!parseResult.ok) {
        emitSseError(res, parseResult.error.message);
        return;
      }

      const conversation: ConversationHandle = {
        channel: 'airnote',
        chatId: asChatId(threadId),
        correlationId: asCorrelationId(requestId),
      };

      await new Promise<void>((resolve) => {
        deps.chatSerializer.run(
          `airnote:${threadId}`,
          async () => {
            const result = await deps.engine.run({
              incoming: parseResult.value,
              runContext: {
                companyId:        asCompanyId(companyId),
                userId:           asUserId(userId),
                companyRole:      asCompanyRoleSlug(aiRole),
                channel:          'airnote',
                traceId:          requestId,
                requestId,
                chatId:           threadId,
                userExternalId,
                requesterAiRole:  aiRole,
                ...(email ? { requesterEmail: email } : {}),
                ...(departmentId ? { departmentId: asDepartmentId(departmentId) } : {}),
              },
              conversation,
              channelAdapter: adapter,
              approvalGate: deps.approvalGate,
            });
            if (!result.ok) {
              adapter.emitError(result.error.message);
            }
            resolve();
          },
        );
      });
    } catch (error) {
      log.error('airnote.chat.failed', {
        error: error instanceof Error ? error.message : String(error),
        requestId,
        userId,
      });
      emitSseError(res, 'Airnote chat failed. Please try again.');
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });

  // List this user's AirNote threads (most recent first). Scoped to the caller's
  // own (userId, companyId) on the airnote channel — never another user's chats.
  router.get('/threads', airnoteAuth, async (req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const page      = Math.max(1, Number(req.query['page']) || 1);
      const pageSize  = Math.min(50, Math.max(1, Number(req.query['pageSize']) || 30));

      const where = { userId, companyId, channel: 'airnote' };

      const [rows, total] = await Promise.all([
        deps.prisma.desktopThread.findMany({
          where,
          orderBy: [
            { lastMessageAt: { sort: 'desc', nulls: 'last' } },
            { createdAt:     'desc' },
          ],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id:            true,
            title:         true,
            createdAt:     true,
            updatedAt:     true,
            lastMessageAt: true,
            // Latest message → a short preview line for the chat list.
            messages: {
              orderBy: { createdAt: 'desc' },
              take:    1,
              select:  { role: true, content: true },
            },
          },
        }),
        deps.prisma.desktopThread.count({ where }),
      ]);

      const threads = rows.map((t) => {
        const last = t.messages[0];
        const preview = last ? last.content.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
        return {
          id:            t.id,
          title:         t.title,
          createdAt:     t.createdAt,
          updatedAt:     t.updatedAt,
          lastMessageAt: t.lastMessageAt,
          preview,
        };
      });

      res.json({
        success: true,
        data: {
          threads,
          pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
          },
        },
      });
    } catch (e) {
      log.error('airnote.threads.list.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/threads/:threadId', airnoteAuth, async (req: Request, res: Response) => {
    try {
      const userId   = res.locals['userId'] as string;
      const threadId = req.params['threadId']!;
      const page     = Math.max(1, Number(req.query['page']) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query['pageSize']) || 50));

      const thread = await deps.prisma.desktopThread.findUnique({
        where: { id: threadId },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            skip:    (page - 1) * pageSize,
            take:    pageSize,
          },
        },
      });

      if (!thread || thread.userId !== userId) {
        res.status(404).json({ success: false, message: 'Thread not found' });
        return;
      }

      const totalMessages = await deps.prisma.desktopMessage.count({ where: { threadId } });

      res.json({
        success: true,
        data: {
          id:            thread.id,
          channel:       thread.channel,
          title:         thread.title,
          createdAt:     thread.createdAt,
          updatedAt:     thread.updatedAt,
          lastMessageAt: thread.lastMessageAt,
          messages:      thread.messages,
          pagination: {
            page,
            pageSize,
            totalMessages,
            totalPages: Math.ceil(totalMessages / pageSize),
          },
        },
      });
    } catch (e) {
      log.error('airnote.threads.get.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  return router;
}

function emitSseEvent(res: Response, eventName: string, data: unknown): void {
  if (!res.writableEnded) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function emitSseError(res: Response, message: string): void {
  emitSseEvent(res, 'error', { message });
  if (!res.writableEnded) res.end();
}
