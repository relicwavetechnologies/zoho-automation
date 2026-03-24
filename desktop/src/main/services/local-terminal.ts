import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs/promises'

export type TerminalEvent =
  | { type: 'start'; data: { command: string; cwd: string; startedAt: number } }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'error'; data: { message: string; durationMs: number } }
  | { type: 'exit'; data: { exitCode: number | null; signal: NodeJS.Signals | null; durationMs: number } }

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

function emitTerminalEvent(
  executionId: string,
  onEvent: (event: TerminalEvent) => void | Promise<void>,
  event: TerminalEvent,
): void {
  void Promise.resolve(onEvent(event)).catch((error) => {
    console.error('[desktop:terminal] failed to publish terminal event', {
      executionId,
      eventType: event.type,
      error: error instanceof Error ? error.message : 'unknown_error',
    })
  })
}

export async function executeTerminalCommand(
  executionId: string,
  command: string,
  cwd: string,
  onEvent: (event: TerminalEvent) => void | Promise<void>,
): Promise<{ success: boolean; error?: string }> {
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
    let finalized = false

    const emitExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (finalized) return
      finalized = true
      cleanupTerminalExecution(executionId)
      emitTerminalEvent(executionId, onEvent, {
        type: 'exit',
        data: { exitCode: code ?? null, signal: signal ?? null, durationMs: Date.now() - startedAt },
      })
    }

    emitTerminalEvent(executionId, onEvent, {
      type: 'start',
      data: { command: trimmedCommand, cwd, startedAt },
    })

    child.stdout.on('data', (chunk: Buffer) => {
      emitTerminalEvent(executionId, onEvent, { type: 'stdout', data: chunk.toString('utf8') })
    })

    child.stderr.on('data', (chunk: Buffer) => {
      emitTerminalEvent(executionId, onEvent, { type: 'stderr', data: chunk.toString('utf8') })
    })

    child.on('error', (error) => {
      if (finalized) return
      finalized = true
      cleanupTerminalExecution(executionId)
      emitTerminalEvent(executionId, onEvent, {
        type: 'error',
        data: { message: error.message, durationMs: Date.now() - startedAt },
      })
    })

    child.on('exit', (code, signal) => {
      emitExit(code, signal)
    })

    child.on('close', (code, signal) => {
      emitExit(code, signal)
    })

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to execute command',
    }
  }
}

export async function killTerminalExecution(executionId: string): Promise<{ success: boolean; error?: string }> {
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
}
