import { cn } from '../../lib/utils'

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Skeleton({ className, ...props }: SkeletonProps): JSX.Element {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md bg-white/[0.05]',
        className
      )}
      {...props}
    >
      <div 
        className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/[0.08] to-transparent"
      />
    </div>
  )
}
