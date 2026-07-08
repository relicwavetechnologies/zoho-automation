import { createFileRoute } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { IconExternalLink, IconFolderOpen, IconRefresh, IconTrash } from '@tabler/icons-react'

import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  DEFAULT_DIVO_BACKEND_URL,
  type DivoSessionStatus,
  getDivoSessionStatus,
  getStoredDivoBackendUrl,
  normalizeDivoBackendUrl,
  normalizeDivoSessionStatus,
  signInDivoWithLark,
  storeDivoBackendUrl,
} from '@/lib/divo-auth'
import {
  type DivoWorkspaceStatus,
  clearPiWorkspacePath,
  getPiWorkspaceStatus,
  setPiWorkspacePath,
} from '@/lib/pi-workspace'

export const Route = createFileRoute(route.settings.divo as any)({
  component: DivoSettings,
})

function DivoSettings() {
  const [backendUrl, setBackendUrl] = useState(getStoredDivoBackendUrl)
  const [workspace, setWorkspace] = useState<DivoWorkspaceStatus | null>(null)
  const [status, setStatus] = useState<DivoSessionStatus>({
    configured: false,
    departments: [],
  })
  const [isLoadingStatus, setIsLoadingStatus] = useState(true)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [isChangingDepartment, setIsChangingDepartment] = useState(false)

  const refreshStatus = async () => {
    setIsLoadingStatus(true)
    try {
      const [next, workspaceStatus] = await Promise.all([
        getDivoSessionStatus(),
        getPiWorkspaceStatus(),
      ])
      setStatus(normalizeDivoSessionStatus(next))
      setWorkspace(workspaceStatus)
      if (next.backendUrl) {
        setBackendUrl(next.backendUrl)
        storeDivoBackendUrl(next.backendUrl)
      }
    } catch (error) {
      toast.error('Failed to read Divo session', { description: String(error) })
    } finally {
      setIsLoadingStatus(false)
    }
  }

  useEffect(() => {
    void refreshStatus()
  }, [])

  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      const normalizedBackendUrl = normalizeDivoBackendUrl(backendUrl)
      setBackendUrl(normalizedBackendUrl)
      storeDivoBackendUrl(normalizedBackendUrl)

      const next = await signInDivoWithLark(normalizedBackendUrl)
      setStatus(normalizeDivoSessionStatus(next))
      toast.success('Divo connected')
    } catch (error) {
      toast.error('Divo connection failed', { description: String(error) })
    } finally {
      setIsConnecting(false)
    }
  }

  const restartPiForWorkspaceChange = async () => {
    await invoke('pi_stop').catch(() => undefined)
  }

  const handleChooseWorkspace = async () => {
    try {
      const selected = await invoke<string | string[] | null>('open_dialog', {
        options: {
          directory: true,
          multiple: false,
        },
      })
      const nextPath = Array.isArray(selected) ? selected[0] : selected
      if (!nextPath) return

      const next = await setPiWorkspacePath(nextPath)
      setWorkspace(next)
      await restartPiForWorkspaceChange()
      toast.success('Divo workspace updated')
    } catch (error) {
      toast.error('Failed to choose workspace', { description: String(error) })
    }
  }

  const handleClearWorkspace = async () => {
    try {
      const next = await clearPiWorkspacePath()
      setWorkspace(next)
      await restartPiForWorkspaceChange()
      toast.success('Using default Divo workspace')
    } catch (error) {
      toast.error('Failed to clear workspace', { description: String(error) })
    }
  }

  const handleDisconnect = async () => {
    setIsDisconnecting(true)
    try {
      await invoke('divo_clear_session')
      await invoke('pi_stop').catch(() => undefined)
      setStatus({ configured: false, departments: [] })
      toast.success('Divo disconnected')
    } catch (error) {
      toast.error('Failed to disconnect Divo', { description: String(error) })
    } finally {
      setIsDisconnecting(false)
    }
  }

  const handleDepartmentChange = async (departmentId: string) => {
    setIsChangingDepartment(true)
    try {
      const next = await invoke<DivoSessionStatus>('divo_set_department', {
        departmentId: departmentId || null,
      })
      setStatus(normalizeDivoSessionStatus(next))
      toast.success('Divo department updated')
    } catch (error) {
      toast.error('Failed to update department', { description: String(error) })
    } finally {
      setIsChangingDepartment(false)
    }
  }

  const selectedDepartmentName =
    status.departments.find((dept) => dept.id === status.departmentId)?.name ??
    status.departmentId
  const selectedWorkspacePath = workspace?.selectedWorkspacePath
  const effectiveWorkspacePath = workspace?.effectiveWorkspacePath ?? ''
  const workspaceDescription = selectedWorkspacePath
    ? 'Divo starts in the selected workspace folder.'
    : 'Divo starts in the default workspace.'

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className={cn("flex items-center justify-between w-full mr-2 pr-3", !IS_MACOS && "pr-30")}>
          <span className="font-medium text-base font-studio">Divo</span>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshStatus}
            disabled={isLoadingStatus || isConnecting}
            className="relative z-50"
          >
            <IconRefresh size={14} />
            Refresh
          </Button>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
            <Card title="Connection">
              <CardItem
                title="Backend URL"
                description="The Divo backend used for company auth and gateway calls."
                align="start"
                actions={
                  <Input
                    value={backendUrl}
                    onChange={(event) => setBackendUrl(event.target.value)}
                    placeholder={DEFAULT_DIVO_BACKEND_URL}
                    disabled={isConnecting}
                    className="w-80"
                  />
                }
              />
              <CardItem
                title="Status"
                description={
                  status.configured
                    ? `Connected${status.email ? ` as ${status.email}` : ''}`
                    : 'Not connected'
                }
                actions={
                  status.configured ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDisconnect}
                      disabled={isDisconnecting}
                    >
                      <IconTrash size={14} />
                      {isDisconnecting ? 'Disconnecting' : 'Disconnect'}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleConnect}
                      disabled={isConnecting}
                    >
                      <IconExternalLink size={14} />
                      {isConnecting ? 'Waiting for Lark' : 'Connect with Lark'}
                    </Button>
                  )
                }
              />
            </Card>

            <Card title="Agent Workspace">
              <CardItem
                title="Workspace Folder"
                description={workspaceDescription}
                column
                align="start"
                actions={
                  <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
                    <Input
                      value={effectiveWorkspacePath}
                      readOnly
                      placeholder="Resolving Divo workspace..."
                      className="min-w-0 flex-1"
                    />
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleChooseWorkspace}
                      >
                        <IconFolderOpen size={14} />
                        Choose
                      </Button>
                      {selectedWorkspacePath && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleClearWorkspace}
                        >
                          <IconTrash size={14} />
                          Clear
                        </Button>
                      )}
                    </div>
                  </div>
                }
              />
              <CardItem
                title="Divo Home"
                description={workspace?.homePath ?? 'Not resolved yet'}
              />
              <CardItem
                title="Divo Workspace State"
                description={workspace?.divoPath ?? 'Not resolved yet'}
              />
              <CardItem
                title="Divo Scratch"
                description={workspace?.divoTmpPath ?? 'Not resolved yet'}
              />
              <CardItem
                title="Company Skills"
                description={workspace?.companySkillsPath ?? 'Not resolved yet'}
              />
              <CardItem
                title="User Skills"
                description={workspace?.userSkillsPath ?? 'Not resolved yet'}
              />
            </Card>

            {status.configured && (
              <Card title="Session">
                <CardItem
                  title="User"
                  description={status.name ?? status.email ?? status.userId ?? 'Signed in'}
                />
                <CardItem
                  title="Company"
                  description={status.companyId ?? 'Unknown'}
                />
                <CardItem
                  title="Department"
                  description={selectedDepartmentName ?? 'No default department'}
                  actions={
                    status.departments.length > 0 ? (
                      <select
                        value={status.departmentId ?? ''}
                        disabled={isChangingDepartment}
                        onChange={(event) => handleDepartmentChange(event.target.value)}
                        className="h-8 w-56 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                      >
                        <option value="">No default</option>
                        {status.departments.map((department) => (
                          <option key={department.id} value={department.id}>
                            {department.name}
                          </option>
                        ))}
                      </select>
                    ) : undefined
                  }
                />
                <CardItem
                  title="Expires"
                  description={
                    status.expiresAt
                      ? new Date(status.expiresAt).toLocaleString()
                      : 'Unknown'
                  }
                />
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
