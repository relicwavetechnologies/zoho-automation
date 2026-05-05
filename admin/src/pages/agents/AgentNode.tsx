import { Bot, Building2, Crown, Wrench } from "lucide-react"
import { Handle, Position } from "@xyflow/react"
import { cn } from "@/lib/utils"
import type { AgentDef } from "./agent-platform-data"

type AgentNodeData = {
  agent: AgentDef
  toolCount: number
  subAgentCount: number
  selected?: boolean
}

export function AgentNode({ data }: { data: AgentNodeData }) {
  const { agent, toolCount, subAgentCount, selected } = data
  const isSupervisor = agent.role === "supervisor"
  const isDeptHead = agent.role === "dept-head"

  const Icon = isSupervisor ? Crown : isDeptHead ? Building2 : Bot

  return (
    <div
      className={cn(
        "w-[220px] cursor-pointer rounded-lg border-2 bg-card transition-all",
        "border-transparent shadow-soft hover:shadow-elevated",
        isSupervisor && "bg-emphasis text-emphasis-foreground",
        selected && "ring-2 ring-accent ring-offset-2 ring-offset-mat",
        !agent.enabled && "opacity-50",
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
      <div className="flex items-start gap-2 p-3">
        <div
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            isSupervisor ? "bg-emphasis-foreground/15" : isDeptHead ? "bg-accent/15 text-accent" : "bg-secondary text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[12px] font-semibold">{agent.name}</p>
            {!agent.enabled ? (
              <span className="rounded-sm bg-secondary px-1 py-0 text-[9px] font-medium text-muted-foreground">off</span>
            ) : null}
          </div>
          <p className={cn("truncate text-[10px] font-medium", isSupervisor ? "opacity-70" : "text-muted-foreground")}>
            {agent.slug}
          </p>
          <p
            className={cn(
              "line-clamp-2 text-[10px] leading-snug",
              isSupervisor ? "opacity-80" : "text-muted-foreground",
            )}
          >
            {agent.capabilityDescription}
          </p>
        </div>
      </div>
      <div
        className={cn(
          "flex items-center gap-2 border-t px-3 py-1.5 text-[10px]",
          isSupervisor ? "border-white/10 opacity-80" : "border-border/40 text-muted-foreground",
        )}
      >
        <span className="inline-flex items-center gap-1">
          <Wrench className="h-2.5 w-2.5" />
          {toolCount} tools
        </span>
        <span className="inline-flex items-center gap-1">
          <Bot className="h-2.5 w-2.5" />
          {subAgentCount} sub
        </span>
        {agent.directSlug ? (
          <span className="ml-auto rounded-sm bg-accent/15 px-1 py-0 font-mono text-[9px] font-semibold text-accent">
            {agent.directSlug}
          </span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
    </div>
  )
}
