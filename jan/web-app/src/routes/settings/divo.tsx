import { createFileRoute } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { IconExternalLink, IconFolderOpen, IconRefresh, IconTrash } from '@tabler/icons-react'

import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DivoDexWordmark } from '@/components/DivoDexBrand'
import { cn } from '@/lib/utils'
import {
  DEFAULT_DIVO_BACKEND_URL,
  type DivoSessionStatus,
  getStoredDivoBackendUrl,
  isDivoAuthCancelled,
  normalizeDivoBackendUrl,
  normalizeDivoSessionStatus,
  signInDivoWithLark,
  storeDivoBackendUrl,
  validateDivoSession,
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

type PiParallelismStatus = {
  configuredCapacity: number | null
  effectiveCapacity: number
  defaultCapacity: number
  minCapacity: number
  maxCapacity: number
  applied?: boolean
  restartRequired?: boolean
}

function DivoSettings() {
  const [backendUrl, setBackendUrl] = useState(getStoredDivoBackendUrl)
  const [workspace, setWorkspace] = useState<DivoWorkspaceStatus | null>(null)
  const [parallelism, setParallelism] = useState<PiParallelismStatus | null>(null)
  const [status, setStatus] = useState<DivoSessionStatus>({
    configured: false,
    departments: [],
  })
  const [isLoadingStatus, setIsLoadingStatus] = useState(true)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [isChangingDepartment, setIsChangingDepartment] = useState(false)
  const [isChangingParallelism, setIsChangingParallelism] = useState(false)
  const connectAbortRef = useRef<AbortController | null>(null)

  const refreshStatus = async () => {
    setIsLoadingStatus(true)
    try {
      const [next, workspaceStatus, parallelismStatus] = await Promise.all([
        validateDivoSession(),
        getPiWorkspaceStatus(),
        invoke<PiParallelismStatus>('pi_get_parallelism'),
      ])
      setStatus(normalizeDivoSessionStatus(next))
      setWorkspace(workspaceStatus)
      setParallelism(parallelismStatus)
      if (status.departmentId && status.departmentId !== next.departmentId) {
        await restartPiForWorkspaceChange()
      }
      if (next.backendUrl) {
        setBackendUrl(next.backendUrl)
        storeDivoBackendUrl(next.backendUrl)
      }
    } catch (error) {
      toast.error('Failed to read Divo Dex session', { description: String(error) })
    } finally {
      setIsLoadingStatus(false)
    }
  }

  useEffect(() => {
    void refreshStatus()
  }, [])

  const cancelConnect = () => {
    connectAbortRef.current?.abort()
  }

  const handleConnect = async () => {
    const controller = new AbortController()
    connectAbortRef.current = controller
    setIsConnecting(true)
    try {
      const normalizedBackendUrl = normalizeDivoBackendUrl(backendUrl)
      setBackendUrl(normalizedBackendUrl)
      storeDivoBackendUrl(normalizedBackendUrl)

      const next = await signInDivoWithLark(normalizedBackendUrl, {
        signal: controller.signal,
      })
      setStatus(normalizeDivoSessionStatus(next))
      toast.success('Divo Dex connected')
    } catch (error) {
      if (!isDivoAuthCancelled(error)) {
        toast.error('Divo Dex connection failed', { description: String(error) })
      }
    } finally {
      if (connectAbortRef.current === controller) {
        connectAbortRef.current = null
      }
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
      toast.success('Divo Dex workspace updated')
    } catch (error) {
      toast.error('Failed to choose workspace', { description: String(error) })
    }
  }

  const handleClearWorkspace = async () => {
    try {
      const next = await clearPiWorkspacePath()
      setWorkspace(next)
      await restartPiForWorkspaceChange()
      toast.success('Using default Divo Dex workspace')
    } catch (error) {
      toast.error('Failed to clear workspace', { description: String(error) })
    }
  }

  const handleParallelismChange = async (capacity: number) => {
    setIsChangingParallelism(true)
    try {
      const next = await invoke<PiParallelismStatus>('pi_set_parallelism', { capacity })
      setParallelism(next)
      if (next.restartRequired) {
        toast.info('Parallel-agent limit will apply after active agents finish or Pi is restarted')
      } else {
        toast.success(`Divo can now run up to ${next.effectiveCapacity} Pi agents at once`)
      }
    } catch (error) {
      toast.error('Failed to update parallel-agent limit', { description: String(error) })
    } finally {
      setIsChangingParallelism(false)
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
      await restartPiForWorkspaceChange()
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
  const configuredParallelism = parallelism?.configuredCapacity ?? parallelism?.effectiveCapacity
  const parallelismOptions = parallelism
    ? Array.from(
      { length: parallelism.maxCapacity - parallelism.minCapacity + 1 },
      (_, index) => parallelism.minCapacity + index
    )
    : []

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className={cn("flex items-center justify-between w-full mr-2 pr-3", !IS_MACOS && "pr-30")}>
          <DivoDexWordmark textClassName="text-base" />
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
                description="The Divo Dex backend used for company auth and gateway calls."
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
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleConnect()}
                        disabled={isConnecting}
                      >
                        <IconExternalLink size={14} />
                        {isConnecting ? 'Waiting for Lark' : 'Connect with Lark'}
                      </Button>
                      {isConnecting ? (
                        <Button variant="ghost" size="sm" onClick={cancelConnect}>
                          Cancel
                        </Button>
                      ) : null}
                    </div>
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
                      placeholder="Resolving Divo Dex workspace..."
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
                title="Divo Dex Home"
                description={workspace?.homePath ?? 'Not resolved yet'}
              />
              <CardItem
                title="Divo Dex Workspace State"
                description={workspace?.divoPath ?? 'Not resolved yet'}
              />
              <CardItem
                title="Divo Dex Scratch"
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

            <Card title="Parallel Agents">
              <CardItem
                title="Concurrent Pi Agents"
                description={
                  parallelism
                    ? `Up to ${parallelism.effectiveCapacity} active Pi runtimes. Each chat remains isolated; additional chats wait independently.`
                    : 'Loading the current Pi runtime limit…'
                }
                actions={
                  parallelism ? (
                    <select
                      value={configuredParallelism ?? parallelism.defaultCapacity}
                      disabled={isChangingParallelism}
                      onChange={(event) => void handleParallelismChange(Number(event.target.value))}
                      className="h-8 w-28 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                      aria-label="Concurrent Pi agents"
                    >
                      {parallelismOptions.map((capacity) => (
                        <option key={capacity} value={capacity}>
                          {capacity}
                        </option>
                      ))}
                    </select>
                  ) : undefined
                }
              />
              <CardItem
                title="Safety boundary"
                description="Agents in the same workspace can still edit the same files. Use separate workspaces or worktrees for concurrent coding tasks."
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
