import { useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { agentsApi, type CreateAgentInput, type ModelCatalogEntry, type UpdateAgentInput } from "@/lib/api"
import { adminQueryKeys, getAdminQueryScope } from "@/lib/query-client"
import type { AgentDef, AgentModelProvider, AgentRole, ToolDef } from "./agent-platform-data"

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
    provider: isAgentModelProvider(agent.provider) ? agent.provider : null,
    modelId: agent.modelId,
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

function isAgentModelProvider(value: string | null): value is AgentModelProvider {
  return value === "google" || value === "openai"
}

export type AgentDataState = {
  agents: AgentDef[]
  agentById: Record<string, AgentDef>
  tools: ToolDef[]
  toolById: Record<string, ToolDef>
  modelCatalog: ModelCatalogEntry[]
  loading: boolean
  error: string | null
  stats: { total: number; heads: number; specialists: number; enabled: number }
  refresh: () => Promise<void>
  toggleAgent: (id: string) => Promise<void>
  updateAgent: (id: string, data: UpdateAgentInput) => Promise<void>
  createAgent: (data: CreateAgentInput) => Promise<void>
  deleteAgent: (id: string) => Promise<void>
}

export function useAgentData(): AgentDataState {
  const { token } = useAdminAuth()
  const queryClient = useQueryClient()
  const scope = getAdminQueryScope(token)
  const agentsQuery = useQuery({
    queryKey: adminQueryKeys.agents(scope),
    enabled: Boolean(token),
    queryFn: async () => {
      const agentData = await agentsApi.list<BackendAgent>(token ?? undefined)
      return Array.isArray(agentData) ? agentData : []
    },
  })
  const toolsQuery = useQuery({
    queryKey: adminQueryKeys.toolRegistry(scope),
    enabled: Boolean(token),
    queryFn: async () => {
      const toolData = await agentsApi.toolRegistry<BackendTool>(token ?? undefined)
      return Array.isArray(toolData) ? toolData : []
    },
  })
  const modelCatalogQuery = useQuery({
    queryKey: adminQueryKeys.agentModelCatalog(scope),
    enabled: Boolean(token),
    queryFn: async () => agentsApi.modelCatalog(token ?? undefined),
  })

  const rawAgents = agentsQuery.data ?? []
  const rawTools = toolsQuery.data ?? []
  const modelCatalog = modelCatalogQuery.data ?? []
  const agents = rawAgents.map((a) => toAgentDef(a, rawAgents))
  const agentById = Object.fromEntries(agents.map((a) => [a.id, a])) as Record<string, AgentDef>
  const tools = rawTools.map(toToolDef)
  const toolById = Object.fromEntries(tools.map((t) => [t.id, t])) as Record<string, ToolDef>
  const loading = agentsQuery.isPending || toolsQuery.isPending || modelCatalogQuery.isPending
  const error = useMemo(() => {
    const source = agentsQuery.error ?? toolsQuery.error ?? modelCatalogQuery.error
    return source instanceof Error ? source.message : null
  }, [agentsQuery.error, toolsQuery.error, modelCatalogQuery.error])

  const stats = {
    total: agents.length,
    heads: agents.filter((a) => a.role === "dept-head").length,
    specialists: agents.filter((a) => a.role === "specialist").length,
    enabled: agents.filter((a) => a.enabled).length,
  }

  const toggleAgent = async (id: string) => {
    if (!token) return
    const previousAgents = queryClient.getQueryData<BackendAgent[]>(adminQueryKeys.agents(scope)) ?? []
    queryClient.setQueryData<BackendAgent[]>(adminQueryKeys.agents(scope), (current = []) =>
      current.map((agent) => (agent.id === id ? { ...agent, isActive: !agent.isActive } : agent)),
    )
    try {
      await agentsApi.toggle(id, token)
      toast.success("Agent toggled")
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.agents(scope) })
    } catch {
      queryClient.setQueryData(adminQueryKeys.agents(scope), previousAgents)
    }
  }

  const updateAgent = async (id: string, data: UpdateAgentInput) => {
    if (!token) return
    try {
      await agentsApi.update(id, data, token)
      toast.success("Agent updated")
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.agents(scope) })
    } catch { /* error toast handled by api.ts */ }
  }

  const createAgent = async (data: CreateAgentInput) => {
    if (!token) return
    try {
      await agentsApi.create(data, token)
      toast.success("Agent created")
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.agents(scope) })
    } catch { /* error toast handled by api.ts */ }
  }

  const deleteAgent = async (id: string) => {
    if (!token) return
    try {
      await agentsApi.delete(id, token)
      toast.success("Agent deleted")
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.agents(scope) })
    } catch { /* error toast handled by api.ts */ }
  }

  return {
    agents,
    agentById,
    tools,
    toolById,
    modelCatalog,
    loading,
    error,
    stats,
    refresh: () => Promise.all([agentsQuery.refetch(), toolsQuery.refetch()]).then(() => undefined),
    toggleAgent,
    updateAgent,
    createAgent,
    deleteAgent,
  }
}
