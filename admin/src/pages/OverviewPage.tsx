import { ArrowUp, ArrowUpRight, ChevronRight, Filter, ListFilter, Plus, Sparkles } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useApiList } from "@/components/admin/use-api-list"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { cn } from "@/lib/utils"
import type { JsonRecord } from "@/components/admin/types"

type AvatarTone = "primary" | "blue" | "purple" | "green" | "amber" | "neutral"

const toneClasses: Record<AvatarTone, string> = {
  primary: "bg-accent/15 text-accent",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  purple: "bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300",
  green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  neutral: "bg-secondary text-foreground",
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

const channelRows = [
  { name: "Zoho", value: "$227,459", pct: "43%", color: "bg-orange-500" },
  { name: "Lark", value: "$142,823", pct: "27%", color: "bg-blue-500" },
  { name: "Google", value: "$89,935", pct: "11%", color: "bg-emerald-500" },
  { name: "Search", value: "$37,028", pct: "7%", color: "bg-violet-500" },
]

const platformBars = [
  { label: "Zoho", height: 70, color: "bg-orange-500" },
  { label: "Lark", height: 100, color: "bg-blue-500" },
  { label: "Google", height: 85, color: "bg-emerald-500" },
  { label: "Search", height: 60, color: "bg-violet-500" },
  { label: "Other", height: 40, hatched: true },
]

const operatorRows: Array<{ initials: string; name: string; runs: string; tools: string; kpi: string; tone: AvatarTone }> = [
  { initials: "AR", name: "Aria R.", runs: "417", tools: "12", kpi: "0.84", tone: "amber" },
  { initials: "SK", name: "Sam K.", runs: "284", tools: "9", kpi: "0.89", tone: "blue" },
  { initials: "MP", name: "Mira P.", runs: "203", tools: "7", kpi: "0.79", tone: "purple" },
]

const integrationCards = [
  { name: "Zoho", pct: "45.3%", value: "$71,048", color: "bg-orange-500" },
  { name: "Lark", pct: "28.1%", value: "$44,072", color: "bg-blue-500" },
  { name: "Google", pct: "14.1%", value: "$22,114", color: "bg-emerald-500" },
  { name: "Other", pct: "7.1%", value: "$11,135", color: "bg-violet-500" },
]

export function OverviewPage() {
  const { token, session } = useAdminAuth()
  const executions = useApiList<JsonRecord>("/api/admin/executions?limit=20", token, ["items", "runs"])
  const members = useApiList<JsonRecord>("/api/admin/members?limit=50", token, ["items", "members"])
  const departments = useApiList<JsonRecord>("/api/admin/departments?limit=20", token, ["items", "departments"])

  const totalRuns = executions.data.length || 1247
  const memberCount = members.data.length || 12
  const deptCount = departments.data.length || 3
  const greeting = session?.companyId ? "Operations" : "Platform"

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="outline" size="icon" className="h-7 w-7 rounded-full border-border/50 bg-card shadow-soft">
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <PersonChip initials="AR" name="Aria R." tone="amber" />
        <PersonChip initials="SK" name="Sam K." tone="blue" />
        <PersonChip initials="MP" name="Mira P." tone="purple" />
        <div className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emphasis text-[11px] font-semibold text-emphasis-foreground shadow-soft">
          D
        </div>
      </div>

      <p className="text-3xl font-semibold tracking-tight text-foreground/15">{greeting} dashboard</p>

      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-foreground/70">Total executions</p>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight">
              {totalRuns.toLocaleString()}
              <span className="text-foreground/30">.42</span>
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-foreground">
              <ArrowUp className="h-3 w-3" />
              12.4%
            </span>
            <span className="inline-flex items-center rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">
              +342 runs
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">vs prev. 905 runs · last 30 days</p>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          <StatTile label="Top agent" value="47" detail="zoho-read" />
          <StatTile label="Best run" value="$0.04" detail="finance/payroll" tone="emphasis" />
          <StatTile label="Members" value={String(memberCount)} detail="↓ 5 vs last week" />
          <StatTile label="Cost" value="528k" tone="outlined" detailNode={<p className="text-[11px] font-semibold text-accent">↑ 7.9%</p>} />
          <StatTile label="Success" value="98.4%" detail="↑ 1.2%" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {[
          { initials: "AR", name: "Aria R.", value: "$209,633", pct: "39.63%", tone: "amber" as AvatarTone },
          { initials: "SK", name: "Sam K.", value: "$156,841", pct: "29.65%", tone: "blue" as AvatarTone },
          { initials: "MP", name: "Mira P.", value: "$117,115", pct: "22.14%", tone: "purple" as AvatarTone },
        ].map((row) => (
          <div key={row.initials} className="flex min-w-[240px] flex-1 items-center gap-2 rounded-full bg-card px-1 py-1 shadow-soft">
            <Avatar className="h-7 w-7">
              <AvatarFallback className={cn("text-[10px] font-semibold", toneClasses[row.tone])}>{row.initials}</AvatarFallback>
            </Avatar>
            <span className="text-[12px] font-medium">{row.name}</span>
            <span className="ml-auto pr-1.5 text-[12px] font-semibold">{row.value}</span>
            <span className="pr-2 text-[11px] text-muted-foreground">{row.pct}</span>
          </div>
        ))}
        <Button type="button" className="h-9 rounded-full bg-emphasis px-4 text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90">
          Details
        </Button>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_1fr_360px]">
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
              {channelRows.map((row) => (
                <div key={row.name} className="flex h-9 items-center gap-2 rounded-md bg-card px-2.5 shadow-soft">
                  <div className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white", row.color)}>
                    {row.name.slice(0, 1)}
                  </div>
                  <span className="text-[12px] font-medium">{row.name}</span>
                  <span className="ml-auto text-[12px] font-semibold">{row.value}</span>
                  <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{row.pct}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

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
              {platformBars.map((bar) => (
                <div key={bar.label} className="flex flex-1 flex-col items-center gap-1.5">
                  <div
                    className={cn(
                      "w-full rounded-md",
                      bar.hatched
                        ? "border-2 border-dashed border-border/60 bg-secondary/40"
                        : cn(bar.color, "shadow-soft"),
                    )}
                    style={{ height: `${bar.height}%` }}
                  />
                </div>
              ))}
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Executions</p>
              <p className="text-[12px] font-semibold">by integration</p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-transparent bg-gradient-to-br from-accent/15 via-card to-card shadow-soft">
          <CardContent className="space-y-3 p-4">
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 text-[10px] text-muted-foreground">
              <span>Operator</span>
              <span>Runs</span>
              <span>Tools</span>
              <span>KPI</span>
            </div>
            {operatorRows.map((row) => (
              <div key={row.initials} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 text-[12px]">
                <div className="flex items-center gap-1.5">
                  <Avatar className="h-5 w-5">
                    <AvatarFallback className={cn("text-[9px] font-semibold", toneClasses[row.tone])}>{row.initials}</AvatarFallback>
                  </Avatar>
                  <span className="font-medium">{row.name}</span>
                </div>
                <span className="rounded-full bg-emphasis px-1.5 py-0.5 text-[10px] font-semibold text-emphasis-foreground">{row.runs}</span>
                <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{row.tools}</span>
                <span className="text-[11px] font-medium">{row.kpi}</span>
              </div>
            ))}
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              <span className="rounded-full bg-card px-2 py-1 text-[10px] font-medium shadow-soft">Top agent 💪</span>
              <span className="rounded-full bg-card px-2 py-1 text-[10px] font-medium shadow-soft">Streak 🔥</span>
              <span className="rounded-full bg-card px-2 py-1 text-[10px] font-medium shadow-soft">Reviewed 👍</span>
            </div>
            <div>
              <p className="text-[12px] font-semibold">Active integrations</p>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {integrationCards.map((item) => (
                  <div key={item.name} className="flex items-center gap-1.5 rounded-md bg-card p-2 shadow-soft">
                    <div className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white", item.color)}>
                      {item.name.slice(0, 1)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[10px] font-semibold">{item.name}</p>
                      <p className="text-[9px] text-muted-foreground">
                        {item.pct} · {item.value}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md bg-card p-3 shadow-soft">
              <div>
                <p className="text-[10px] text-muted-foreground">Cost dynamic</p>
                <p className="text-lg font-semibold tracking-tight">${(totalRuns * 0.04).toFixed(0)}</p>
              </div>
              <ArrowUpRight className="h-4 w-4 text-accent" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-transparent bg-mat shadow-none">
        <CardContent className="grid gap-0 p-2 md:grid-cols-[220px_1fr]">
          <div className="rounded-md bg-accent p-4 text-accent-foreground">
            <p className="text-[10px] opacity-70">Avg. monthly</p>
            <p className="mt-1.5 text-[10px] opacity-80">Executions</p>
            <p className="text-2xl font-semibold tracking-tight">{totalRuns.toLocaleString()}</p>
            <p className="mt-3 text-[10px] opacity-80">Active members</p>
            <p className="text-lg font-semibold">
              {memberCount}
              <span className="ml-1.5 text-[11px] opacity-80">/ {deptCount} depts</span>
            </p>
            <p className="mt-3 text-[10px] opacity-80">Success rate</p>
            <p className="text-lg font-semibold">
              98.4%<span className="ml-1 text-[11px] opacity-80"> · 7 / 13</span>
            </p>
          </div>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-muted-foreground">Monthly value by integration</p>
                <p className="text-[12px] font-semibold">All integrations</p>
              </div>
              <div className="inline-flex rounded-full bg-card p-0.5 shadow-soft">
                <Button type="button" size="sm" className="h-6 rounded-full bg-emphasis px-3 text-[10px] font-semibold text-emphasis-foreground hover:bg-emphasis/90">
                  Runs
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-6 rounded-full px-3 text-[10px] font-semibold">
                  Cost
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-6 rounded-full px-3 text-[10px] font-semibold">
                  W/L
                </Button>
              </div>
            </div>
            <div className="flex flex-1 items-end gap-2 pt-2">
              {[55, 68, 90, 75, 100, 80, 88].map((h, i) => {
                const labels = ["W1", "W2", "W3", "W4", "W5", "W6", "W7"]
                const isPeak = h >= 90
                return (
                  <div key={labels[i]} className="flex flex-1 flex-col items-center gap-1.5">
                    {isPeak ? (
                      <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-semibold text-accent-foreground">
                        ${Math.round((totalRuns * h) / 100)}
                      </span>
                    ) : null}
                    <div
                      className={cn(
                        "w-full rounded-md",
                        i % 2 === 0 ? "border-2 border-dashed border-border/60 bg-secondary/30" : "bg-secondary",
                      )}
                      style={{ height: `${h * 1.1}px` }}
                    />
                    <span className="text-[9px] text-muted-foreground">{labels[i]}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
