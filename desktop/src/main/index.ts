import { app, shell, BrowserWindow, ipcMain, protocol, net } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { URL } from 'url'

const PROTOCOL_SCHEME = 'cursorr'
const BACKEND_URL = process.env.CURSORR_BACKEND_URL ?? 'http://localhost:8000'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/* ─── Custom protocol registration ─── */
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
      '--',
      process.argv[1],
    ])
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME)
}

/* ─── Single instance lock ─── */
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    const deepLink = commandLine.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`))
    if (deepLink) handleDeepLink(deepLink)
  })
}

/* ─── macOS open-url ─── */
app.on('open-url', (_event, url) => {
  handleDeepLink(url)
})

function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'auth' && parsed.pathname === '/callback') {
      const code = parsed.searchParams.get('code')
      if (code && mainWindow) {
        mainWindow.webContents.send('desktop-auth:callback', { code })
      }
    }
  } catch {
    // ignore malformed URLs
  }
}

/* ─── IPC handlers ─── */

// Auth: direct email+password login
ipcMain.handle('desktop-auth:login', async (_event, email: string, password: string) => {
  const res = await net.fetch(`${BACKEND_URL}/api/member/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return res.json()
})

// Auth: exchange handoff code for desktop session
ipcMain.handle('desktop-auth:exchange', async (_event, code: string) => {
  const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  return res.json()
})

// Auth: validate session
ipcMain.handle('desktop-auth:me', async (_event, token: string) => {
  const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.json()
})

// Auth: logout
ipcMain.handle('desktop-auth:logout', async (_event, token: string) => {
  const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.json()
})

// Auth: open browser login
ipcMain.handle('desktop-auth:open-login', async () => {
  const webAppUrl = process.env.CURSORR_WEB_APP_URL ?? 'http://localhost:5173'
  shell.openExternal(`${webAppUrl}/desktop-login?desktop=true`)
})

// Threads: list
ipcMain.handle('desktop:threads', async (_event, token: string) => {
  const res = await net.fetch(`${BACKEND_URL}/api/desktop/threads`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.json()
})

// Threads: get one
ipcMain.handle('desktop:thread', async (_event, token: string, threadId: string) => {
  const res = await net.fetch(`${BACKEND_URL}/api/desktop/threads/${threadId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.json()
})

// Threads: create
ipcMain.handle('desktop:thread:create', async (_event, token: string) => {
  const res = await net.fetch(`${BACKEND_URL}/api/desktop/threads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  return res.json()
})

// Threads: delete
ipcMain.handle('desktop:thread:delete', async (_event, token: string, threadId: string) => {
  const res = await net.fetch(`${BACKEND_URL}/api/desktop/threads/${threadId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  return { success: res.ok }
})

// Chat: send message (returns stream URL info)
ipcMain.handle(
  'desktop:chat:send',
  async (_event, token: string, threadId: string, message: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/chat/${threadId}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    return res.json()
  },
)

ipcMain.handle(
  'desktop:chat:start-stream',
  async (event, token: string, threadId: string, message: string, requestId: string) => {
    const target = event.sender
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/chat/${threadId}/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ message }),
    })

    if (!res.ok || !res.body) {
      const bodyText = await res.text()
      target.send('desktop:chat:event', {
        requestId,
        event: {
          type: 'error',
          data: bodyText || `Chat stream failed (${res.status})`,
        },
      })
      return { success: false }
    }

    ; (async () => {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''

          for (const frame of frames) {
            const dataLines = frame
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))

            if (dataLines.length === 0) continue
            const raw = dataLines.join('\n').trim()
            if (!raw) continue

            try {
              const parsed = JSON.parse(raw) as { type: string; data: unknown }
              target.send('desktop:chat:event', { requestId, event: parsed })
            } catch {
              target.send('desktop:chat:event', {
                requestId,
                event: { type: 'error', data: 'Malformed stream event received from backend' },
              })
            }
          }
        }

        const trailing = buffer.trim()
        if (trailing.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trailing.slice(6).trim()) as { type: string; data: unknown }
            target.send('desktop:chat:event', { requestId, event: parsed })
          } catch {
            // ignore final malformed fragment
          }
        }
      } catch (error) {
        target.send('desktop:chat:event', {
          requestId,
          event: {
            type: 'error',
            data: error instanceof Error ? error.message : 'Desktop stream failed',
          },
        })
      }
    })()

    return { success: true }
  },
)

// Chat: stream — returns a unique stream URL that the renderer fetches via SSE
ipcMain.handle(
  'desktop:chat:stream-url',
  (_event, token: string, threadId: string) => {
    return {
      url: `${BACKEND_URL}/api/desktop/chat/${threadId}/stream`,
      token,
    }
  },
)

// Generic fetch proxy for renderer
ipcMain.handle(
  'desktop:fetch',
  async (_event, url: string, options: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const res = await net.fetch(url.startsWith('http') ? url : `${BACKEND_URL}${url}`, {
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      body: options.body,
    })
    const text = await res.text()
    return { status: res.status, body: text }
  },
)

/* ─── App lifecycle ─── */

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
