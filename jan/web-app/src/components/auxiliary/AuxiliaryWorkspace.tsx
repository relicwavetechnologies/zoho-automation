import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import {
  AUXILIARY_SIZE,
  useAuxiliaryShell,
} from '@/hooks/useAuxiliaryShell'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { AuxiliaryRail } from './AuxiliaryRail'
import { cn } from '@/lib/utils'

type AuxiliaryWorkspaceProps = {
  children: React.ReactNode
}

/**
 * Shell layer: owns layout/resize/mobile overlay only.
 * Tab content lives in AuxiliaryRail → Tab Host → Surfaces.
 */
export function AuxiliaryWorkspace({ children }: AuxiliaryWorkspaceProps) {
  const open = useAuxiliaryShell((s) => s.open)
  const sizePercent = useAuxiliaryShell((s) => s.sizePercent)
  const setOpen = useAuxiliaryShell((s) => s.setOpen)
  const setSizePercent = useAuxiliaryShell((s) => s.setSizePercent)
  const isMobile = useIsMobile()
  const [dragging, setDragging] = useState(false)

  // Keep shell/store in sync if mobile sheet is dismissed.
  useEffect(() => {
    if (!isMobile && !open) setDragging(false)
  }, [isMobile, open])

  if (isMobile) {
    return (
      <div className="size-full min-h-0 min-w-0">
        {children}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="right"
            className="w-[min(100vw,28rem)] p-0 sm:max-w-md"
            showCloseButton={false}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Sidebar</SheetTitle>
            </SheetHeader>
            <AuxiliaryRail embedded className="border-0" />
          </SheetContent>
        </Sheet>
      </div>
    )
  }

  if (!open) {
    return <div className="size-full min-h-0 min-w-0">{children}</div>
  }

  return (
    <div className="relative size-full min-h-0 min-w-0">
      <ResizablePanelGroup
        direction="horizontal"
        className="size-full"
      >
        <ResizablePanel
          id="main"
          order={1}
          defaultSize={100 - sizePercent}
          minSize={100 - AUXILIARY_SIZE.max}
          className="min-w-0"
        >
          <div className="size-full min-h-0 min-w-0 overflow-hidden">
            {children}
          </div>
        </ResizablePanel>
        <ResizableHandle
          className="w-px bg-border/80 hover:bg-primary/40"
          onDragging={setDragging}
        />
        <ResizablePanel
          id="auxiliary"
          order={2}
          defaultSize={sizePercent}
          minSize={AUXILIARY_SIZE.min}
          maxSize={AUXILIARY_SIZE.max}
          onResize={(size) => setSizePercent(size)}
          className="min-w-0"
        >
          <AuxiliaryRail />
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Prevent iframes (artifact previews) from swallowing resize drags. */}
      {dragging
        ? createPortal(
            <div
              className={cn('fixed inset-0 z-[100] cursor-col-resize')}
              aria-hidden
            />,
            document.body
          )
        : null}
    </div>
  )
}
