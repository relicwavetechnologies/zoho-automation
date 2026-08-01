import { useState } from "react"
import { Brain, Loader2, Users, Building2, Globe } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MetricCard } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { EmptyState } from "@/components/admin/empty-state"
import { cn } from "@/lib/utils"
import { useMemoryData, type MemoryEntry } from "./memory/use-memory-data"

const scopeColor: Record<string, string> = {
  personal: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  department: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  company: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
}

function formatDate(iso?: string): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" })
  } catch { return iso }
}

export function MemoriesPage() {
  const { memories, stats, loading, error, filters, setFilters } = useMemoryData()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <>
      <PageHeader
        eyebrow="AI Memory"
        title="Memories"
        description="Backend-governed personal, department, and company memory. Shared facts are published only through review, RBAC, and approval."
      />

      <section className="grid gap-3 md:grid-cols-3">
        <MetricCard
          label="Personal memories"
          value={String(stats?.totalPersonal ?? 0)}
          detail="Private content hidden from admins"
          icon={Users}
        />
        <MetricCard
          label="Team memories"
          value={String(stats?.totalDepartment ?? 0)}
          detail="Department-level knowledge"
          icon={Building2}
          tone="accent"
        />
        <MetricCard
          label="Company memories"
          value={String(stats?.totalCompany ?? 0)}
          detail="Org-wide policies & facts"
          icon={Globe}
          tone="emphasis"
        />
      </section>

      <SectionCard title="Memory browser" description="Canonical versioned memory. Changes use the governed review and approval flow.">
        {/* Filters */}
        <div className="mb-4 flex items-center gap-2">
          <Select
            value={filters.scope ?? "all"}
            onValueChange={(v) => setFilters({ ...filters, scope: v === "all" ? undefined : v })}
          >
            <SelectTrigger className="h-8 w-36 bg-card text-[12px]">
              <SelectValue placeholder="All scopes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-[12px]">All scopes</SelectItem>
              <SelectItem value="department" className="text-[12px]">Department</SelectItem>
              <SelectItem value="company" className="text-[12px]">Company</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {error ? (
          <EmptyState title="Memory API unavailable" description={error} />
        ) : memories.length === 0 ? (
          <EmptyState
            title="No memories"
            description="Personal memory is learned from eligible conversations. Department and company knowledge always use the governed review and approval flow."
          />
        ) : (
          <div className="space-y-1.5">
            {memories.map((mem) => (
              <MemoryRow
                key={mem.id}
                memory={mem}
                expanded={expandedId === mem.id}
                onToggle={() => setExpandedId(expandedId === mem.id ? null : mem.id)}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </>
  )
}

function MemoryRow({
  memory,
  expanded,
  onToggle,
}: {
  memory: MemoryEntry
  expanded: boolean
  onToggle: () => void
}) {
  const scope = memory.scope
  const source = (memory.metadata?.source as string) ?? "auto"

  return (
    <div className={cn("rounded-md bg-card shadow-soft transition-colors", expanded && "ring-1 ring-accent/30")}>
      <div
        className="flex cursor-pointer items-center gap-3 px-3 py-2.5"
        onClick={onToggle}
      >
        <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className="flex-1 truncate text-[12px]">{memory.memory}</p>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold", scopeColor[scope] ?? "bg-secondary text-muted-foreground")}>
          {scope}
        </span>
        <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {source}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatDate(memory.createdAt)}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-border/40 px-3 py-2.5 space-y-2">
          <p className="text-[12px] leading-5 text-foreground/85">{memory.memory}</p>
          {memory.metadata && Object.keys(memory.metadata).length > 0 && (
            <pre className="max-h-32 overflow-auto rounded-md bg-secondary/50 p-2 font-mono text-[10px] text-muted-foreground">
              {JSON.stringify(memory.metadata, null, 2)}
            </pre>
          )}
          {memory.score !== undefined && (
            <p className="text-[10px] text-muted-foreground">Relevance score: {memory.score.toFixed(3)}</p>
          )}
        </div>
      )}
    </div>
  )
}
