import type * as React from 'react'

import { cn } from '@/lib/utils'

// Section label in the rails — Cursor-style muted title text, not an all-caps
// utility caption.
export function SidebarPanelLabel({ children, className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'flex min-w-0 items-center pl-2.5 text-[0.8125rem] font-normal tracking-normal text-[#8f8f8f]',
        className
      )}
      {...props}
    >
      <span className="min-w-0 truncate leading-none">{children}</span>
    </span>
  )
}
