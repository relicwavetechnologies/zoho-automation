import { ipcMain, dialog, BrowserWindow } from 'electron'
import { basename } from 'path'
import { runWorkspaceAction, type WorkspaceAction } from '../services/workspace-actions'

export function registerWorkspaceHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('desktop:workspace:select', async () => {
    const mainWindow = getMainWindow()
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

  ipcMain.handle('desktop:workspace:run-action', async (_event, workspaceRoot: string, action: WorkspaceAction) => {
    return runWorkspaceAction(workspaceRoot, action)
  })
}
