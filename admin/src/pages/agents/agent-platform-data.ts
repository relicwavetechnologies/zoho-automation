// Mock data for the agent platform canvas.
// Shape mirrors `docs/GENERIC-AGENT-PLATFORM-VISION.md` §3 (Capability Registry).
// Replace with live AgentRegistry when backend lands (vision doc §7.3).

export type AgentRole = "supervisor" | "dept-head" | "specialist"

export type AgentDef = {
  id: string
  slug: string
  name: string
  role: AgentRole
  parentId: string | null
  departmentId?: string
  enabled: boolean
  capabilityDescription: string
  toolIds: string[]
  subAgentIds: string[]
  systemPromptSections: {
    role: string
    canDo: string
    cannotDo: string
    rules: string
    tone: string
  }
  directSlug?: string
  defaultDepartments?: string[]
}

export type ToolDef = {
  id: string
  family: "lark" | "google" | "zoho" | "context" | "internal"
  name: string
  actionGroups: ReadonlyArray<"read" | "create" | "update" | "delete" | "send">
  description: string
}

export const tools: ToolDef[] = [
  { id: "zohoCrm", family: "zoho", name: "Zoho CRM", actionGroups: ["read", "create", "update"], description: "Leads, contacts, deals" },
  { id: "zohoBooks", family: "zoho", name: "Zoho Books", actionGroups: ["read", "create"], description: "Invoices, payments, ledger" },
  { id: "larkMessage", family: "lark", name: "Lark Message", actionGroups: ["send"], description: "Send messages and cards" },
  { id: "larkBase", family: "lark", name: "Lark Base", actionGroups: ["read", "create", "update"], description: "Base tables and records" },
  { id: "larkCalendar", family: "lark", name: "Lark Calendar", actionGroups: ["read", "create"], description: "Events, busy/free, invitees" },
  { id: "larkDocs", family: "lark", name: "Lark Docs", actionGroups: ["read", "create"], description: "Docs and pages" },
  { id: "googleDrive", family: "google", name: "Google Drive", actionGroups: ["read", "create"], description: "Files and folders" },
  { id: "googleGmail", family: "google", name: "Gmail", actionGroups: ["read", "send"], description: "Inbox, threads, drafts" },
  { id: "contextSearch", family: "context", name: "Context Search", actionGroups: ["read"], description: "RAG over company knowledge" },
  { id: "webSearch", family: "internal", name: "Web Search", actionGroups: ["read"], description: "External web lookups" },
]

export const toolById = Object.fromEntries(tools.map((t) => [t.id, t])) as Record<string, ToolDef>

export const agents: AgentDef[] = [
  {
    id: "supervisor",
    slug: "supervisor",
    name: "Supervisor",
    role: "supervisor",
    parentId: null,
    enabled: true,
    capabilityDescription:
      "Root orchestrator. Routes user requests to department heads based on semantic understanding of intent.",
    toolIds: [],
    subAgentIds: ["finance-head", "sales-head", "media-head", "lark-ops", "google-ops", "zoho-ops", "context-agent"],
    systemPromptSections: {
      role: "You are the platform supervisor. Your job is to route every user request to the correct department.",
      canDo: "Read all dept head capability descriptions. Dispatch to one or many heads. Synthesize cross-dept replies.",
      cannotDo: "Execute tools yourself. Bypass agent-level RBAC. Skip the audit log.",
      rules: "Always pick the most specific dept head. If unsure, ask a single clarifying question.",
      tone: "Concise, professional, no chit-chat.",
    },
  },
  {
    id: "finance-head",
    slug: "finance-head",
    name: "Finance Head",
    role: "dept-head",
    parentId: "supervisor",
    departmentId: "finance",
    enabled: true,
    directSlug: "--finance",
    defaultDepartments: ["finance"],
    capabilityDescription:
      "Owns Finance domain — bookkeeping, invoicing, expense reports, vendor onboarding, ledger queries.",
    toolIds: ["zohoBooks", "contextSearch", "larkMessage"],
    subAgentIds: ["books-specialist", "crm-specialist"],
    systemPromptSections: {
      role: "Finance head. Owns books, payments, vendor management.",
      canDo: "Query ledger, draft invoices, route to Books or CRM specialists for deep work.",
      cannotDo: "Send money. Approve expenses without HITL.",
      rules: "All write operations route through approval gate. Always cite ledger entry IDs in replies.",
      tone: "Precise, numerate, no rounding.",
    },
  },
  {
    id: "sales-head",
    slug: "sales-head",
    name: "Sales Head",
    role: "dept-head",
    parentId: "supervisor",
    departmentId: "sales",
    enabled: true,
    directSlug: "--sales",
    defaultDepartments: ["sales"],
    capabilityDescription:
      "Owns Sales domain — CRM operations, lead routing, pipeline reporting, outreach drafts.",
    toolIds: ["zohoCrm", "googleGmail", "larkMessage", "contextSearch"],
    subAgentIds: ["crm-specialist"],
    systemPromptSections: {
      role: "Sales head. Owns CRM and outbound.",
      canDo: "Run CRM queries, draft outreach emails, summarize pipeline state.",
      cannotDo: "Send outbound emails without HITL approval.",
      rules: "Drafts go to user inbox first. Never auto-send.",
      tone: "Crisp, action-oriented.",
    },
  },
  {
    id: "media-head",
    slug: "media-head",
    name: "Media Head",
    role: "dept-head",
    parentId: "supervisor",
    departmentId: "media",
    enabled: true,
    directSlug: "--media",
    defaultDepartments: ["media"],
    capabilityDescription:
      "Owns Media domain — content drafts, asset library, publishing schedule, brand guideline checks.",
    toolIds: ["larkDocs", "googleDrive", "contextSearch", "webSearch"],
    subAgentIds: [],
    systemPromptSections: {
      role: "Media head. Owns content and brand assets.",
      canDo: "Draft posts, find assets, summarize brand guidelines.",
      cannotDo: "Publish without explicit approval.",
      rules: "Always tag drafts with brand-checked flag.",
      tone: "Creative, on-brand.",
    },
  },
  {
    id: "lark-ops",
    slug: "lark-ops",
    name: "Lark Ops",
    role: "dept-head",
    parentId: "supervisor",
    enabled: true,
    capabilityDescription:
      "Owns Lark workspace operations — calendar, base, messaging, docs.",
    toolIds: ["larkMessage", "larkBase", "larkCalendar", "larkDocs"],
    subAgentIds: ["calendar-specialist", "base-specialist"],
    systemPromptSections: {
      role: "Lark workspace operator.",
      canDo: "Schedule meetings, query base tables, post messages, create docs.",
      cannotDo: "Delete records without HITL.",
      rules: "Calendar invites to >5 attendees require approval.",
      tone: "Operational, tight.",
    },
  },
  {
    id: "google-ops",
    slug: "google-ops",
    name: "Google Ops",
    role: "dept-head",
    parentId: "supervisor",
    enabled: true,
    capabilityDescription:
      "Owns Google Workspace operations — Drive, Gmail.",
    toolIds: ["googleDrive", "googleGmail"],
    subAgentIds: [],
    systemPromptSections: {
      role: "Google workspace operator.",
      canDo: "Find files, draft emails, share documents.",
      cannotDo: "Send mail without HITL.",
      rules: "External recipients always require approval.",
      tone: "Operational, tight.",
    },
  },
  {
    id: "zoho-ops",
    slug: "zoho-ops",
    name: "Zoho Ops",
    role: "dept-head",
    parentId: "supervisor",
    enabled: false,
    capabilityDescription:
      "Owns Zoho suite operations — CRM and Books cross-cutting workflows.",
    toolIds: ["zohoCrm", "zohoBooks"],
    subAgentIds: [],
    systemPromptSections: {
      role: "Zoho operator.",
      canDo: "Cross-suite reads, paired CRM-Books workflows.",
      cannotDo: "Anything destructive without HITL.",
      rules: "Always confirm tenant before writes.",
      tone: "Operational.",
    },
  },
  {
    id: "context-agent",
    slug: "context-agent",
    name: "Context Agent",
    role: "dept-head",
    parentId: "supervisor",
    enabled: true,
    capabilityDescription:
      "Owns RAG retrieval — answers grounded questions from the company knowledge corpus.",
    toolIds: ["contextSearch", "webSearch"],
    subAgentIds: [],
    systemPromptSections: {
      role: "Context retrieval agent.",
      canDo: "Search internal corpus, blend with web search, return cited answers.",
      cannotDo: "Fabricate citations.",
      rules: "Every claim cites a doc or returns 'unknown'.",
      tone: "Faithful, sourced.",
    },
  },
  {
    id: "books-specialist",
    slug: "books-specialist",
    name: "Books Specialist",
    role: "specialist",
    parentId: "finance-head",
    enabled: true,
    capabilityDescription: "Deep Zoho Books expertise — ledger reconciliation, invoice templates, ageing reports.",
    toolIds: ["zohoBooks"],
    subAgentIds: [],
    systemPromptSections: {
      role: "Zoho Books specialist.",
      canDo: "Reconcile ledger, build ageing reports, manage invoice templates.",
      cannotDo: "Send invoices without HITL.",
      rules: "Always quote document numbers.",
      tone: "Numerate, terse.",
    },
  },
  {
    id: "crm-specialist",
    slug: "crm-specialist",
    name: "CRM Specialist",
    role: "specialist",
    parentId: "finance-head",
    enabled: true,
    capabilityDescription: "Deep Zoho CRM expertise — pipeline modeling, deal hygiene, custom field lookups.",
    toolIds: ["zohoCrm"],
    subAgentIds: [],
    systemPromptSections: {
      role: "Zoho CRM specialist.",
      canDo: "Pipeline reports, deal hygiene, custom field queries.",
      cannotDo: "Mass updates without HITL.",
      rules: "Verify ownership before edits.",
      tone: "Numerate, terse.",
    },
  },
  {
    id: "calendar-specialist",
    slug: "calendar-specialist",
    name: "Calendar Specialist",
    role: "specialist",
    parentId: "lark-ops",
    enabled: true,
    capabilityDescription: "Deep Lark Calendar expertise — recurrence rules, room booking, busy/free reasoning.",
    toolIds: ["larkCalendar"],
    subAgentIds: [],
    systemPromptSections: {
      role: "Lark Calendar specialist.",
      canDo: "Find optimal slots, manage recurring events, resolve conflicts.",
      cannotDo: "Cancel another user's events.",
      rules: "Always confirm timezone.",
      tone: "Operational.",
    },
  },
  {
    id: "base-specialist",
    slug: "base-specialist",
    name: "Base Specialist",
    role: "specialist",
    parentId: "lark-ops",
    enabled: false,
    capabilityDescription: "Deep Lark Base expertise — schema design, formula fields, cross-table joins.",
    toolIds: ["larkBase"],
    subAgentIds: [],
    systemPromptSections: {
      role: "Lark Base specialist.",
      canDo: "Schema design, formula authoring, joins.",
      cannotDo: "Drop tables.",
      rules: "Schema changes require admin HITL.",
      tone: "Technical.",
    },
  },
]

export const agentById = Object.fromEntries(agents.map((a) => [a.id, a])) as Record<string, AgentDef>

export const platformStats = () => {
  const total = agents.length
  const heads = agents.filter((a) => a.role === "dept-head").length
  const specialists = agents.filter((a) => a.role === "specialist").length
  const enabled = agents.filter((a) => a.enabled).length
  return { total, heads, specialists, enabled }
}
