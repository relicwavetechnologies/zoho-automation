import { useAuxiliaryShell } from '@/hooks/useAuxiliaryShell'
import { useTitlebarLayout } from '@/stores/titlebar-layout-store'

/**
 * Frameless-window drag strip. Intentionally inset from the left/right so
 * traffic lights, window controls, and header actions stay clickable — a
 * full-bleed drag overlay steals hover (cursor: grab) and clicks.
 *
 * When the auxiliary rail is open, also reserve its top strip so tab close /
 * focus controls are not covered by the drag layer.
 */
export function WindowDragRegion() {
  const leftCount = useTitlebarLayout((s) => s.layout.left.length)
  const rightCount = useTitlebarLayout((s) => s.layout.right.length)
  const auxiliaryOpen = useAuxiliaryShell((s) => s.open)
  const sizePercent = useAuxiliaryShell((s) => s.sizePercent)

  // macOS traffic lights sit under a padded header; Windows/Linux in-app
  // controls are absolute. Always leave room for the auxiliary toggle (~2.75rem).
  const leftInset = IS_MACOS
    ? 88
    : Math.max(12, leftCount > 0 ? leftCount * 32 + 24 : 12)
  const windowControlsWidth =
    (IS_WINDOWS || IS_LINUX) && rightCount > 0 ? rightCount * 32 + 24 : 0
  const controlsInset = Math.max(52, windowControlsWidth + 44)
  // sizePercent is of the main/aux panel group; using it as a viewport % is a
  // slight over-reserve when the left sidebar is open — safer than under-cutting.
  const rightInset = auxiliaryOpen
    ? `max(${controlsInset}px, calc(${sizePercent}% + 10px))`
    : controlsInset

  if (!IS_TAURI) return null

  return (
    <div
      className="fixed top-0 z-20 h-12 cursor-grab active:cursor-grabbing"
      style={{ left: leftInset, right: rightInset }}
      title="Drag window"
      aria-label="Window drag area"
      data-tauri-drag-region
    />
  )
}
