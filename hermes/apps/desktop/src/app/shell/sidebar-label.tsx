import type * as React from 'react'

import { cn } from '@/lib/utils'

// Section label in the rails — Cursor/VS Code style: a small, muted, uppercase
// caption with letter-spacing and no decorative dot.
export function SidebarPanelLabel({ children, className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'flex min-w-0 items-center pl-2 text-[0.64rem] font-semibold uppercase tracking-[0.14em] text-(--ui-text-tertiary)',
        className
      )}
      {...props}
    >
      <span className="min-w-0 truncate leading-none">{children}</span>
    </span>
  )
}
