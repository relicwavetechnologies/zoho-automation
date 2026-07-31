import { invoke } from '@tauri-apps/api/core'

const PI_WORKSPACE_STORAGE_KEY = 'divo.piWorkspacePath'

export type DivoWorkspaceStatus = {
  homePath: string
  defaultWorkspacePath: string
  effectiveWorkspacePath: string
  selectedWorkspacePath?: string
  divoPath: string
  divoTmpPath: string
  divoScriptsPath: string
  divoArtifactsPath: string
  divoLogsPath: string
  companySkillsPath: string
  userSkillsPath: string
}

function getLegacyPiWorkspacePath(): string | undefined {
  const value = localStorage.getItem(PI_WORKSPACE_STORAGE_KEY)?.trim()
  return value || undefined
}

function clearLegacyPiWorkspacePath(): void {
  localStorage.removeItem(PI_WORKSPACE_STORAGE_KEY)
}

export async function getPiWorkspaceStatus(): Promise<DivoWorkspaceStatus> {
  const status = await invoke<DivoWorkspaceStatus>('divo_get_workspace_status')
  const legacyPath = getLegacyPiWorkspacePath()
  if (status.selectedWorkspacePath || !legacyPath) {
    if (status.selectedWorkspacePath) clearLegacyPiWorkspacePath()
    return status
  }

  try {
    const migrated = await setPiWorkspacePath(legacyPath)
    clearLegacyPiWorkspacePath()
    return migrated
  } catch {
    clearLegacyPiWorkspacePath()
    return status
  }
}

export async function setPiWorkspacePath(path: string): Promise<DivoWorkspaceStatus> {
  return invoke<DivoWorkspaceStatus>('divo_set_workspace_path', {
    workspacePath: path,
    workspace_path: path,
  })
}

export async function clearPiWorkspacePath(): Promise<DivoWorkspaceStatus> {
  return invoke<DivoWorkspaceStatus>('divo_clear_workspace_path')
}
