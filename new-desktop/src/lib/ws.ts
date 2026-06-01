import { WS_BASE } from './config';
import type { StatusEvent } from '@/types/status-events';

export type WsState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface DesktopWsClientOptions {
  token: string;
  onEvent: (event: StatusEvent) => void;
  onStateChange?: (state: WsState) => void;
  /** Fired when the socket drops unexpectedly (not an intentional close). */
  onInterrupted?: () => void;
}

export interface DesktopChatStartRequest {
  type: 'chat.start';
  requestId: string;
  threadId: string;
  message: string;
  mode?: 'fast' | 'high';
  workspace?: { name: string; path: string } | null;
}

interface BackendPlanStep {
  status: string;
  title: string;
  subtitle?: string;
  toolFamily?: string;
}

type BackendChatEvent =
  | { type: 'text'; data: string }
  | {
      type: 'done';
      data: {
        message: {
          id: string;
          threadId: string;
          role: string;
          content: string;
          createdAt: string;
        };
      };
    }
  | { type: 'error'; data: string }
  | { type: 'plan'; steps: BackendPlanStep[] }
  | { type: 'thinking'; text: string }
  | { type: 'tool.start'; callId: string; name: string; family: string; args: unknown; verb?: string }
  | {
      type: 'tool.end';
      callId: string;
      name: string;
      ok: boolean;
      output: string;
      durationMs: number;
      past?: string;
    }
  | { type: 'terminal.exec.request'; callId: string; command: string; cwd: string; net: boolean; timeoutMs?: number };

type BackendServerEvent =
  | { type: 'session.ready'; wsSessionId: string; userId: string; companyId: string }
  | { type: 'session.heartbeat'; ts: number }
  | { type: 'chat.event'; requestId: string; event: BackendChatEvent };

interface PendingRequest {
  threadId: string;
  assistantMessageId: string;
  started: boolean;
  startedAt: string;
}

/**
 * WebSocket client for the desktop streaming gateway. The backend route is
 * being built in advance-backend/src/http/desktop/desktop-ws.gateway.ts. This
 * client follows the contract documented in our mock:
 *  - JWT in the `?token=...` query string (Tauri-friendly, no header support)
 *  - Server listens on `/ws/desktop`
 *  - Client sends backend-native `chat.start` payloads
 *  - Server emits wrapped `chat.event` payloads, which this client adapts into
 *    the renderer StatusEvent shape.
 */
export class DesktopWsClient {
  private ws: WebSocket | null = null;
  private state: WsState = 'idle';
  private retryCount = 0;
  private heartbeatTimer: number | null = null;
  private sequence = 0;
  private pending = new Map<string, PendingRequest>();
  /** Set when we intentionally close — prevents the socket's close handler from auto-reconnecting a dead client. */
  private intentionalClose = false;

  constructor(private opts: DesktopWsClientOptions) {}

  connect() {
    if (this.ws && this.state !== 'closed' && this.state !== 'error') return;
    this.intentionalClose = false;
    this.setState('connecting');

    const url = new URL(`${WS_BASE}/ws/desktop`);
    url.searchParams.set('token', this.opts.token);

    const ws = new WebSocket(url.toString());
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retryCount = 0;
      this.setState('open');
      this.startHeartbeat();
    });
    ws.addEventListener('message', (evt) => {
      try {
        const parsed = JSON.parse(evt.data as string) as BackendServerEvent;
        this.handleServerEvent(parsed);
      } catch {
        // ignore malformed payloads
      }
    });
    ws.addEventListener('close', () => {
      this.stopHeartbeat();
      this.setState('closed');
      // Don't resurrect a client we closed on purpose (e.g. React unmount).
      if (!this.intentionalClose) {
        this.opts.onInterrupted?.();
        this.scheduleReconnect();
      }
    });
    ws.addEventListener('error', () => {
      this.setState('error');
    });
  }

  send(payload: DesktopChatStartRequest | { type: 'cancel'; threadId: string }) {
    if (!this.ws || this.state !== 'open') return false;
    if (payload.type === 'chat.start') {
      this.pending.set(payload.requestId, {
        threadId: payload.threadId,
        assistantMessageId: `assistant-${payload.requestId}`,
        started: false,
        startedAt: new Date().toISOString(),
      });
    }
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  sendTerminalResult(
    threadId: string,
    result: {
      callId: string;
      status: 'completed' | 'declined' | 'blocked' | 'unavailable';
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      durationMs?: number;
      timedOut?: boolean;
      message?: string;
    },
  ): boolean {
    if (!this.ws || this.state !== 'open') return false;
    this.ws.send(JSON.stringify({ type: 'terminal.exec.result', threadId, ...result }));
    return true;
  }

  close() {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private setState(s: WsState) {
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws && this.state === 'open') {
        this.ws.send(JSON.stringify({ type: 'session.heartbeat' }));
      }
    }, 30_000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.retryCount >= 6) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.retryCount);
    this.retryCount += 1;
    window.setTimeout(() => this.connect(), delay);
  }

  private handleServerEvent(event: BackendServerEvent) {
    if (event.type !== 'chat.event') return;

    const pending = this.pending.get(event.requestId);
    const threadId = pending?.threadId
      ?? (event.event.type === 'done' ? event.event.data.message.threadId : undefined);
    if (!threadId) return;

    const assistantMessageId = pending?.assistantMessageId ?? `assistant-${event.requestId}`;
    const now = new Date().toISOString();

    const ensureStarted = () => {
      const current = this.pending.get(event.requestId);
      if (current?.started) return;
      this.pending.set(event.requestId, {
        threadId,
        assistantMessageId,
        started: true,
        startedAt: current?.startedAt ?? now,
      });
      this.emit({
        kind: 'message.started',
        threadId,
        runId: event.requestId,
        sequence: this.nextSequence(),
        at: current?.startedAt ?? now,
        messageId: assistantMessageId,
      });
    };

    if (event.event.type === 'text') {
      ensureStarted();
      this.emit({
        kind: 'message.delta',
        threadId,
        runId: event.requestId,
        sequence: this.nextSequence(),
        at: now,
        messageId: assistantMessageId,
        delta: event.event.data,
      });
      return;
    }

    if (event.event.type === 'plan') {
      ensureStarted();
      this.emit({
        kind: 'plan',
        threadId,
        runId: event.requestId,
        sequence: this.nextSequence(),
        at: now,
        summary: '',
        steps: event.event.steps.map(s => ({
          status: normalizePlanStatus(s.status),
          title: s.title,
          ...(s.subtitle ? { subtitle: s.subtitle } : {}),
          ...(s.toolFamily ? { toolFamily: s.toolFamily } : {}),
        })),
      });
      return;
    }

    if (event.event.type === 'thinking') {
      ensureStarted();
      this.emit({
        kind: 'thinking',
        threadId,
        runId: event.requestId,
        sequence: this.nextSequence(),
        at: now,
        message: event.event.text,
      });
      return;
    }

    if (event.event.type === 'tool.start') {
      ensureStarted();
      this.emit({
        kind: 'tool.start',
        threadId,
        runId: event.requestId,
        sequence: this.nextSequence(),
        at: now,
        toolCallId: event.event.callId,
        toolName: event.event.name,
        family: event.event.family,
        args: isPlainRecord(event.event.args) ? event.event.args : { value: event.event.args },
        ...(event.event.verb ? { verb: event.event.verb } : {}),
      });
      return;
    }

    if (event.event.type === 'tool.end') {
      ensureStarted();
      if (event.event.ok) {
        this.emit({
          kind: 'tool.done',
          threadId,
          runId: event.requestId,
          sequence: this.nextSequence(),
          at: now,
          toolCallId: event.event.callId,
          summary: shortToolSummary(event.event.name, event.event.output),
          durationMs: event.event.durationMs,
          outputPreview: event.event.output,
          ...(event.event.past ? { past: event.event.past } : {}),
        });
      } else {
        this.emit({
          kind: 'tool.error',
          threadId,
          runId: event.requestId,
          sequence: this.nextSequence(),
          at: now,
          toolCallId: event.event.callId,
          error: { code: 'TOOL_ERROR', message: event.event.output },
        });
      }
      return;
    }

    if (event.event.type === 'terminal.exec.request') {
      ensureStarted();
      this.emit({
        kind: 'terminal.request', threadId, runId: event.requestId, sequence: this.nextSequence(), at: now,
        callId: event.event.callId, command: event.event.command, cwd: event.event.cwd, net: event.event.net,
        ...(event.event.timeoutMs ? { timeoutMs: event.event.timeoutMs } : {}),
      });
      return;
    }

    if (event.event.type === 'done') {
      ensureStarted();
      this.emit({
        kind: 'message.completed',
        threadId,
        runId: event.requestId,
        sequence: this.nextSequence(),
        at: event.event.data.message.createdAt,
        messageId: assistantMessageId,
        content: event.event.data.message.content,
      });
      this.emit({
        kind: 'run.completed',
        threadId,
        runId: event.requestId,
        sequence: this.nextSequence(),
        at: new Date().toISOString(),
        durationMs: 0,
        toolsUsed: 0,
      });
      this.pending.delete(event.requestId);
      return;
    }

    ensureStarted();
    this.emit({
      kind: 'run.failed',
      threadId,
      runId: event.requestId,
      sequence: this.nextSequence(),
      at: now,
      error: { code: 'DESKTOP_CHAT_ERROR', message: event.event.data },
    });
    this.pending.delete(event.requestId);
  }

  private emit(event: StatusEvent) {
    this.opts.onEvent(event);
  }

  private nextSequence() {
    this.sequence += 1;
    return this.sequence;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePlanStatus(raw: string): 'pending' | 'running' | 'done' | 'failed' | 'skipped' {
  switch (raw) {
    case 'pending':
    case 'running':
    case 'done':
    case 'failed':
    case 'skipped':
      return raw;
    default:
      return 'pending';
  }
}

function shortToolSummary(name: string, output: string): string {
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray((parsed as { data?: unknown[] }).data)) {
        const len = (parsed as { data: unknown[] }).data.length;
        return `${name} · ${len} result${len === 1 ? '' : 's'}`;
      }
      if (typeof (parsed as { message?: unknown }).message === 'string') {
        return (parsed as { message: string }).message.slice(0, 80);
      }
    }
  } catch {
    /* fall through */
  }
  const trimmed = output.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed || name;
}
