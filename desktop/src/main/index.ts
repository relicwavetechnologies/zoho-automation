import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { URL } from 'url'

import { registerAuthHandlers } from './ipc/auth.handler'
import { registerChatHandlers } from './ipc/chat.handler'
import { registerFilesHandlers } from './ipc/files.handler'
import { registerTerminalHandlers } from './ipc/terminal.handler'
import { registerThreadHandlers } from './ipc/threads.handler'
import { registerWorkspaceHandlers } from './ipc/workspace.handler'

const PROTOCOL_SCHEME = 'cursorr'
let mainWindow: BrowserWindow | null = null

function getMainWindow(): BrowserWindow | null {
  return mainWindow
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

function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'auth' && parsed.pathname === '/callback') {
      const code = parsed.searchParams.get('code')
      const state = parsed.searchParams.get('state')
      const error = parsed.searchParams.get('error')
      if ((code || error) && mainWindow) {
        mainWindow.webContents.send('desktop-auth:callback', { code, state, error })
      }
    }
  } catch {
    // ignore malformed URLs
  }
}

/* ─── Custom protocol registration ─── */
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, ['--', process.argv[1]])
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

/* ─── Register all IPC handlers ─── */
registerAuthHandlers()
registerChatHandlers()
registerFilesHandlers()
registerTerminalHandlers()
registerThreadHandlers()
registerWorkspaceHandlers(getMainWindow)

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
