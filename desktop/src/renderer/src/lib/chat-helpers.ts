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
export type ApprovalRequiredWorkspaceAction = Extract<
  DesktopWorkspaceAction,
  { kind: 'run_command' | 'write_file' | 'mkdir' | 'delete_path' }
>

export type PendingLocalActionState = {
  id: string
  threadId: string
  workspaceName: string
  workspacePath: string
  action: DesktopWorkspaceAction
  source: 'manual' | 'agent'
  engine?: 'mastra' | 'langgraph'
  status?: 'pending' | 'approved' | 'running'
}

export type RunningCommandState = {
  id: string
  threadId: string
  workspaceName: string
  cwd: string
  command: string
  source: 'manual' | 'agent'
  engine?: 'mastra' | 'langgraph'
}

export type ActionLoopResult =
  | { kind: 'action'; action: DesktopWorkspaceAction; blocks?: ContentBlock[]; plan?: ExecutionPlan | null; executionId?: string }
  | { kind: 'answer'; message: import('../types').Message; plan?: ExecutionPlan | null; executionId?: string }

export type ActionResultPayload = {
  kind: DesktopWorkspaceAction['kind']
  ok: boolean
  summary: string
  details?: Record<string, unknown>
}

export type ActionCompletion = {
  ok: boolean
  actionResultSummary: string
  actionResultDetails?: Record<string, unknown>
  summaryContent: string
  summaryMetadata: MessageMetadata
  toolResultSummary?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const LOCAL_WORKSPACE_SIGNAL_PATTERN = /\b(file|files|folder|folders|directory|directories|workspace|repo|repository|codebase|project folder|local path|path|terminal|shell|command|bash|zsh|run command|install|exec|execute|ls|cat|pwd|git|pnpm|npm|node|python|tsc|read file|open file|write file|save file|mkdir|delete file|delete folder)\b/i
const REMOTE_WORKFLOW_SIGNAL_PATTERN = /\b(zoho|crm|deal|contact|lead|ticket|outreach|publisher|search the web|web research|competitor|lark(?:\s+(?:doc|docs|calendar|meeting|meetings|task|tasks|approval|approvals|base))?|schedule(?:\s+(?:a|the))?\s+meeting|calendar event)\b/i

export function isLikelyLocalWorkspaceIntent(text: string): boolean {
  const hasLocalSignal = LOCAL_WORKSPACE_SIGNAL_PATTERN.test(text)
  if (!hasLocalSignal) {
    return false
  }

  const hasRemoteWorkflowSignal = REMOTE_WORKFLOW_SIGNAL_PATTERN.test(text)
  return !hasRemoteWorkflowSignal
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
  action: ApprovalRequiredWorkspaceAction,
  workspacePath: string,
  status: ApprovalContentBlock['status'] = 'pending',
): ApprovalContentBlock {
  switch (action.kind) {
    case 'run_command':
      return { type: 'approval', id, kind: action.kind, title: 'Command approval', description: 'Run this shell command inside the selected workspace.', subject: `$ ${action.command}`, footer: workspacePath, status }
    case 'write_file':
      return { type: 'approval', id, kind: action.kind, title: 'File change approval', description: 'Write this file inside the selected workspace.', subject: action.path, footer: workspacePath, status }
    case 'mkdir':
      return { type: 'approval', id, kind: action.kind, title: 'Folder creation approval', description: 'Create this folder inside the selected workspace.', subject: action.path, footer: workspacePath, status }
    case 'delete_path':
      return { type: 'approval', id, kind: action.kind, title: 'Delete approval', description: 'Delete this path inside the selected workspace.', subject: action.path, footer: workspacePath, status }
  }
}

export function buildTerminalBlock(
  id: string,
  command: string,
  cwd: string,
  status: 'running' | 'done' | 'failed' = 'running',
): Extract<ContentBlock, { type: 'terminal' }> {
  return { type: 'terminal', id, command, cwd, status, stdout: '', stderr: '' }
}

export function isApprovalRequiredAction(action: DesktopWorkspaceAction): action is ApprovalRequiredWorkspaceAction {
  return (
    action.kind === 'run_command'
    || action.kind === 'write_file'
    || action.kind === 'mkdir'
    || action.kind === 'delete_path'
  )
}

export function isImmediateWorkspaceAction(action: DesktopWorkspaceAction): action is Extract<DesktopWorkspaceAction, { kind: 'list_files' | 'read_file' }> {
  return action.kind === 'list_files' || action.kind === 'read_file'
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
      actionResultDetails: {
        cwd: input.cwd,
        status: 'rejected',
      },
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
    actionResultDetails: {
      cwd: input.cwd,
      exitCode: input.exitCode ?? null,
      signal: input.signal ?? null,
      durationMs: input.durationMs,
      stdout: input.stdout,
      stderr: input.stderr,
    },
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
      actionResultDetails: { path: targetPath, error: errorMessage },
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
        actionResultDetails: { path: targetPath, itemCount: items.length },
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
        actionResultDetails: { path: targetPath, content: payload.content ?? '' },
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
        actionResultDetails: { path: targetPath, bytes: payload.bytes },
        summaryContent: `Wrote file \`${targetPath}\`.`,
        summaryMetadata: { localFileSummary: { kind: action.kind, path: targetPath, status: 'done' } },
        toolResultSummary: 'Write complete',
      }
    }
    case 'mkdir':
      return {
        ok: true,
        actionResultSummary: `Created folder ${targetPath}.`,
        actionResultDetails: { path: targetPath },
        summaryContent: `Created folder \`${targetPath}\`.`,
        summaryMetadata: { localFileSummary: { kind: action.kind, path: targetPath, status: 'done' } },
        toolResultSummary: 'Folder created',
      }
    case 'delete_path':
      return {
        ok: true,
        actionResultSummary: `Deleted ${targetPath}.`,
        actionResultDetails: { path: targetPath },
        summaryContent: `Deleted \`${targetPath}\`.`,
        summaryMetadata: { localFileSummary: { kind: action.kind, path: targetPath, status: 'done' } },
        toolResultSummary: 'Deleted',
      }
  }
}
