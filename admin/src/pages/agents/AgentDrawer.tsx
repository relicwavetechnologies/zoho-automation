import { useEffect, useRef, useState } from "react"
import { Activity, Bot, Building2, Clock, Cog, Crown, FlaskConical, Globe, GripVertical, Power, Save, Wrench } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { agentById, toolById, type AgentDef } from "./agent-platform-data"

type AgentDrawerProps = {
  agent: AgentDef | null
  onClose: () => void
}

const familyColor: Record<string, string> = {
  zoho: "bg-orange-500",
  lark: "bg-blue-500",
  google: "bg-emerald-500",
  context: "bg-violet-500",
  internal: "bg-secondary",
}

const familyLabel: Record<string, string> = {
  zoho: "Zoho",
  lark: "Lark",
  google: "Google",
  context: "Context",
  internal: "Internal",
}

const MIN_W = 360
const MAX_W = 900
const DEFAULT_W = 460
const STORAGE_KEY = "divo_admin_agent_drawer_width"

const mockStats = (id: string) => {
  const seed = id.charCodeAt(0) + id.length * 7
  return {
    runs: 120 + (seed % 800),
    lastActive: ["2m ago", "12m ago", "1h ago", "3h ago", "yesterday"][seed % 5],
    avgLatency: `${(0.4 + (seed % 30) / 10).toFixed(1)}s`,
  }
}

export function AgentDrawer({ agent, onClose }: AgentDrawerProps) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_W
    const stored = Number(localStorage.getItem(STORAGE_KEY))
    return stored && stored >= MIN_W && stored <= MAX_W ? stored : DEFAULT_W
  })
  const [isResizing, setIsResizing] = useState(false)
  const widthRef = useRef(width)

  useEffect(() => {
    widthRef.current = width
  }, [width])

  useEffect(() => {
    if (!isResizing) return
    const handleMove = (e: MouseEvent) => {
      const next = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - e.clientX))
      setWidth(next)
    }
    const handleUp = () => {
      setIsResizing(false)
      localStorage.setItem(STORAGE_KEY, String(widthRef.current))
    }
    document.body.style.cursor = "ew-resize"
    document.body.style.userSelect = "none"
    window.addEventListener("mousemove", handleMove)
    window.addEventListener("mouseup", handleUp)
    return () => {
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      window.removeEventListener("mousemove", handleMove)
      window.removeEventListener("mouseup", handleUp)
    }
  }, [isResizing])

  return (
    <Sheet open={!!agent} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="overflow-hidden border-l border-border/40 bg-mat p-0 sm:!max-w-none"
        style={{ width }}
      >
        {/* Resize handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize drawer"
          onMouseDown={(e) => {
            e.preventDefault()
            setIsResizing(true)
          }}
          className={cn(
            "group absolute left-0 top-0 z-20 flex h-full w-1.5 cursor-ew-resize items-center justify-center transition-colors",
            isResizing ? "bg-accent/40" : "hover:bg-accent/30",
          )}
        >
          <div
            className={cn(
              "flex h-12 w-3 -translate-x-1 items-center justify-center rounded-r-full bg-border/60 opacity-0 transition-opacity group-hover:opacity-100",
              isResizing && "bg-accent opacity-100",
            )}
          >
            <GripVertical className="h-3 w-3 text-mat" />
          </div>
        </div>

        {agent ? <AgentDrawerContent agent={agent} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function AgentDrawerContent({ agent }: { agent: AgentDef }) {
  const stats = mockStats(agent.id)
  const isSupervisor = agent.role === "supervisor"
  const isDeptHead = agent.role === "dept-head"
  const RoleIcon = isSupervisor ? Crown : isDeptHead ? Building2 : Bot
  const roleLabel = isSupervisor ? "Root agent" : isDeptHead ? "Department head" : "Specialist sub-agent"

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {/* Hero */}
        <SheetHeader className="space-y-3 border-b border-border/40 bg-card p-5 pl-6">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg",
                isSupervisor ? "bg-emphasis text-emphasis-foreground" : "bg-accent/15 text-accent",
              )}
            >
              <RoleIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-accent">{roleLabel}</p>
              <SheetTitle className="text-lg font-semibold leading-tight">{agent.name}</SheetTitle>
              <SheetDescription className="font-mono text-[12px] text-muted-foreground">{agent.slug}</SheetDescription>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                agent.enabled
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                : "bg-secondary text-muted-foreground",
              )}
            >
              {agent.enabled ? "Live" : "Off"}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-1">
            <StatPill icon={Activity} label="Runs (30d)" value={stats.runs.toLocaleString()} />
            <StatPill icon={Clock} label="Last active" value={stats.lastActive} />
            <StatPill icon={Globe} label="Avg latency" value={stats.avgLatency} />
          </div>
        </SheetHeader>

        {/* Body */}
        <div className="space-y-5 p-5 pl-6">
          <Section label="Capability">
            <p className="text-[13px] leading-6 text-foreground/85">{agent.capabilityDescription}</p>
          </Section>

          {agent.toolIds.length > 0 ? (
            <Section label="Allowed tools" count={agent.toolIds.length} icon={Wrench}>
              <div className="space-y-1.5">
                {agent.toolIds.map((toolId) => {
                  const tool = toolById[toolId]
                  if (!tool) return null
                  return (
                    <div key={toolId} className="flex items-center gap-2.5 rounded-md bg-card p-2.5 shadow-soft">
                      <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white", familyColor[tool.family])}>
                        <span className="text-[10px] font-bold">{familyLabel[tool.family].slice(0, 1)}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold">{tool.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{tool.description}</p>
                      </div>
                      <div className="flex shrink-0 flex-wrap justify-end gap-1">
                        {tool.actionGroups.map((g) => (
                          <span key={g} className="rounded-sm bg-secondary px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {g}
                          </span>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </Section>
          ) : null}

          {agent.subAgentIds.length > 0 ? (
            <Section label="Sub-agents" count={agent.subAgentIds.length} icon={Building2}>
              <div className="space-y-1.5">
                {agent.subAgentIds.map((id) => {
                  const child = agentById[id]
                  if (!child) return null
                  return (
                    <div key={id} className="flex items-center gap-2.5 rounded-md bg-card p-2.5 shadow-soft">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                        <Bot className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold">{child.name}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{child.slug}</p>
                      </div>
                      {!child.enabled ? (
                        <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">off</span>
                      ) : (
                        <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">●</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </Section>
          ) : null}

          <Section label="System prompt" icon={Cog}>
            <div className="overflow-hidden rounded-md bg-card shadow-soft">
              <PromptRow label="Role" value={agent.systemPromptSections.role} />
              <PromptRow label="Can do" value={agent.systemPromptSections.canDo} />
              <PromptRow label="Cannot do" value={agent.systemPromptSections.cannotDo} />
              <PromptRow label="Rules" value={agent.systemPromptSections.rules} />
              <PromptRow label="Tone" value={agent.systemPromptSections.tone} last />
            </div>
          </Section>

          <Section label="Routing">
            <div className="overflow-hidden rounded-md bg-card shadow-soft">
              <KeyValue label="Direct slug" value={agent.directSlug ?? "—"} mono />
              <KeyValue label="Default departments" value={agent.defaultDepartments?.join(", ") ?? "—"} />
              <KeyValue label="Status" value={agent.enabled ? "enabled" : "disabled"} last />
            </div>
          </Section>
        </div>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border/40 bg-mat/95 p-3 pl-6 backdrop-blur">
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 rounded-md text-[12px] font-medium" disabled>
          <FlaskConical className="h-3.5 w-3.5" />
          Test
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 rounded-md text-[12px] font-medium" disabled>
          <Power className="h-3.5 w-3.5" />
          {agent.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          type="button"
          size="sm"
          className="ml-auto h-8 gap-1.5 rounded-md bg-emphasis px-3 text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
          disabled
        >
          <Save className="h-3.5 w-3.5" />
          Save changes
        </Button>
      </div>
    </div>
  )
}

function StatPill({ icon: Icon, label, value }: { icon: typeof Activity; label: string; value: string }) {
  return (
    <div className="rounded-md bg-mat px-2 py-1.5">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Icon className="h-2.5 w-2.5" />
        {label}
      </div>
      <p className="mt-0.5 text-[13px] font-semibold">{value}</p>
    </div>
  )
}

function Section({
  label,
  count,
  icon: Icon,
  children,
}: {
  label: string
  count?: number
  icon?: typeof Wrench
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon className="h-3 w-3 text-muted-foreground" /> : null}
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        {count !== undefined ? (
          <span className="rounded-sm bg-secondary px-1.5 py-0 text-[10px] font-semibold text-muted-foreground">
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  )
}

function PromptRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div className={cn("space-y-1 p-3", !last && "border-b border-border/40")}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-[12px] leading-5 text-foreground/85">{value}</p>
    </div>
  )
}

function KeyValue({ label, value, mono, last }: { label: string; value: string; mono?: boolean; last?: boolean }) {
  return (
    <div className={cn("flex items-baseline gap-2 px-3 py-2 text-[12px]", !last && "border-b border-border/40")}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("ml-auto truncate font-medium", mono && "font-mono text-[11px]")}>{value}</span>
    </div>
  )
}
