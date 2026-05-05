import type { LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type MetricCardProps = {
  label: string
  value: string
  detail?: string
  icon: LucideIcon
  tone?: "default" | "emphasis" | "primary" | "accent"
}

export function MetricCard({ label, value, detail, icon: Icon, tone = "default" }: MetricCardProps) {
  const isEmphasis = tone === "emphasis"
  const isAccent = tone === "accent"
  const isPrimary = tone === "primary"
  const isTinted = isEmphasis || isAccent || isPrimary

  return (
    <Card
      className={cn(
        "overflow-hidden border-transparent",
        !isTinted && "bg-gradient-to-br from-card via-card to-accent/[0.05]",
        isEmphasis && "bg-emphasis text-emphasis-foreground",
        isAccent && "bg-accent text-accent-foreground",
        isPrimary && "bg-primary text-primary-foreground",
      )}
    >
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className={cn("truncate text-[10px] font-medium uppercase tracking-wide", isTinted ? "opacity-70" : "text-muted-foreground")}>
              {label}
            </p>
            <p className="truncate text-2xl font-semibold tracking-tight">{value}</p>
            {detail ? (
              <p className={cn("truncate text-[11px]", isTinted ? "opacity-70" : "text-muted-foreground")}>{detail}</p>
            ) : null}
          </div>
          <div
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
              isTinted ? "bg-white/15" : "bg-secondary",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
