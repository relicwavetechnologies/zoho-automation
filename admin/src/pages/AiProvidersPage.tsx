import { useEffect, useMemo, useState } from "react"
import { Activity, CheckCircle2, CloudCog, KeyRound, PlugZap, RefreshCcw, Save, Sparkles, TestTube2, Unplug } from "lucide-react"
import { toast } from "sonner"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { MetricCard } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { StatusBadge } from "@/components/admin/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { aiModelsApi, aiProvidersApi, useProviderStatus, type AiModelTarget } from "@/lib/api"
import { cn } from "@/lib/utils"

const modelCatalog = {
  openai: ["gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex"],
  google: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.1-flash-lite-preview"],
} as const

type ProviderKey = keyof typeof modelCatalog

const isProviderKey = (value: string): value is ProviderKey => value === "openai" || value === "google"

const pct = (value: number | null | undefined) => Math.max(0, Math.min(100, Math.round(value ?? 0)))

function Gauge({ label, value }: { label: string; value?: number | null }) {
  const percent = pct(value)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{percent}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function ProviderCard({
  title,
  description,
  status,
  tone,
  children,
  actions,
}: {
  title: string
  description: string
  status: string
  tone?: "openai" | "google"
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="rounded-lg bg-card p-3 shadow-soft">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white",
              tone === "google" ? "bg-emerald-500" : "bg-emphasis",
            )}
          >
            {tone === "google" ? <CloudCog className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[13px] font-semibold">{title}</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
          </div>
        </div>
        <StatusBadge value={status} />
      </div>
      <div className="mt-3 space-y-3">{children}</div>
      {actions ? <div className="mt-3 flex flex-wrap gap-1.5">{actions}</div> : null}
    </div>
  )
}

export function AiProvidersPage() {
  const { token } = useAdminAuth()
  const authToken = token ?? undefined
  const status = useProviderStatus(authToken, 30_000)
  const [connectOpen, setConnectOpen] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [gatewayUrl, setGatewayUrl] = useState("")
  const [dedicatedAccountId, setDedicatedAccountId] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [targets, setTargets] = useState<AiModelTarget[]>([])
  const [targetsLoading, setTargetsLoading] = useState(true)
  const [provider, setProvider] = useState<ProviderKey>("google")
  const [modelId, setModelId] = useState<string>("gemini-3.1-flash-lite-preview")

  const openai = status.data?.providers.openai
  const google = status.data?.providers.google
  const defaultTarget = useMemo(() => targets.find((target) => target.targetKey === "default"), [targets])

  useEffect(() => {
    let active = true
    async function loadTargets() {
      if (!authToken) return
      try {
        setTargetsLoading(true)
        const rows = await aiModelsApi.list(authToken)
        if (!active) return
        setTargets(rows)
        const defaultRow = rows.find((row) => row.targetKey === "default")
        const nextProvider = defaultRow?.provider ?? status.data?.settings.defaultAiProvider ?? "google"
        const safeProvider = isProviderKey(nextProvider) ? nextProvider : "google"
        setProvider(safeProvider)
        setModelId(defaultRow?.modelId ?? status.data?.settings.defaultAiModel ?? modelCatalog[safeProvider][0])
      } catch (e) {
        toast.error("Model targets failed", { description: e instanceof Error ? e.message : String(e) })
      } finally {
        if (active) setTargetsLoading(false)
      }
    }
    void loadTargets()
    return () => {
      active = false
    }
  }, [authToken, status.data?.settings.defaultAiProvider, status.data?.settings.defaultAiModel])

  useEffect(() => {
    if (!modelCatalog[provider].includes(modelId as never)) {
      setModelId(modelCatalog[provider][0])
    }
  }, [modelId, provider])

  async function connectOpenAI() {
    if (!authToken) return
    setBusy("connect")
    try {
      await aiProvidersApi.connectOpenAI({ apiKey, gatewayUrl, dedicatedAccountId }, authToken)
      toast.success("OpenAI Gateway connected")
      setApiKey("")
      setGatewayUrl("")
      setDedicatedAccountId("")
      setConnectOpen(false)
      await status.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function disconnectOpenAI() {
    if (!authToken) return
    setBusy("disconnect")
    try {
      await aiProvidersApi.disconnectOpenAI(authToken)
      toast.success("OpenAI Gateway disconnected")
      await status.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function testOpenAI() {
    if (!authToken) return
    setBusy("test")
    try {
      const result = await aiProvidersApi.testOpenAI(authToken)
      toast[result.ok ? "success" : "error"]("OpenAI Gateway test", {
        description: `${result.status} in ${result.latencyMs}ms`,
      })
      await status.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function saveModelConfig() {
    if (!authToken) return
    setBusy("model")
    try {
      const updated = await aiModelsApi.update("default", {
        provider,
        modelId,
        fastProvider: defaultTarget?.fastProvider ?? "openai",
        fastModelId: defaultTarget?.fastModelId ?? "gpt-4o-mini",
        thinkingLevel: defaultTarget?.thinkingLevel ?? null,
        fastThinkingLevel: defaultTarget?.fastThinkingLevel ?? null,
        xtremeProvider: defaultTarget?.xtremeProvider ?? null,
        xtremeModelId: defaultTarget?.xtremeModelId ?? null,
        xtremeThinkingLevel: defaultTarget?.xtremeThinkingLevel ?? null,
      }, authToken)
      await aiProvidersApi.updateSettings({ defaultAiProvider: provider, defaultAiModel: modelId }, authToken)
      setTargets((rows) => [updated, ...rows.filter((row) => row.targetKey !== "default")])
      toast.success("Default model saved")
      await status.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="AI Providers"
        title="Provider routing"
        description="Connect Gateway-backed OpenAI Codex, verify Gemini availability, and select the default orchestration model."
        actions={
          <Button type="button" variant="outline" size="sm" onClick={() => void status.refresh()}>
            <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
            Refresh
          </Button>
        }
      />

      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label="OpenAI" value={openai?.connected ? "Live" : "Off"} detail={openai?.gatewayUrl ?? "Gateway dedicated account"} icon={Sparkles} tone="emphasis" />
        <MetricCard label="Gemini" value={google?.connected ? "Live" : "Off"} detail="API key provider" icon={CloudCog} tone="accent" />
        <MetricCard label="Default" value={status.data?.settings.defaultAiProvider ?? provider} detail={status.data?.settings.defaultAiModel ?? modelId} icon={PlugZap} />
        <MetricCard label="Targets" value={targetsLoading ? "..." : String(targets.length)} detail="Model config rows" icon={Activity} />
      </section>

      <Tabs defaultValue="providers">
        <TabsList className="flex h-auto flex-wrap justify-start rounded-2xl p-1">
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="models">Model Config</TabsTrigger>
        </TabsList>

        <TabsContent value="providers">
          <SectionCard title="Provider connections" description="Gateway and API-key-backed providers available to orchestration.">
            <div className="grid gap-3 xl:grid-cols-2">
              <ProviderCard
                title="OpenAI Codex"
                description="Dedicated Gateway account for GPT and Codex models."
                status={openai?.status ?? (status.loading ? "loading" : "disconnected")}
                tone="openai"
                actions={
                  <>
                    <Button type="button" size="sm" onClick={() => setConnectOpen(true)}>
                      <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                      Connect
                    </Button>
                    <Button type="button" variant="outline" size="sm" disabled={!openai?.connected || busy === "test"} onClick={() => void testOpenAI()}>
                      <TestTube2 className="mr-1.5 h-3.5 w-3.5" />
                      Test Connection
                    </Button>
                    <Button type="button" variant="outline" size="sm" disabled={!openai?.connected || busy === "disconnect"} onClick={() => void disconnectOpenAI()}>
                      <Unplug className="mr-1.5 h-3.5 w-3.5" />
                      Disconnect
                    </Button>
                  </>
                }
              >
                <div className="grid gap-2 rounded-lg bg-secondary/70 p-3 text-[12px]">
                  <div className="flex justify-between gap-3"><span className="text-muted-foreground">Plan</span><span className="font-medium">{openai?.planType ?? "Pro"}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-muted-foreground">Dedicated ID</span><span className="truncate font-medium">{openai?.dedicatedAccountId ?? "Not connected"}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-muted-foreground">Credits</span><span className="font-medium">{openai?.creditsBalance ?? "Pending"}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-muted-foreground">Last used</span><span className="font-medium">{openai?.lastUsedAt ?? "Never"}</span></div>
                </div>
                <Gauge label="Primary window" value={openai?.primaryWindowPct ?? (openai?.connected ? 100 : 0)} />
                <Gauge label="Secondary window" value={openai?.secondaryWindowPct ?? (openai?.connected ? 100 : 0)} />
              </ProviderCard>

              <ProviderCard
                title="Google Gemini"
                description="Connected through backend Gemini API keys."
                status={google?.status ?? (status.loading ? "loading" : "disconnected")}
                tone="google"
              >
                <div className="flex flex-wrap gap-1.5">
                  {modelCatalog.google.map((model) => (
                    <Badge key={model} variant="secondary" className="rounded-full">{model}</Badge>
                  ))}
                </div>
                <div className="flex items-center gap-2 rounded-lg bg-secondary/70 p-3 text-[12px] text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  Connected via API Key
                </div>
              </ProviderCard>
            </div>
          </SectionCard>
        </TabsContent>

        <TabsContent value="models">
          <SectionCard title="Default model target" description="Controls the engine target used for orchestration when no more specific target is selected.">
            <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)_auto] md:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="provider">Provider</Label>
                <Select value={provider} onValueChange={(value) => setProvider(isProviderKey(value) ? value : "google")}>
                  <SelectTrigger id="provider" className="h-9 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="google">Google</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="model">Model</Label>
                <Select value={modelId} onValueChange={setModelId}>
                  <SelectTrigger id="model" className="h-9 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelCatalog[provider].map((model) => (
                      <SelectItem key={model} value={model}>{model}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" size="sm" disabled={busy === "model"} onClick={() => void saveModelConfig()}>
                <Save className="mr-1.5 h-3.5 w-3.5" />
                Save
              </Button>
            </div>
          </SectionCard>
        </TabsContent>
      </Tabs>

      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent className="p-4">
          <DialogHeader>
            <DialogTitle className="text-[15px]">Connect OpenAI Gateway</DialogTitle>
            <DialogDescription className="text-[12px]">Store the dedicated Gateway key and account reference for OpenAI routing.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="gateway-url">Gateway URL</Label>
              <Input id="gateway-url" value={gatewayUrl} onChange={(event) => setGatewayUrl(event.target.value)} placeholder="https://gateway.example.com" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-id">Dedicated account ID</Label>
              <Input id="account-id" value={dedicatedAccountId} onChange={(event) => setDedicatedAccountId(event.target.value)} placeholder="acct_..." />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="api-key">Gateway API key</Label>
              <Input id="api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="divo_..." />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConnectOpen(false)}>Cancel</Button>
            <Button type="button" disabled={!apiKey || !gatewayUrl || !dedicatedAccountId || busy === "connect"} onClick={() => void connectOpenAI()}>
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
