/**
 * Pure utility functions for chat business logic.
 * No React, no state — importable from anywhere.
 */
import type { ContentBlock, MessageMetadata, ApprovalContentBlock } from '../types'
import type { ExecutionPlan } from '../types'

// ── Types ───────────────────────────────────────────────────────────────────

export type DesktopWorkspaceAction =
  | { kind: 'list_files'; path?: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete_path'; path: string }
  | { kind: 'run_command'; command: string }

export type NonCommandWorkspaceAction = Exclude<DesktopWorkspaceAction, { kind: 'run_command' }>

export type PendingLocalActionState = {
  id: string
  threadId: string
  workspaceName: string
  workspacePath: string
  action: DesktopWorkspaceAction
  source: 'manual' | 'agent'
}

export type RunningCommandState = {
  id: string
  threadId: string
  workspaceName: string
  cwd: string
  command: string
  source: 'manual' | 'agent'
}

export type ActionLoopResult =
  | { kind: 'action'; action: DesktopWorkspaceAction; blocks?: ContentBlock[]; plan?: ExecutionPlan | null }
  | { kind: 'answer'; message: import('../types').Message; plan?: ExecutionPlan | null }

export type ActionResultPayload = {
  kind: DesktopWorkspaceAction['kind']
  ok: boolean
  summary: string
}

export type ActionCompletion = {
  ok: boolean
  actionResultSummary: string
  summaryContent: string
  summaryMetadata: MessageMetadata
  toolResultSummary?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isLikelyLocalWorkspaceIntent(text: string): boolean {
  return /\b(file|folder|directory|workspace|create|edit|write|rewrite|read|open|delete|remove|mkdir|terminal|command|run|install|exec|execute|ls|cat|pwd|git|pnpm|npm|node|python|tsc|markdown|md|save|export|report|summary|research|analyze|analysis|findings|brief|document)\b/i.test(text)
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...[truncated]`
}

export function buildAgentActionToolBlock(
  action: DesktopWorkspaceAction,
): Extract<ContentBlock, { type: 'tool' }> {
  switch (action.kind) {
    case 'list_files':
      return { type: 'tool', id: crypto.randomUUID(), name: action.kind, label: `Listing ${action.path || '.'}`, icon: 'list', status: 'running' }
    case 'read_file':
      return { type: 'tool', id: crypto.randomUUID(), name: action.kind, label: `Reading ${action.path}`, icon: 'file-text', status: 'running' }
    case 'write_file':
      return { type: 'tool', id: crypto.randomUUID(), name: action.kind, label: `Writing ${action.path}`, icon: 'file-pen', status: 'running' }
    case 'mkdir':
      return { type: 'tool', id: crypto.randomUUID(), name: action.kind, label: `Creating folder ${action.path}`, icon: 'edit', status: 'running' }
    case 'delete_path':
      return { type: 'tool', id: crypto.randomUUID(), name: action.kind, label: `Deleting ${action.path}`, icon: 'zap', status: 'running' }
    case 'run_command':
      return { type: 'tool', id: crypto.randomUUID(), name: action.kind, label: `Preparing ${action.command}`, icon: 'zap', status: 'running' }
  }
}

export function buildApprovalBlock(
  id: string,
  action: Extract<DesktopWorkspaceAction, { kind: 'run_command' | 'write_file' | 'mkdir' | 'delete_path' }>,
  workspacePath: string,
): ApprovalContentBlock {
  switch (action.kind) {
    case 'run_command':
      return { type: 'approval', id, kind: action.kind, title: 'Command approval', description: 'Run this shell command inside the selected workspace.', subject: `$ ${action.command}`, footer: workspacePath, status: 'pending' }
    case 'write_file':
      return { type: 'approval', id, kind: action.kind, title: 'File change approval', description: 'Write this file inside the selected workspace.', subject: action.path, footer: workspacePath, status: 'pending' }
    case 'mkdir':
      return { type: 'approval', id, kind: action.kind, title: 'Folder creation approval', description: 'Create this folder inside the selected workspace.', subject: action.path, footer: workspacePath, status: 'pending' }
    case 'delete_path':
      return { type: 'approval', id, kind: action.kind, title: 'Delete approval', description: 'Delete this path inside the selected workspace.', subject: action.path, footer: workspacePath, status: 'pending' }
  }
}

export function summarizeCommandCompletion(input: {
  command: string
  cwd: string
  status: 'done' | 'failed' | 'rejected'
  exitCode?: number | null
  signal?: string | null
  durationMs?: number
  stdout?: string
  stderr?: string
}): ActionCompletion {
  const durationLabel = input.durationMs ? ` in ${Math.max(1, Math.round(input.durationMs / 1000))}s` : ''
  const exitLabel = input.exitCode !== undefined ? `exit code ${input.exitCode ?? 'unknown'}` : 'no exit code'
  const signalLabel = input.signal ? ` (signal ${input.signal})` : ''
  const stdoutTail = truncateText(input.stdout?.trim() || '', 6000)
  const stderrTail = truncateText(input.stderr?.trim() || '', 4000)

  if (input.status === 'rejected') {
    return {
      ok: false,
      actionResultSummary: `User rejected command: ${input.command}`,
      summaryContent: `Rejected command \`${input.command}\`.`,
      summaryMetadata: { localCommandSummary: { command: input.command, cwd: input.cwd, status: 'rejected' } },
      toolResultSummary: 'Rejected',
    }
  }

  const actionResultSummary = [
    `Command: ${input.command}`,
    `Working directory: ${input.cwd}`,
    `Status: ${input.status}`,
    `Exit: ${exitLabel}${signalLabel}`,
    input.durationMs ? `Duration: ${input.durationMs}ms` : '',
    stdoutTail ? `STDOUT:\n${stdoutTail}` : '',
    stderrTail ? `STDERR:\n${stderrTail}` : '',
  ].filter(Boolean).join('\n\n')

  return {
    ok: input.status === 'done',
    actionResultSummary,
    summaryContent: `Executed \`${input.command}\` in \`${input.cwd}\` with ${exitLabel}${signalLabel}${durationLabel}.`,
    summaryMetadata: {
      localCommandSummary: {
        command: input.command,
        cwd: input.cwd,
        status: input.status,
        exitCode: input.exitCode,
        durationMs: input.durationMs,
      },
    },
    toolResultSummary: input.status === 'done' ? `Completed with ${exitLabel}` : `Failed with ${exitLabel}${signalLabel}`,
  }
}

export function summarizeWorkspaceAction(
  action: NonCommandWorkspaceAction,
  result: { success: boolean; data?: unknown; error?: string },
): ActionCompletion {
  const targetPath = action.kind === 'list_files' ? action.path || '.' : action.path

  if (!result.success) {
    const errorMessage = result.error || 'Action failed'
    return {
      ok: false,
      actionResultSummary: `Failed to ${action.kind} ${targetPath}: ${errorMessage}`,
      summaryContent: `Failed to ${action.kind.replace('_', ' ')} \`${targetPath}\`.`,
      summaryMetadata: { localFileSummary: { kind: action.kind, path: targetPath, status: 'failed' } },
      toolResultSummary: errorMessage,
    }
  }

  switch (action.kind) {
    case 'list_files': {
      const payload = (result.data ?? {}) as { items?: Array<{ name: string; type: string }> }
      const items = payload.items ?? []
      const preview = items.slice(0, 40).map((item) => `- [${item.type === 'directory' ? 'dir' : item.type}] ${item.name}`).join('\n')
      const truncatedLabel = items.length > 40 ? `\n...and ${items.length - 40} more` : ''
      return {
        ok: true,
        actionResultSummary: `Directory listing for ${targetPath}:\n${preview}${truncatedLabel}`.trim(),
        summaryContent: `Listed files in \`${targetPath}\`.`,
        summaryMetadata: { localFileSummary: { kind: action.kind, path: targetPath, status: 'done' } },
        toolResultSummary: `Found ${items.length} item${items.length === 1 ? '' : 's'}`,
      }
    }
    case 'read_file': {
      const payload = (result.data ?? {}) as { content?: string }
      const content = truncateText(payload.content ?? '', 12000)
      return {
        ok: true,
        actionResultSummary: `File content for ${targetPath}:\n\n${content}`,
        summaryContent: `Read file \`${targetPath}\`.`,
        summaryMetadata: { localFileSummary: { kind: action.kind, path: targetPath, status: 'done' } },
        toolResultSummary: 'Read complete',
      }
    }
    case 'write_file': {
      const payload = (result.data ?? {}) as { bytes?: number }
      return {
        ok: true,
        actionResultSummary: `Wrote ${targetPath}${typeof payload.bytes === 'number' ? ` (${payload.bytes} bytes)` : ''}.`,
        summaryContent: `Wrote file \`${targetPath}\`.`,
        summaryMetadata: { localFileSummary: { kind: action.kind, path: targetPath, status: 'done' } },
        toolResultSummary: 'Write complete',
      }
    }
    case 'mkdir':
      return {
        ok: true,
        actionResultSummary: `Created folder ${targetPath}.`,
        summaryContent: `Created folder \`${targetPath}\`.`,
        summaryMetadata: { localFileSummary: { kind: action.kind, path: targetPath, status: 'done' } },
        toolResultSummary: 'Folder created',
      }
    case 'delete_path':
      return {
        ok: true,
        actionResultSummary: `Deleted ${targetPath}.`,
        summaryContent: `Deleted \`${targetPath}\`.`,
        summaryMetadata: { localFileSummary: { kind: action.kind, path: targetPath, status: 'done' } },
        toolResultSummary: 'Deleted',
      }
  }
}
