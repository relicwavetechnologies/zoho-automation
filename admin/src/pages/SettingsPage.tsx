import { ClipboardList, RefreshCw, ShieldAlert, Users } from "lucide-react"
import { DataTable } from "@/components/admin/data-table"
import { MetricCard, MetricStrip } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { StatusBadge } from "@/components/admin/status-badge"
import { useApiList } from "@/components/admin/use-api-list"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import type { JsonRecord } from "@/components/admin/types"

// Outcomes the audit backend reports for a failed or rejected action.
const FAILURE_OUTCOMES = new Set(["failed", "error", "rejected", "cancelled", "expired", "revoked", "denied"])

export function SettingsPage() {
  const { token } = useAdminAuth()
  const audit = useApiList<JsonRecord>("/api/admin/audit/logs?limit=50", token, ["items", "logs"])

  const events = audit.data
  const failures = events.filter((event) => FAILURE_OUTCOMES.has(String(event.outcome ?? "").toLowerCase())).length
  const actors = new Set(events.map((event) => String(event.actorId ?? "")).filter(Boolean)).size

  return (
    <div className="page">
      <PageHeader
        eyebrow="Governance"
        title="Audit log"
        description="A record of privileged admin actions and their outcomes across the workspace."
        actions={
          <button type="button" className="btn" onClick={() => void audit.refresh()} disabled={audit.loading || audit.refreshing}>
            <RefreshCw size={14} className={audit.refreshing ? "ws-spin" : undefined} />
            Refresh
          </button>
        }
      />
      <div className="ws-stack">
        <MetricStrip columns={3}>
          <MetricCard label="Events" value={String(events.length)} detail="The 50 most recent privileged actions" icon={ClipboardList} />
          <MetricCard label="Actors" value={String(actors)} detail="Distinct admins involved" icon={Users} />
          <MetricCard label="Failures" value={String(failures)} detail="Refused, expired or rolled back" icon={ShieldAlert} />
        </MetricStrip>
        <SectionCard title="Recent activity" description="Admin actions and their outcomes, newest first." flush>
          <DataTable
            rows={events}
            loading={audit.loading}
            emptyTitle="Nothing recorded yet"
            emptyDescription="Audit events appear here after a privileged action runs — grants, ceiling changes, connections and approvals."
            columns={[
              { key: "action", header: "Action" },
              { key: "actorId", header: "Actor" },
              { key: "outcome", header: "Outcome", render: (row) => <StatusBadge value={String(row.outcome ?? "")} /> },
              { key: "createdAt", header: "Created" },
            ]}
          />
        </SectionCard>
      </div>
    </div>
  )
}
