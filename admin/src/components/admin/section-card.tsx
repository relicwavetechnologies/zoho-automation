import type { ReactNode } from "react"

/**
 * A titled panel. Was a shadcn Card with a gradient wash; now the same
 * `.ws-panel` the Workspace screens use — hairline border, no gradient, no
 * shadow. Depth in this design language is a one-pixel rule, not a glow.
 */
type SectionCardProps = {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** Content that should sit flush to the panel edges (tables, row lists). */
  flush?: boolean
}

export function SectionCard({ title, description, actions, children, className, flush }: SectionCardProps) {
  return (
    <section className={className ? `ws-panel ${className}` : "ws-panel"}>
      <header>
        <div className="ws-panel-t">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div> : null}
      </header>
      {flush ? children : <div className="ws-panel-body">{children}</div>}
    </section>
  )
}
