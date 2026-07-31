import { Badge } from "@/components/ui/badge"

type StatusBadgeProps = {
  value?: string | null
}

const positive = new Set(["active", "connected", "healthy", "success", "completed", "paid", "accepted"])
const warning = new Set(["pending", "running", "queued", "not paid", "degraded"])
const negative = new Set(["failed", "error", "rejected", "cancelled", "expired", "disconnected", "revoked"])

export function StatusBadge({ value }: StatusBadgeProps) {
  const label = value || "unknown"
  const normalized = label.toLowerCase()
  const variant = positive.has(normalized) ? "success" : negative.has(normalized) ? "destructive" : warning.has(normalized) ? "secondary" : "outline"
  return (
    <Badge variant={variant} className="text-[10px] font-semibold uppercase tracking-wide">
      {label}
    </Badge>
  )
}
