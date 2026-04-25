# Permission Resolution Flow — End-to-End Trace

> Traced for: `larkTask:create` denied for Finance dept MANAGER role  
> Date: 2026-04-24

---

## The Two Role Systems (Root of All Confusion)

```
┌─────────────────────────────────────────────────────────────────────┐
│  SYSTEM 1: AiRole  (company-level, table: AiRoleDefinition)         │
│  Slugs: MEMBER | COMPANY_ADMIN | SUPER_ADMIN | <custom>             │
│  Controls: ToolPermission + ToolActionPermission tables             │
│  Admin UI: Tools & Permissions page                                 │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  SYSTEM 2: DepartmentRole  (per-dept, table: DepartmentRole)        │
│  Slugs: MANAGER | MEMBER | VIEWER | <whatever admin named it>       │
│  Controls: DepartmentToolPermission + DepartmentMembership tables   │
│  Admin UI: Department config page                                   │
└─────────────────────────────────────────────────────────────────────┘

  These two systems are COMPLETELY SEPARATE.
  No foreign key, no shared slug space, no bridging.
  The code in department.service.ts:636 accidentally conflates them.
```

---

## Full Flow: Incoming Lark Message → Tool Call Verdict

```
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 1 — vercel-orchestration.engine.ts :: resolveRuntimeContext() │
│  (runs once per message, before any agent or tool runs)             │
└─────────────────────────────────────────────────────────────────────┘

  requesterAiRole = message.trace.userRole ?? "MEMBER"
  (e.g., "MEMBER" — this is the company-level AI role from ChannelIdentity.aiRole)

  fallbackAllowedToolIds =
    toolPermissionService.getAllowedTools(companyId, requesterAiRole)
      └─ Reads ToolPermission table
      └─ Checks AiRoleDefinition.validSlugs → "MEMBER" is built-in ✓
      └─ Returns: ["contextSearch", "larkTask", "larkMessage", "gmail", ...]

  ┌──────────────────────────────────────────────────────────────────┐
  │ departmentService.resolveRuntimeContext({                         │
  │   userId, companyId,                                             │
  │   departmentId: "finance-dept-id",                               │
  │   fallbackAllowedToolIds,    ← computed above                    │
  │   requesterAiRole,           ← "MEMBER"                          │
  │ })                                                               │
  └──────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │  STEP 2 — department.service.ts :: resolveRuntimeContext()      │
  │  (the department branch — departmentId is set)                  │
  └─────────────────────────────────────────────────────────────────┘

  BRANCH A — no departmentId (WORKS CORRECTLY):
    allowedActionsByTool =
      toolPermissionService.getAllowedActionsByTool(
        companyId,
        requesterAiRole,         ← "MEMBER" ✓ correct company AI role
        fallbackAllowedToolIds
      )
    → larkTask:create → ALLOWED ✓

  BRANCH B — has departmentId (THE BROKEN PATH):

    DB query 1:
      membership = DepartmentMembership JOIN DepartmentRole
      → membership.role.slug = "MANAGER"   ← DepartmentRole slug

    DB query 2:
      rolePermissions = DepartmentToolPermission
        WHERE departmentId = "finance-dept-id"
        AND   roleId       = membership.roleId
      → (probably empty or only has a few explicit entries)

    DB query 3:
      userOverrides = DepartmentUserToolOverride
        WHERE departmentId = "finance-dept-id"
        AND   userId       = linkedUserId
      → (probably empty)

    ┌──────────────────────────────────────────────────────────────┐
    │  *** THE BUG ***                                             │
    │                                                              │
    │  companyAllowedActionsByTool =                               │
    │    toolPermissionService.getAllowedActionsByTool(             │
    │      companyId,                                              │
    │      membership.role.slug,   ← "MANAGER" ← WRONG!           │
    │      vercelToolIds           ← (all tools, ignores           │
    │    )                              fallbackAllowedToolIds)     │
    │                                                              │
    │  Inside getAllowedActionsByTool:                              │
    │    normalizedRole = "MANAGER"                                │
    │    validRoleSlugs = aiRoleService.getRoleSlugs(companyId)   │
    │      → ["MEMBER", "COMPANY_ADMIN", "SUPER_ADMIN"]            │
    │                                                              │
    │    "MANAGER" NOT IN validRoleSlugs                           │
    │    → return {}   ← ALWAYS EMPTY                              │
    │                                                              │
    │  companyAllowedActionsByTool = {}  (empty)                   │
    └──────────────────────────────────────────────────────────────┘

    For EVERY (toolId, actionGroup) pair →
      resolveDepartmentToolAction({
        toolId:                  "larkTask",
        actionGroup:             "create",
        rolePermissionMap:       buildActionLookup(rolePermissions),
        overrideMap:             buildActionLookup(userOverrides),
        companyAllowedActionsByTool: {}   ← broken fallback
      })

        LAYER 1: overrideMap["larkTask"]?.has("create")  → false (no override)
        LAYER 2: rolePermissionMap["larkTask"]?.has("create") → false (no dept entry)
        LAYER 3: companyAllowedActionsByTool["larkTask"]?.includes("create")
                   → {}["larkTask"] = undefined → [].includes("create") → false
        RESULT:  { allowed: false, source: "none" }  ← DENIED

    allowedActionsByTool = {
      <only tools with explicit DepartmentToolPermission rows>
    }
    allowedToolIds = Object.keys(allowedActionsByTool)
    → "larkTask" is NOT here

  ┌─────────────────────────────────────────────────────────────────┐
  │  STEP 3 — runtime object is assembled                           │
  └─────────────────────────────────────────────────────────────────┘

  runtime = {
    companyId,
    requesterAiRole: "MEMBER",
    departmentId: "finance-dept-id",
    departmentRoleSlug: "MANAGER",
    allowedToolIds: [...],          ← no larkTask
    allowedActionsByTool: {...},    ← no larkTask entry
  }

  Also: departmentRuntimeCache.set(...)
  → This broken result is cached for 5 minutes.
  → Even if you fix the DB, the cache serves stale denied results.

  ┌─────────────────────────────────────────────────────────────────┐
  │  STEP 4 — Tool call executes → legacy-tools.ts                  │
  │  ensureActionPermission(runtime, "larkTask", "create")          │
  └─────────────────────────────────────────────────────────────────┘

  getAllowedActionGroups(runtime, "larkTask"):
    explicit = runtime.allowedActionsByTool["larkTask"]  → undefined
    if (explicit && explicit.length > 0) → false, skip
    allowedViaCanonical = runtime.allowedToolIds.includes("larkTask")  → false
    allowedViaLegacy    = runtime.allowedToolIds.includes("larkTask")  → false
    return []

  [].includes("create") → false
  → buildEnvelope({ success: false, errorKind: "permission", ... })
  → "Permission denied: larkTask cannot perform create for the current department role."
  ✗ DENIED
```

---

## The Two Judgement Points

```
JUDGEMENT POINT 1 — Build time (once per request)
  department.service.ts :: resolveRuntimeContext()
  Produces: runtime.allowedToolIds + runtime.allowedActionsByTool
  Cached: 5 min in departmentRuntimeCache (Redis)
  BUG HERE: uses dept role slug as company AI role for fallback lookup

JUDGEMENT POINT 2 — Call time (once per tool invocation)
  legacy-tools.ts :: ensureActionPermission()
  Reads: runtime.allowedActionsByTool (already built/cached)
  No DB access, pure in-memory check
  CORRECT but the input data is wrong because of Point 1
```

---

## What SHOULD Happen (the intended design)

```
For a user who is Finance dept MANAGER but company-level MEMBER:

  LAYER 1: Per-user override (DepartmentUserToolOverride)
    → highest priority, specific to this person in this dept

  LAYER 2: DepartmentRole permission (DepartmentToolPermission)
    → explicit allow/deny for "MANAGER" role in Finance dept
    → if not set, fall through

  LAYER 3: Company AI role fallback (ToolActionPermission via AiRoleDefinition)
    → what is this person allowed at company level as a MEMBER?
    → larkTask:create is allowed for MEMBER → PASS ✓

  Current code passes "MANAGER" (dept role slug) to Layer 3 instead of
  "MEMBER" (company AI role slug), causing Layer 3 to always return {}.
```

---

## The Fix (1 line)

**File:** `backend/src/company/departments/department.service.ts:638`

```typescript
// BEFORE (BUG):
const companyAllowedActionsByTool = await toolPermissionService.getAllowedActionsByTool(
  input.companyId,
  membership.role.slug,          // ← "MANAGER" (dept role slug — WRONG)
  vercelToolIds,
);

// AFTER (FIX):
const companyAllowedActionsByTool = await toolPermissionService.getAllowedActionsByTool(
  input.companyId,
  input.requesterAiRole ?? 'MEMBER',  // ← "MEMBER" (company AI role — CORRECT)
  vercelToolIds,
);
```

After fixing, also invalidate the cache:
```bash
pnpm tsx scripts/clear-perm-cache.ts   # or restart redis / wait 5 min
```

---

## All Known Issues (Rewrite Decision Checklist)

| # | Severity | Location | Issue |
|---|----------|----------|-------|
| 1 | **CRITICAL** | `department.service.ts:638` | Dept role slug used as company AI role slug → company fallback is always `{}` → every tool without explicit `DepartmentToolPermission` row is denied |
| 2 | **MEDIUM** | `department.service.ts:636` | `fallbackAllowedToolIds` is ignored in the dept path — code uses `vercelToolIds` (all tools) instead, making the param a no-op |
| 3 | **MEDIUM** | Design | Two role systems (`AiRole` vs `DepartmentRole`) with no bridging, no shared slug space, but code implicitly assumes they might overlap |
| 4 | **LOW** | `departmentRuntimeCache` | 5-min Redis TTL → permission changes take up to 5 min to propagate; no immediate invalidation on dept role change |
| 5 | **LOW** | `getAllowedActionGroups` | Dual lookup (`canonicalToolId` + `normalizedToolId`) with fallback to `allowedToolIds` — confusing, easily masks misconfiguration |
| 6 | **LOW** | Multiple callers | Not all `resolveRuntimeContext` callers pass `requesterAiRole` (lark webhook does, langgraph and desktop engine don't) |

---

## Rewrite vs Fix Assessment

```
OPTION A — 1-line fix + cache bust
  Change line 638, clear Redis, done.
  Risk: LOW. Isolated change, already traced.
  Time: 10 minutes.
  Covers: Bug #1 (the actual denial).
  Leaves: Design issues #2–6 (not breaking, just messy).

OPTION B — Rewrite permission resolution service
  New service that:
    1. Takes (companyId, userId, departmentId, companyAiRole) as inputs
    2. Resolves the 3-layer lookup cleanly and explicitly
    3. Has a single clear cache key
    4. Validates both role systems at entry, not mid-flow
  Risk: MEDIUM. Must wire all 5 callers to new service.
  Time: 1–2 days.
  Covers: All 6 issues.
  Benefit: Makes future dept permission changes safe and predictable.

RECOMMENDATION:
  Do Option A now (unblocks larkTask immediately).
  Do Option B as a follow-up when you have a quiet day —
  the rewrite is clean and safe because the interface is small
  (one function with clear inputs/outputs).
```
