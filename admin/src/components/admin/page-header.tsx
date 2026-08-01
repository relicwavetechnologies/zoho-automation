import type { ReactNode } from "react"

/**
 * Page header for the pages still on the shared admin components.
 *
 * Same markup as the Workspace `PageHeader` (`.ws-ph`) so the two sets of
 * pages have identical rhythm — a header that is a few pixels off is the kind
 * of thing nobody can name but everybody registers as "these are two apps".
 */
type PageHeaderProps = {
  eyebrow?: string
  title: string
  description?: string
  actions?: ReactNode
}

export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <div className="ws-ph">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1 style={{ marginTop: eyebrow ? 7 : 0 }}>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="ws-ph-act">{actions}</div> : null}
    </div>
  )
}
