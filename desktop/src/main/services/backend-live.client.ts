import { BrowserWindow, app } from 'electron'
import { WebSocket, type RawData } from 'ws'

import { readRuntimeConfig } from '../../shared/runtime-config'
import { executeTerminalCommand } from './local-terminal'
import { getWorkspacePolicy, type DesktopWorkspacePolicy } from './desktop-remote-policy'
import { runWorkspaceAction, type WorkspaceAction } from './workspace-actions'

type DesktopWorkspaceSnapshot = { name: string; path: string }

type RemoteLocalAction =
  | { kind: 'list_files'; path?: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete_path'; path: string }
  | { kind: 'run_command'; command: string }

type BackendMessage =
  | {
    type: 'chat.event';
    requestId: string;
    event: { type: string; data: unknown };
  }
  | {
    type: 'local_action.request';
    dispatchId: string;
    action: RemoteLocalAction;
    workspace?: DesktopWorkspaceSnapshot | null;
    overrideAsk?: boolean;
    reason?: string | null;
  }
  | {
    type: 'session.ready';
    wsSessionId: string;
    userId: string;
    companyId: string;
  }
  | {
    type: 'execution.error';
    message: string;
  }

type OutboundMessage =
  | {
    type: 'session.hello' | 'session.heartbeat' | 'workspace.status';
    deviceLabel?: string;
    capabilities?: string[];
    workspace?: DesktopWorkspaceSnapshot | null;
    permissionPolicy?: DesktopWorkspacePolicy | null;
  }
  | {
    type: 'chat.start';
    requestId: string;
    threadId: string;
    message: string;
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
    result: {
      kind: RemoteLocalAction['kind'];
      ok: boolean;
      summary: string;
      payload?: Record<string, unknown>;
    };
  }

class BackendLiveClient {
  private static readonly HEARTBEAT_INTERVAL_MS = 15_000

  private socket: WebSocket | null = null

  private connectPromise: Promise<void> | null = null

  private token: string | null = null

  private workspace: DesktopWorkspaceSnapshot | null = null

  private reconnectTimer: NodeJS.Timeout | null = null

  private wsSessionId: string | null = null

  private heartbeatTimer: NodeJS.Timeout | null = null

  private getMainWindow: (() => BrowserWindow | null) | null = null

  setMainWindowGetter(getter: () => BrowserWindow | null): void {
    this.getMainWindow = getter
  }

  private emitToRenderer(channel: string, payload: unknown): void {
    const window = this.getMainWindow?.()
    if (!window || window.isDestroyed()) {
      return
    }

    const { webContents } = window
    if (!webContents || webContents.isDestroyed()) {
      return
    }

    try {
      webContents.send(channel, payload)
    } catch (error) {
      console.warn('[desktop:live] failed to emit IPC event', {
        channel,
        error: error instanceof Error ? error.message : 'unknown_error',
      })
    }
  }

  async ensureConnected(token: string, workspace?: DesktopWorkspaceSnapshot | null): Promise<void> {
    this.token = token
    this.workspace = workspace ?? this.workspace
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      await this.sendPresence('workspace.status')
      return
    }
    await this.connect()
  }

  async updateWorkspace(workspace?: DesktopWorkspaceSnapshot | null): Promise<void> {
    this.workspace = workspace ?? null
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      await this.sendPresence('workspace.status')
    }
  }

  disconnect(): void {
    this.token = null
    this.wsSessionId = null
    this.stopHeartbeat()
    this.connectPromise = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      const socket = this.socket
      this.socket = null
      try {
        socket.close()
      } catch {
        // ignore close errors during logout/shutdown
      }
    }
  }

  async startChatStream(input: {
    token: string;
    requestId: string;
    threadId: string;
    message: string;
    attachedFiles?: Array<Record<string, unknown>>;
    mode?: 'fast' | 'high';
    workspace?: DesktopWorkspaceSnapshot | null;
    workflowInvocation?: {
      workflowId: string;
      workflowName?: string;
      overrideText?: string;
    };
  }): Promise<{ success: boolean; error?: string }> {
    await this.ensureConnected(input.token, input.workspace)
    return this.send({
      type: 'chat.start',
      requestId: input.requestId,
      threadId: input.threadId,
      message: input.message,
      attachedFiles: input.attachedFiles,
      mode: input.mode,
      workspace: input.workspace ?? null,
      workflowInvocation: input.workflowInvocation,
    })
  }

  async startActStream(input: {
    token: string;
    requestId: string;
    threadId: string;
    payload: Record<string, unknown>;
    workspace?: DesktopWorkspaceSnapshot | null;
  }): Promise<{ success: boolean; error?: string }> {
    await this.ensureConnected(input.token, input.workspace)
    return this.send({
      type: 'chat.act',
      requestId: input.requestId,
      threadId: input.threadId,
      payload: input.payload,
      workspace: input.workspace ?? null,
    })
  }

  async cancelStream(requestId: string): Promise<{ success: boolean; error?: string }> {
    return this.send({
      type: 'chat.cancel',
      requestId,
    })
  }

  private async connect(): Promise<void> {
    if (this.connectPromise) {
      await this.connectPromise
      return
    }

    this.connectPromise = this.openSocket()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  private describeConnectionError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message.trim()
    }
    if (typeof error === 'string' && error.trim()) {
      return error.trim()
    }
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>
      const message = typeof record.message === 'string' ? record.message.trim() : ''
      if (message) {
        return message
      }
      const code = typeof record.code === 'string' ? record.code.trim() : ''
      if (code) {
        return code
      }
      const type = typeof record.type === 'string' ? record.type.trim() : ''
      if (type) {
        return type
      }
      try {
        return JSON.stringify(record)
      } catch {
        return 'unknown_error'
      }
    }
    return 'unknown_error'
  }

  private async openSocket(): Promise<void> {
    const runtimeConfig = readRuntimeConfig()
    const backendUrl = runtimeConfig.backendUrl.trim()
    if (!backendUrl || !this.token) {
      throw new Error('Desktop live backend configuration is missing')
    }
    const wsUrl = backendUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') + '/ws/desktop'
    const socket = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    })
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      let settled = false

      const cleanup = (): void => {
        socket.off('open', onOpen)
        socket.off('error', onError)
        socket.off('close', onClose)
        socket.off('unexpected-response', onUnexpectedResponse)
      }

      const fail = (reason: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        if (this.socket === socket) {
          this.socket = null
        }
        try {
          socket.terminate()
        } catch {
          // ignore cleanup failures
        }
        reject(new Error(this.describeConnectionError(reason)))
      }

      const onOpen = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }

      const onError = (error: Error): void => {
        fail(error)
      }

      const onClose = (code: number, reason: Buffer): void => {
        const reasonText = reason.toString('utf8').trim()
        fail(reasonText || `socket_closed_${code}`)
      }

      const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number; statusMessage?: string }): void => {
        const status = typeof response.statusCode === 'number' ? response.statusCode : 'unknown'
        const statusMessage = typeof response.statusMessage === 'string' && response.statusMessage.trim()
          ? ` ${response.statusMessage.trim()}`
          : ''
        fail(`unexpected_response_${String(status)}${statusMessage}`)
      }

      socket.once('open', onOpen)
      socket.once('error', onError)
      socket.once('close', onClose)
      socket.once('unexpected-response', onUnexpectedResponse)
    })

    socket.on('message', (raw: RawData) => {
      this.handleBackendMessage(raw.toString('utf8')).catch((error) => {
        console.error('[desktop:live] failed to handle backend message', error)
      })
    })
    socket.on('close', () => {
      this.wsSessionId = null
      this.stopHeartbeat()
      if (this.socket === socket) {
        this.socket = null
      }
      this.scheduleReconnect()
    })
    socket.on('error', (error: Error) => {
      console.warn('[desktop:live] socket error', {
        error: error.message,
      })
    })

    await this.sendPresence('session.hello')
    this.startHeartbeat()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.token) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect().catch((error) => {
        console.warn('[desktop:live] reconnect failed', {
          error: error instanceof Error ? error.message : 'unknown_error',
        })
        this.scheduleReconnect()
      })
    }, 2000)
  }

  private async sendPresence(type: 'session.hello' | 'session.heartbeat' | 'workspace.status'): Promise<void> {
    const permissionPolicy = await getWorkspacePolicy(this.workspace?.path ?? null)
    await this.send({
      type,
      deviceLabel: `${app.getName()} ${process.platform}`,
      capabilities: ['chat_stream', 'remote_local_actions'],
      workspace: this.workspace,
      permissionPolicy,
    })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      void this.sendPresence('session.heartbeat').catch((error) => {
        console.error('[desktop:live] heartbeat failed', error)
      })
    }, BackendLiveClient.HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private async handleBackendMessage(raw: string): Promise<void> {
    const message = JSON.parse(raw) as BackendMessage
    if (message.type === 'session.ready') {
      this.wsSessionId = message.wsSessionId
      return
    }

    if (message.type === 'chat.event') {
      this.emitToRenderer('desktop:chat:event', {
        requestId: message.requestId,
        event: message.event,
      })
      return
    }

    if (message.type === 'execution.error') {
      this.emitToRenderer('desktop:chat:event', {
        requestId: 'system',
        event: { type: 'error', data: message.message },
      })
      return
    }

    if (message.type === 'local_action.request') {
      await this.executeRemoteLocalAction(message.dispatchId, message.action, message.workspace ?? this.workspace)
    }
  }

  private async executeRemoteLocalAction(
    dispatchId: string,
    action: RemoteLocalAction,
    workspace: DesktopWorkspaceSnapshot | null,
  ): Promise<void> {
    if (!workspace?.path) {
      await this.send({
        type: 'local_action.result',
        dispatchId,
        result: {
          kind: action.kind,
          ok: false,
          summary: 'No active desktop workspace is available for remote local execution.',
        },
      })
      return
    }

    if (action.kind === 'run_command') {
      const execId = dispatchId
      let resultSent = false
      let capturedStdout = ''
      let capturedStderr = ''
      const appendOutput = (current: string, chunk: string): string => {
        const next = `${current}${chunk}`
        return next.length > 8000 ? next.slice(-8000) : next
      }
      const sendResult = async (result: {
        kind: RemoteLocalAction['kind'];
        ok: boolean;
        summary: string;
        payload?: Record<string, unknown>;
      }): Promise<void> => {
        if (resultSent) return
        resultSent = true
        await this.send({
          type: 'local_action.result',
          dispatchId,
          result,
        })
      }
      const result = await executeTerminalCommand(execId, action.command, workspace.path, async (event) => {
        this.emitToRenderer('desktop:terminal:event', {
          executionId: execId,
          event,
        })
        await this.send({
          type: 'local_action.progress',
          dispatchId,
          eventType: event.type,
          data: event.data,
        })
        if (event.type === 'stdout') {
          capturedStdout = appendOutput(capturedStdout, event.data)
        }
        if (event.type === 'stderr') {
          capturedStderr = appendOutput(capturedStderr, event.data)
        }
        if (event.type === 'exit') {
          await sendResult({
            kind: 'run_command',
            ok: event.data.exitCode === 0,
            summary: event.data.exitCode === 0
              ? `Command completed successfully: ${action.command}`
              : `Command failed with exit code ${String(event.data.exitCode)}: ${action.command}`,
            payload: {
              exitCode: event.data.exitCode,
              signal: event.data.signal,
              cwd: workspace.path,
              command: action.command,
              stdout: capturedStdout.trim() || undefined,
              stderr: capturedStderr.trim() || undefined,
            },
          })
        }
        if (event.type === 'error') {
          await sendResult({
            kind: 'run_command',
            ok: false,
            summary: `Command execution failed: ${event.data.message}`,
            payload: {
              cwd: workspace.path,
              command: action.command,
              stdout: capturedStdout.trim() || undefined,
              stderr: capturedStderr.trim() || undefined,
              error: event.data.message,
            },
          })
        }
      })
      if (!result.success) {
        await sendResult({
          kind: 'run_command',
          ok: false,
          summary: result.error ?? 'Command execution failed',
          payload: {
            cwd: workspace.path,
            command: action.command,
            stdout: capturedStdout.trim() || undefined,
            stderr: capturedStderr.trim() || undefined,
            error: result.error,
          },
        })
      }
      return
    }

    const workspaceResult = await runWorkspaceAction(workspace.path, action as WorkspaceAction)
    await this.send({
      type: 'local_action.result',
      dispatchId,
      result: {
        kind: action.kind,
        ok: workspaceResult.success,
        summary: workspaceResult.success
          ? `Workspace action completed: ${action.kind}`
          : (workspaceResult.error ?? `Workspace action failed: ${action.kind}`),
        payload: workspaceResult.success
          ? (workspaceResult.data as Record<string, unknown> | undefined)
          : { error: workspaceResult.error, workspacePath: workspace.path },
      },
    })
  }

  private async send(message: OutboundMessage): Promise<{ success: boolean; error?: string }> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return { success: false, error: 'Desktop live socket is not connected' }
    }
    try {
      this.socket.send(JSON.stringify(message))
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Desktop live socket send failed',
      }
    }
  }
}

export const backendLiveClient = new BackendLiveClient()
