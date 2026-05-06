import { Building2, Plus, Shield, Users } from "lucide-react"
import { DataTable } from "@/components/admin/data-table"
import { EmptyState } from "@/components/admin/empty-state"
import { MetricCard } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { StatusBadge } from "@/components/admin/status-badge"
import { Button } from "@/components/ui/button"
import { CreateDepartmentDialog } from "./departments/CreateDepartmentDialog"
import { DepartmentDrawer } from "./departments/DepartmentDrawer"
import { useDepartmentData } from "./departments/use-department-data"
import { useMemo, useState } from "react"

export function DepartmentsPage() {
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
    <>
      <PageHeader
        eyebrow="Organization"
        title="Departments"
        description="Create departments, manage roles and members, tune tool permissions, and configure the department agent surface."
        actions={
          <Button
            type="button"
            className="h-8 gap-1.5 rounded-md bg-emphasis px-3 text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            New department
          </Button>
        }
      />

      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label="Departments" value={String(stats.total)} detail={`${stats.roles} roles across the org`} icon={Building2} />
        <MetricCard label="Active" value={String(stats.active)} detail="Currently operating" icon={Shield} tone="accent" />
        <MetricCard label="Members" value={String(stats.members)} detail="Assigned across all departments" icon={Users} />
        <MetricCard label="Archived" value={String(stats.archived)} detail="Hidden from active routing" icon={Building2} tone="emphasis" />
      </section>

      <SectionCard title="Department registry" description="Select a department to open the full management drawer.">
        {error ? (
          <EmptyState title="Department API unavailable" description={error} />
        ) : (
          <DataTable
            rows={departments}
            loading={loading}
            emptyTitle="No departments"
            emptyDescription="Create the first department to start assigning roles, memberships, and permissions."
            onRowClick={(row) => {
              setSelectedDepartmentId(row.id)
              void loadDetailSection(row.id, "overview")
            }}
            columns={[
              {
                key: "name",
                header: "Name",
                render: (row) => (
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold">{row.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{row.description || "No description"}</p>
                  </div>
                ),
              },
              { key: "slug", header: "Slug", render: (row) => <span className="font-mono text-[12px] text-muted-foreground">{row.slug}</span> },
              { key: "status", header: "Status", render: (row) => <StatusBadge value={row.status} /> },
              { key: "memberCount", header: "Members" },
              { key: "roleCount", header: "Roles" },
              {
                key: "hasAgentConfig",
                header: "Config",
                render: (row) => (
                  <span className={row.hasAgentConfig ? "text-[12px] font-medium text-emerald-600 dark:text-emerald-400" : "text-[12px] text-muted-foreground"}>
                    {row.hasAgentConfig ? "Ready" : "Missing"}
                  </span>
                ),
              },
            ]}
          />
        )}
      </SectionCard>

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
    </>
  )
}
