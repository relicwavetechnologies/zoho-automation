import { app, shell, BrowserWindow } from "electron";
import { join } from "path";
import { URL } from "url";
import { readRuntimeConfig } from "../shared/runtime-config";

import { registerAuthHandlers } from "./ipc/auth.handler";
import { registerChatHandlers } from "./ipc/chat.handler";
import { registerFilesHandlers } from "./ipc/files.handler";
import { registerTerminalHandlers } from "./ipc/terminal.handler";
import { registerThreadHandlers } from "./ipc/threads.handler";
import { registerWorkspaceHandlers } from "./ipc/workspace.handler";

const PROTOCOL_SCHEME = "cursorr";
let mainWindow: BrowserWindow | null = null;
let pendingAuthCallback:
  | { code?: string | null; state?: string | null; error?: string | null }
  | null = null;

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#0a0a0a",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (pendingAuthCallback && mainWindow) {
      mainWindow.webContents.send("desktop-auth:callback", pendingAuthCallback);
      pendingAuthCallback = null;
    }
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "auth" && parsed.pathname === "/callback") {
      const code = parsed.searchParams.get("code");
      const state = parsed.searchParams.get("state");
      const error = parsed.searchParams.get("error");
      if (code || error) {
        pendingAuthCallback = { code, state, error };
        if (mainWindow && !mainWindow.webContents.isLoading()) {
          mainWindow.webContents.send("desktop-auth:callback", pendingAuthCallback);
          pendingAuthCallback = null;
        }
      }
    }
  } catch {
    // ignore malformed URLs
  }
}

function registerProtocolClient(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
        "--",
        process.argv[1],
      ]);
    }
    return;
  }

  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

/* ─── Single instance lock ─── */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const deepLink = commandLine.find((arg) =>
      arg.startsWith(`${PROTOCOL_SCHEME}://`),
    );
    if (deepLink) handleDeepLink(deepLink);
  });
}

/* ─── macOS open-url ─── */
app.on("open-url", (_event, url) => {
  handleDeepLink(url);
});

/* ─── Register all IPC handlers ─── */
registerAuthHandlers();
registerChatHandlers();
registerFilesHandlers();
registerTerminalHandlers();
registerThreadHandlers();
registerWorkspaceHandlers(getMainWindow);

/* ─── App lifecycle ─── */
app.whenReady().then(() => {
  const runtimeConfig = readRuntimeConfig();
  console.info("[desktop:runtime.config]", {
    backendUrl: runtimeConfig.backendUrl,
    backendUrlSource: runtimeConfig.backendUrlSource,
    webAppUrl: runtimeConfig.webAppUrl,
    webAppUrlSource: runtimeConfig.webAppUrlSource,
  });
  if (!runtimeConfig.backendUrl) {
    console.warn(
      "[desktop:runtime.config] DIVO_BACKEND_URL is unset. Desktop API calls will fail until it is configured.",
    );
  }

  registerProtocolClient();
  createWindow();

  const initialDeepLink = process.argv.find((arg) =>
    arg.startsWith(`${PROTOCOL_SCHEME}://`),
  );
  if (initialDeepLink) {
    handleDeepLink(initialDeepLink);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
