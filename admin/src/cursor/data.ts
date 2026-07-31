/*
 * Shared trace/status types + the status-pill mapping used across the Cursor
 * admin pages. The former mock constants (people/runs/spend/trace) were removed
 * once every page was wired to real backend data — see use-run-detail.ts,
 * use-ai-ops.ts, and use-spend.ts for the live data seams.
 */

export type RunStatus = "ok" | "err" | "run"

export interface TraceTool {
  n: string
  stage: "thinking" | "read" | "grep" | "edit" | "done"
  label: string
  i: Record<string, unknown>
  o: Record<string, unknown>
  /** real-data extras (reconstructed runs): tool errored / precomputed subtitle */
  _error?: boolean
  _subtitle?: string
}

/** Status → mock badge markup class + label. */
export const statusBadge = (s: RunStatus): { cls: string; label: string } =>
  s === "ok" ? { cls: "b-ok", label: "completed" } : s === "err" ? { cls: "b-err", label: "failed" } : { cls: "b-run", label: "running" }
