import { contextBridge, ipcRenderer } from 'electron'

export type DesktopAPI = {
  config: {
    backendUrl: string
  }
  auth: {
    openLarkLogin: () => Promise<void>
    exchangeLark: (code: string, state: string) => Promise<{ success: boolean; data?: { token: string; session: unknown } }>
    me: (token: string) => Promise<{ success: boolean; data?: unknown }>
    logout: (token: string) => Promise<{ success: boolean }>
    unlinkLark: (token: string) => Promise<{ success: boolean }>
    onCallback: (cb: (payload: { code?: string; state?: string; error?: string }) => void) => () => void
  }
  workspace: {
    select: () => Promise<{ canceled: boolean; data?: { id: string; path: string; name: string } }>
    runAction: (
      workspaceRoot: string,
      action:
        | { kind: 'list_files'; path?: string }
        | { kind: 'read_file'; path: string }
        | { kind: 'write_file'; path: string; content: string }
        | { kind: 'mkdir'; path: string }
        | { kind: 'delete_path'; path: string },
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
  }
  terminal: {
    exec: (
      executionId: string,
      command: string,
      cwd: string,
    ) => Promise<{ success: boolean; error?: string }>
    kill: (
      executionId: string,
    ) => Promise<{ success: boolean; error?: string }>
    onEvent: (
      cb: (payload: { executionId: string; event: { type: string; data: unknown } }) => void,
    ) => () => void
  }
  threads: {
    list: (token: string) => Promise<{ success: boolean; data?: unknown[] }>
    get: (token: string, threadId: string) => Promise<{ success: boolean; data?: unknown }>
    create: (token: string) => Promise<{ success: boolean; data?: { id: string } }>
    addMessage: (
      token: string,
      threadId: string,
      payload: { role: string; content: string; metadata?: Record<string, unknown> },
    ) => Promise<{ success: boolean; data?: unknown }>
    delete: (token: string, threadId: string) => Promise<{ success: boolean }>
  }
  chat: {
    send: (
      token: string,
      threadId: string,
      message: string,
    ) => Promise<{ success: boolean; data?: unknown }>
    getStreamUrl: (
      token: string,
      threadId: string,
    ) => Promise<{ url: string; token: string }>
    startStream: (
      token: string,
      threadId: string,
      message: string,
      requestId: string,
    ) => Promise<{ success: boolean }>
    act: (
      token: string,
      threadId: string,
      payload: Record<string, unknown>,
    ) => Promise<{ success: boolean; data?: unknown; message?: string }>
    onStreamEvent: (
      cb: (payload: { requestId: string; event: { type: string; data: unknown } }) => void,
    ) => () => void
  }
  fetch: (
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ status: number; body: string }>
}

const api: DesktopAPI = {
  config: {
    backendUrl: process.env.CURSORR_BACKEND_URL ?? 'http://localhost:8000',
  },
  auth: {
    openLarkLogin: () => ipcRenderer.invoke('desktop-auth:open-lark-login'),
    exchangeLark: (code, state) => ipcRenderer.invoke('desktop-auth:exchange-lark', code, state),
    me: (token) => ipcRenderer.invoke('desktop-auth:me', token),
    logout: (token) => ipcRenderer.invoke('desktop-auth:logout', token),
    unlinkLark: (token) => ipcRenderer.invoke('desktop-auth:unlink-lark', token),
    onCallback: (cb) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { code?: string; state?: string; error?: string },
      ): void => {
        cb(payload)
      }
      ipcRenderer.on('desktop-auth:callback', handler)
      return () => {
        ipcRenderer.removeListener('desktop-auth:callback', handler)
      }
    },
  },
  workspace: {
    select: () => ipcRenderer.invoke('desktop:workspace:select'),
    runAction: (workspaceRoot, action) =>
      ipcRenderer.invoke('desktop:workspace:run-action', workspaceRoot, action),
  },
  terminal: {
    exec: (executionId, command, cwd) =>
      ipcRenderer.invoke('desktop:terminal:exec', executionId, command, cwd),
    kill: (executionId) =>
      ipcRenderer.invoke('desktop:terminal:kill', executionId),
    onEvent: (cb) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { executionId: string; event: { type: string; data: unknown } },
      ): void => {
        cb(payload)
      }
      ipcRenderer.on('desktop:terminal:event', handler)
      return () => {
        ipcRenderer.removeListener('desktop:terminal:event', handler)
      }
    },
  },
  threads: {
    list: (token) => ipcRenderer.invoke('desktop:threads', token),
    get: (token, threadId) => ipcRenderer.invoke('desktop:thread', token, threadId),
    create: (token) => ipcRenderer.invoke('desktop:thread:create', token),
    addMessage: (token, threadId, payload) =>
      ipcRenderer.invoke('desktop:thread:add-message', token, threadId, payload),
    delete: (token, threadId) => ipcRenderer.invoke('desktop:thread:delete', token, threadId),
  },
  chat: {
    send: (token, threadId, message) =>
      ipcRenderer.invoke('desktop:chat:send', token, threadId, message),
    getStreamUrl: (token, threadId) =>
      ipcRenderer.invoke('desktop:chat:stream-url', token, threadId),
    startStream: (token, threadId, message, requestId) =>
      ipcRenderer.invoke('desktop:chat:start-stream', token, threadId, message, requestId),
    act: (token, threadId, payload) =>
      ipcRenderer.invoke('desktop:chat:act', token, threadId, payload),
    onStreamEvent: (cb) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { requestId: string; event: { type: string; data: unknown } },
      ): void => {
        cb(payload)
      }
      ipcRenderer.on('desktop:chat:event', handler)
      return () => {
        ipcRenderer.removeListener('desktop:chat:event', handler)
      }
    },
  },
  fetch: (url, options = {}) => ipcRenderer.invoke('desktop:fetch', url, options),
}

contextBridge.exposeInMainWorld('desktopAPI', api)
