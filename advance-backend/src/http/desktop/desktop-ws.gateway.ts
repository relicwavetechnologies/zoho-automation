import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage as HttpIncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { Prisma, type PrismaClient } from '../../generated/prisma';
import type { OrchestrationEngine } from '../../application/orchestration/engine/core';
import type { ChatMessageSerializer } from '../../application/orchestration/chat-message-serializer';
import type { ApprovalGateService } from '../../application/approval/approval-gate.service';
import { DesktopChannelAdapter, type DesktopChatStartPayload } from '../../infrastructure/channels/desktop/desktop.adapter';
import type { ConversationHandle } from '../../application/channels/channel.adapter';
import { asChatId, asCompanyId, asCorrelationId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import { terminalRegistry, type ExecResult } from '../../application/orchestration/tools/shared/terminal-bridge';
import type { Logger } from '../../shared/logger';

export interface DesktopWsGatewayDeps {
  prisma:          PrismaClient;
  memberJwtSecret: string;
  logger:          Logger;
  engine:          OrchestrationEngine;
  chatSerializer:  ChatMessageSerializer;
  approvalGate?:   ApprovalGateService;
}

interface MemberJwtPayload {
  sessionId: string;
  userId:    string;
  companyId: string;
  role?:     string;
  exp?:      number;
}

interface DesktopSessionContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly companyId: string;
  readonly role: string;
  readonly larkOpenId?: string;
  readonly userEmail?: string;
}

function verifyJwt(token: string, secret: string): MemberJwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  try {
    if (!timingSafeEqual(Buffer.from(s, 'base64url'), Buffer.from(expected, 'base64url'))) return null;
  } catch { return null; }
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as MemberJwtPayload;
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExecStatus(s: string): s is ExecResult['status'] {
  return s === 'completed' || s === 'declined' || s === 'blocked' || s === 'unavailable';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readWorkspace(value: unknown): { readonly name: string; readonly path: string } | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const name = readString(value['name']);
  const path = readString(value['path']);
  return name && path ? { name, path } : null;
}

function readWorkflowInvocation(value: unknown): DesktopChatStartPayload['workflowInvocation'] {
  if (!isRecord(value)) return undefined;
  const workflowId = readString(value['workflowId']);
  if (!workflowId) return undefined;
  const workflowName = readString(value['workflowName']);
  const overrideText = readString(value['overrideText']);
  return {
    workflowId,
    ...(workflowName ? { workflowName } : {}),
    ...(overrideText ? { overrideText } : {}),
  };
}

function parseChatStartMessage(msg: Record<string, unknown>): DesktopChatStartPayload | null {
  if (msg['type'] !== 'chat.start') return null;
  const requestId = readString(msg['requestId']);
  const threadId = readString(msg['threadId']);
  const message = readString(msg['message']);
  if (!requestId || !threadId || message === undefined) return null;
  const modeValue = readString(msg['mode']);
  const mode = modeValue === 'fast' || modeValue === 'high' ? modeValue : undefined;
  const workflowInvocation = readWorkflowInvocation(msg['workflowInvocation']);
  return {
    type: 'chat.start',
    requestId,
    threadId,
    message,
    ...(mode ? { mode } : {}),
    workspace: readWorkspace(msg['workspace']),
    ...(workflowInvocation ? { workflowInvocation } : {}),
  };
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(payload));
}

function sendDesktopError(ws: WebSocket, requestId: string, message: string): void {
  sendJson(ws, {
    type: 'chat.event',
    requestId,
    event: { type: 'error', data: message },
  });
}

export function createDesktopWsGateway(deps: DesktopWsGatewayDeps) {
  const log = deps.logger.child({ service: 'desktop-ws' });

  function attach(httpServer: HttpServer): void {
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      if (url.pathname !== '/ws/desktop') return;

      void handleUpgrade(req, socket, head, wss, deps, log)
        .catch((error: unknown) => {
          log.warn('ws.upgrade.failed', { error: String(error) });
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        });
    });

    log.info('ws.gateway.attached', { path: '/ws/desktop' });
  }

  return { attach };
}

async function handleUpgrade(
  req: HttpIncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  deps: DesktopWsGatewayDeps,
  log: Logger,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const authHeader = req.headers['authorization'];
  const token = url.searchParams.get('token')
    ?? (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined)
    ?? '';

  const payload = verifyJwt(token, deps.memberJwtSecret);
  if (!payload) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const session = await resolveDesktopSession(deps, payload);
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    handleConnection(ws, session, deps, log);
  });
}

async function resolveDesktopSession(
  deps: DesktopWsGatewayDeps,
  payload: MemberJwtPayload,
): Promise<DesktopSessionContext | null> {
  const session = await deps.prisma.memberSession.findUnique({
    where: { sessionId: payload.sessionId },
    include: { user: { select: { email: true } } },
  });
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
  if (session.userId !== payload.userId || session.companyId !== payload.companyId) return null;
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    companyId: session.companyId,
    role: session.role,
    ...(session.larkOpenId ? { larkOpenId: session.larkOpenId } : {}),
    ...(session.user.email ? { userEmail: session.user.email } : {}),
  };
}

function handleConnection(
  ws: WebSocket,
  session: DesktopSessionContext,
  deps: DesktopWsGatewayDeps,
  log: Logger,
): void {
  log.info('ws.connected', { userId: session.userId, companyId: session.companyId });

  sendJson(ws, {
    type: 'session.ready',
    wsSessionId: randomUUID(),
    userId: session.userId,
    companyId: session.companyId,
  });

  const heartbeat = setInterval(() => {
    sendJson(ws, { type: 'session.heartbeat', ts: Date.now() });
  }, 30_000);

  ws.on('message', (raw: RawData) => {
    void handleClientMessage(ws, session, raw, deps, log);
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    log.info('ws.disconnected', { userId: session.userId });
  });

  ws.on('error', (error: Error) => {
    log.warn('ws.error', { error: error.message, userId: session.userId });
  });
}

async function handleClientMessage(
  ws: WebSocket,
  session: DesktopSessionContext,
  raw: RawData,
  deps: DesktopWsGatewayDeps,
  log: Logger,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    sendDesktopError(ws, 'system', 'Malformed desktop WebSocket message.');
    return;
  }

  if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
    sendDesktopError(ws, 'system', 'Malformed desktop WebSocket message.');
    return;
  }

  log.info('ws.message', { type: parsed['type'], userId: session.userId });

  if (parsed['type'] === 'session.heartbeat') {
    sendJson(ws, { type: 'session.heartbeat', ts: Date.now() });
    return;
  }

  if (parsed['type'] === 'workspace.status') {
    return;
  }

  if (parsed['type'] === 'terminal.exec.result') {
    const threadId = readString(parsed['threadId']);
    const callId = readString(parsed['callId']);
    const statusRaw = readString(parsed['status']);
    if (threadId && callId && statusRaw && isExecStatus(statusRaw)) {
      const result: ExecResult = {
        status: statusRaw,
        ...(typeof parsed['exitCode'] === 'number' ? { exitCode: parsed['exitCode'] } : {}),
        ...(typeof parsed['stdout'] === 'string' ? { stdout: parsed['stdout'] } : {}),
        ...(typeof parsed['stderr'] === 'string' ? { stderr: parsed['stderr'] } : {}),
        ...(typeof parsed['durationMs'] === 'number' ? { durationMs: parsed['durationMs'] } : {}),
        ...(typeof parsed['timedOut'] === 'boolean' ? { timedOut: parsed['timedOut'] } : {}),
        ...(typeof parsed['message'] === 'string' ? { message: parsed['message'] } : {}),
      };
      terminalRegistry.get(threadId)?.resolveResult(callId, result);
    }
    return;
  }

  const chatStart = parseChatStartMessage(parsed);
  if (chatStart) {
    deps.chatSerializer.run(`desktop:${chatStart.threadId}`, async () => {
      await processDesktopChatStart({
        ws,
        session,
        message: chatStart,
        deps,
        log,
      });
    });
  }
}

export async function processDesktopChatStart(input: {
  ws: WebSocket;
  session: DesktopSessionContext;
  message: DesktopChatStartPayload;
  deps: DesktopWsGatewayDeps;
  log: Logger;
}): Promise<void> {
  const { ws, session, message, deps, log } = input;
  const adapter = new DesktopChannelAdapter({
    prisma: deps.prisma,
    ws,
    requestId: message.requestId,
    logger: log,
  });

  // Expose the adapter as the terminal bridge for this thread so the runCommand
  // tool can gate + stream through it. Cleaned up in finally.
  terminalRegistry.register(message.threadId, adapter);

  try {
    const thread = await deps.prisma.desktopThread.findUnique({
      where: { id: message.threadId },
      select: {
        id: true,
        userId: true,
        companyId: true,
        departmentId: true,
        title: true,
        workspaceId: true,
        workspacePath: true,
        workspaceName: true,
      },
    });
    if (!thread || thread.userId !== session.userId || thread.companyId !== session.companyId) {
      sendDesktopError(ws, message.requestId, 'Thread not found.');
      return;
    }
    const effectiveThread = await ensureThreadWorkspace({
      deps,
      session,
      thread,
      ...(message.workspace !== undefined ? { workspace: message.workspace } : {}),
    });

    const now = new Date();
    const userContent = message.message.trim();
    await deps.prisma.desktopMessage.create({
      data: {
        threadId: thread.id,
        role: 'user',
        content: userContent,
      },
    });

    await deps.prisma.desktopThread.update({
      where: { id: effectiveThread.id },
      data: {
        lastMessageAt: now,
        ...(shouldSetInitialTitle(effectiveThread.title, userContent)
          ? { title: buildThreadTitle(userContent) }
          : {}),
      },
    });

    await ensureRuntimeConversation({
      deps,
      session,
      thread: effectiveThread,
    });

    const parseResult = adapter.parseIncoming({
      ...message,
      userExternalId: session.larkOpenId ?? session.userId,
      timestamp: now.toISOString(),
    });
    if (!parseResult.ok) {
      sendDesktopError(ws, message.requestId, parseResult.error.message);
      return;
    }

    const conversation: ConversationHandle = {
      channel: 'desktop',
      chatId: asChatId(thread.id),
      correlationId: asCorrelationId(message.requestId),
    };

    const result = await deps.engine.run({
      incoming: parseResult.value,
      runContext: {
        companyId: asCompanyId(session.companyId),
        userId: asUserId(session.userId),
        companyRole: asCompanyRoleSlug(session.role),
        channel: 'desktop',
        traceId: message.requestId,
        requestId: message.requestId,
        chatId: thread.id,
        userExternalId: session.larkOpenId ?? session.userId,
        requesterAiRole: session.role,
        ...(session.userEmail ? { requesterEmail: session.userEmail } : {}),
        ...(effectiveThread.departmentId ? { departmentId: asDepartmentId(effectiveThread.departmentId) } : {}),
        ...(effectiveThread.workspacePath ? { workspacePath: effectiveThread.workspacePath } : {}),
      },
      conversation,
      channelAdapter: adapter,
      ...(deps.approvalGate ? { approvalGate: deps.approvalGate } : {}),
    });

    if (!result.ok) {
      adapter.emitError(result.error.message);
    }
  } catch (error) {
    log.error('desktop.chat_start.failed', {
      error: error instanceof Error ? error.message : String(error),
      requestId: message.requestId,
      threadId: message.threadId,
    });
    sendDesktopError(ws, message.requestId, 'Desktop chat failed. Please try again.');
  } finally {
    terminalRegistry.unregister(message.threadId);
  }
}

async function ensureRuntimeConversation(input: {
  deps: DesktopWsGatewayDeps;
  session: DesktopSessionContext;
  thread: {
    id: string;
    companyId: string;
    departmentId: string | null;
    title: string | null;
    workspaceId: string | null;
    workspacePath: string | null;
    workspaceName: string | null;
  };
}): Promise<void> {
  const workspaceRef = input.thread.workspacePath
    ? {
        desktopWorkspace: {
          id: input.thread.workspaceId,
          path: input.thread.workspacePath,
          name: input.thread.workspaceName,
        },
      }
    : undefined;

  await input.deps.prisma.runtimeConversation.upsert({
    where: {
      companyId_channel_channelConversationKey: {
        companyId: input.session.companyId,
        channel: 'desktop',
        channelConversationKey: input.thread.id,
      },
    },
    create: {
      companyId: input.session.companyId,
      channel: 'desktop',
      channelConversationKey: input.thread.id,
      rawChannelKey: input.thread.id,
      status: 'active',
      createdByUserId: input.session.userId,
      ...(input.session.userEmail ? { createdByEmail: input.session.userEmail } : {}),
      ...(input.thread.departmentId ? { departmentId: input.thread.departmentId } : {}),
      ...(input.thread.title ? { title: input.thread.title } : {}),
      ...(workspaceRef ? { refsJson: workspaceRef } : {}),
    },
    update: {
      updatedAt: new Date(),
      ...(input.thread.departmentId ? { departmentId: input.thread.departmentId } : {}),
      ...(input.thread.title ? { title: input.thread.title } : {}),
      ...(workspaceRef ? { refsJson: workspaceRef } : {}),
    },
  });
}

async function ensureThreadWorkspace(input: {
  deps: DesktopWsGatewayDeps;
  session: DesktopSessionContext;
  thread: {
    id: string;
    userId: string;
    companyId: string;
    departmentId: string | null;
    title: string | null;
    workspaceId: string | null;
    workspacePath: string | null;
    workspaceName: string | null;
  };
  workspace?: { readonly name: string; readonly path: string } | null;
}) {
  const path = normalizeWorkspacePath(input.workspace?.path);
  if (!path) return input.thread;

  const name = input.workspace?.name?.trim() || workspaceNameFromPath(path);
  if (input.thread.workspacePath === path && input.thread.workspaceName === name) {
    return input.thread;
  }

  const workspace = await input.deps.prisma.desktopWorkspace.upsert({
    where: {
      companyId_userId_path: {
        companyId: input.session.companyId,
        userId: input.session.userId,
        path,
      },
    },
    create: {
      companyId: input.session.companyId,
      userId: input.session.userId,
      path,
      name,
      lastOpenedAt: new Date(),
    },
    update: {
      name,
      lastOpenedAt: new Date(),
    },
  });

  await input.deps.prisma.desktopThread.update({
    where: { id: input.thread.id },
    data: {
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      workspaceName: workspace.name,
    },
  });

  return {
    ...input.thread,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    workspaceName: workspace.name,
  };
}

function normalizeWorkspacePath(path: string | undefined): string | null {
  const trimmed = path?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : null;
}

function workspaceNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function shouldSetInitialTitle(title: string | null, userContent: string): boolean {
  return userContent.trim().length > 0 && (!title || title === 'New conversation');
}

function buildThreadTitle(userContent: string): string {
  const normalized = userContent.replace(/\s+/g, ' ').trim();
  return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized;
}
