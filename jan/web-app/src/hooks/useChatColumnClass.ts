import { useAuxiliaryShell } from '@/hooks/useAuxiliaryShell'
import { cn } from '@/lib/utils'

/**
 * Chat column width that reflows when the auxiliary rail is open.
 * Avoids hard-coded viewport % widths fighting the right panel.
 */
export function useChatColumnClass(className?: string) {
  const railOpen = useAuxiliaryShell((s) => s.open)

  return cn(
    'mx-auto w-full min-w-0 px-4',
    railOpen
      ? 'max-w-2xl md:max-w-3xl'
      : 'md:w-[58%] md:max-w-none xl:w-[48%] md:px-0',
    className
  )
}
