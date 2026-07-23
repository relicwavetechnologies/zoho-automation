import { useAuxiliaryTabs } from '@/hooks/useAuxiliaryTabs'
import { AuxiliaryLauncher } from './AuxiliaryLauncher'
import { AuxiliaryTabStrip } from './AuxiliaryTabStrip'
import { AuxiliarySurfaceRouter } from './AuxiliarySurfaceRouter'
import { cn } from '@/lib/utils'

type AuxiliaryRailProps = {
  className?: string
  /** When true, rail is inside a sheet — no left border. */
  embedded?: boolean
}

/**
 * Tab host only — no second titlebar/toggle. Open/close lives in the main header.
 */
export function AuxiliaryRail({ className, embedded }: AuxiliaryRailProps) {
  const tabs = useAuxiliaryTabs((s) => s.tabs)
  const activeTabId = useAuxiliaryTabs((s) => s.activeTabId)
  const activeTab =
    tabs.find((t) => t.id === activeTabId) ?? tabs[tabs.length - 1] ?? null

  return (
    <aside
      className={cn(
        'bg-background flex h-full min-h-0 w-full flex-col overflow-hidden',
        !embedded && 'border-l border-border/80',
        className
      )}
      aria-label="Auxiliary sidebar"
    >
      {tabs.length > 0 ? (
        <>
          <AuxiliaryTabStrip tabs={tabs} activeTabId={activeTab?.id ?? null} />
          <div className="min-h-0 flex-1 overflow-hidden">
            {activeTab ? <AuxiliarySurfaceRouter tab={activeTab} /> : null}
          </div>
        </>
      ) : (
        <AuxiliaryLauncher />
      )}
    </aside>
  )
}
