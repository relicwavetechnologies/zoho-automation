import type { LucideIcon } from "lucide-react"
import { Inbox } from "lucide-react"

type EmptyStateProps = {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  icon?: LucideIcon
}

export function EmptyState({ title, description, actionLabel, onAction, icon: Icon = Inbox }: EmptyStateProps) {
  return (
    <div className="ws-empty">
      <div className="ic"><Icon size={17} aria-hidden="true" /></div>
      <b>{title}</b>
      <p>{description}</p>
      {actionLabel && onAction ? (
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={onAction}>{actionLabel}</button>
        </div>
      ) : null}
    </div>
  )
}
