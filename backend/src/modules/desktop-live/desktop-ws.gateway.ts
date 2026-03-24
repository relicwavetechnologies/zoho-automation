import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { WebSocketServer, type WebSocket } from 'ws';

import config from '../../config';
import { logger } from '../../utils/logger';
import { memberAuthService, type MemberSessionDTO } from '../member-auth/member-auth.service';
import { vercelDesktopEngine } from '../desktop-chat/vercel-desktop.engine';
import type { PendingApprovalAction } from '../../company/orchestration/vercel/types';

type MemberJwtPayload = {
  userId: string;
  sessionId: string;
  role: string;
  companyId: string;
  channel: string;
};

type DesktopWorkspaceSnapshot = {
  name: string;
  path: string;
};

type DesktopPermissionDecision = 'allow' | 'ask' | 'deny';

type DesktopWorkspacePolicy = {
  version: number;
  actions: Partial<Record<RemoteLocalAction['kind'], DesktopPermissionDecision>>;
};

type DesktopAgentSession = {
  wsSessionId: string;
  memberSession: MemberSessionDTO;
  memberSessionId: string;
  userId: string;
  companyId: string;
  authProvider?: string;
  larkTenantKey?: string;
  larkOpenId?: string;
  larkUserId?: string;
  deviceLabel?: string;
  activeWorkspace?: DesktopWorkspaceSnapshot;
  capabilities?: string[];
  permissionPolicyVersion?: number;
  permissionPolicy?: DesktopWorkspacePolicy;
  lastHeartbeatAt: number;
};

type WsEnvelope =
  | {
    type: 'session.hello';
    deviceLabel?: string;
    capabilities?: string[];
    workspace?: DesktopWorkspaceSnapshot | null;
    permissionPolicy?: DesktopWorkspacePolicy | null;
  }
  | {
    type: 'session.heartbeat';
    deviceLabel?: string;
    capabilities?: string[];
    workspace?: DesktopWorkspaceSnapshot | null;
    permissionPolicy?: DesktopWorkspacePolicy | null;
  }
  | {
    type: 'workspace.status';
    deviceLabel?: string;
    capabilities?: string[];
    workspace?: DesktopWorkspaceSnapshot | null;
    permissionPolicy?: DesktopWorkspacePolicy | null;
  }
  | {
    type: 'chat.start';
    requestId: string;
    threadId: string;
    message?: string;
    attachedFiles?: Array<Record<string, unknown>>;
    mode?: 'fast' | 'high';
    workspace?: DesktopWorkspaceSnapshot | null;
    workflowInvocation?: {
      workflowId: string;
      workflowName?: string;
      overrideText?: string;
    };
  }
  | {
    type: 'chat.act';
    requestId: string;
    threadId: string;
    payload: Record<string, unknown>;
    workspace?: DesktopWorkspaceSnapshot | null;
  }
  | {
    type: 'chat.cancel';
    requestId: string;
  }
  | {
    type: 'local_action.progress';
    dispatchId: string;
    eventType: 'start' | 'stdout' | 'stderr' | 'error' | 'exit';
    data: unknown;
  }
  | {
    type: 'local_action.result';
    dispatchId: string;
    result: RemoteLocalActionResult;
  };

export type RemoteLocalAction =
  | { kind: 'list_files'; path?: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete_path'; path: string }
  | { kind: 'run_command'; command: string };

export type RemoteLocalActionResult = {
  kind: RemoteLocalAction['kind'];
  ok: boolean;
  summary: string;
  payload?: Record<string, unknown>;
};

type PendingDispatch = {
  wsSessionId: string;
  userId: string;
  companyId: string;
  action: RemoteLocalAction;
  resolve: (value: RemoteLocalActionResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type StreamResponseAdapter = {
  requestId: string;
  closed: boolean;
  buffer: string;
  close: () => void;
  setHeader: (_name: string, _value: string) => void;
  flushHeaders?: () => void;
  write: (chunk: string) => void;
  end: () => void;
};

const STREAM_TIMEOUT_MS = 15 * 60 * 1000;
const HEARTBEAT_STALE_MS = 45_000;
const DEFAULT_POLICY: DesktopWorkspacePolicy = {
  version: 1,
  actions: {
    list_files: 'allow',
    read_file: 'allow',
    run_command: 'ask',
    write_file: 'ask',
    mkdir: 'ask',
    delete_path: 'ask',
  },
};

const normalizeWorkspace = (value: unknown): DesktopWorkspaceSnapshot | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const path = typeof record.path === 'string' ? record.path.trim() : '';
  if (!path) return undefined;
  return { name: name || path, path };
};

const normalizePolicy = (value: unknown): DesktopWorkspacePolicy => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_POLICY;
  }
  const record = value as Record<string, unknown>;
  const actionsRecord = record.actions && typeof record.actions === 'object' && !Array.isArray(record.actions)
    ? record.actions as Record<string, unknown>
    : {};

  const readDecision = (key: RemoteLocalAction['kind']): DesktopPermissionDecision => {
    const raw = actionsRecord[key];
    return raw === 'allow' || raw === 'deny' || raw === 'ask'
      ? raw
      : DEFAULT_POLICY.actions[key] ?? 'ask';
  };

  return {
    version: typeof record.version === 'number' && Number.isFinite(record.version) ? record.version : DEFAULT_POLICY.version,
    actions: {
      list_files: readDecision('list_files'),
      read_file: readDecision('read_file'),
      run_command: readDecision('run_command'),
      write_file: readDecision('write_file'),
      mkdir: readDecision('mkdir'),
      delete_path: readDecision('delete_path'),
    },
  };
};

const summarizeAction = (action: RemoteLocalAction): string => {
  switch (action.kind) {
    case 'run_command':
      return action.command;
    case 'write_file':
      return `Write ${action.path}`;
    case 'mkdir':
      return `Create directory ${action.path}`;
    case 'delete_path':
      return `Delete ${action.path}`;
    case 'read_file':
      return `Read ${action.path}`;
    case 'list_files':
      return `List files${action.path ? ` in ${action.path}` : ''}`;
    default:
      return action.kind;
  }
};

const actionPolicyGroup = (action: RemoteLocalAction): DesktopPermissionDecision => {
  return DEFAULT_POLICY.actions[action.kind] ?? 'ask';
};

const summarizePolicy = (policy?: DesktopWorkspacePolicy): string => {
  const effective = policy ?? DEFAULT_POLICY;
  const actions = effective.actions;
  return [
    `list_files=${actions.list_files ?? 'ask'}`,
    `read_file=${actions.read_file ?? 'ask'}`,
    `run_command=${actions.run_command ?? 'ask'}`,
    `write_file=${actions.write_file ?? 'ask'}`,
    `mkdir=${actions.mkdir ?? 'ask'}`,
    `delete_path=${actions.delete_path ?? 'ask'}`,
  ].join(', ');
};

class DesktopWsGateway {
  private server?: WebSocketServer;

  private readonly sockets = new Map<string, WebSocket>();

  private readonly sessions = new Map<string, DesktopAgentSession>();

  private readonly activeStreams = new Map<string, StreamResponseAdapter>();

  private readonly pendingDispatches = new Map<string, PendingDispatch>();

  attach(httpServer: HttpServer): void {
    if (this.server) {
      return;
    }

    const wss = new WebSocketServer({ noServer: true });
    this.server = wss;

    httpServer.on('upgrade', async (req, socket, head) => {
      try {
        const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
        if (url.pathname !== '/ws/desktop') {
          return;
        }
        const session = await this.authenticate(req);
        wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleConnection(ws, req, session);
        });
      } catch (error) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        logger.warn('desktop.ws.upgrade.rejected', {
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      }
    });
  }

  private async authenticate(req: IncomingMessage): Promise<MemberSessionDTO> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) {
      throw new Error('Missing desktop WS bearer token');
    }

    let decoded: MemberJwtPayload;
    try {
      decoded = jwt.verify(token, config.JWT_SECRET) as MemberJwtPayload;
    } catch {
      throw new Error('Invalid desktop WS bearer token');
    }

    const session = await memberAuthService.resolveMemberSession(decoded.sessionId);
    if (!session) {
      throw new Error('Desktop WS session expired');
    }
    return session;
  }

  private handleConnection(ws: WebSocket, _req: IncomingMessage, session: MemberSessionDTO): void {
    const wsSessionId = crypto.randomUUID();
    const record: DesktopAgentSession = {
      wsSessionId,
      memberSession: session,
      memberSessionId: session.sessionId,
      userId: session.userId,
      companyId: session.companyId,
      authProvider: session.authProvider,
      larkTenantKey: session.larkTenantKey,
      larkOpenId: session.larkOpenId,
      larkUserId: session.larkUserId,
      lastHeartbeatAt: Date.now(),
      permissionPolicy: DEFAULT_POLICY,
      permissionPolicyVersion: DEFAULT_POLICY.version,
    };

    this.sockets.set(wsSessionId, ws);
    this.sessions.set(wsSessionId, record);
    logger.info('desktop.ws.connected', {
      wsSessionId,
      userId: session.userId,
      companyId: session.companyId,
      authProvider: session.authProvider,
    });

    this.send(ws, {
      type: 'session.ready',
      wsSessionId,
      userId: session.userId,
      companyId: session.companyId,
    });

    ws.on('message', (raw) => {
      this.handleMessage(wsSessionId, raw.toString('utf8')).catch((error) => {
        logger.error('desktop.ws.message.failed', {
          wsSessionId,
          error: error instanceof Error ? error.message : 'unknown_error',
        });
        this.send(ws, {
          type: 'execution.error',
          message: error instanceof Error ? error.message : 'Desktop WS message failed',
        });
      });
    });

    ws.on('close', () => {
      this.handleDisconnect(wsSessionId, 'socket_closed');
    });
    ws.on('error', (error) => {
      logger.warn('desktop.ws.socket.error', {
        wsSessionId,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      this.handleDisconnect(wsSessionId, 'socket_error');
    });
  }

  private handleDisconnect(wsSessionId: string, reason: string): void {
    const session = this.sessions.get(wsSessionId);
    this.sockets.delete(wsSessionId);
    this.sessions.delete(wsSessionId);

    for (const [requestId, stream] of this.activeStreams.entries()) {
      if (requestId.startsWith(`${wsSessionId}:`)) {
        stream.close();
        this.activeStreams.delete(requestId);
      }
    }

    for (const [dispatchId, pending] of this.pendingDispatches.entries()) {
      if (pending.wsSessionId === wsSessionId) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Desktop session disconnected during remote action'));
        this.pendingDispatches.delete(dispatchId);
      }
    }

    logger.info('desktop.ws.disconnected', {
      wsSessionId,
      userId: session?.userId ?? null,
      companyId: session?.companyId ?? null,
      reason,
    });
  }

  private async handleMessage(wsSessionId: string, raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as WsEnvelope;
    const session = this.sessions.get(wsSessionId);
    if (!session) {
      throw new Error('Desktop WS session not found');
    }

    switch (envelope.type) {
      case 'session.hello':
      case 'session.heartbeat':
      case 'workspace.status': {
        session.lastHeartbeatAt = Date.now();
        session.deviceLabel = envelope.deviceLabel ?? session.deviceLabel;
        session.capabilities = envelope.capabilities ?? session.capabilities;
        session.activeWorkspace = normalizeWorkspace(envelope.workspace) ?? session.activeWorkspace;
        const policy = normalizePolicy(envelope.permissionPolicy);
        session.permissionPolicy = policy;
        session.permissionPolicyVersion = policy.version;
        const eventName = envelope.type === 'session.heartbeat'
          ? 'desktop.ws.heartbeat'
          : 'desktop.ws.presence.updated';
        const logFn = envelope.type === 'session.heartbeat' ? logger.debug : logger.info;
        logFn(eventName, {
          wsSessionId,
          userId: session.userId,
          workspacePath: session.activeWorkspace?.path ?? null,
          policyVersion: session.permissionPolicyVersion ?? null,
        });
        return;
      }
      case 'chat.start': {
        await this.startChatStream(wsSessionId, session, envelope);
        return;
      }
      case 'chat.act': {
        await this.startActStream(wsSessionId, session, envelope);
        return;
      }
      case 'chat.cancel': {
        const key = `${wsSessionId}:${envelope.requestId}`;
        const stream = this.activeStreams.get(key);
        stream?.close();
        this.activeStreams.delete(key);
        logger.info('desktop.ws.chat.cancelled', { wsSessionId, requestId: envelope.requestId });
        return;
      }
      case 'local_action.progress': {
        logger.info('desktop.ws.remote_action.progress', {
          wsSessionId,
          dispatchId: envelope.dispatchId,
          eventType: envelope.eventType,
        });
        return;
      }
      case 'local_action.result': {
        const pending = this.pendingDispatches.get(envelope.dispatchId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingDispatches.delete(envelope.dispatchId);
        pending.resolve(envelope.result);
        logger.info('desktop.ws.remote_action.completed', {
          wsSessionId,
          dispatchId: envelope.dispatchId,
          ok: envelope.result.ok,
          kind: envelope.result.kind,
        });
        return;
      }
      default:
        return;
    }
  }

  private async startChatStream(
    wsSessionId: string,
    session: DesktopAgentSession,
    message: Extract<WsEnvelope, { type: 'chat.start' }>,
  ): Promise<void> {
    const stream = this.createStreamAdapter(wsSessionId, message.requestId);
    try {
      await vercelDesktopEngine.stream({
        params: { threadId: message.threadId },
        body: {
          message: message.message ?? '',
          attachedFiles: message.attachedFiles ?? [],
          mode: message.mode ?? 'high',
          workspace: message.workspace ?? undefined,
          approvalPolicySummary: summarizePolicy(session.permissionPolicy),
          workflowInvocation: message.workflowInvocation,
        },
      } as any, stream as any, session.memberSession);
    } finally {
      stream.close();
      this.activeStreams.delete(`${wsSessionId}:${message.requestId}`);
    }
  }

  private async startActStream(
    wsSessionId: string,
    session: DesktopAgentSession,
    message: Extract<WsEnvelope, { type: 'chat.act' }>,
  ): Promise<void> {
    const stream = this.createStreamAdapter(wsSessionId, message.requestId);
    try {
      await vercelDesktopEngine.streamAct({
        params: { threadId: message.threadId },
        body: {
          ...message.payload,
          approvalPolicySummary: summarizePolicy(session.permissionPolicy),
        },
      } as any, stream as any, session.memberSession);
    } finally {
      stream.close();
      this.activeStreams.delete(`${wsSessionId}:${message.requestId}`);
    }
  }

  private createStreamAdapter(wsSessionId: string, requestId: string): StreamResponseAdapter {
    const socket = this.sockets.get(wsSessionId);
    const key = `${wsSessionId}:${requestId}`;
    const stream: StreamResponseAdapter = {
      requestId,
      closed: false,
      buffer: '',
      close: () => {
        stream.closed = true;
      },
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      write: (chunk: string) => {
        if (stream.closed) return;
        stream.buffer += chunk;
        const frames = stream.buffer.split('\n\n');
        stream.buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const raw = frame
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n')
            .trim();
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw) as { type: string; data: unknown };
            this.send(socket, { type: 'chat.event', requestId, event: parsed });
          } catch {
            this.send(socket, {
              type: 'chat.event',
              requestId,
              event: { type: 'error', data: 'Malformed stream event received from backend' },
            });
          }
        }
      },
      end: () => {
        stream.closed = true;
      },
    };
    this.activeStreams.set(key, stream);
    return stream;
  }

  private send(socket: WebSocket | undefined, payload: Record<string, unknown>): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  private listEligibleSessions(userId: string, companyId: string): Array<DesktopAgentSession> {
    const now = Date.now();
    return [...this.sessions.values()].filter((session) =>
      session.userId === userId
      && session.companyId === companyId
      && Boolean(session.activeWorkspace?.path)
      && now - session.lastHeartbeatAt <= HEARTBEAT_STALE_MS);
  }

  getRemoteExecutionAvailability(userId: string, companyId: string): {
    status: 'available' | 'none' | 'ambiguous';
    session?: DesktopAgentSession;
  } {
    const eligible = this.listEligibleSessions(userId, companyId);
    if (eligible.length === 0) return { status: 'none' };
    if (eligible.length > 1) return { status: 'ambiguous' };
    return { status: 'available', session: eligible[0] };
  }

  getPolicyDecision(
    userId: string,
    companyId: string,
    action: RemoteLocalAction,
  ): {
    status: 'allow' | 'ask' | 'deny' | 'none' | 'ambiguous';
    session?: DesktopAgentSession;
  } {
    const availability = this.getRemoteExecutionAvailability(userId, companyId);
    if (availability.status !== 'available' || !availability.session) {
      return { status: availability.status };
    }
    const session = availability.session;
    const decision = session.permissionPolicy?.actions[action.kind]
      ?? actionPolicyGroup(action);
    return { status: decision, session };
  }

  getPolicySummary(userId: string, companyId: string): string | undefined {
    const availability = this.getRemoteExecutionAvailability(userId, companyId);
    if (availability.status !== 'available' || !availability.session) {
      return undefined;
    }
    return summarizePolicy(availability.session.permissionPolicy);
  }

  async dispatchRemoteLocalAction(input: {
    userId: string;
    companyId: string;
    action: RemoteLocalAction;
    reason?: string;
    overrideAsk?: boolean;
  }): Promise<RemoteLocalActionResult> {
    const policy = this.getPolicyDecision(input.userId, input.companyId, input.action);
    if (policy.status === 'none') {
      throw new Error('No active desktop workspace is available for local execution.');
    }
    if (policy.status === 'ambiguous') {
      throw new Error('Multiple desktop workspaces are online; remote execution target is ambiguous.');
    }
    if (policy.status === 'deny') {
      throw new Error('This desktop workspace policy denies the requested local action.');
    }
    if (policy.status === 'ask' && !input.overrideAsk) {
      throw new Error('This desktop workspace requires approval before local execution.');
    }

    const session = policy.session!;
    const socket = this.sockets.get(session.wsSessionId);
    if (!socket) {
      throw new Error('The selected desktop workspace is no longer connected.');
    }

    const dispatchId = crypto.randomUUID();
    const result = new Promise<RemoteLocalActionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingDispatches.delete(dispatchId);
        reject(new Error('Remote local action timed out.'));
      }, STREAM_TIMEOUT_MS);
      this.pendingDispatches.set(dispatchId, {
        wsSessionId: session.wsSessionId,
        userId: input.userId,
        companyId: input.companyId,
        action: input.action,
        resolve,
        reject,
        timeout,
      });
    });

    this.send(socket, {
      type: 'local_action.request',
      dispatchId,
      action: input.action,
      workspace: session.activeWorkspace,
      overrideAsk: Boolean(input.overrideAsk),
      reason: input.reason ?? null,
    });
    logger.info('desktop.ws.remote_action.dispatched', {
      dispatchId,
      wsSessionId: session.wsSessionId,
      userId: input.userId,
      companyId: input.companyId,
      actionKind: input.action.kind,
      workspacePath: session.activeWorkspace?.path ?? null,
      overrideAsk: Boolean(input.overrideAsk),
    });
    return result;
  }

  buildApprovalPendingAction(input: {
    approvalId: string;
    summary: string;
    subject?: string;
  }): PendingApprovalAction {
    return {
      kind: 'tool_action',
      approvalId: input.approvalId,
      scope: 'backend_remote',
      toolId: 'coding',
      actionGroup: 'execute',
      operation: 'remote_local_action',
      title: 'Desktop execution approval required',
      summary: input.summary,
      subject: input.subject,
      payload: {},
    };
  }
}

export const desktopWsGateway = new DesktopWsGateway();
