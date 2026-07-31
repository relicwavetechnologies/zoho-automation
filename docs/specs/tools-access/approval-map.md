# Tools, access and approval — end-to-end map

Companion to `tools-ux.html`. This is what exists today, where the seams are, and
what has to change for the spec to be buildable.

## 1. Policy — what a person may ever do

| Layer | Where | Shape |
|---|---|---|
| Company ceiling | `src/domain/tools/tool-id.ts` → `TOOL_DEFAULT_PERMISSIONS` | per canonical tool, per company role (`MEMBER` / `COMPANY_ADMIN` / `SUPER_ADMIN`) |
| Tool class | `src/domain/tools/tool-policy.ts` | `configurable` \| `local` \| `system`; `DEPARTMENT_GRANT_ONLY_TOOLS` |
| Department overlay | `DepartmentToolPermission` (role) + `DepartmentUserToolOverride` (person) | default-deny: person override → dept role grant → deny |
| Resolution | `src/application/permissions/permission.service.ts` | company axis is both the ceiling **and** the answer when no department is selected; company-admin carve-outs are `exclusive` (strip-then-set) or `floor` (union) |
| Cache | `permission.cache.ts` | Redis, 900s, keyed by `TOOL_PERMISSION_POLICY_REVISION`; invalidated only via `invalidateCompany` / `invalidateDept` |

Supported actions per tool: `TOOL_SUPPORTED_ACTIONS` — `read create update delete send execute`.

## 2. Approval — who has to say yes first

Config lives in `DepartmentAgentConfig.managerApprovalJson`, validated by
`ManagerApprovalConfigSchema` (`application/approval/approval.types.ts`):

```
{ enabled, requiredActions:[{toolId, actions[]}], requiredActionGroups[],
  requiredToolIds[] /*legacy*/, managerDmAuditToolIds[], managerDmAuditActionGroups[] }
```

Runtime path, identical for every tool:

```
tool call
  └─ permissionCheck(args, perm)                         → permission_denied
  └─ approvalGate.check(...)                             ai-sdk-adapter.ts:83
     ├─ checkApprovalPolicy()  pure, generic             approval-policy.ts
     │    reads are NEVER gated
     ├─ resolver.resolveManager(deptId, companyId)       approval-resolver.service.ts
     ├─ RuntimeApproval row, idempotent per
     │    (scopedChatId, toolId, action, argsHash)       runtime-approval.repository.ts
     ├─ larkAdapter.sendDirectCard(manager.larkOpenId)   ← the only delivery route
     └─ pending | rejected | allowed | misconfigured
  └─ execute
```

Same gate is reached from three entry points: `ai-sdk-adapter.ts`,
`orchestration/tools/orchestration/call-tool.ts`, `gateway/tool-executor.ts`.
`runCommand` is deliberately exempt — it self-gates per command on the user's machine.

Resolution back: Lark card button → webhook → `ApprovalResumerService` → run resumes.

### A second, unrelated approval system

`gateway/local-approval-intent.service.ts` is the **user confirming their own**
action ("check this email before sending"). In-memory, 5-minute TTL, prepared →
claimed → consumed. Its `buildApprovalPresentation()` already covers
google / airtable / zoho / generic. Desktop renders it in `LiveApprovalComposer`.

Do not conflate the two. Manager approval is durable and about authority; local
intent is ephemeral and about care.

## 3. Why approval today is effectively Lark-only

1. **Every approver resolver requires a connected Lark account.**
   `resolveManager`, `resolveConnectionOwner` and `resolveCompanyAdmin` all end with
   "…and an `IntegrationConnection(provider:'lark')` with an `externalAccountId`",
   returning `null` otherwise.
2. **`null` approver is fatal, not degraded.** The gate answers
   `misconfigured` and the tool call fails. So switching approval on in a
   desktop-only company breaks every gated action instead of queuing it.
3. **One delivery route.** `sendDirectCard` is the only way a request reaches a
   human. No inbox, no desktop notification, no email.
4. **No read API for approvals.** A manager cannot list what is waiting on them.
   `RuntimeApprovalRepository` has no "pending for approver" query.
5. **The card speaks machine.** It prints raw `toolId` and `actionGroup`;
   `buildArgsSummary` is a best-effort string built at the call site.
6. **Desktop renders four kinds.** `LiveApprovalComposer` has real editors for
   `gmail | zoho | lark | schedule`; everything else falls through to a
   key/value dump of raw args.
7. **Config UI is a bare switch** in the Access-map tab, per (tool, action),
   reachable only for department-managed tools, with no statement of who approves.

## 4. Transport, for reference

```
desktop-tools.routes.ts       GET  /tools
                             GET  /tools/:toolId/manage?scope=&departmentId=
                             PUT  /tools/:toolId/global/roles/:role/actions/:actionGroup
                             PUT  /tools/:toolId/departments/:departmentId/roles/:roleId/actions/:actionGroup
                             PUT  /tools/:toolId/departments/:departmentId/members/:userId/actions/:actionGroup
desktop-departments.routes.ts GET/PUT /departments/:id/manager-approval, /manage, /roles, /memberships
        ↓ memberAuth
src-tauri/src/core/divo/commands.rs  (registered in lib.rs)
        ↓ invoke
jan/web-app/src/lib/divo-tools.ts
        ↓
routes/plugins/index.tsx · $pluginId.tsx · components/tool-access/* · components/tool-catalogue/*
```

## 5. Build order

| Wave | Change |
|---|---|
| A | Approver resolution stops requiring Lark; Lark card becomes one best-effort route; no approver reachable ≠ failure |
| B | `RuntimeApproval` read/decide API + Tauri commands + desktop approval inbox |
| C | One `describeToolAction(toolId, action, args)` used by the Lark card, the inbox and the local composer |
| D | Tools/Access UI per `tools-ux.html` — progressive disclosure, personas, company-policy scope |
| E | Approval config moves into the new Access tab, per capability per action, naming the approver |

Invariant to preserve through all of it: the `RuntimeApproval` row is the source
of truth and its idempotency key is
`(scopedChatId, toolId, action, argsHash)` — delivery is a side effect, and an
ambiguous delivery result must never silently create a second request.
