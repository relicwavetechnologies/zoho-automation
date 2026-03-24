import fs from 'fs/promises'
import { resolve, relative, dirname, sep } from 'path'

export type WorkspaceAction =
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

export async function runWorkspaceAction(
  workspaceRoot: string,
  action: WorkspaceAction,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
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
}
