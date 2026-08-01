import { Building2, Plus, Shield, Users } from "lucide-react"
import { DataTable } from "@/components/admin/data-table"
import { EmptyState } from "@/components/admin/empty-state"
import { MetricCard, MetricStrip } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { StatusBadge } from "@/components/admin/status-badge"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { CreateDepartmentDialog } from "./departments/CreateDepartmentDialog"
import { DepartmentDrawer } from "./departments/DepartmentDrawer"
import { useDepartmentData } from "./departments/use-department-data"
import { useMemo, useState } from "react"

export function DepartmentsPage() {
  const { session } = useAdminAuth()
  const {
    departments,
    detailById,
    toolCatalogById,
    loading,
    error,
    stats,
    loadDetailSection,
    isSectionLoading,
    getSectionError,
    createDepartment,
    updateDepartment,
    archiveDepartment,
    createRole,
    updateRole,
    deleteRole,
    upsertMembership,
    removeMembership,
    searchCandidates,
    setRolePermission,
    setUserOverride,
    updateConfig,
  } = useDepartmentData()

  const [selectedDepartmentId, setSelectedDepartmentId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const selectedDepartment = useMemo(
    () => departments.find((department) => department.id === selectedDepartmentId) ?? null,
    [departments, selectedDepartmentId],
  )

  const selectedDetail = selectedDepartmentId ? detailById[selectedDepartmentId] ?? null : null
  const selectedOverviewLoading = selectedDepartmentId ? isSectionLoading(selectedDepartmentId, "overview") : false

  return (
    <div className="page">
      <PageHeader
        eyebrow={session?.companyName ?? "Organisation"}
        title="Departments"
        description="A department is the only unit below the company. Its roles decide what Divo may do for the people in it, within the company ceiling."
        actions={
          <button type="button" className="btn primary" onClick={() => setCreateOpen(true)}>
            <Plus size={14} />
            New department
          </button>
        }
      />

      <div className="ws-stack">
        <MetricStrip>
          <MetricCard label="Departments" value={String(stats.total)} detail={`${stats.roles} roles between them`} icon={Building2} />
          <MetricCard label="Active" value={String(stats.active)} detail="Routing work today" icon={Shield} />
          <MetricCard label="People" value={String(stats.members)} detail="Assigned across all departments" icon={Users} />
          <MetricCard label="Archived" value={String(stats.archived)} detail="Kept for the record, never routed to" icon={Building2} />
        </MetricStrip>

        <SectionCard
          title="Every department"
          description="Open one to manage its roles, its people and what they may do."
          flush
        >
        {error ? (
          <EmptyState title="Department API unavailable" description={error} />
        ) : (
          <DataTable
            rows={departments}
            loading={loading}
            emptyTitle="No departments yet"
            emptyDescription="Create the first one to start assigning roles, people and permissions."
            onRowClick={(row) => {
              setSelectedDepartmentId(row.id)
              void loadDetailSection(row.id, "overview")
            }}
            columns={[
              {
                key: "name",
                header: "Name",
                render: (row) => (
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>{row.name}</div>
                    <div className="ws-sub" style={{ marginTop: 3 }}>{row.description || "No description"}</div>
                  </div>
                ),
              },
              { key: "slug", header: "Slug", render: (row) => <span className="mono ws-sub">{row.slug}</span> },
              { key: "status", header: "Status", render: (row) => <StatusBadge value={row.status} /> },
              { key: "memberCount", header: "People" },
              { key: "roleCount", header: "Roles" },
              {
                key: "hasAgentConfig",
                header: "Config",
                render: (row) => (
                  <span className={row.hasAgentConfig ? "badge b-ok" : "badge"}>
                    {row.hasAgentConfig ? <span className="dot" /> : null}
                    {row.hasAgentConfig ? "Ready" : "Not set up"}
                  </span>
                ),
              },
            ]}
          />
        )}
        </SectionCard>
      </div>

      <DepartmentDrawer
        department={selectedDepartment}
        detail={selectedDetail}
        detailLoading={selectedOverviewLoading}
        toolCatalogById={toolCatalogById}
        onClose={() => setSelectedDepartmentId(null)}
        onLoadSection={loadDetailSection}
        isSectionLoading={isSectionLoading}
        getSectionError={getSectionError}
        onUpdateDepartment={updateDepartment}
        onArchiveDepartment={archiveDepartment}
        onCreateRole={createRole}
        onUpdateRole={updateRole}
        onDeleteRole={deleteRole}
        onSearchCandidates={searchCandidates}
        onAddMember={upsertMembership}
        onRemoveMember={removeMembership}
        onSetRolePermission={setRolePermission}
        onSetUserOverride={setUserOverride}
        onUpdateConfig={updateConfig}
      />

      <CreateDepartmentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={async (data) => {
          const created = await createDepartment(data)
          if (created?.id) {
            setSelectedDepartmentId(created.id)
            void loadDetailSection(created.id, "overview", true)
          }
          return created
        }}
      />
    </div>
  )
}
