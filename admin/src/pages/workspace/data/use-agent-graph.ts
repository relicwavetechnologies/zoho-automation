/**
 * The agent map — Divo's orchestrator and everything it can reach, for one person.
 *
 * HALF OF THIS IS REAL. Read this paragraph before trusting a field.
 *
 * The graph's *shape* is real. Departments, people, roles, which tools exist and
 * exactly which actions a given person may run come from live routes — the same
 * permission snapshot the Team matrix uses, with company-admin reads enabled for
 * company views. If an edge is lit here, the backend really would let that
 * person run that agent today.
 *
 * The graph's *agent configuration* is invented. System prompt, model, container
 * policy and memory scope have no backend at all: there is no agent-definition
 * table, and the per-user container is keyed by company+user rather than by
 * anything an admin authored. Those fields are marked in DATA_SOURCES and every
 * panel rendering them says so.
 *
 * ONE AGENT IS ONE FAMILY. The backend has no "agent" — it has ~40 tools grouped
 * into 17 families, and the tool is far too fine a grain to be a thing you
 * configure: nobody wants to write a system prompt for "AITable Fields"
 * separately from "AITable Datasheets". So a family is the agent, its tools are
 * the actions it can take, and the map draws one node per family.
 */
import { useMemo } from 'react'
import {
  useDepartment, useDepartmentMatrix,
  type ConfiguredProvenance, type DeptMember, type DeptRole, type ToolScopeSnapshot,
} from './use-team'
import {
  familyAgentId, isAuthored, useAgentDrafts,
  type AgentDefinition, type ContainerMode, type MemoryScope,
} from './agent-store'

export type { ContainerMode, MemoryScope } from './agent-store'

/* ── Families ──────────────────────────────────────────────
   Mirrors TOOL_FAMILY_DEFINITIONS and TOOL_FAMILY_MAP in
   advance-backend/src/domain/tools/tool-id.ts, which is the source of truth.
   Duplicated rather than fetched because no route serves the taxonomy, and a
   tool the backend adds without telling us falls back to its own family rather
   than vanishing from the map. */

export type ToolFamily =
  | 'lark' | 'google' | 'canva' | 'airtable' | 'aitable' | 'zoho' | 'shopify'
  | 'context' | 'skills' | 'memory' | 'rag' | 'data' | 'execution'
  | 'scheduling' | 'semrush' | 'oms' | 'menhood'

export const FAMILY_NAME: Record<ToolFamily, string> = {
  lark: 'Lark',
  google: 'Google Workspace',
  canva: 'Canva',
  airtable: 'Airtable',
  aitable: 'AITable',
  zoho: 'Zoho',
  shopify: 'Shopify',
  context: 'Search and context',
  skills: 'Skills',
  memory: 'Memory',
  rag: 'Document retrieval',
  data: 'Data processing',
  execution: 'Local execution',
  scheduling: 'Scheduled work',
  semrush: 'Semrush',
  oms: 'OMS',
  menhood: 'Menhood',
}

const FAMILY_OF: Record<string, ToolFamily> = {
  larkMessaging: 'lark', larkContacts: 'lark', larkTask: 'lark', larkCalendar: 'lark',
  larkMeeting: 'lark', larkDoc: 'lark', larkBase: 'lark', larkApproval: 'lark',

  googleGmail: 'google', googleDrive: 'google', googleCalendar: 'google', googleDocs: 'google',
  googleSheets: 'google', googleSlides: 'google', googleForms: 'google', googleTasks: 'google',
  googleContacts: 'google', googleChat: 'google', googleAppsScript: 'google',

  canvaDesign: 'canva',

  airtableBase: 'airtable', airtableRecords: 'airtable',
  airtableSchema: 'airtable', airtableAutomation: 'airtable',

  aitableDatasheets: 'aitable', aitableFields: 'aitable',

  zohoCrm: 'zoho', zohoBooks: 'zoho',

  shopifyAnalytics: 'shopify', shopifyOrders: 'shopify', shopifyCustomers: 'shopify',

  webSearch: 'context',
  knowledge: 'memory',
  mailAutomations: 'scheduling', scheduledWorkflows: 'scheduling',
  semrush: 'semrush',
  omsSiteData: 'oms',
  menhoodData: 'menhood',
}

/**
 * Which family a tool belongs to.
 *
 * An unknown id becomes its own family rather than being dropped or lumped into
 * a catch-all — a tool the backend added is worth seeing on the map, and it
 * will be named after itself until this table catches up.
 */
export function familyOf(toolId: string): ToolFamily {
  return FAMILY_OF[toolId] ?? (toolId as ToolFamily)
}

export const familyName = (family: ToolFamily): string => FAMILY_NAME[family] ?? family

/* ── What the map is made of ───────────────────────────── */

/** One governed tool, seen as a single thing this agent can do. */
export type AgentTool = {
  toolId: string
  name: string
  description: string | null
  supportedActions: string[]
  actionLabels: Record<string, string>
  /** What this person may actually run, after the company ceiling is applied. */
  allowedActions: string[]
  /**
   * Configured for this person but held down by a company-level rule.
   *
   * Worth keeping apart from "not granted": one is a decision somebody made
   * about this person, the other is a ceiling above them, and only the second
   * has an admin who can lift it.
   */
  blockedActions: string[]
  provenance: ConfiguredProvenance | null
  reachable: boolean
}

/**
 * One agent — the unit the map draws and the drawer edits.
 *
 * Two kinds. A `family` agent is the default carve-up: every Google tool is the
 * Google agent whether anybody asked for that or not, because a tool has to
 * belong somewhere. An `authored` agent is one an admin made, and it takes its
 * tools *out* of their families — so the two kinds together always partition the
 * tool set exactly once.
 */
export type AgentNode = {
  id: string
  kind: 'family' | 'authored'
  /** Null for an authored agent, which may span families or none of them. */
  family: ToolFamily | null
  name: string
  tools: AgentTool[]
  /** Distinct actions this person may run anywhere in the agent. */
  allowedActions: string[]
  reachableToolCount: number
  blockedToolCount: number
  reachable: boolean
  config: AgentConfig
  /** Whether a human wrote this agent's configuration, or it is on defaults. */
  authored: boolean
}

/* ── The invented half ─────────────────────────────────── */

export type AgentConfig = {
  systemPrompt: string
  modelId: string
  container: {
    mode: ContainerMode
    cpu: number
    memoryMb: number
    idleStopMinutes: number
  }
  memory: {
    /** Which bank this agent reads and writes. `agent` does not exist yet. */
    scope: MemoryScope
    retentionDays: number | null
    learning: boolean
  }
}

/**
 * Defaults every agent falls back to.
 *
 * These mirror what a per-user container is actually given today — 2 vCPU,
 * 2 GiB, stopped after 45 idle minutes — so the numbers on screen are the real
 * ones even though nothing reads them from anywhere.
 */
const DEFAULT_CONFIG: AgentConfig = {
  systemPrompt: '',
  modelId: 'deepseek-chat',
  container: { mode: 'shared', cpu: 2, memoryMb: 2048, idleStopMinutes: 45 },
  memory: { scope: 'user', retentionDays: null, learning: false },
}

/** Per-agent overrides, keyed by family. Only a few families are written out. */
const CONFIG_BY_FAMILY: Partial<Record<ToolFamily, Partial<AgentConfig>>> = {
  zoho: {
    systemPrompt:
      'You are the finance desk. Read Zoho precisely and never round a figure. '
      + 'Stage every invoice for review before it is created, and never send anything to a customer.',
    modelId: 'deepseek-reasoner',
    container: { mode: 'dedicated', cpu: 2, memoryMb: 3072, idleStopMinutes: 20 },
    memory: { scope: 'agent', retentionDays: 90, learning: true },
  },
  google: {
    systemPrompt: 'You handle mail and documents. Draft, never send, unless the person asked for a send in this turn.',
    container: { mode: 'dedicated', cpu: 1, memoryMb: 1536, idleStopMinutes: 45 },
    memory: { scope: 'user', retentionDays: 30, learning: true },
  },
  lark: {
    systemPrompt: 'You work inside Lark. Match the room you are posting into — brief in a group, fuller in a DM.',
    memory: { scope: 'department', retentionDays: 180, learning: true },
  },
  memory: {
    systemPrompt: 'You are the memory keeper. Cite the resource behind every claim.',
    memory: { scope: 'company', retentionDays: null, learning: false },
  },
  context: {
    container: { mode: 'ephemeral', cpu: 1, memoryMb: 1024, idleStopMinutes: 5 },
    memory: { scope: 'agent', retentionDays: 7, learning: false },
  },
}

function mergeConfig(...layers: Array<Partial<AgentConfig> | undefined>): AgentConfig {
  return layers.reduce<AgentConfig>((acc, layer) => layer ? {
    ...acc,
    ...layer,
    container: { ...acc.container, ...layer.container },
    memory: { ...acc.memory, ...layer.memory },
  } : acc, DEFAULT_CONFIG)
}

/** A family agent's shipped shape, before anyone edits it. */
export const configFor = (family: ToolFamily): AgentConfig => mergeConfig(CONFIG_BY_FAMILY[family])

/** Whether this family arrives pre-written, or is running on bare defaults. */
export const isConfigured = (family: ToolFamily) => Boolean(CONFIG_BY_FAMILY[family])

export const CONTAINER_LABEL: Record<ContainerMode, string> = {
  dedicated: 'Its own container',
  shared: 'Shares the person’s container',
  ephemeral: 'New container each run',
}

export const MEMORY_SCOPE_LABEL: Record<AgentConfig['memory']['scope'], string> = {
  agent: 'This agent only',
  user: 'The person',
  department: 'The department',
  company: 'The whole company',
}

export const PROVENANCE_LABEL: Record<ConfiguredProvenance, string> = {
  member_override: 'Set for this person',
  department_role: 'From their role',
  default: 'Divo default',
}

/* ── The graph ─────────────────────────────────────────── */

export type AgentGraph = {
  department: { id: string; name: string } | null
  people: DeptMember[]
  roles: DeptRole[]
  /** Every agent the department governs, reachable or not. */
  agents: AgentNode[]
  reachableCount: number
  /** Governed tools behind those agents, for the "12 tools" style counts. */
  toolCount: number
  loading: boolean
  error: string | null
  refused: boolean
}

/**
 * Builds the map for one department, seen through one person's permissions.
 *
 * Pass no `userId` and every agent comes back unreachable — which is the honest
 * answer, because "what can this person do" has no meaning until a person is
 * chosen. Showing everything lit until someone is picked would read as "the
 * department can do all of this" and be wrong the moment it mattered.
 */
/**
 * The agents a person can actually reach, derived from the permission matrix.
 *
 * Lifted out of the hook so it can be tested. This is the calculation behind
 * the map's one promise — "lit edges are permissions the backend would really
 * grant today" — and a wrong edge here is not a cosmetic bug: it tells an
 * admin somebody can do something they cannot, or cannot do something they
 * can. It ran entirely untested inside a `useMemo`, reachable only by loading
 * the page against a live department.
 *
 * Pure: same inputs, same answer, no fetching.
 */
export function buildAgents(
  tools: readonly ToolScopeSnapshot[],
  userId: string | undefined,
  drafts: Record<string, AgentDefinition>,
): AgentNode[] {
  // Which authored agent has claimed each tool. Built first because a claimed
  // tool must leave its family — otherwise it would appear twice and the map
  // would be lying about who runs it.
  const claimedBy = new Map<string, AgentDefinition>()
  for (const draft of Object.values(drafts)) {
    if (!isAuthored(draft.id)) continue
    for (const toolId of draft.toolIds) claimedBy.set(toolId, draft)
  }

  const buckets = new Map<string, AgentTool[]>()

  for (const snapshot of tools) {
    const mine = userId
      ? snapshot.memberActionStates.filter((s) => s.userId === userId)
      : []

    const allowedActions = mine.filter((s) => s.effectiveAllowed).map((s) => s.actionGroup)
    const blockedActions = mine
      .filter((s) => s.configuredAllowed && !s.effectiveAllowed)
      .map((s) => s.actionGroup)

    // Provenance of the grant that actually landed. A member override beats a
    // role grant beats a default, and naming the strongest one tells an admin
    // where to go to change it.
    const strongest = mine
      .filter((s) => s.effectiveAllowed)
      .sort((a, b) => rankProvenance(b.configuredProvenance) - rankProvenance(a.configuredProvenance))[0]

    const tool: AgentTool = {
      toolId: snapshot.tool.toolId,
      name: snapshot.tool.name,
      description: snapshot.tool.description ?? null,
      supportedActions: snapshot.supportedActions,
      actionLabels: snapshot.actionLabels,
      allowedActions,
      blockedActions,
      provenance: strongest?.configuredProvenance ?? null,
      reachable: allowedActions.length > 0,
    }

    const owner = claimedBy.get(tool.toolId)
    const key = owner ? owner.id : familyAgentId(familyOf(tool.toolId))
    const bucket = buckets.get(key)
    if (bucket) bucket.push(tool)
    else buckets.set(key, [tool])
  }

  const nodes = Array.from(buckets.entries()).map(([id, tools]) => {
    const draft = drafts[id]
    const authored = isAuthored(id)
    const family = authored ? null : (id.slice('family:'.length) as ToolFamily)
    const reachableTools = tools.filter((t) => t.reachable)

    return {
      id,
      kind: authored ? 'authored' : 'family',
      family,
      name: draft?.name || (family ? familyName(family) : 'Untitled agent'),
      tools,
      // Deduped: "read" on eight Lark tools is one capability to a reader,
      // not eight.
      allowedActions: Array.from(new Set(reachableTools.flatMap((t) => t.allowedActions))),
      reachableToolCount: reachableTools.length,
      blockedToolCount: tools.filter((t) => !t.reachable && t.blockedActions.length > 0).length,
      reachable: reachableTools.length > 0,
      // An admin's edit wins over the family's shipped defaults, which win
      // over the bare default. Same precedence as the permission resolver.
      config: mergeConfig(family ? CONFIG_BY_FAMILY[family] : undefined, draft ?? undefined),
      authored: Boolean(draft) || (family ? isConfigured(family) : false),
    } satisfies AgentNode
  })

  // Authored agents first — somebody made those on purpose. Then reachable,
  // then the biggest, so the eye lands on what this person actually has.
  return nodes.sort((a, b) =>
    Number(b.kind === 'authored') - Number(a.kind === 'authored')
    || Number(b.reachable) - Number(a.reachable)
    || b.tools.length - a.tools.length
    || a.name.localeCompare(b.name))
}

export function useAgentGraph(departmentId?: string, userId?: string): AgentGraph {
  const dept = useDepartment(departmentId)
  const matrix = useDepartmentMatrix(departmentId)
  const drafts = useAgentDrafts()

  const agents = useMemo<AgentNode[]>(
    () => buildAgents(matrix.tools, userId, drafts),
    [matrix.tools, userId, drafts],
  )

  return {
    department: dept.snapshot
      ? { id: dept.snapshot.department.id, name: dept.snapshot.department.name }
      : null,
    people: dept.snapshot?.memberships ?? [],
    roles: dept.snapshot?.roles ?? [],
    agents,
    reachableCount: agents.filter((a) => a.reachable).length,
    toolCount: agents.reduce((n, a) => n + a.tools.length, 0),
    loading: dept.loading || matrix.loading,
    error: dept.error ?? matrix.error,
    refused: dept.refused,
  }
}

const rankProvenance = (p: ConfiguredProvenance): number =>
  p === 'member_override' ? 3 : p === 'department_role' ? 2 : 1
