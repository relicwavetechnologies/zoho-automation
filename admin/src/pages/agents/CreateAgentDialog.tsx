import { useState } from "react"
import { Bot, Building2, Crown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { CreateAgentInput } from "@/lib/api"
import type { AgentDef, ToolDef } from "./agent-platform-data"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  agents: AgentDef[]
  tools: ToolDef[]
  onCreate: (data: CreateAgentInput) => Promise<void>
}

export function CreateAgentDialog({ open, onOpenChange, agents, tools, onCreate }: Props) {
  const [name, setName] = useState("")
  const [parentId, setParentId] = useState<string>("")
  const [capabilityDescription, setCapabilityDescription] = useState("")
  const [systemPrompt, setSystemPrompt] = useState("")
  const [selectedTools, setSelectedTools] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const parentOptions = agents.filter((a) => a.role === "supervisor" || a.role === "dept-head")

  const toggleTool = (toolId: string) => {
    setSelectedTools((prev) =>
      prev.includes(toolId) ? prev.filter((t) => t !== toolId) : [...prev, toolId],
    )
  }

  const reset = () => {
    setName("")
    setParentId("")
    setCapabilityDescription("")
    setSystemPrompt("")
    setSelectedTools([])
  }

  const handleCreate = async () => {
    if (!name.trim() || !systemPrompt.trim()) return
    setBusy(true)
    try {
      await onCreate({
        name: name.trim(),
        description: capabilityDescription.trim() || undefined,
        systemPrompt: systemPrompt.trim(),
        toolIds: selectedTools.length > 0 ? selectedTools : undefined,
        parentId: parentId || undefined,
      })
      reset()
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border/40 bg-mat sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold">Create new agent</DialogTitle>
          <DialogDescription className="text-[12px]">
            Define a new agent in the hierarchy. It will be available to the supervisor immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Name</Label>
            <Input
              placeholder="e.g. Finance Head"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 bg-card text-[13px]"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Parent agent</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger className="h-9 bg-card text-[13px]">
                <SelectValue placeholder="Select parent (optional)" />
              </SelectTrigger>
              <SelectContent>
                {parentOptions.map((a) => {
                  const Icon = a.role === "supervisor" ? Crown : Building2
                  return (
                    <SelectItem key={a.id} value={a.id} className="text-[13px]">
                      <span className="flex items-center gap-2">
                        <Icon className="h-3 w-3 text-muted-foreground" />
                        {a.name}
                      </span>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Capability description</Label>
            <Input
              placeholder="1-2 sentences describing what this agent does"
              value={capabilityDescription}
              onChange={(e) => setCapabilityDescription(e.target.value)}
              className="h-9 bg-card text-[13px]"
            />
            <p className="text-[10px] text-muted-foreground">The supervisor reads this to decide when to route to this agent.</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">System prompt</Label>
            <textarea
              className="w-full rounded-md border border-border/60 bg-card p-2.5 font-mono text-[12px] leading-5 text-foreground/85 focus:outline-none focus:ring-1 focus:ring-accent"
              rows={6}
              placeholder="Role, rules, restrictions, tone..."
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Tools ({selectedTools.length} selected)
            </Label>
            <div className="grid max-h-40 gap-1.5 overflow-y-auto rounded-md border border-border/40 bg-card p-2">
              {tools.map((tool) => {
                const selected = selectedTools.includes(tool.id)
                return (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => toggleTool(tool.id)}
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
                      selected ? "bg-accent/15 text-accent" : "hover:bg-secondary"
                    }`}
                  >
                    <Bot className="h-3 w-3 shrink-0" />
                    <span className="font-medium">{tool.name}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">{tool.id}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 bg-emphasis text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
            disabled={busy || !name.trim() || !systemPrompt.trim()}
            onClick={handleCreate}
          >
            Create agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
