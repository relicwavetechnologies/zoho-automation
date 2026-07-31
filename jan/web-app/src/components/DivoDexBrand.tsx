import { cn } from '@/lib/utils'
import { useId } from 'react'

type DivoDexMarkProps = {
  className?: string
  decorative?: boolean
}

export function DivoDexMark({
  className,
  decorative = false,
}: DivoDexMarkProps) {
  const maskId = useId().replace(/:/g, '')

  return (
    <svg
      viewBox="0 0 64 64"
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : 'Divo Dex'}
      aria-hidden={decorative || undefined}
      className={cn('shrink-0', className)}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
          <rect width="64" height="64" fill="#fff" />
          <path d="M5 59 59 5" stroke="#000" strokeWidth="9.5" />
        </mask>
      </defs>
      <path
        d="M17 10h9a22 22 0 0 1 0 44h-9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinejoin="round"
        mask={`url(#${maskId})`}
      />
    </svg>
  )
}

type DivoDexWordmarkProps = {
  className?: string
  markClassName?: string
  textClassName?: string
}

export function DivoDexWordmark({
  className,
  markClassName,
  textClassName,
}: DivoDexWordmarkProps) {
  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      <DivoDexMark decorative className={cn('size-5', markClassName)} />
      <span className={cn('font-medium font-studio', textClassName)}>Divo Dex</span>
    </div>
  )
}
