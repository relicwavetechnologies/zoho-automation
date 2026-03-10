import { ipcMain } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs/promises'

const terminalProcesses = new Map<string, ChildProcessWithoutNullStreams>()
const terminalKillTimers = new Map<string, NodeJS.Timeout>()

function cleanupTerminalExecution(executionId: string): void {
  terminalProcesses.delete(executionId)
  const timer = terminalKillTimers.get(executionId)
  if (timer) {
    clearTimeout(timer)
    terminalKillTimers.delete(executionId)
  }
}

export function registerTerminalHandlers(): void {
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
        event: { type: 'start', data: { command: trimmedCommand, cwd, startedAt } },
      })

      child.stdout.on('data', (chunk: Buffer) => {
        target.send('desktop:terminal:event', {
          executionId,
          event: { type: 'stdout', data: chunk.toString('utf8') },
        })
      })

      child.stderr.on('data', (chunk: Buffer) => {
        target.send('desktop:terminal:event', {
          executionId,
          event: { type: 'stderr', data: chunk.toString('utf8') },
        })
      })

      child.on('error', (error) => {
        cleanupTerminalExecution(executionId)
        target.send('desktop:terminal:event', {
          executionId,
          event: { type: 'error', data: { message: error.message, durationMs: Date.now() - startedAt } },
        })
      })

      child.on('close', (code, signal) => {
        cleanupTerminalExecution(executionId)
        target.send('desktop:terminal:event', {
          executionId,
          event: {
            type: 'exit',
            data: { exitCode: code ?? null, signal: signal ?? null, durationMs: Date.now() - startedAt },
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
}
