# Generic Enterprise Agent Platform — Architecture Vision

> **Status**: Design phase  
> **Scope**: advance-backend escalation to a company-agnostic, multi-dept, hierarchical agent orchestration platform  
> **Audience**: Engineering, Admin UI team

---

## 1. The Problem With Today's Architecture

The current system is a **Lark-centric, hardcoded 4-agent topology**:

- Supervisor has 4 fixed dispatcher tools: Lark, Google, Zoho, Context
- Routing rules are baked into `supervisor.prompt.ts` as hardcoded text
- Adding a new integration (HubSpot, Notion, a new dept) requires editing supervisor code and its prompt
- No concept of "which agents does this user have access to" — agent-level RBAC is missing
- Channel layer is tightly coupled to Lark; adding Slack/Teams requires understanding Lark internals
- All tools are always visible to all agents regardless of domain

**The company context**: This is a group of companies — product, services, media, events. Too many integrations and departments to hardcode. The architecture must make adding a new department or tool a configuration task, not a code change.

---

## 2. The Target Architecture

### 2.1 Three-Tier Agent Hierarchy

```
User (Lark / Slack / Teams / REST)
  ↓
┌─────────────────────────────────────────────────┐
│  SUPERVISOR (root, always system-level)         │
│  Discovers dept heads dynamically from registry │
│  Routes by LLM understanding of user intent     │
└─────────────────────────────────────────────────┘
          ↓                    ↓                ↓
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Finance     │   │  Sales Head  │   │  Media Head  │
│  Head Agent  │   │              │   │              │
│  (dept head) │   │  (dept head) │   │  (dept head) │
└──────────────┘   └──────────────┘   └──────────────┘
    ↓       ↓
┌────────┐ ┌───────┐
│ Books  │ │ CRM   │   ← Specialist sub-agents (optional)
│ Spec.  │ │ Spec. │     only needed when dept head gets complex
└────────┘ └───────┘
```

**Three tiers:**
1. **Supervisor** — root, system-managed, discovers dept heads from registry, routes by LLM semantic understanding
2. **Dept Head Agent** — sovereign over a domain, has its own tools AND can delegate to specialist sub-agents
3. **Specialist Sub-Agent** — deep expertise for a narrow task, optional, created when the dept head becomes too complex

**Depth limit**: Soft limit of 3 levels by default. Beyond that, latency compounds and LLM context bloats. Configurable per company.

### 2.2 The Unified Capability Model

**Everything is a capability. Nothing is special-cased.**

When building an agent, you assign it two kinds of capabilities from one unified picker:

| Type | Example | At Runtime |
|------|---------|------------|
| **Tool** | Zoho Books, Lark Calendar, Google Drive | Direct API call → returns result string |
| **Sub-Agent** | CRM Specialist, Books Specialist | Runs another LLM agent → returns result string |

From the parent agent's LLM perspective, calling a sub-agent looks identical to calling a tool — it receives a task string and returns a result. The engine handles the recursive execution transparently.

This means:
- `toAISdkTools()` converts both `Tool[]` and `AgentRegistration[]` uniformly
- A sub-agent can be assigned to multiple parents (reuse)
- Adding a new integration = add tool to registry, assign to relevant agents in UI
- Making a dept head more sophisticated = spin out a sub-agent, assign it — no parent rewiring needed

### 2.3 Routing Modes

**Mode 1 — LLM-routed (default)**  
Supervisor reads the user's message and picks the right dept head based on semantic understanding of their `capabilityDescription`. Works for open-ended queries and cross-dept requests.

**Mode 2 — Direct slug routing**  
User context activates a specific agent directly, bypassing the supervisor. Not user-typed — transparent to the user. Example: a pinned "Switch to Finance Agent" button in Lark sends `--finance` prefix transparently. The channel layer intercepts the prefix and routes directly.

Use direct routing when: the user already knows which dept they need, or the system knows from context (e.g., user is in the Finance Lark channel).

**Cross-dept queries**: Supervisor handles by routing to multiple dept heads sequentially, then synthesizing. This already works in the current system and is preserved.

---

## 3. The Capability Registry

### 3.1 Tool Registry

All tools ever built by the team live in a central registry. Tools are always **in-house built** (TypeScript, conforming to `tool.contract.ts`). Every tool has:

- `id` — canonical identifier (e.g., `zohoBooks`, `larkCalendar`)
- `family` — grouping (lark, google, zoho, context, etc.)
- `actionGroups` — what it can do (`read`, `create`, `update`, `delete`, `send`)
- `description` + `parameterDocs` — for LLM tool selection
- `permissionCheck()` — hard RBAC gate, always enforced
- `execute()` — never throws, returns `Result<T, ToolError>`

**The tool registry is a closed list** — only engineering adds new tools (writing TypeScript). The UI exposes them for assignment to agents, but doesn't create them.

### 3.2 Agent Registry

All agents (dept heads, specialists) live in a DB-backed registry. Adding a new dept = inserting a row (via UI, not code).

```typescript
Agent {
  id: AgentId
  slug: string                    // 'finance-head', 'crm-specialist'
  name: string                    // "Finance Head"
  companyId: CompanyId
  parentAgentId?: AgentId         // null = supervisor can dispatch to it (dept head)
  capabilityDescription: string   // 1-2 sentences — supervisor reads this to route
  systemPrompt: string            // compiled from structured sections
  assignedToolIds: ToolId[]       // leaf capabilities (hard RBAC boundary)
  assignedSubAgentIds: AgentId[]  // branch capabilities
  departmentId?: DepartmentId     // for default routing based on user's dept
  isEnabled: boolean
}
```

**DAG constraint**: No cycles. When assigning sub-agents in the UI, only agents not already in the upstream tree are shown. Validated on save.

---

## 4. RBAC Architecture

### 4.1 The Split

| Layer | Mechanism | Enforced By |
|-------|-----------|-------------|
| **Routing rules / behavior** | System prompt (natural language) | LLM understanding |
| **Tool access control** | `permissionCheck()` in tool contract | Code, cannot be bypassed |
| **Agent access control** | `allowedAgentIds` in PermissionResult | Registry filter at runtime |
| **Resource scoping** | `ResourceScope[]` passed to tools | Tools opt-in to scope enforcement |

The key principle: **prompts describe what an agent tries to do. Tools enforce what it's allowed to do.** A well-crafted adversarial prompt cannot bypass a `permissionCheck()`.

### 4.2 RBAC Layers (in resolution order)

```
Company ceiling (role-based tool defaults)
  └── Department overrides (dept-role permissions)
       └── Per-user overrides (highest specificity)
            └── Agent capability boundary (assignedToolIds — agent can never exceed this)
```

An agent running on behalf of user X can only invoke tools that are **both** in user X's allowed tool set AND in the agent's `assignedToolIds`. The intersection is the effective capability.

### 4.3 Agent-Level RBAC

Currently missing — any user can invoke any agent. With the new model:

- `PermissionResult` gains `allowedAgentIds: ReadonlySet<AgentSlug>`
- `AgentPermission` table: `(companyId, role, agentSlug, allowed: bool)`
- `AgentRegistry.forRuntime(perm)` filters to agents the user can access
- Supervisor only dispatches to agents in the filtered set

### 4.4 Resource Scoping

For cases where tool-level access isn't granular enough (e.g., user A should only see their department's Lark Base tables):

- `ResourceScope { toolId, scopeType, scopeValue }` — e.g., `{ toolId: 'larkBase', scopeType: 'tableId', scopeValue: 'tbl123xxx' }`
- `PermissionResult` gains `resourceScopes: ResourceScope[]`
- Tools opt-in to scope enforcement in their `execute()` function
- Stored in `ResourceScopeRule` table per company/dept/role

### 4.5 Temporal Permissions

Currently HITL approval is one-shot. Extended model:

- `TemporalPermission { companyId, userId, toolId, action, grantedAt, expiresAt, grantedBy }`
- When a manager approves HITL, they can optionally grant a time-bounded permission (e.g., 1 hour) instead of just one-shot
- Checked in `PermissionService.resolve()` — if valid temporal grant exists, elevate allowed actions

### 4.6 Full Audit Log

Every RBAC decision is persisted (currently only in-memory per request):

```typescript
AuditEvent {
  id, timestamp
  companyId, userId, departmentId
  requestId, sessionId
  kind: 'permission_check' | 'tool_execution' | 'agent_dispatch' | 'approval_decision'
  subject: { toolId?, agentSlug?, action? }
  decision: 'allowed' | 'denied' | 'pending' | 'approved' | 'rejected'
  reason?: string
}
```

Queryable at `GET /api/admin/audit-log`. Async writes — never blocks the hot path.

---

## 5. Channel Architecture

### 5.1 Channel Plugin System

Currently Lark is hardcoded into `composition.ts`. Target: a `ChannelPlugin` interface that makes any channel a drop-in.

```typescript
interface ChannelPlugin {
  key: ChannelKey                                          // 'lark' | 'slack' | 'teams' | 'rest'
  buildAdapter(deps): ChannelAdapter                       // message parsing, reply sending
  buildWebhookRouter(deps): express.Router                 // channel-specific webhook handling
  resolveIdentity(externalId, deps): Promise<ResolvedIdentity | null>
}
```

`composition.ts` loops through registered plugins. `ENABLED_CHANNELS=lark,rest` env var controls which load.

### 5.2 Supported Channels

| Channel | Status | Notes |
|---------|--------|-------|
| Lark | Current | Refactor to plugin interface, no functional change |
| REST API | Planned | `POST /api/agent/chat` — SDK mode for internal tools and web UI |
| Slack | Future | Drop-in once plugin interface is in place |
| Teams | Future | Drop-in once plugin interface is in place |

**REST API channel** is the immediate priority after Lark refactor — it enables the Admin UI to test agents directly and allows any internal service to call the agent over HTTP.

---

## 6. Admin UI Vision

### 6.1 AI-Assisted Agent Builder

Non-engineers (dept leads, company admin) create agents through a conversational interface — not a form.

**The flow:**
1. Admin describes the department in plain English
2. Builder AI asks clarifying questions (what systems do they use? what should it refuse? any approval rules?)
3. The conversation produces a structured `AgentDefinition` — system prompt sections, tool assignments, sub-agent structure, capability description
4. The definition is rendered immediately in the React Flow canvas
5. Admin edits nodes directly if anything needs adjustment

The builder AI never asks the admin to write a system prompt. It translates behavior descriptions into structured prompt sections (`Role`, `What you can do`, `What you cannot do`, `Rules`, `Tone`).

### 6.2 React Flow Canvas

Visual tree of all agents for the company. Each node = one agent.

**Node click → Side Drawer:**
```
Agent Name / Slug
─────────────────
Capability Description    ← what supervisor reads to route
Allowed Tools             ← checkbox list from tool registry
Allowed Sub-Agents        ← agent picker (DAG-validated)
System Prompt Sections    ← structured: Role / Rules / Restrictions / Tone
Direct Slug               ← e.g. --finance (for direct routing)
Default for Departments   ← multi-select dept picker
─────────────────
[Test this agent]  [Save]  [Enable/Disable]
```

**Test panel**: Opens a chat scoped to that agent. Admin types queries, sees exactly what users will see. Catches bad system prompts before enabling.

### 6.3 Admin Governance

Single group admin governs all companies under the group. Company selector at the top of the canvas (`Viewing: Finance Co / Media Co / Events Co`).

- Group admin: full read/write across all companies
- Company admin (future): scoped to their company's agents
- Shared agent templates: group admin can create templates any company can instantiate

---

## 7. What Changes in the Codebase

### 7.1 What Stays the Same (Do Not Touch)

- `Result<T,E>` discriminated union pattern (`src/shared/result.ts`)
- `Tool.contract.ts` interface — permissionCheck + execute
- `HistoryService` poison filtering
- HITL approval gate core flow (approval-gate, approval-resumer)
- RAG pipeline — context search broker, faithfulness grading, query expansion
- `withFallback()` model routing

### 7.2 New Domain Files

```
src/domain/agents/agent-registration.ts       ← AgentRegistration type
src/domain/audit/audit-event.ts               ← AuditEvent type
src/domain/permissions/agent-permission.ts    ← AgentPermission type
src/domain/permissions/resource-scope.ts      ← ResourceScope type
```

### 7.3 New Application Files

```
src/application/orchestration/registry/agent-registry.ts   ← AgentRegistry class
src/application/orchestration/registry/agent-runner.ts     ← generic runner (replaces 4 runner files)
src/application/audit/audit-log.service.ts
src/application/channels/channel-plugin.ts                 ← ChannelPlugin interface
src/application/channels/channel-registry.ts               ← ChannelRegistry class
```

### 7.4 New Infrastructure Files

```
src/infrastructure/persistence/audit-log.repo.ts
src/infrastructure/channels/lark/lark.plugin.ts            ← Lark as ChannelPlugin
src/infrastructure/channels/rest/rest.plugin.ts            ← REST API channel
src/http/routes/agent-chat.routes.ts                       ← POST /api/agent/chat
src/http/routes/audit-log.routes.ts                        ← GET /api/admin/audit-log
```

### 7.5 Modified Files

| File | Change |
|------|--------|
| `supervisor.ts` | Receives AgentRegistry, builds dispatcher tools dynamically |
| `supervisor.prompt.ts` | Routing section generated from agent capabilityDescriptions |
| `composition.ts` | Wire AgentRegistry, ChannelRegistry, AuditLogService |
| `permission.service.ts` | Add allowedAgentIds, resource scopes, temporal check, audit emit |
| `ai-sdk-adapter.ts` | Handles both Tool[] and AgentRegistration[], emits audit events |
| `server.ts` | Use ChannelRegistry.mountRoutes() |

### 7.6 Retired Files (after migration)

```
src/application/orchestration/agent-runners/lark.runner.ts
src/application/orchestration/agent-runners/google.runner.ts
src/application/orchestration/agent-runners/zoho.runner.ts
src/application/orchestration/agent-runners/context.runner.ts
```

These become agent definitions in the DB seeded at startup. The faithfulness grading from `context.runner.ts` becomes an `AgentRunHook` passed to the generic runner.

---

## 8. Database Migrations

| Table | Purpose |
|-------|---------|
| `AgentRegistration` | Agent definitions (dept heads, specialists, built-in agents) |
| `AgentPermission` | `(companyId, role, agentSlug, allowed)` — agent-level RBAC |
| `AuditEvent` | Append-only audit log for all RBAC + tool decisions |
| `ResourceScopeRule` | Per-tool resource scoping rules by company/dept/role |
| `TemporalPermission` | Time-bounded elevated permissions |
| `ApprovalPolicyRule` | DB-backed approval policy (replaces hardcoded `approval-policy.ts`) |
| `CompanyToolConfig` | Per-company tool enablement (which integrations are set up) |

---

## 9. Implementation Order

| Phase | What | Why |
|-------|------|-----|
| **1** | Migrate Finance Head to AgentRegistration model | Proves the pattern with a real case that already exists |
| **2** | Dynamic AgentRegistry + generic agent runner | Foundation for all other phases |
| **3** | Supervisor reads agents from registry dynamically | Replaces hardcoded 4-dispatcher topology |
| **4** | Agent-level RBAC + Audit Log | Most critical missing safety layer |
| **5** | Channel plugin system + REST API channel | Unlocks Admin UI testing + future channels |
| **6** | Resource scoping + Temporal permissions | Completes the RBAC picture |
| **7** | DB-backed approval policy | Makes HITL fully configurable |
| **8** | Admin UI — React Flow canvas + agent builder | Brings the whole thing to non-engineers |
| **9** | AI-assisted agent builder conversation | The self-service layer on top of the canvas |

---

## 10. Verification Checkpoints

After Phase 1-2: Run `scripts/run-engine-harness.ts` — Finance Head behaves identically, routed dynamically  
After Phase 3: Supervisor prompt no longer contains hardcoded agent names  
After Phase 4: Set AgentPermission to deny an agent for a role — supervisor never dispatches to it  
After Phase 5: `curl POST /api/agent/chat` with valid API key, get a reply  
After Phase 6: Restrict `larkBase` to specific tableId, confirm agent returns scope error on other tables  
After Phase 8: Non-engineer creates a new dept agent end-to-end without touching any code  

---

## 11. Design Principles (Reference)

1. **Prompts describe behavior. Tools enforce access.** Never rely on a prompt to enforce security.
2. **Everything is a capability.** Tools and sub-agents are both assignable to an agent. No special-casing.
3. **Adding a dept = inserting a row.** The code should never need to change to add a new integration or department agent.
4. **The supervisor is always the chokepoint.** No agent-to-agent calls bypass the hierarchy. Simpler RBAC.
5. **Depth compounds cost.** Default max 3 levels. Each hop = one more LLM call + latency.
6. **Closed tool registry, open agent registry.** Only engineers add tools (TypeScript). Anyone with admin access can create agents (UI).
7. **Audit everything.** Every RBAC decision is persisted. Access patterns are observable.
