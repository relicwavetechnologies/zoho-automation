import { statusBadge, type RunStatus } from "@/cursor/data"

/** Status pill — matches the mock's `.badge.b-*` with the leading dot. */
export function StatusPill({ status }: { status: RunStatus }) {
  const { cls, label } = statusBadge(status)
  return (
    <span className={`badge ${cls}`}>
      <span className="dot" />
      {label}
    </span>
  )
}

/** Bar sparkline — mock `.spark` with `<i>` heights (0–100). */
export function Spark({ values }: { values: number[] }) {
  return (
    <div className="spark">
      {values.map((h, i) => (
        <i key={i} style={{ height: `${h}%` }} />
      ))}
    </div>
  )
}
