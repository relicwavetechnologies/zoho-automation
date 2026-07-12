import { ClipboardList, Shield, SlidersHorizontal, Sparkles, Wrench } from "lucide-react"
import { Link, useSearchParams } from "react-router-dom"
import { DataTable } from "@/components/admin/data-table"
import { MetricCard } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { StatusBadge } from "@/components/admin/status-badge"
import { useApiList } from "@/components/admin/use-api-list"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import type { JsonRecord } from "@/components/admin/types"

const validTabs = new Set(["governance", "audit", "controls", "permissions"])

export function SettingsPage() {
  const { token } = useAdminAuth()
  const [params, setParams] = useSearchParams()
  const activeTab = validTabs.has(params.get("tab") ?? "") ? params.get("tab") ?? "governance" : "governance"
  const permissions = useApiList<JsonRecord>("/api/admin/rbac/permissions", token, ["items", "permissions"])
  const audit = useApiList<JsonRecord>("/api/admin/audit/logs?limit=30", token, ["items", "logs"])
  const controls = useApiList<JsonRecord>("/api/admin/controls", token, ["items", "controls"])
  const tools = useApiList<JsonRecord>("/api/admin/company/tool-permissions", token, ["items", "permissions", "tools"])

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Governance"
        description="RBAC, audit logs, runtime controls, and tool permissions in one calibrated surface."
        actions={
          <Button asChild size="sm">
            <Link to="/ai-providers">
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              AI Providers
            </Link>
          </Button>
        }
      />
      <section className="grid gap-3 md:grid-cols-3">
        <MetricCard label="RBAC" value={String(permissions.data.length)} detail="Permission rows" icon={Shield} />
        <MetricCard label="Audit" value={String(audit.data.length)} detail="Recent events" icon={ClipboardList} tone="emphasis" />
        <MetricCard label="Controls" value={String(controls.data.length)} detail="Runtime controls" icon={SlidersHorizontal} />
      </section>
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          params.set("tab", value)
          setParams(params)
        }}
      >
        <TabsList className="flex h-auto flex-wrap justify-start rounded-2xl p-1">
          <TabsTrigger value="governance">Governance</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="controls">Controls</TabsTrigger>
          <TabsTrigger value="permissions">Tool permissions</TabsTrigger>
        </TabsList>
        <TabsContent value="governance">
          <SectionCard title="RBAC permissions" description="Role-action rules from the old admin RBAC route.">
            <DataTable
              rows={permissions.data}
              loading={permissions.loading}
              emptyTitle="No RBAC rows"
              emptyDescription="RBAC permissions will appear when the backend route is migrated."
              columns={[
                { key: "role", header: "Role" },
                { key: "action", header: "Action" },
                { key: "allowed", header: "Allowed" },
                { key: "updatedAt", header: "Updated" },
              ]}
            />
          </SectionCard>
        </TabsContent>
        <TabsContent value="audit">
          <SectionCard title="Audit logs" description="Admin actions and their outcomes.">
            <DataTable
              rows={audit.data}
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
        </TabsContent>
        <TabsContent value="controls">
          <SectionCard title="Runtime controls" description="Feature controls and operational safety switches.">
            <DataTable
              rows={controls.data}
              loading={controls.loading}
              emptyTitle="No controls"
              emptyDescription="Controls will appear when the admin controls route is migrated."
              columns={[
                { key: "key", header: "Control" },
                { key: "enabled", header: "Enabled" },
                { key: "updatedAt", header: "Updated" },
              ]}
            />
          </SectionCard>
        </TabsContent>
        <TabsContent value="permissions">
          <SectionCard title="Tool permissions" description="Company role and tool action permission matrix.">
            <DataTable
              rows={tools.data}
              loading={tools.loading}
              emptyTitle="No tool permissions"
              emptyDescription="Tool permission rows will appear once company-admin APIs are migrated."
              columns={[
                { key: "toolId", header: "Tool" },
                { key: "role", header: "Role" },
                { key: "enabled", header: "Enabled" },
                { key: "updatedAt", header: "Updated" },
              ]}
            />
          </SectionCard>
        </TabsContent>
      </Tabs>
      <SectionCard title="Design system note" description="Every control on this page is built from the new shadcn primitive layer.">
        <div className="flex items-center gap-3 rounded-lg bg-secondary p-4 text-sm text-muted-foreground">
          <Wrench className="h-4 w-4 text-foreground" aria-hidden="true" />
          API-backed data appears as each admin route lands in the advanced backend.
        </div>
      </SectionCard>
    </>
  )
}
