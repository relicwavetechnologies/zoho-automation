import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { agentsApi, type CreateAgentInput, type UpdateAgentInput } from "@/lib/api"
import type { AgentDef, AgentRole, ToolDef } from "./agent-platform-data"

type BackendAgent = {
  id: string
  companyId: string
  name: string
  slug: string
  description: string | null
  capabilityDescription: string | null
  systemPrompt: string
  hookId: string | null
  maxSteps: number
  temperature: number
  isRootAgent: boolean
  isActive: boolean
  toolIds: string[]
  modelId: string | null
  provider: string | null
  parentId: string | null
  children?: BackendAgent[]
}

type BackendTool = {
  toolId: string
  name: string
  description: string | null
  category: string | null
  domain: string | null
  promptSnippet: string | null
  hitlRequired: boolean
  guardrails: string[]
  deprecated: boolean
}

function deriveRole(agent: BackendAgent): AgentRole {
  if (agent.isRootAgent) return "supervisor"
  if (agent.parentId === null) return "dept-head"
  return "specialist"
}

function mapFamily(domain: string | null, category: string | null): ToolDef["family"] {
  const d = (domain ?? category ?? "").toLowerCase()
  if (d.includes("lark")) return "lark"
  if (d.includes("google") || d.includes("gmail")) return "google"
  if (d.includes("zoho")) return "zoho"
  if (d.includes("context") || d.includes("rag") || d.includes("search")) return "context"
  return "internal"
}

function toToolDef(t: BackendTool): ToolDef {
  return {
    id: t.toolId,
    family: mapFamily(t.domain, t.category),
    name: t.name,
    actionGroups: ["read"],
    description: t.description ?? "",
  }
}

function toAgentDef(agent: BackendAgent, allAgents: BackendAgent[]): AgentDef {
  const children = allAgents.filter((a) => a.parentId === agent.id)
  const role = deriveRole(agent)
  const isTopLevel = role === "supervisor" || role === "dept-head"
  const parentAgent = agent.parentId ? allAgents.find((a) => a.id === agent.parentId) : null

  return {
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    role: parentAgent && deriveRole(parentAgent) !== "supervisor" ? "specialist" : role,
    parentId: agent.parentId,
    enabled: agent.isActive,
    capabilityDescription: agent.capabilityDescription ?? agent.description ?? "",
    toolIds: agent.toolIds,
    subAgentIds: children.map((c) => c.id),
    systemPromptSections: {
      role: agent.systemPrompt,
      canDo: "",
      cannotDo: "",
      rules: "",
      tone: "",
    },
    directSlug: isTopLevel ? `--${agent.slug}` : undefined,
    defaultDepartments: [],
  }
}

export type AgentDataState = {
  agents: AgentDef[]
  agentById: Record<string, AgentDef>
  tools: ToolDef[]
  toolById: Record<string, ToolDef>
  loading: boolean
  error: string | null
  stats: { total: number; heads: number; specialists: number; enabled: number }
  refresh: () => void
  toggleAgent: (id: string) => Promise<void>
  updateAgent: (id: string, data: UpdateAgentInput) => Promise<void>
  createAgent: (data: CreateAgentInput) => Promise<void>
  deleteAgent: (id: string) => Promise<void>
}

export function useAgentData(): AgentDataState {
  const { token } = useAdminAuth()
  const [rawAgents, setRawAgents] = useState<BackendAgent[]>([])
  const [rawTools, setRawTools] = useState<BackendTool[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const [agentData, toolData] = await Promise.all([
        agentsApi.list<BackendAgent>(token),
        agentsApi.toolRegistry<BackendTool>(token),
      ])
      setRawAgents(Array.isArray(agentData) ? agentData : [])
      setRawTools(Array.isArray(toolData) ? toolData : [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load agents"
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { fetchAll() }, [fetchAll])

  const agents = rawAgents.map((a) => toAgentDef(a, rawAgents))
  const agentById = Object.fromEntries(agents.map((a) => [a.id, a])) as Record<string, AgentDef>
  const tools = rawTools.map(toToolDef)
  const toolById = Object.fromEntries(tools.map((t) => [t.id, t])) as Record<string, ToolDef>

  const stats = {
    total: agents.length,
    heads: agents.filter((a) => a.role === "dept-head").length,
    specialists: agents.filter((a) => a.role === "specialist").length,
    enabled: agents.filter((a) => a.enabled).length,
  }

  const toggleAgent = async (id: string) => {
    if (!token) return
    try {
      await agentsApi.toggle(id, token)
      toast.success("Agent toggled")
      await fetchAll()
    } catch { /* error toast handled by api.ts */ }
  }

  const updateAgent = async (id: string, data: UpdateAgentInput) => {
    if (!token) return
    try {
      await agentsApi.update(id, data, token)
      toast.success("Agent updated")
      await fetchAll()
    } catch { /* error toast handled by api.ts */ }
  }

  const createAgent = async (data: CreateAgentInput) => {
    if (!token) return
    try {
      await agentsApi.create(data, token)
      toast.success("Agent created")
      await fetchAll()
    } catch { /* error toast handled by api.ts */ }
  }

  const deleteAgent = async (id: string) => {
    if (!token) return
    try {
      await agentsApi.delete(id, token)
      toast.success("Agent deleted")
      await fetchAll()
    } catch { /* error toast handled by api.ts */ }
  }

  return { agents, agentById, tools, toolById, loading, error, stats, refresh: fetchAll, toggleAgent, updateAgent, createAgent, deleteAgent }
}
