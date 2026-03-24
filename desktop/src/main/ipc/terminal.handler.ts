import { ipcMain } from 'electron'
import { executeTerminalCommand, killTerminalExecution } from '../services/local-terminal'

export function registerTerminalHandlers(): void {
  ipcMain.handle('desktop:terminal:exec', async (event, executionId: string, command: string, cwd: string) => {
    const target = event.sender
    return executeTerminalCommand(executionId, command, cwd, (termEvent) => {
      target.send('desktop:terminal:event', {
        executionId,
        event: termEvent,
      })
    })
  })

  ipcMain.handle('desktop:terminal:kill', async (_event, executionId: string) => {
    return killTerminalExecution(executionId)
  })
}
