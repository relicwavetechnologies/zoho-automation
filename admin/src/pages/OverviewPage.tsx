import { ArrowUp, ArrowUpRight, ChevronRight, Filter, ListFilter, Sparkles } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { adminQueryKeys, getAdminQueryScope } from "@/lib/query-client"
import { cn } from "@/lib/utils"

type AvatarTone = "primary" | "blue" | "purple" | "green" | "amber" | "neutral"

const toneClasses: Record<AvatarTone, string> = {
  primary: "bg-accent/15 text-accent",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  purple: "bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300",
  green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  neutral: "bg-secondary text-foreground",
}

const TONES: AvatarTone[] = ["amber", "blue", "purple", "green", "primary"]

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

type AnalyticsOverview = {
  period: { days: number }
  executions: { total: number; previousTotal: number; growthPct: number | null; delta: number }
  successRate: number
  activeMembers: number
  departmentCount: number
  tokens: { totalInput: number; totalOutput: number; total: number; callCount: number; estimatedCostUsd: number }
  channelBreakdown: Array<{ channel: string; count: number; pct: number }>
  userActivity: Array<{ userId: string; name: string; email: string | null; count: number; pct: number }>
  weeklyTrend: Array<{ week: string; count: number }>
  integrations: Array<{ provider: string; connected: boolean }>
  modelBreakdown: Array<{ modelId: string; provider: string; calls: number; inputTokens: number; outputTokens: number }>
}

type MemberUsage = {
  period: { days: number }
  members: Array<{
    userId: string; name: string | null; email: string | null
    inputTokens: number; outputTokens: number; totalTokens: number
    calls: number; monthlyLimit: number; usagePct: number
  }>
}

function PersonChip({ initials, name, tone = "neutral" }: { initials: string; name: string; tone?: AvatarTone }) {
  return (
    <div className="inline-flex h-7 items-center gap-1.5 rounded-full bg-card pl-1 pr-2.5 shadow-soft">
      <Avatar className="h-5 w-5">
        <AvatarFallback className={cn("text-[9px] font-semibold", toneClasses[tone])}>{initials}</AvatarFallback>
      </Avatar>
      <span className="text-[12px] font-medium">{name}</span>
    </div>
  )
}

function StatTile({
  label,
  value,
  detail,
  tone = "default",
  detailNode,
}: {
  label: string
  value: string
  detail?: string
  tone?: "default" | "emphasis" | "outlined"
  detailNode?: React.ReactNode
}) {
  return (
    <Card
      className={cn(
        "relative w-[136px] shrink-0 border-transparent",
        tone === "emphasis" && "bg-emphasis text-emphasis-foreground",
        tone === "outlined" && "border-accent/40 bg-card",
      )}
    >
      <CardContent className="space-y-1.5 p-3">
        <p className={cn("text-[11px] font-medium", tone === "emphasis" ? "opacity-70" : "text-muted-foreground")}>{label}</p>
        <p className="text-xl font-semibold tracking-tight">{value}</p>
        {detailNode ?? (
          <p className={cn("truncate text-[11px]", tone === "emphasis" ? "opacity-70" : "text-muted-foreground")}>{detail}</p>
        )}
        {tone === "emphasis" ? (
          <div className="absolute bottom-2 right-2 flex h-4 w-4 items-center justify-center rounded-full bg-emphasis-foreground text-emphasis">
            <ChevronRight className="h-2.5 w-2.5" />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

const channelColors: Record<string, string> = {
  lark: "bg-blue-500",
  desktop: "bg-emerald-500",
  web: "bg-violet-500",
}

const integrationColors: Record<string, string> = {
  zoho: "bg-orange-500",
  lark: "bg-blue-500",
  google: "bg-emerald-500",
}

export function OverviewPage() {
  const { token } = useAdminAuth()
  const scope = getAdminQueryScope(token)

  const analytics = useQuery({
    queryKey: adminQueryKeys.apiList(scope, "/api/admin/analytics/overview", "analytics"),
    enabled: Boolean(token),
    queryFn: () => api.get<AnalyticsOverview>("/api/admin/analytics/overview", token!),
    refetchInterval: 60_000,
  })

  const memberUsage = useQuery({
    queryKey: adminQueryKeys.apiList(scope, "/api/admin/token-usage/members", "members"),
    enabled: Boolean(token),
    queryFn: () => api.get<MemberUsage>("/api/admin/token-usage/members", token!),
    refetchInterval: 60_000,
  })

  const data = analytics.data
  const members = memberUsage.data?.members ?? []
  const loading = analytics.isPending

  const totalRuns = data?.executions.total ?? 0
  const memberCount = data?.activeMembers ?? 0
  const deptCount = data?.departmentCount ?? 0
  const successRate = data?.successRate ?? 0
  const growthPct = data?.executions.growthPct
  const delta = data?.executions.delta ?? 0
  const prevRuns = data?.executions.previousTotal ?? 0
  const costUsd = data?.tokens.estimatedCostUsd ?? 0
  const totalTokens = data?.tokens.total ?? 0

  const topAgent = data?.modelBreakdown[0]
  const users = data?.userActivity ?? []
  const channels = data?.channelBreakdown ?? []
  const weekly = data?.weeklyTrend ?? []
  const integrations = data?.integrations ?? []
  const maxWeekly = Math.max(...weekly.map(w => w.count), 1)

  if (loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-64 rounded-full" />
        <Skeleton className="h-10 w-96" />
        <div className="flex gap-3">
          {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-24 w-[136px] rounded-lg" />)}
        </div>
        <div className="grid gap-3 xl:grid-cols-3">
          <Skeleton className="h-52 rounded-lg" />
          <Skeleton className="h-52 rounded-lg" />
          <Skeleton className="h-52 rounded-lg" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* ── Person chips ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        {users.slice(0, 4).map((user, i) => (
          <PersonChip key={user.userId} initials={getInitials(user.name)} name={user.name} tone={TONES[i % TONES.length]!} />
        ))}
        {deptCount > 0 ? (
          <div className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emphasis text-[11px] font-semibold text-emphasis-foreground shadow-soft">
            {deptCount}
          </div>
        ) : null}
      </div>

      <p className="text-3xl font-semibold tracking-tight text-foreground/15">Operations dashboard</p>

      {/* ── Executions hero + stat tiles ── */}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-foreground/70">Total executions</p>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight">{totalRuns.toLocaleString()}</span>
            {growthPct != null ? (
              <span className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                growthPct >= 0 ? "bg-accent text-accent-foreground" : "bg-secondary text-muted-foreground",
              )}>
                {growthPct >= 0 ? <ArrowUp className="h-3 w-3" /> : null}
                {growthPct >= 0 ? "+" : ""}{growthPct}%
              </span>
            ) : null}
            {delta !== 0 ? (
              <span className="inline-flex items-center rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">
                {delta >= 0 ? "+" : ""}{delta} runs
              </span>
            ) : null}
          </div>
          <p className="text-[11px] text-muted-foreground">vs prev. {prevRuns} runs · last {data?.period.days ?? 30} days</p>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          <StatTile label="Tokens" value={formatTokens(totalTokens)} detail={`${data?.tokens.callCount ?? 0} LLM calls`} />
          <StatTile label="Cost" value={`$${costUsd.toFixed(2)}`} detail="estimated" tone="emphasis" />
          <StatTile label="Members" value={String(memberCount)} detail={`${deptCount} dept${deptCount !== 1 ? "s" : ""}`} />
          <StatTile
            label="Success"
            value={`${successRate}%`}
            tone="outlined"
            detailNode={<p className="text-[11px] font-semibold text-accent">{totalRuns > 0 ? "from runs" : "—"}</p>}
          />
          {topAgent ? (
            <StatTile label="Top model" value={String(topAgent.calls)} detail={topAgent.modelId} />
          ) : null}
        </div>
      </div>

      {/* ── User activity bars ── */}
      {users.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {users.slice(0, 4).map((user, i) => (
            <div key={user.userId} className="flex min-w-[240px] flex-1 items-center gap-2 rounded-full bg-card px-1 py-1 shadow-soft">
              <Avatar className="h-7 w-7">
                <AvatarFallback className={cn("text-[10px] font-semibold", toneClasses[TONES[i % TONES.length]!])}>
                  {getInitials(user.name)}
                </AvatarFallback>
              </Avatar>
              <span className="text-[12px] font-medium">{user.name}</span>
              <span className="ml-auto pr-1.5 text-[12px] font-semibold">{user.count} runs</span>
              <span className="pr-2 text-[11px] text-muted-foreground">{user.pct}%</span>
            </div>
          ))}
          <Button type="button" className="h-9 rounded-full bg-emphasis px-4 text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90">
            Details
          </Button>
        </div>
      ) : null}

      {/* ── 3-column grid ── */}
      <div className="grid gap-3 xl:grid-cols-[1fr_1fr_360px]">
        {/* Channel breakdown */}
        <Card className="border-transparent bg-mat shadow-none">
          <CardContent className="space-y-2 p-3">
            <div className="flex items-center justify-between">
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 rounded-md bg-card px-2 text-[11px] font-medium shadow-soft hover:bg-card">
                <ListFilter className="h-3 w-3" />
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 rounded-md bg-card px-2 text-[11px] font-medium shadow-soft hover:bg-card">
                <Filter className="h-3 w-3" />
                Filters
              </Button>
            </div>
            <div className="space-y-1.5">
              {channels.map((ch) => (
                <div key={ch.channel} className="flex h-9 items-center gap-2 rounded-md bg-card px-2.5 shadow-soft">
                  <div className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white", channelColors[ch.channel] ?? "bg-secondary")}>
                    {ch.channel.slice(0, 1).toUpperCase()}
                  </div>
                  <span className="text-[12px] font-medium capitalize">{ch.channel}</span>
                  <span className="ml-auto text-[12px] font-semibold">{ch.count} runs</span>
                  <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{ch.pct}%</span>
                </div>
              ))}
              {channels.length === 0 ? (
                <p className="py-4 text-center text-[11px] text-muted-foreground">No execution data yet</p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* Model breakdown bars */}
        <Card className="border-transparent bg-mat shadow-none">
          <CardContent className="flex h-full flex-col gap-3 p-3">
            <div className="flex items-center justify-between">
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 rounded-md bg-card px-2 text-[11px] font-medium shadow-soft hover:bg-card">
                <Sparkles className="h-3 w-3" />
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 rounded-md bg-card px-2 text-[11px] font-medium shadow-soft hover:bg-card">
                <Filter className="h-3 w-3" />
                Filters
              </Button>
            </div>
            <div className="flex flex-1 items-end gap-2 px-1 py-2">
              {(data?.modelBreakdown ?? []).slice(0, 5).map((model, i) => {
                const maxCalls = Math.max(...(data?.modelBreakdown ?? []).map(m => m.calls), 1)
                const heightPct = Math.max((model.calls / maxCalls) * 100, 8)
                const colors = ["bg-orange-500", "bg-blue-500", "bg-emerald-500", "bg-violet-500"]
                return (
                  <div key={model.modelId} className="flex flex-1 flex-col items-center gap-1.5">
                    <div
                      className={cn("w-full rounded-md shadow-soft", colors[i % colors.length])}
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                )
              })}
              {(data?.modelBreakdown ?? []).length === 0 ? (
                <p className="flex-1 py-8 text-center text-[11px] text-muted-foreground">No model data</p>
              ) : null}
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">LLM calls</p>
              <p className="text-[12px] font-semibold">by model</p>
            </div>
          </CardContent>
        </Card>

        {/* Right sidebar: token usage by member + integrations */}
        <Card className="border-transparent bg-gradient-to-br from-accent/15 via-card to-card shadow-soft">
          <CardContent className="space-y-3 p-4">
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 text-[10px] text-muted-foreground">
              <span>Member</span>
              <span>Tokens</span>
              <span>Limit</span>
              <span>%</span>
            </div>
            {members.slice(0, 4).map((m, i) => (
              <div key={m.userId} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 text-[12px]">
                <div className="flex items-center gap-1.5">
                  <Avatar className="h-5 w-5">
                    <AvatarFallback className={cn("text-[9px] font-semibold", toneClasses[TONES[i % TONES.length]!])}>
                      {getInitials(m.name ?? m.email ?? "?")}
                    </AvatarFallback>
                  </Avatar>
                  <span className="font-medium">{m.name ?? m.email ?? "Unknown"}</span>
                </div>
                <span className="rounded-full bg-emphasis px-1.5 py-0.5 text-[10px] font-semibold text-emphasis-foreground">
                  {formatTokens(m.totalTokens)}
                </span>
                <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {formatTokens(m.monthlyLimit)}
                </span>
                <span className={cn("text-[11px] font-medium", m.usagePct > 90 ? "text-destructive" : "text-emerald-500")}>
                  {m.usagePct}%
                </span>
              </div>
            ))}
            {members.length === 0 ? (
              <p className="py-2 text-center text-[11px] text-muted-foreground">No token usage data</p>
            ) : null}

            <div className="flex flex-wrap gap-1.5 pt-0.5">
              <span className="rounded-full bg-card px-2 py-1 text-[10px] font-medium shadow-soft">
                {data?.tokens.callCount ?? 0} LLM calls
              </span>
              <span className="rounded-full bg-card px-2 py-1 text-[10px] font-medium shadow-soft">
                {formatTokens(totalTokens)} total
              </span>
            </div>

            <p className="text-[12px] font-semibold">Integration health</p>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {integrations.map((item) => (
                <div key={item.provider} className="flex items-center gap-1.5 rounded-md bg-card p-2 shadow-soft">
                  <div className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white", integrationColors[item.provider] ?? "bg-secondary")}>
                    {item.provider.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] font-semibold capitalize">{item.provider}</p>
                    <p className="text-[9px] text-muted-foreground">
                      {item.connected ? "Connected" : "Disconnected"}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between rounded-md bg-card p-3 shadow-soft">
              <div>
                <p className="text-[10px] text-muted-foreground">Token cost ({data?.period.days ?? 30}d)</p>
                <p className="text-lg font-semibold tracking-tight">${costUsd.toFixed(2)}</p>
              </div>
              <ArrowUpRight className="h-4 w-4 text-accent" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Bottom: avg stats + weekly chart ── */}
      <Card className="border-transparent bg-mat shadow-none">
        <CardContent className="grid gap-0 p-2 md:grid-cols-[220px_1fr]">
          <div className="rounded-md bg-accent p-4 text-accent-foreground">
            <p className="text-[10px] opacity-70">Period ({data?.period.days ?? 30}d)</p>
            <p className="mt-1.5 text-[10px] opacity-80">Executions</p>
            <p className="text-2xl font-semibold tracking-tight">{totalRuns.toLocaleString()}</p>
            <p className="mt-3 text-[10px] opacity-80">Active members</p>
            <p className="text-lg font-semibold">
              {memberCount}
              <span className="ml-1.5 text-[11px] opacity-80">/ {deptCount} dept{deptCount !== 1 ? "s" : ""}</span>
            </p>
            <p className="mt-3 text-[10px] opacity-80">Success rate</p>
            <p className="text-lg font-semibold">
              {successRate}%
            </p>
          </div>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-muted-foreground">Weekly execution trend</p>
                <p className="text-[12px] font-semibold">Last {weekly.length} weeks</p>
              </div>
            </div>
            <div className="flex flex-1 items-end gap-2 pt-2">
              {weekly.map((w, i) => {
                const heightPx = Math.max((w.count / maxWeekly) * 110, 8)
                const isPeak = w.count === maxWeekly && w.count > 0
                const weekLabel = `W${i + 1}`
                return (
                  <div key={w.week} className="flex flex-1 flex-col items-center gap-1.5">
                    {isPeak ? (
                      <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-semibold text-accent-foreground">
                        {w.count}
                      </span>
                    ) : null}
                    <div
                      className={cn(
                        "w-full rounded-md",
                        i % 2 === 0 ? "border-2 border-dashed border-border/60 bg-secondary/30" : "bg-secondary",
                      )}
                      style={{ height: `${heightPx}px` }}
                    />
                    <span className="text-[9px] text-muted-foreground">{weekLabel}</span>
                  </div>
                )
              })}
              {weekly.length === 0 ? (
                <p className="flex-1 py-8 text-center text-[11px] text-muted-foreground">No weekly data yet</p>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
