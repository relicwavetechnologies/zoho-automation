import type { ReactNode } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type SectionCardProps = {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** When true, applies a more visible accent gradient (matches the home page right rail). */
  hero?: boolean
}

export function SectionCard({ title, description, actions, children, className, hero }: SectionCardProps) {
  return (
    <Card
      className={cn(
        "border-transparent bg-gradient-to-br via-card to-accent/[0.05]",
        hero ? "from-accent/15 to-card" : "from-card",
        className,
      )}
    >
      <CardHeader className="flex flex-col gap-2 p-3 pb-2 md:flex-row md:items-start md:justify-between">
        <div className="space-y-0.5">
          <CardTitle className="text-[13px] font-semibold">{title}</CardTitle>
          {description ? <CardDescription className="text-[11px]">{description}</CardDescription> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-1.5">{actions}</div> : null}
      </CardHeader>
      <CardContent className="p-3 pt-0">{children}</CardContent>
    </Card>
  )
}
