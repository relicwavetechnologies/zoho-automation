import type { ComponentProps, FC, ReactNode } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { larkContextKindLabel, type LarkContextDisplayRef, type LarkContextRef } from '@/lib/today-panel'
import { cn } from '@/lib/utils'

type LarkContextRefChipSource = LarkContextRef | LarkContextDisplayRef

interface LarkContextRefChipProps {
  ref: LarkContextRefChipSource
  onRemove?: () => void
  className?: string
}

export const LarkContextRefChip: FC<LarkContextRefChipProps> = ({ ref: contextRef, onRemove, className }) => {
  const tooltip = contextRef.detail ? (
    <>
      <span className="block font-medium">{contextRef.label}</span>
      <span className="mt-0.5 block text-[10px] text-background/70">{contextRef.detail}</span>
    </>
  ) : (
    contextRef.label
  )

  const chip = (
    <span
      className={cn(
        'inline-flex max-w-[14rem] items-center gap-1 rounded-md border border-[color-mix(in_srgb,#7fa9cf_40%,transparent)] bg-[color-mix(in_srgb,#7fa9cf_10%,#121820)] py-0.5 pl-1.5 text-[10.5px] text-[#c5d9ed]',
        onRemove ? 'pr-0.5' : 'pr-1.5',
        className
      )}
      data-slot="lark-context-ref-chip"
    >
      <span className="shrink-0 text-[8px] font-semibold uppercase tracking-[0.06em] text-[#7fa9cf]">
        {larkContextKindLabel(contextRef.kind)}
      </span>
      <span className="min-w-0 truncate">{contextRef.label}</span>
      {onRemove ? (
        <button
          aria-label={`Remove ${contextRef.label}`}
          className="grid size-3.5 shrink-0 place-items-center rounded text-[#888] hover:text-[#ccc]"
          onClick={onRemove}
          type="button"
        >
          <Codicon name="close" size="0.625rem" />
        </button>
      ) : null}
    </span>
  )

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent
          className="max-w-[18rem] border border-[#3a4a5a] bg-[#1a2430] px-2.5 py-1.5 text-[11px] leading-snug text-[#d8e8f7] shadow-lg"
          side="top"
          sideOffset={6}
        >
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function LarkContextRefChipList({
  children,
  className,
  ...props
}: ComponentProps<'div'>) {
  return (
    <div className={cn('flex flex-wrap gap-1', className)} data-slot="lark-context-ref-chips" {...props}>
      {children}
    </div>
  )
}
