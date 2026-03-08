import { contextBridge, ipcRenderer } from 'electron'

export type DesktopAPI = {
  config: {
    backendUrl: string
  }
  auth: {
    login: (email: string, password: string) => Promise<{ success: boolean; data?: { token: string; session: unknown } }>
    openLogin: () => Promise<void>
    exchange: (code: string) => Promise<{ success: boolean; data?: { token: string; session: unknown } }>
    me: (token: string) => Promise<{ success: boolean; data?: unknown }>
    logout: (token: string) => Promise<{ success: boolean }>
    onCallback: (cb: (payload: { code: string }) => void) => () => void
  }
  threads: {
    list: (token: string) => Promise<{ success: boolean; data?: unknown[] }>
    get: (token: string, threadId: string) => Promise<{ success: boolean; data?: unknown }>
    create: (token: string) => Promise<{ success: boolean; data?: { id: string } }>
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
    login: (email, password) => ipcRenderer.invoke('desktop-auth:login', email, password),
    openLogin: () => ipcRenderer.invoke('desktop-auth:open-login'),
    exchange: (code) => ipcRenderer.invoke('desktop-auth:exchange', code),
    me: (token) => ipcRenderer.invoke('desktop-auth:me', token),
    logout: (token) => ipcRenderer.invoke('desktop-auth:logout', token),
    onCallback: (cb) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { code: string }): void => {
        cb(payload)
      }
      ipcRenderer.on('desktop-auth:callback', handler)
      return () => {
        ipcRenderer.removeListener('desktop-auth:callback', handler)
      }
    },
  },
  threads: {
    list: (token) => ipcRenderer.invoke('desktop:threads', token),
    get: (token, threadId) => ipcRenderer.invoke('desktop:thread', token, threadId),
    create: (token) => ipcRenderer.invoke('desktop:thread:create', token),
    delete: (token, threadId) => ipcRenderer.invoke('desktop:thread:delete', token, threadId),
  },
  chat: {
    send: (token, threadId, message) =>
      ipcRenderer.invoke('desktop:chat:send', token, threadId, message),
    getStreamUrl: (token, threadId) =>
      ipcRenderer.invoke('desktop:chat:stream-url', token, threadId),
    startStream: (token, threadId, message, requestId) =>
      ipcRenderer.invoke('desktop:chat:start-stream', token, threadId, message, requestId),
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
