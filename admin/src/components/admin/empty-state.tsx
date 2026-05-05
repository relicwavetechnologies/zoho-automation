import type { LucideIcon } from "lucide-react"
import { Inbox } from "lucide-react"
import { Button } from "@/components/ui/button"

type EmptyStateProps = {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  icon?: LucideIcon
}

export function EmptyState({ title, description, actionLabel, onAction, icon: Icon = Inbox }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      </div>
      {actionLabel && onAction ? (
        <Button type="button" variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}
