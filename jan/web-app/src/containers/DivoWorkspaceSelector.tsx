import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IconFolderOpen } from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { PI_PROVIDER_ID } from '@/lib/pi'
import {
  getPiWorkspaceStatus,
  setPiWorkspacePath,
  type DivoWorkspaceStatus,
} from '@/lib/pi-workspace'
import { cn } from '@/lib/utils'

function displayWorkspacePath(path: string): string {
  if (!path) return 'Resolving workspace...'
  return path
}

export default function DivoWorkspaceSelector() {
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const serviceHub = useServiceHub()
  const [workspace, setWorkspace] = useState<DivoWorkspaceStatus | null>(null)
  const [loading, setLoading] = useState(false)

  const isPiProvider = selectedProvider === PI_PROVIDER_ID
  const workspacePath = workspace?.effectiveWorkspacePath ?? ''
  const selectedWorkspacePath = workspace?.selectedWorkspacePath

  const label = useMemo(
    () => displayWorkspacePath(workspacePath),
    [workspacePath]
  )

  const refreshWorkspace = useCallback(async () => {
    if (!isPiProvider) return
    try {
      const status = await getPiWorkspaceStatus()
      setWorkspace(status)
    } catch (error) {
      toast.error('Failed to resolve Divo workspace', {
        description: String(error),
      })
    }
  }, [isPiProvider])

  useEffect(() => {
    void refreshWorkspace()
  }, [refreshWorkspace])

  const handleChooseWorkspace = useCallback(async () => {
    if (!isPiProvider || loading) return

    try {
      setLoading(true)
      const selected = await serviceHub.dialog().open({
        directory: true,
        multiple: false,
      })
      const nextPath = Array.isArray(selected) ? selected[0] : selected
      if (!nextPath) return

      const status = await setPiWorkspacePath(nextPath)
      setWorkspace(status)
      await invoke('pi_stop').catch(() => undefined)
      toast.success('Divo workspace selected')
    } catch (error) {
      toast.error('Failed to choose workspace', { description: String(error) })
    } finally {
      setLoading(false)
    }
  }, [isPiProvider, loading, serviceHub])

  if (!isPiProvider) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={cn(
            'h-9 max-w-[min(720px,calc(100vw-12rem))] rounded-full border px-4',
            'justify-start gap-2 text-sm font-medium'
          )}
          onClick={handleChooseWorkspace}
          disabled={loading}
          aria-label="Choose Divo workspace"
        >
          <IconFolderOpen size={16} className="shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-foreground">Workspace</span>
          <span className="truncate text-muted-foreground">{label}</span>
          {!selectedWorkspacePath && workspacePath && (
            <span className="shrink-0 text-muted-foreground">Default</span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{workspacePath || 'Resolving Divo workspace...'}</p>
      </TooltipContent>
    </Tooltip>
  )
}
