import { useState } from "react"
import { Brain, Building2, ChevronRight, Globe, Users } from "lucide-react"
import { MetricCard, MetricStrip } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { EmptyState } from "@/components/admin/empty-state"
import { SkelRows } from "@/pages/workspace/ui"
import { useMemoryData, type MemoryEntry } from "./memory/use-memory-data"

function formatDate(iso?: string): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" })
  } catch { return iso }
}

const SCOPE_LABEL: Record<MemoryEntry["scope"], string> = {
  department: "A department",
  company: "Everyone",
}

export function MemoriesPage() {
  const { memories, stats, loading, error, filters, setFilters } = useMemoryData()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  /*
   * The page's own shape while it loads, rather than a spinner where the page
   * is not.
   *
   * The header and the three counters are the frame this screen always has, so
   * they stay put and only their numbers arrive — which is what stops the
   * layout jumping the moment the read lands. Everything below is a list of
   * unknown length, so it gets rows.
   */
  if (loading) {
    return (
      <div className="page">
        <PageHeader
          eyebrow="AI Memory"
          title="Governed knowledge"
          description="Canonical department and company memory. Shared changes always follow review, live RBAC, and approval policy. Personal content stays private."
        />
        <div className="ws-stack">
          <MetricStrip columns={3}>
            <MetricCard label="Personal" value="—" detail="Private content hidden from admins" icon={Users} />
            <MetricCard label="Department" value="—" detail="Shared inside one team" icon={Building2} />
            <MetricCard label="Company" value="—" detail="Applies to everyone" icon={Globe} />
          </MetricStrip>
          <SectionCard title="Stored memories" description="Newest first. Open one to inspect its human-readable provenance." flush>
            <SkelRows n={5} />
          </SectionCard>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="AI Memory"
        title="Governed knowledge"
        description="Canonical department and company memory. Shared changes always follow review, live RBAC, and approval policy. Personal content stays private."
      />

      <div className="ws-stack">
        <MetricStrip columns={3}>
          <MetricCard label="Personal" value={String(stats?.totalPersonal ?? 0)} detail="Private content hidden from admins" icon={Users} />
          <MetricCard label="Department" value={String(stats?.totalDepartment ?? 0)} detail="Shared inside one team" icon={Building2} />
          <MetricCard label="Company" value={String(stats?.totalCompany ?? 0)} detail="Applies to everyone" icon={Globe} />
        </MetricStrip>

        <div className="filters">
          <select
            className="select"
            value={filters.scope ?? "all"}
            onChange={(event) => setFilters({
              ...filters,
              scope: event.target.value === "all" ? undefined : event.target.value,
            })}
          >
            <option value="all">Every shared scope</option>
            <option value="department">Department</option>
            <option value="company">Company</option>
          </select>
        </div>

        <SectionCard title="Stored memories" description="Newest first. Open one to inspect its human-readable provenance." flush>
          {error ? (
            <EmptyState title="Memory API unavailable" description={error} />
          ) : memories.length === 0 ? (
            <EmptyState
              title="No shared memories"
              description="Department and company knowledge appears here only after the governed review and approval flow completes."
            />
          ) : (
            <div className="ws-rows">
              {memories.map((memory) => (
                <MemoryRow
                  key={memory.id}
                  memory={memory}
                  expanded={expandedId === memory.id}
                  onToggle={() => setExpandedId(expandedId === memory.id ? null : memory.id)}
                />
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
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
  const source = typeof memory.metadata?.source === "string" ? memory.metadata.source : "governed review"

  return (
    <div className="ws-row" style={{ alignItems: "flex-start" }}>
      <span className="ws-ic"><Brain size={14} /></span>
      <div className="ws-row-main">
        <b style={{ fontWeight: 400 }}>{memory.memory}</b>
        <p>
          {SCOPE_LABEL[memory.scope]} · {source} · {formatDate(memory.createdAt)}
        </p>

        {expanded ? (
          <div className="ws-ba">
            {memory.metadata && Object.keys(memory.metadata).length > 0 ? (
              <div className="raw">
                <div className="lbl">Where it came from</div>
                <pre>{JSON.stringify(memory.metadata, null, 2)}</pre>
              </div>
            ) : (
              <div className="ws-sub">No additional provenance was recorded.</div>
            )}
            {memory.score !== undefined ? (
              <div className="ws-sub">Relevance {memory.score.toFixed(3)}</div>
            ) : null}
          </div>
        ) : null}

        <div style={{ marginTop: 9 }}>
          <button type="button" className="ws-more" data-open={expanded} onClick={onToggle}>
            <ChevronRight size={13} />{expanded ? "Hide" : "Details"}
          </button>
        </div>
      </div>
    </div>
  )
}
