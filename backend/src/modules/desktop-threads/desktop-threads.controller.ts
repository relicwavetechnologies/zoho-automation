import { Request, Response } from 'express';
import { z } from 'zod';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { MemberSessionDTO } from '../member-auth/member-auth.service';
import { desktopThreadsService } from './desktop-threads.service';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { prisma } from '../../utils/prisma';
import { departmentService } from '../../company/departments/department.service';

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

type TimedValueCacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const createMessageSchema = z.object({
  role: z.string().min(1).max(32),
  content: z.string().max(20000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const getThreadQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  beforeMessageId: z.string().uuid().optional(),
});

const createThreadSchema = z.object({
  departmentId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160).optional(),
});

const DESKTOP_SHARE_STATUS_CACHE_TTL_MS = 15_000;
const shareStatusCache = new Map<string, TimedValueCacheEntry<Date | null>>();

const readTimedCache = <T>(cache: Map<string, TimedValueCacheEntry<T>>, key: string): T | null => {
  const now = Date.now();
  for (const [entryKey, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(entryKey);
    }
  }
  const cached = cache.get(key);
  return cached && cached.expiresAt > now ? cached.value : null;
};

const writeTimedCache = <T>(cache: Map<string, TimedValueCacheEntry<T>>, key: string, value: T, ttlMs: number): T => {
  cache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
  return value;
};

class DesktopThreadsController extends BaseController {
  private session(req: Request): MemberSessionDTO {
    const s = (req as MemberRequest).memberSession;
    if (!s) throw new Error('Member session required');
    return s;
  }

  list = async (req: Request, res: Response) => {
    const s = this.session(req);
    res.setHeader('Cache-Control', 'no-store');
    const threads = await desktopThreadsService.listThreads(s.userId, s.companyId);
    return res.json(ApiResponse.success(threads, 'Threads listed'));
  };

  get = async (req: Request, res: Response) => {
    const s = this.session(req);
    const requesterAiRole = s.aiRole ?? s.role;
    res.setHeader('Cache-Control', 'no-store');
    const query = getThreadQuerySchema.parse(req.query);
    const result = await desktopThreadsService.getThreadMessagesPage(req.params.threadId, s.userId, {
      limit: query.limit ?? 6,
      beforeMessageId: query.beforeMessageId,
    });
    const allowedTools = await toolPermissionService.getAllowedTools(s.companyId, requesterAiRole);
    const canShareKnowledge = allowedTools.includes('share_chat_vectors');
    if (canShareKnowledge) {
      const conversationKey = `desktop:${req.params.threadId}`;
      const shareCacheKey = `${s.companyId}:${conversationKey}`;
      let sharedThroughAt = readTimedCache(shareStatusCache, shareCacheKey);
      if (sharedThroughAt === null && !shareStatusCache.has(shareCacheKey)) {
        const latestSharedRequest = await prisma.vectorShareRequest.findFirst({
          where: {
            companyId: s.companyId,
            conversationKey,
            status: { in: ['approved', 'auto_shared', 'shared_notified', 'already_shared'] },
          },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, reviewedAt: true, reason: true },
        });
        if (latestSharedRequest) {
          try {
            const meta = latestSharedRequest.reason ? JSON.parse(latestSharedRequest.reason) as { snapshotAt?: string } : null;
            if (meta?.snapshotAt) {
              const parsed = new Date(meta.snapshotAt);
              if (!Number.isNaN(parsed.getTime())) {
                sharedThroughAt = parsed;
              }
            }
          } catch {
            // Ignore malformed share metadata.
          }
          if (!sharedThroughAt) {
            sharedThroughAt = latestSharedRequest.reviewedAt ?? latestSharedRequest.createdAt;
          }
        }
        writeTimedCache(shareStatusCache, shareCacheKey, sharedThroughAt, DESKTOP_SHARE_STATUS_CACHE_TTL_MS);
      }
      result.messages = result.messages.map((message) =>
        {
          const existingMetadata =
            message.metadata && typeof message.metadata === 'object'
              ? (message.metadata as Record<string, unknown>)
              : {};
          const existingShareAction =
            existingMetadata.shareAction && typeof existingMetadata.shareAction === 'object'
              ? (existingMetadata.shareAction as Record<string, unknown>)
              : {};
          const messageCreatedAt = new Date(String(message.createdAt));
          const isShared =
            sharedThroughAt !== null
              && !Number.isNaN(messageCreatedAt.getTime())
              && messageCreatedAt.getTime() <= sharedThroughAt.getTime();

          return message.role === 'assistant'
            ? {
              ...message,
              metadata: {
                ...existingMetadata,
                shareAction: {
                  ...existingShareAction,
                  type: 'conversation',
                  conversationKey,
                  label: "Share this chat's knowledge",
                  shared: isShared,
                },
              },
            }
            : message;
        },
      );
    }
    return res.json(ApiResponse.success(result, 'Thread loaded'));
  };

  create = async (req: Request, res: Response) => {
    const s = this.session(req);
    const payload = createThreadSchema.parse(req.body ?? {});
    const resolvedDepartment = await departmentService.resolveDepartmentForThreadCreation({
      userId: s.userId,
      companyId: s.companyId,
      requestedDepartmentId: payload.departmentId,
    });
    const thread = await desktopThreadsService.createThread(
      s.userId,
      s.companyId,
      resolvedDepartment?.id ?? null,
      payload.title ?? null,
    );
    return res.status(201).json(ApiResponse.success(thread, 'Thread created'));
  };

  addMessage = async (req: Request, res: Response) => {
    const s = this.session(req);
    const { role, content, metadata } = createMessageSchema.parse(req.body);
    const message = await desktopThreadsService.addMessage(req.params.threadId, s.userId, role, content, metadata);
    return res.status(201).json(ApiResponse.success(message, 'Message created'));
  };

  delete = async (req: Request, res: Response) => {
    const s = this.session(req);
    await desktopThreadsService.deleteThread(req.params.threadId, s.userId);
    return res.status(204).send();
  };
}

export const desktopThreadsController = new DesktopThreadsController();
