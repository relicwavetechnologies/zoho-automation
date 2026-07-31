import { ClipboardList, RefreshCw, ShieldAlert, Users } from "lucide-react"
import { DataTable } from "@/components/admin/data-table"
import { MetricCard } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { StatusBadge } from "@/components/admin/status-badge"
import { useApiList } from "@/components/admin/use-api-list"
import { Button } from "@/components/ui/button"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { cn } from "@/lib/utils"
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
    <>
      <PageHeader
        eyebrow="Governance"
        title="Audit log"
        description="A record of privileged admin actions and their outcomes across the workspace."
        actions={
          <Button size="sm" variant="outline" onClick={() => void audit.refresh()} disabled={audit.loading || audit.refreshing}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", audit.refreshing && "animate-spin")} />
            Refresh
          </Button>
        }
      />
      <section className="grid gap-3 md:grid-cols-3">
        <MetricCard label="Events" value={String(events.length)} detail="Most recent admin actions" icon={ClipboardList} tone="emphasis" />
        <MetricCard label="Actors" value={String(actors)} detail="Distinct admins" icon={Users} />
        <MetricCard label="Failures" value={String(failures)} detail="Failed or rejected outcomes" icon={ShieldAlert} />
      </section>
      <SectionCard title="Recent activity" description="Admin actions and their outcomes, newest first.">
        <DataTable
          rows={events}
          loading={audit.loading}
          emptyTitle="No audit logs"
          emptyDescription="Audit events will appear after privileged actions run."
          columns={[
            { key: "action", header: "Action" },
            { key: "actorId", header: "Actor" },
            { key: "outcome", header: "Outcome", render: (row) => <StatusBadge value={String(row.outcome ?? "")} /> },
            { key: "createdAt", header: "Created" },
          ]}
        />
      </SectionCard>
    </>
  )
}
