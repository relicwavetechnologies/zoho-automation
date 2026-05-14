import { useState } from "react"
import { ArrowUpRight, CheckCircle2, AlertTriangle, XCircle, ClipboardList, PlugZap, RefreshCw, Shield, SlidersHorizontal, Sparkles, Wrench } from "lucide-react"
import { Link, useSearchParams } from "react-router-dom"
import { DataTable } from "@/components/admin/data-table"
import { MetricCard } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { StatusBadge } from "@/components/admin/status-badge"
import { useApiList } from "@/components/admin/use-api-list"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { companyIntegrationsApi } from "@/lib/api"
import type { ZohoScopeLevel } from "@/lib/api"
import type { JsonRecord } from "@/components/admin/types"

const SCOPE_LABELS: Record<string, string> = {
  read_only: "Read only",
  read_write: "Read + Write",
  full: "Full access",
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—"
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function IntegrationCard({ provider, data, actions }: {
  provider: string
  data: JsonRecord | undefined
  actions?: React.ReactNode
}) {
  const connected = data?.connected === true
  const status = String(data?.status ?? "disconnected")
  const isError = status === "error"
  const connectedAt = data?.connectedAt as string | null ?? null
  const scopeLevel = data?.scopeLevel as string | null ?? null
  const error = data?.error as string | null ?? null
  const details = data?.details as Record<string, unknown> | null ?? null

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-soft">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${connected && !isError ? "bg-green-500/10 text-green-600" : isError ? "bg-red-500/10 text-red-500" : "bg-muted text-muted-foreground"}`}>
            {connected && !isError ? <CheckCircle2 className="h-4 w-4" /> : isError ? <AlertTriangle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          </div>
          <div>
            <p className="text-[13px] font-semibold capitalize">{provider}</p>
            <p className="text-[11px] text-muted-foreground">
              {connected && !isError ? `Connected ${formatRelativeTime(connectedAt)}` : isError ? "Token error — reconnect required" : "Not connected"}
            </p>
          </div>
        </div>
        <div className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium ${connected && !isError ? "bg-green-500/10 text-green-700" : isError ? "bg-red-500/10 text-red-600" : "bg-muted text-muted-foreground"}`}>
          {connected && !isError ? "Connected" : isError ? "Error" : "Disconnected"}
        </div>
      </div>

      {(scopeLevel || details || error) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-[11px] text-muted-foreground">
          {scopeLevel ? <span>{"Access: "}<strong className="text-foreground">{SCOPE_LABELS[scopeLevel] ?? scopeLevel}</strong></span> : null}
          {details?.email ? <span>{"Account: "}<strong className="text-foreground">{`${details.email}`}</strong></span> : null}
          {details?.tenantKey ? <span>{"Tenant: "}<strong className="text-foreground">{`${details.tenantKey}`.slice(0, 12)}…</strong></span> : null}
          {details?.environment ? <span>{"Env: "}<strong className="text-foreground">{`${details.environment}`}</strong></span> : null}
          {error ? <span className="text-red-500">{`Error: ${error}`}</span> : null}
        </div>
      )}

      {actions && <div className="flex items-end gap-2 border-t pt-3">{actions}</div>}
    </div>
  )
}

const validTabs = new Set(["integrations", "governance", "audit", "controls", "permissions"])

export function SettingsPage() {
  const { token } = useAdminAuth()
  const [zohoScope, setZohoScope] = useState<ZohoScopeLevel>("read_only")
  const [params, setParams] = useSearchParams()
  const activeTab = validTabs.has(params.get("tab") ?? "") ? params.get("tab") ?? "integrations" : "integrations"
  const integrations = useApiList<JsonRecord>("/api/admin/company/onboarding/status", token, ["items", "providers"])
  const permissions = useApiList<JsonRecord>("/api/admin/rbac/permissions", token, ["items", "permissions"])
  const audit = useApiList<JsonRecord>("/api/admin/audit/logs?limit=30", token, ["items", "logs"])
  const controls = useApiList<JsonRecord>("/api/admin/controls", token, ["items", "controls"])
  const tools = useApiList<JsonRecord>("/api/admin/company/tool-permissions", token, ["items", "permissions", "tools"])

  const [busy, setBusy] = useState<string | null>(null)

  const startZohoConnect = async () => {
    if (!token) return
    setBusy("zoho")
    try {
      const result = await companyIntegrationsApi.startZoho(zohoScope, token)
      window.open(result.authUrl, "_blank", "noopener,noreferrer")
    } finally {
      setBusy(null)
    }
  }

  const startLarkConnect = async () => {
    if (!token) return
    setBusy("lark")
    try {
      const result = await companyIntegrationsApi.startLark(token)
      window.open(result.url, "_blank", "noopener,noreferrer")
    } finally {
      setBusy(null)
    }
  }

  const startGoogleConnect = async () => {
    if (!token) return
    setBusy("google")
    try {
      const result = await companyIntegrationsApi.startGoogle("company", token)
      window.open(result.url, "_blank", "noopener,noreferrer")
    } finally {
      setBusy(null)
    }
  }

  const disconnectProvider = async (provider: string) => {
    if (!token) return
    setBusy(provider + "-disconnect")
    try {
      await companyIntegrationsApi.disconnect(provider, token)
      integrations.refresh?.()
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Governance and integrations"
        description="Connection status, RBAC, audit logs, runtime controls, and tool permissions in one calibrated surface."
        actions={
          <Button asChild size="sm">
            <Link to="/ai-providers">
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              AI Providers
            </Link>
          </Button>
        }
      />
      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label="Integrations" value={String(integrations.data.length)} detail="Provider status rows" icon={PlugZap} tone="accent" />
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
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="governance">Governance</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="controls">Controls</TabsTrigger>
          <TabsTrigger value="permissions">Tool permissions</TabsTrigger>
        </TabsList>
        <TabsContent value="integrations">
          <SectionCard title="AI provider routing" description="Connect OpenAI Codex Gateway accounts and choose the default orchestration model.">
            <div className="flex flex-col gap-3 rounded-lg bg-card p-3 shadow-soft md:flex-row md:items-center md:justify-between">
              <div className="flex min-w-0 items-start gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emphasis text-emphasis-foreground">
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold">OpenAI Codex account</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">Manage Gateway credentials, dedicated account status, and model routing.</p>
                </div>
              </div>
              <Button asChild size="sm" variant="outline" className="shrink-0">
                <Link to="/ai-providers">
                  Open
                  <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </SectionCard>
          <SectionCard title="Connected integrations" description="Manage your Zoho, Lark, and Google connections.">
            <div className="grid gap-3">
              {integrations.loading ? (
                <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">Loading integrations…</div>
              ) : (
                <>
                  <IntegrationCard
                    provider="zoho"
                    data={integrations.data.find((r) => r.provider === "zoho")}
                    actions={
                      <>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-medium text-muted-foreground">Access level</label>
                          <Select value={zohoScope} onValueChange={(v) => setZohoScope(v as ZohoScopeLevel)}>
                            <SelectTrigger className="w-[180px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="read_only">Read only</SelectItem>
                              <SelectItem value="read_write">Read + Write</SelectItem>
                              <SelectItem value="full">Full access</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {integrations.data.find((r) => r.provider === "zoho")?.connected ? (
                          <>
                            <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void startZohoConnect()}>
                              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                              {busy === "zoho" ? "Reconnecting…" : "Reconnect"}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" className="text-red-500 hover:text-red-600" disabled={busy !== null} onClick={() => void disconnectProvider("zoho")}>
                              {busy === "zoho-disconnect" ? "Disconnecting…" : "Disconnect"}
                            </Button>
                          </>
                        ) : (
                          <Button type="button" size="sm" disabled={busy !== null} onClick={() => void startZohoConnect()}>
                            {busy === "zoho" ? "Connecting…" : "Connect"}
                            <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
                          </Button>
                        )}
                      </>
                    }
                  />
                  <IntegrationCard
                    provider="lark"
                    data={integrations.data.find((r) => r.provider === "lark")}
                    actions={
                      integrations.data.find((r) => r.provider === "lark")?.connected ? (
                        <>
                          <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void startLarkConnect()}>
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                            {busy === "lark" ? "Reconnecting…" : "Reconnect"}
                          </Button>
                          <Button type="button" size="sm" variant="ghost" className="text-red-500 hover:text-red-600" disabled={busy !== null} onClick={() => void disconnectProvider("lark")}>
                            {busy === "lark-disconnect" ? "Disconnecting…" : "Disconnect"}
                          </Button>
                        </>
                      ) : (
                        <Button type="button" size="sm" disabled={busy !== null} onClick={() => void startLarkConnect()}>
                          {busy === "lark" ? "Connecting…" : "Connect"}
                          <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
                        </Button>
                      )
                    }
                  />
                  <IntegrationCard
                    provider="google"
                    data={integrations.data.find((r) => r.provider === "google")}
                    actions={
                      integrations.data.find((r) => r.provider === "google")?.connected ? (
                        <>
                          <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void startGoogleConnect()}>
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                            {busy === "google" ? "Reconnecting…" : "Reconnect"}
                          </Button>
                          <Button type="button" size="sm" variant="ghost" className="text-red-500 hover:text-red-600" disabled={busy !== null} onClick={() => void disconnectProvider("google")}>
                            {busy === "google-disconnect" ? "Disconnecting…" : "Disconnect"}
                          </Button>
                        </>
                      ) : (
                        <Button type="button" size="sm" disabled={busy !== null} onClick={() => void startGoogleConnect()}>
                          {busy === "google" ? "Connecting…" : "Connect"}
                          <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
                        </Button>
                      )
                    }
                  />
                </>
              )}
            </div>
          </SectionCard>
        </TabsContent>
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
