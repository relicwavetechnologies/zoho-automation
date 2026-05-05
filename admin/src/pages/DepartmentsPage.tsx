import { Building2, Plus } from "lucide-react"
import { DataTable } from "@/components/admin/data-table"
import { EmptyState } from "@/components/admin/empty-state"
import { MetricCard } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { StatusBadge } from "@/components/admin/status-badge"
import { useApiList } from "@/components/admin/use-api-list"
import { Button } from "@/components/ui/button"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import type { JsonRecord } from "@/components/admin/types"

export function DepartmentsPage() {
  const { token } = useAdminAuth()
  const departments = useApiList<JsonRecord>("/api/admin/departments", token, ["items", "departments"])

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Departments"
        description="Department structure, role membership, skills, and tool-level permissions."
        actions={
          <Button type="button" className="rounded-full">
            <Plus className="h-4 w-4" />
            New department
          </Button>
        }
      />
      <section className="grid gap-3 md:grid-cols-3">
        <MetricCard label="Departments" value={String(departments.data.length)} detail="Loaded from admin API" icon={Building2} tone="accent" />
        <MetricCard label="Role matrix" value="Scoped" detail="Configured per department role" icon={Building2} />
        <MetricCard label="Overrides" value="Available" detail="User-level tool overrides" icon={Building2} tone="emphasis" />
      </section>
      <SectionCard title="Department registry" description="Select a department in the old API data to inspect its attached roles and skills.">
        {departments.error ? (
          <EmptyState title="Department API unavailable" description={departments.error} />
        ) : (
          <DataTable
            rows={departments.data}
            loading={departments.loading}
            emptyTitle="No departments"
            emptyDescription="Create departments to group skills, roles, and permissions."
            columns={[
              { key: "name", header: "Name" },
              { key: "slug", header: "Slug" },
              { key: "status", header: "Status", render: (row) => <StatusBadge value={String(row.status ?? "")} /> },
              { key: "updatedAt", header: "Updated" },
            ]}
          />
        )}
      </SectionCard>
    </>
  )
}
