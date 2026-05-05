import type { ReactNode } from "react"

type PageHeaderProps = {
  eyebrow?: string
  title: string
  description?: string
  actions?: ReactNode
}

export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="space-y-1">
        {eyebrow ? <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-accent">{eyebrow}</p> : null}
        <div className="space-y-0.5">
          <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">{title}</h1>
          {description ? <p className="max-w-2xl text-[12px] leading-5 text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
