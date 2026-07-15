import { invoke } from '@tauri-apps/api/core'
import { ShieldCheck, SquareTerminal } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'

type PermissionRulesResponse = {
  bashAlwaysAllow?: boolean
}

export function PermissionRulesPopover() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [bashAlwaysAllow, setBashAlwaysAllow] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadRules = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rules = await invoke<PermissionRulesResponse>('pi_get_permission_rules')
      setBashAlwaysAllow(rules?.bashAlwaysAllow === true)
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Permission rules could not be loaded.'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) void loadRules()
  }

  const updateBashRule = async (allowed: boolean) => {
    if (saving) return

    setSaving(true)
    setError(null)
    try {
      await invoke('pi_set_persistent_bash_approval', { allowed })
      setBashAlwaysAllow(allowed)
      toast.success(
        allowed
          ? 'Bash is always allowed on this device until you turn it off.'
          : 'Bash will ask for approval before each command.'
      )
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : 'The Bash permission rule could not be updated.'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Permission rules"
          data-testid="permission-rules-trigger"
        >
          <ShieldCheck />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-0">
        <PopoverHeader className="p-4">
          <PopoverTitle>Permission rules</PopoverTitle>
          <PopoverDescription>
            Control which local actions can run without asking again.
          </PopoverDescription>
        </PopoverHeader>

        <Separator />

        <div className="flex items-start gap-3 p-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
            <SquareTerminal className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Bash commands</p>
                <p className="text-xs text-muted-foreground">
                  {bashAlwaysAllow
                    ? 'Always allow on this device'
                    : 'Ask before every command'}
                </p>
              </div>
              <Switch
                checked={bashAlwaysAllow}
                disabled={loading || saving}
                loading={loading || saving}
                aria-label="Always allow Bash"
                onCheckedChange={(checked) => void updateBashRule(checked)}
              />
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Bash can modify or delete files, access local data, and use the
              network. This setting survives tasks and app restarts until you
              explicitly turn it off.
            </p>
          </div>
        </div>
        {error ? (
          <p className="px-4 pb-4 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
