import { app, shell, BrowserWindow, ipcMain, protocol, net, dialog } from 'electron'
import { join, basename, resolve, relative, dirname, sep } from 'path'
import { is } from '@electron-toolkit/utils'
import { URL } from 'url'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs/promises'

const PROTOCOL_SCHEME = 'cursorr'
const BACKEND_URL = process.env.CURSORR_BACKEND_URL ?? 'http://localhost:8000'

let mainWindow: BrowserWindow | null = null
const terminalProcesses = new Map<string, ChildProcessWithoutNullStreams>()
const terminalKillTimers = new Map<string, NodeJS.Timeout>()

type WorkspaceAction =
  | { kind: 'list_files'; path?: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete_path'; path: string }

function resolveWorkspacePath(workspaceRoot: string, inputPath?: string): string {
  const root = resolve(workspaceRoot)
  const target = resolve(root, inputPath && inputPath.trim() ? inputPath : '.')
  const rel = relative(root, target)
  if (rel === '' || rel === '.') return target
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Path escapes the selected workspace')
  }
  return target
}

function cleanupTerminalExecution(executionId: string): void {
  terminalProcesses.delete(executionId)
  const timer = terminalKillTimers.get(executionId)
  if (timer) {
    clearTimeout(timer)
    terminalKillTimers.delete(executionId)
  }
}

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

ipcMain.handle('desktop:workspace:select', async () => {
  const options: Electron.OpenDialogOptions = {
    title: 'Open Workspace Folder',
    buttonLabel: 'Open Workspace',
    properties: ['openDirectory', 'createDirectory'],
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true }
  }

  const folderPath = result.filePaths[0]
  return {
    canceled: false,
    data: {
      id: folderPath,
      path: folderPath,
      name: basename(folderPath) || folderPath,
    },
  }
})

ipcMain.handle('desktop:terminal:exec', async (event, executionId: string, command: string, cwd: string) => {
  const target = event.sender
  const trimmedCommand = command.trim()
  if (!trimmedCommand) {
    return { success: false, error: 'Command cannot be empty' }
  }

  try {
    const stat = await fs.stat(cwd)
    if (!stat.isDirectory()) {
      return { success: false, error: 'Workspace path is not a directory' }
    }
  } catch {
    return { success: false, error: 'Workspace path does not exist' }
  }

  try {
    const startedAt = Date.now()
    const shellPath = process.env.SHELL || '/bin/zsh'
    const child = spawn(shellPath, ['-lc', trimmedCommand], {
      cwd,
      detached: process.platform !== 'win32',
      env: { ...process.env, FORCE_COLOR: '0' },
    })

    terminalProcesses.set(executionId, child)

    target.send('desktop:terminal:event', {
      executionId,
      event: {
        type: 'start',
        data: { command: trimmedCommand, cwd, startedAt },
      },
    })

    child.stdout.on('data', (chunk: Buffer) => {
      target.send('desktop:terminal:event', {
        executionId,
        event: {
          type: 'stdout',
          data: chunk.toString('utf8'),
        },
      })
    })

    child.stderr.on('data', (chunk: Buffer) => {
      target.send('desktop:terminal:event', {
        executionId,
        event: {
          type: 'stderr',
          data: chunk.toString('utf8'),
        },
      })
    })

    child.on('error', (error) => {
      cleanupTerminalExecution(executionId)
      target.send('desktop:terminal:event', {
        executionId,
        event: {
          type: 'error',
          data: { message: error.message, durationMs: Date.now() - startedAt },
        },
      })
    })

    child.on('close', (code, signal) => {
      cleanupTerminalExecution(executionId)
      target.send('desktop:terminal:event', {
        executionId,
        event: {
          type: 'exit',
          data: {
            exitCode: code ?? null,
            signal: signal ?? null,
            durationMs: Date.now() - startedAt,
          },
        },
      })
    })

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to execute command',
    }
  }
})

ipcMain.handle('desktop:terminal:kill', async (_event, executionId: string) => {
  const child = terminalProcesses.get(executionId)
  if (!child) {
    return { success: false, error: 'No running command found for this execution' }
  }

  try {
    if (process.platform === 'win32') {
      child.kill('SIGTERM')
    } else if (child.pid) {
      process.kill(-child.pid, 'SIGTERM')
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          // process already exited
        }
      }, 1500)
      terminalKillTimers.set(executionId, timer)
    } else {
      child.kill('SIGTERM')
    }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to stop command',
    }
  }
})

ipcMain.handle('desktop:workspace:run-action', async (_event, workspaceRoot: string, action: WorkspaceAction) => {
  try {
    const rootStat = await fs.stat(workspaceRoot)
    if (!rootStat.isDirectory()) {
      return { success: false, error: 'Workspace root is not a directory' }
    }
  } catch {
    return { success: false, error: 'Workspace root does not exist' }
  }

  try {
    if (action.kind === 'list_files') {
      const target = resolveWorkspacePath(workspaceRoot, action.path)
      const entries = await fs.readdir(target, { withFileTypes: true })
      const items = entries
        .slice(0, 200)
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        }))
      return { success: true, data: { path: target, items } }
    }

    if (action.kind === 'read_file') {
      const target = resolveWorkspacePath(workspaceRoot, action.path)
      const content = await fs.readFile(target, 'utf8')
      return { success: true, data: { path: target, content } }
    }

    if (action.kind === 'write_file') {
      const target = resolveWorkspacePath(workspaceRoot, action.path)
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.writeFile(target, action.content, 'utf8')
      return { success: true, data: { path: target, bytes: Buffer.byteLength(action.content, 'utf8') } }
    }

    if (action.kind === 'mkdir') {
      const target = resolveWorkspacePath(workspaceRoot, action.path)
      await fs.mkdir(target, { recursive: true })
      return { success: true, data: { path: target } }
    }

    if (action.kind === 'delete_path') {
      const target = resolveWorkspacePath(workspaceRoot, action.path)
      await fs.rm(target, { recursive: true, force: false })
      return { success: true, data: { path: target } }
    }

    return { success: false, error: 'Unsupported workspace action' }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Workspace action failed',
    }
  }
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

ipcMain.handle(
  'desktop:thread:add-message',
  async (
    _event,
    token: string,
    threadId: string,
    payload: { role: string; content: string; metadata?: Record<string, unknown> },
  ) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return res.json()
  },
)

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
  'desktop:chat:act',
  async (
    _event,
    token: string,
    threadId: string,
    payload: Record<string, unknown>,
  ) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/chat/${threadId}/act`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
