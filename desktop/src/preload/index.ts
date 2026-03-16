import { contextBridge, ipcRenderer } from 'electron'

export type DesktopAPI = {
  config: {
    backendUrl: string
  }
  auth: {
    openLarkLogin: () => Promise<void>
    exchangeLark: (code: string, state: string) => Promise<{ success: boolean; data?: { token: string; session: unknown } }>
    me: (token: string) => Promise<{ success: boolean; data?: unknown }>
    getUsage: (token: string) => Promise<{ success: boolean; data?: unknown }>
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
    get: (
      token: string,
      threadId: string,
      options?: { limit?: number; beforeMessageId?: string },
    ) => Promise<{ success: boolean; data?: unknown }>
    create: (
      token: string,
      payload?: { preferredEngine?: 'mastra' | 'langgraph' },
    ) => Promise<{ success: boolean; data?: { id: string } }>
    updatePreferences: (
      token: string,
      threadId: string,
      payload: { preferredEngine: 'mastra' | 'langgraph' },
    ) => Promise<{ success: boolean; data?: unknown }>
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
      attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>,
      mode?: 'fast' | 'high' | 'xtreme',
      engine?: 'mastra' | 'langgraph',
      workspace?: { name: string; path: string },
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    sendMessageStream: (payload: {
      token: string
      requestId: string
      threadId: string
      message: string
      attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>
      mode?: 'fast' | 'high' | 'xtreme'
      engine?: 'mastra' | 'langgraph'
      workspace?: { name: string; path: string }
      companyId?: string
    }) => Promise<{ success: boolean; data?: unknown; error?: string }>
    actStream: (payload: {
      token: string
      requestId: string
      executionId: string
      threadId: string
      message?: string
      workspace: { name: string; path: string }
      actionResult?: Record<string, unknown>
      plan?: unknown
      mode?: 'fast' | 'high' | 'xtreme'
      engine?: 'mastra' | 'langgraph'
    }) => Promise<{ success: boolean; data?: unknown; error?: string }>
    stopStream: (
      requestId: string,
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    act: (
      token: string,
      threadId: string,
      payload: Record<string, unknown>,
    ) => Promise<{ success: boolean; data?: unknown; message?: string }>
    share: (
      token: string,
      threadId: string,
      reason?: string,
    ) => Promise<{ success: boolean; data?: unknown }>
    onStreamEvent: (
      cb: (payload: { requestId: string; event: { type: string; data: unknown } }) => void,
    ) => () => void
  }
  fetch: (
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ status: number; body: string }>
  files: {
    upload: (
      token: string,
      fileBuffer: ArrayBuffer,
      fileName: string,
      mimeType: string,
    ) => Promise<{ success: boolean; status: number; data: unknown }>
    list: (token: string) => Promise<{ success: boolean; data: unknown }>
    share: (token: string, fileId: string, reason?: string) => Promise<{ success: boolean; data?: unknown }>
    delete: (token: string, fileId: string) => Promise<{ success: boolean; data?: unknown }>
    retry: (token: string, fileId: string) => Promise<{ success: boolean; data?: unknown }>
  }
}

const api: DesktopAPI = {
  config: {
    backendUrl: process.env.CURSORR_BACKEND_URL ?? 'http://localhost:8000',
  },
  auth: {
    openLarkLogin: () => ipcRenderer.invoke('desktop-auth:open-lark-login'),
    exchangeLark: (code, state) => ipcRenderer.invoke('desktop-auth:exchange-lark', code, state),
    me: (token) => ipcRenderer.invoke('desktop-auth:me', token),
    getUsage: (token) => ipcRenderer.invoke('desktop-auth:usage', token),
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
    get: (token, threadId, options) => ipcRenderer.invoke('desktop:thread', token, threadId, options),
    create: (token, payload) => ipcRenderer.invoke('desktop:thread:create', token, payload),
    updatePreferences: (token, threadId, payload) =>
      ipcRenderer.invoke('desktop:thread:update-preferences', token, threadId, payload),
    addMessage: (token, threadId, payload) =>
      ipcRenderer.invoke('desktop:thread:add-message', token, threadId, payload),
    delete: (token, threadId) => ipcRenderer.invoke('desktop:thread:delete', token, threadId),
  },
  chat: {
    send: (token, threadId, message) =>
      ipcRenderer.invoke('desktop:chat:send', token, threadId, message),
    getStreamUrl: (token, threadId) =>
      ipcRenderer.invoke('desktop:chat:stream-url', token, threadId),
    startStream: (token, threadId, message, requestId, attachedFiles, mode, engine, workspace) =>
      ipcRenderer.invoke('desktop:chat:startStream', token, threadId, message, requestId, attachedFiles, mode, engine, workspace),
    sendMessageStream: (payload) =>
      ipcRenderer.invoke('desktop:chat:sendMessageStream', payload),
    actStream: (payload) =>
      ipcRenderer.invoke('desktop:chat:actStream', payload),
    stopStream: (requestId) =>
      ipcRenderer.invoke('desktop:chat:stopStream', requestId),
    act: (token, threadId, payload) =>
      ipcRenderer.invoke('desktop:chat:act', token, threadId, payload),
    share: (token, threadId, reason) =>
      ipcRenderer.invoke('desktop:chat:share', token, threadId, reason),
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
  files: {
    upload: (token, fileBuffer, fileName, mimeType) =>
      ipcRenderer.invoke('desktop:files:upload', token, fileBuffer, fileName, mimeType),
    list: (token) =>
      ipcRenderer.invoke('desktop:files:list', token),
    share: (token, fileId, reason) =>
      ipcRenderer.invoke('desktop:files:share', token, fileId, reason),
    delete: (token, fileId) =>
      ipcRenderer.invoke('desktop:files:delete', token, fileId),
    retry: (token, fileId) =>
      ipcRenderer.invoke('desktop:files:retry', token, fileId),
  },
}

contextBridge.exposeInMainWorld('desktopAPI', api)
