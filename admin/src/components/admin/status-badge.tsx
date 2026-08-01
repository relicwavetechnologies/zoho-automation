/**
 * Status pill. Maps a backend outcome string onto the three badge tones
 * cursor.css defines, so a status looks the same here as it does on a run row.
 */
type StatusBadgeProps = {
  value?: string | null
}

const positive = new Set(["active", "connected", "healthy", "success", "completed", "paid", "accepted", "ready"])
const running = new Set(["pending", "running", "queued", "not paid", "degraded"])
const negative = new Set(["failed", "error", "rejected", "cancelled", "expired", "disconnected", "revoked", "denied", "archived"])

export function StatusBadge({ value }: StatusBadgeProps) {
  const label = value || "unknown"
  const normalized = label.toLowerCase()
  const tone = positive.has(normalized) ? "b-ok" : negative.has(normalized) ? "b-err" : running.has(normalized) ? "b-run" : ""
  return (
    <span className={tone ? `badge ${tone}` : "badge"}>
      {tone ? <span className="dot" /> : null}
      {label}
    </span>
  )
}
