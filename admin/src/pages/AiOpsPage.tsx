import { Activity, Brain, Cpu, Gauge } from "lucide-react"
import { DataTable } from "@/components/admin/data-table"
import { MetricCard } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { StatusBadge } from "@/components/admin/status-badge"
import { useApiList } from "@/components/admin/use-api-list"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import type { JsonRecord } from "@/components/admin/types"

export function AiOpsPage() {
  const { token } = useAdminAuth()
  const executions = useApiList<JsonRecord>("/api/admin/executions?limit=25", token, ["items", "runs"])
  const models = useApiList<JsonRecord>("/api/admin/ai-models", token, ["items", "targets"])
  const tasks = useApiList<JsonRecord>("/api/admin/runtime/tasks?limit=25", token, ["items", "tasks"])

  return (
    <>
      <PageHeader
        eyebrow="AI Ops"
        title="Runtime and model operations"
        description="Execution traces, model targets, and runtime controls rebuilt with a single admin design language."
      />
      <section className="grid gap-3 md:grid-cols-3">
        <MetricCard label="Executions" value={String(executions.data.length)} detail="Visible in current query" icon={Activity} tone="emphasis" />
        <MetricCard label="Model targets" value={String(models.data.length)} detail="Configured model routes" icon={Brain} tone="accent" />
        <MetricCard label="Runtime tasks" value={String(tasks.data.length)} detail="Recent control surface" icon={Cpu} />
      </section>
      <Tabs defaultValue="executions">
        <TabsList className="rounded-full">
          <TabsTrigger value="executions" className="rounded-full">Executions</TabsTrigger>
          <TabsTrigger value="models" className="rounded-full">Models</TabsTrigger>
          <TabsTrigger value="runtime" className="rounded-full">Runtime</TabsTrigger>
        </TabsList>
        <TabsContent value="executions">
          <SectionCard title="Execution traces" description="Read-only execution inspection using the migrated admin route.">
            <DataTable
              rows={executions.data}
              loading={executions.loading}
              emptyTitle="No executions"
              emptyDescription="Execution traces will appear after agent runs complete."
              columns={[
                { key: "id", header: "Run" },
                { key: "channel", header: "Channel" },
                { key: "status", header: "Status", render: (row) => <StatusBadge value={String(row.status ?? "")} /> },
                { key: "createdAt", header: "Created" },
              ]}
            />
          </SectionCard>
        </TabsContent>
        <TabsContent value="models">
          <SectionCard title="Model targets" description="Provider and model routing from the admin AI models API.">
            <DataTable
              rows={models.data}
              loading={models.loading}
              emptyTitle="No model targets"
              emptyDescription="Model configuration rows will appear when the backend exposes them."
              columns={[
                { key: "targetKey", header: "Target" },
                { key: "provider", header: "Provider" },
                { key: "modelId", header: "Model" },
                { key: "updatedAt", header: "Updated" },
              ]}
            />
          </SectionCard>
        </TabsContent>
        <TabsContent value="runtime">
          <SectionCard title="Runtime tasks" description="Recent queue/runtime tasks with control status.">
            <DataTable
              rows={tasks.data}
              loading={tasks.loading}
              emptyTitle="No runtime tasks"
              emptyDescription="Runtime tasks will appear as orchestration work is queued."
              columns={[
                { key: "taskId", header: "Task" },
                { key: "status", header: "Status", render: (row) => <StatusBadge value={String(row.status ?? "")} /> },
                { key: "engine", header: "Engine" },
                { key: "updatedAt", header: "Updated" },
              ]}
            />
          </SectionCard>
        </TabsContent>
      </Tabs>
    </>
  )
}
