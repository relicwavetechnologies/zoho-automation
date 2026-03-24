import { app } from 'electron'
import fs from 'fs/promises'
import { join } from 'path'

export type RemoteLocalActionKind =
  | 'list_files'
  | 'read_file'
  | 'run_command'
  | 'write_file'
  | 'mkdir'
  | 'delete_path'

export type DesktopPermissionDecision = 'allow' | 'ask' | 'deny'

export type DesktopWorkspacePolicy = {
  version: number
  actions: Record<RemoteLocalActionKind, DesktopPermissionDecision>
}

const DEFAULT_POLICY: DesktopWorkspacePolicy = {
  version: 1,
  actions: {
    list_files: 'allow',
    read_file: 'allow',
    run_command: 'ask',
    write_file: 'ask',
    mkdir: 'ask',
    delete_path: 'ask',
  },
}

type PersistedPolicies = {
  version: number
  byWorkspacePath: Record<string, DesktopWorkspacePolicy>
}

let cache: PersistedPolicies | null = null

function getPolicyFilePath(): string {
  return join(app.getPath('userData'), 'desktop-remote-policies.json')
}

async function loadPolicies(): Promise<PersistedPolicies> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(getPolicyFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as PersistedPolicies
    cache = {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      byWorkspacePath: parsed.byWorkspacePath && typeof parsed.byWorkspacePath === 'object'
        ? parsed.byWorkspacePath
        : {},
    }
    return cache
  } catch {
    cache = { version: 1, byWorkspacePath: {} }
    return cache
  }
}

export async function getWorkspacePolicy(workspacePath?: string | null): Promise<DesktopWorkspacePolicy> {
  if (!workspacePath) {
    return DEFAULT_POLICY
  }
  const store = await loadPolicies()
  return store.byWorkspacePath[workspacePath] ?? DEFAULT_POLICY
}
