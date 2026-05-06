import { useMemo, useState } from "react"
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node, type NodeMouseHandler } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { Bot, Building2, ChevronDown, Crown, Loader2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MetricCard } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { AgentDrawer } from "./agents/AgentDrawer"
import { AgentNode } from "./agents/AgentNode"
import { CreateAgentDialog } from "./agents/CreateAgentDialog"
import { useAgentData } from "./agents/use-agent-data"
import type { AgentDef } from "./agents/agent-platform-data"

const NODE_WIDTH = 220
const NODE_HEIGHT = 124
const H_GAP = 40
const V_GAP = 90

function layoutTree(agents: AgentDef[], agentById: Record<string, AgentDef>): { nodes: Node[]; edges: Edge[] } {
  const depthOf = (id: string): number => {
    const a = agentById[id]
    if (!a || !a.parentId) return 0
    return 1 + depthOf(a.parentId)
  }
  const buckets: Record<number, AgentDef[]> = {}
  agents.forEach((a) => {
    const d = depthOf(a.id)
    buckets[d] = buckets[d] ?? []
    buckets[d].push(a)
  })

  const nodes: Node[] = []
  Object.entries(buckets).forEach(([depthStr, list]) => {
    const depth = Number(depthStr)
    const totalWidth = list.length * NODE_WIDTH + (list.length - 1) * H_GAP
    const startX = -totalWidth / 2
    list.forEach((a, i) => {
      nodes.push({
        id: a.id,
        type: "agent",
        position: { x: startX + i * (NODE_WIDTH + H_GAP), y: depth * (NODE_HEIGHT + V_GAP) },
        data: {
          agent: a,
          toolCount: a.toolIds.length,
          subAgentCount: a.subAgentIds.length,
        },
      })
    })
  })

  const edges: Edge[] = agents
    .filter((a) => a.parentId)
    .map((a) => ({
      id: `${a.parentId}->${a.id}`,
      source: a.parentId!,
      target: a.id,
      type: "smoothstep",
      style: {
        stroke: "hsl(var(--border))",
        strokeWidth: 1.5,
      },
    }))

  return { nodes, edges }
}

const nodeTypes = { agent: AgentNode }

export function AgentsPage() {
  const { agents, agentById, tools, toolById, loading, error, stats, toggleAgent, updateAgent, createAgent, deleteAgent } = useAgentData()
  const [selectedAgent, setSelectedAgent] = useState<AgentDef | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const { nodes, edges } = useMemo(() => layoutTree(agents, agentById), [agents, agentById])

  const nodesWithSelection = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: { ...n.data, selected: selectedAgent?.id === n.id },
      })),
    [nodes, selectedAgent],
  )

  const onNodeClick: NodeMouseHandler = (_, node) => {
    const a = agentById[node.id]
    if (a) setSelectedAgent(a)
  }

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-96 flex-col items-center justify-center gap-2 text-muted-foreground">
        <p className="text-[13px]">Failed to load agents</p>
        <p className="text-[11px]">{error}</p>
      </div>
    )
  }

  return (
    <>
      <PageHeader
        eyebrow="Group admin"
        title="Agent platform"
        description="Three-tier hierarchy of every agent in the company. Click a node to inspect its capabilities."
        actions={
          <>
            <Button type="button" variant="outline" className="h-8 gap-1.5 rounded-md bg-card text-[12px] font-medium shadow-soft hover:bg-card">
              <Building2 className="h-3.5 w-3.5" />
              Finance Co.
              <ChevronDown className="h-3 w-3" />
            </Button>
            <Button
              type="button"
              className="h-8 gap-1.5 rounded-md bg-emphasis px-3 text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              New agent
            </Button>
          </>
        }
      />

      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label="Total agents" value={String(stats.total)} detail="Across all tiers" icon={Bot} />
        <MetricCard label="Department heads" value={String(stats.heads)} detail="Tier 2" icon={Building2} tone="accent" />
        <MetricCard label="Specialists" value={String(stats.specialists)} detail="Tier 3" icon={Bot} />
        <MetricCard label="Supervisor" value="1" detail="Root tier" icon={Crown} tone="emphasis" />
      </section>

      <div className="h-[640px] overflow-hidden rounded-lg border border-border/40 bg-gradient-to-br from-card via-card to-accent/[0.05] shadow-soft">
        <ReactFlow
          nodes={nodesWithSelection}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.4}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          onNodeClick={onNodeClick}
        >
          <Background gap={24} size={1} color="hsl(var(--border))" />
          <Controls
            showInteractive={false}
            className="!rounded-md !border !border-border/40 !bg-card !shadow-soft"
          />
          <MiniMap
            className="!rounded-md !border !border-border/40 !bg-card"
            nodeColor={(n) => {
              const a = agentById[n.id]
              if (!a) return "hsl(var(--secondary))"
              if (a.role === "supervisor") return "hsl(var(--emphasis))"
              if (a.role === "dept-head") return "hsl(var(--accent))"
              return "hsl(var(--secondary))"
            }}
            maskColor="hsl(var(--mat) / 0.6)"
          />
        </ReactFlow>
      </div>

      <AgentDrawer
        agent={selectedAgent}
        agentById={agentById}
        toolById={toolById}
        onClose={() => setSelectedAgent(null)}
        onToggle={toggleAgent}
        onSave={updateAgent}
        onDelete={deleteAgent}
      />

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        agents={agents}
        tools={tools}
        onCreate={createAgent}
      />
    </>
  )
}
