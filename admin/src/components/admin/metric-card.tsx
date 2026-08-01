import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

/**
 * Metric cells, joined into one strip rather than floating as separate tiles.
 *
 * The old version tinted a card per tone — one solid dark, one solid orange —
 * which spent the scarce colour on decoration and made four equal-weight
 * numbers compete for attention. They read as a set now, because that is what
 * they are.
 */
export function MetricStrip({ children, columns }: { children: ReactNode; columns?: 2 | 3 | 4 }) {
  return (
    <section className="ws-panel">
      <div className="ws-metrics" data-n={columns ?? 4}>{children}</div>
    </section>
  )
}

type MetricCardProps = {
  label: string
  value: string
  detail?: string
  icon?: LucideIcon
}

export function MetricCard({ label, value, detail, icon: Icon }: MetricCardProps) {
  return (
    <div className="ws-metric">
      <div className="k" style={{ display: "flex", alignItems: "center", gap: 7 }}>
        {Icon ? <Icon size={12} aria-hidden="true" /> : null}
        {label}
      </div>
      <div className="v">{value}</div>
      {detail ? <div className="s">{detail}</div> : null}
    </div>
  )
}
