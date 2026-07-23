import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useAuxiliaryShell } from '@/hooks/useAuxiliaryShell'
import { cn } from '@/lib/utils'
import {
  IconLayoutSidebar,
  IconLayoutSidebarRight,
} from '@tabler/icons-react'
import { ReactNode, memo } from 'react'
import { Button } from '@/components/ui/button'
import { DownloadManagement } from '@/containers/DownloadManegement'
import { useTitlebarLayout } from '@/stores/titlebar-layout-store'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

type HeaderPageProps = {
  children?: ReactNode
}
const HeaderPage = memo(function HeaderPage({ children }: HeaderPageProps) {
  const { open, setLeftPanel } = useLeftPanel()
  const auxiliaryOpen = useAuxiliaryShell((s) => s.open)
  const toggleAuxiliary = useAuxiliaryShell((s) => s.toggle)
  // Collapsed, this header owns the top-left strip — indent past left-anchored Linux
  // window controls (size-8 each at left-4); macOS uses the pl-24 class below.
  const leftButtons = useTitlebarLayout((s) => s.layout.left.length)
  const rightButtons = useTitlebarLayout((s) => s.layout.right.length)
  const linuxControlsPad =
    !IS_MACOS && !open && leftButtons > 0 ? leftButtons * 32 + 24 : undefined
  // Keep the open button clear of in-app window controls (Windows / some Linux DEs).
  const rightControlsPad =
    (IS_WINDOWS || IS_LINUX) && rightButtons > 0
      ? rightButtons * 32 + 16
      : undefined

  return (
    <div
      className={cn(
        // Slim Codex-style titlebar — the content owns the height statement.
        'relative z-50 h-11 flex items-center shrink-0',
        IS_MACOS && !open ? 'pl-24' : ' pl-4',
        children === undefined && 'border-none'
      )}
      style={{
        ...(linuxControlsPad ? { paddingLeft: linuxControlsPad } : null),
        ...(rightControlsPad ? { paddingRight: rightControlsPad } : null),
      }}
    >
      <div className={cn('flex w-full items-center gap-1')}>
        {!open && (
          <>
            <DownloadManagement />
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative z-50 rounded-full"
              onClick={() => setLeftPanel(!open)}
              aria-label="Toggle sidebar"
            >
              <IconLayoutSidebar className="text-muted-foreground relative size-4.5" />
            </Button>
          </>
        )}
        <div className={cn('min-w-0 flex-1')}>{children}</div>

        {/* Above the Tauri drag strip (z-20) so it stays clickable. */}
        <div className="relative z-50 mr-1 flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={auxiliaryOpen ? 'secondary' : 'ghost'}
                size="icon-sm"
                className="rounded-full"
                onClick={() => toggleAuxiliary()}
                aria-label={
                  auxiliaryOpen ? 'Close right sidebar' : 'Open right sidebar'
                }
                aria-pressed={auxiliaryOpen}
              >
                <IconLayoutSidebarRight
                  className={cn(
                    'size-4.5',
                    auxiliaryOpen ? 'text-foreground' : 'text-muted-foreground'
                  )}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {auxiliaryOpen ? 'Close sidebar' : 'Open sidebar'}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
})

export default HeaderPage
