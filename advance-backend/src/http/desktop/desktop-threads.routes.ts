import { Router, type Request, type Response } from 'express';
import { Prisma } from '../../generated/prisma';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { createMemberAuthMiddleware } from '../middleware/member-auth.middleware';

export interface DesktopThreadsRoutesDeps {
  prisma:          PrismaClient;
  logger:          Logger;
  memberJwtSecret: string;
}

export function createDesktopThreadsRoutes(deps: DesktopThreadsRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ service: 'desktop-threads' });

  const memberAuth = createMemberAuthMiddleware({
    prisma:    deps.prisma,
    jwtSecret: deps.memberJwtSecret,
    logger:    deps.logger,
  });

  router.use(memberAuth);

  router.get('/workspaces', async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;

      const workspaces = await deps.prisma.desktopWorkspace.findMany({
        where:   { userId, companyId },
        orderBy: [{ lastOpenedAt: 'desc' }, { updatedAt: 'desc' }],
      });

      res.json({ success: true, data: workspaces });
    } catch (e) {
      log.error('workspaces.list.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/workspaces', async (req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const { path, name } = req.body as { path?: string; name?: string };
      const workspace = await upsertDesktopWorkspace(deps.prisma, {
        userId,
        companyId,
        ...(path !== undefined ? { path } : {}),
        ...(name !== undefined ? { name } : {}),
      });
      if (!workspace) {
        res.status(400).json({ success: false, message: 'workspace path is required' });
        return;
      }

      res.status(201).json({ success: true, data: workspace });
    } catch (e) {
      log.error('workspaces.upsert.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;

      const threads = await deps.prisma.desktopThread.findMany({
        where:   { userId, companyId, channel: 'desktop' },
        orderBy: { updatedAt: 'desc' },
        take:    50,
        select: {
          id: true, title: true, departmentId: true, preferredEngine: true,
          workspaceId: true, workspacePath: true, workspaceName: true,
          workspace: { select: { id: true, path: true, name: true, lastOpenedAt: true, createdAt: true, updatedAt: true } },
          lastMessageAt: true, createdAt: true, updatedAt: true,
          summaryJson: true, taskStateJson: true,
          _count: { select: { messages: true } },
        },
      });

      res.json({ success: true, data: threads.map(serializeThread) });
    } catch (e) {
      log.error('threads.list.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const { title, departmentId, workspaceId, workspace } = req.body as {
        title?: string;
        departmentId?: string;
        workspaceId?: string | null;
        workspace?: { id?: string | null; path?: string; name?: string } | null;
      };

      const resolvedWorkspace = await resolveRequestedWorkspace(deps.prisma, {
        userId,
        companyId,
        workspaceId: workspaceId ?? workspace?.id ?? null,
        ...(workspace?.path !== undefined ? { workspacePath: workspace.path } : {}),
        ...(workspace?.name !== undefined ? { workspaceName: workspace.name } : {}),
      });

      const thread = await deps.prisma.desktopThread.create({
        data: {
          userId,
          companyId,
          channel: 'desktop',
          title: title ?? 'New conversation',
          departmentId: departmentId ?? null,
          workspaceId: resolvedWorkspace?.id ?? null,
          workspacePath: resolvedWorkspace?.path ?? null,
          workspaceName: resolvedWorkspace?.name ?? null,
        },
        include: { workspace: true },
      });

      res.status(201).json({ success: true, data: serializeThread(thread) });
    } catch (e) {
      log.error('threads.create.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/:threadId', async (req: Request, res: Response) => {
    try {
      const userId   = res.locals['userId'] as string;
      const threadId = req.params['threadId']!;
      const page     = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));

      const thread = await deps.prisma.desktopThread.findUnique({
        where: { id: threadId },
        include: {
          workspace: true,
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
          ...serializeThread(thread),
          messages: thread.messages,
          pagination: { page, pageSize, totalMessages, totalPages: Math.ceil(totalMessages / pageSize) },
        },
      });
    } catch (e) {
      log.error('threads.get.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/:threadId/messages', async (req: Request, res: Response) => {
    try {
      const userId   = res.locals['userId'] as string;
      const threadId = req.params['threadId']!;
      const { role, content, metadata } = req.body as { role: string; content: string; metadata?: unknown };

      const thread = await deps.prisma.desktopThread.findUnique({ where: { id: threadId } });
      if (!thread || thread.userId !== userId) {
        res.status(404).json({ success: false, message: 'Thread not found' });
        return;
      }

      const message = await deps.prisma.desktopMessage.create({
        data: {
          threadId,
          role: role ?? 'user',
          content,
          ...(metadata ? { metadata: metadata as any } : {}),
        },
      });

      await deps.prisma.desktopThread.update({
        where: { id: threadId },
        data:  { lastMessageAt: new Date() },
      });

      res.status(201).json({ success: true, data: message });
    } catch (e) {
      log.error('threads.addMessage.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.delete('/:threadId', async (req: Request, res: Response) => {
    try {
      const userId   = res.locals['userId'] as string;
      const threadId = req.params['threadId']!;

      const thread = await deps.prisma.desktopThread.findUnique({ where: { id: threadId } });
      if (!thread || thread.userId !== userId) {
        res.status(404).json({ success: false, message: 'Thread not found' });
        return;
      }

      await deps.prisma.desktopThread.delete({ where: { id: threadId } });
      res.json({ success: true, message: 'Thread deleted' });
    } catch (e) {
      log.error('threads.delete.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  return router;
}

function normalizeWorkspacePath(path: string | undefined): string | null {
  const trimmed = path?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : null;
}

function workspaceNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

async function upsertDesktopWorkspace(
  prisma: PrismaClient,
  input: {
    userId: string;
    companyId: string;
    path?: string;
    name?: string;
  },
) {
  const path = normalizeWorkspacePath(input.path);
  if (!path) return null;
  const name = input.name?.trim() || workspaceNameFromPath(path);

  return prisma.desktopWorkspace.upsert({
    where: {
      companyId_userId_path: {
        companyId: input.companyId,
        userId: input.userId,
        path,
      },
    },
    create: {
      companyId: input.companyId,
      userId: input.userId,
      path,
      name,
      lastOpenedAt: new Date(),
    },
    update: {
      name,
      lastOpenedAt: new Date(),
    },
  });
}

async function resolveRequestedWorkspace(
  prisma: PrismaClient,
  input: {
    userId: string;
    companyId: string;
    workspaceId?: string | null;
    workspacePath?: string;
    workspaceName?: string;
  },
) {
  if (input.workspaceId) {
    const existing = await prisma.desktopWorkspace.findFirst({
      where: { id: input.workspaceId, userId: input.userId, companyId: input.companyId },
    });
    if (existing) return existing;
  }

  return upsertDesktopWorkspace(prisma, {
    userId: input.userId,
    companyId: input.companyId,
    ...(input.workspacePath !== undefined ? { path: input.workspacePath } : {}),
    ...(input.workspaceName !== undefined ? { name: input.workspaceName } : {}),
  });
}

function serializeThread<T extends {
  workspace?: {
    id: string;
    path: string;
    name: string;
    lastOpenedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  workspaceId?: string | null;
  workspacePath?: string | null;
  workspaceName?: string | null;
}>(thread: T) {
  const workspace = thread.workspace
    ? {
        id: thread.workspace.id,
        path: thread.workspace.path,
        name: thread.workspace.name,
        lastOpenedAt: thread.workspace.lastOpenedAt,
        createdAt: thread.workspace.createdAt,
        updatedAt: thread.workspace.updatedAt,
      }
    : null;

  return {
    ...thread,
    workspaceId: workspace?.id ?? thread.workspaceId ?? null,
    workspacePath: workspace?.path ?? thread.workspacePath ?? null,
    workspaceName: workspace?.name ?? thread.workspaceName ?? null,
    workspace,
  } satisfies T & {
    workspaceId: string | null;
    workspacePath: string | null;
    workspaceName: string | null;
    workspace: typeof workspace;
  };
}
