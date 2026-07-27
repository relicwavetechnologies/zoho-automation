# Divo Dynamic Capability Discovery — Living Specification

> Status: **implemented through deterministic discovery, automatic Lark bootstrap, and harness integration; broader live provider scenarios and production rollout remain**
>
> Last updated: **2026-07-28**
>
> Scope: how Divo tells an AI agent which governed capabilities exist, how to
> use them, which connected account applies, and when a reusable skill is or is
> not needed.

## 0. Working protocol

This is the living source of truth for the capability-discovery discussion.

- Finalized decisions are recorded in §2 with their reasoning.
- New evidence is added before implementation decisions are changed.
- Open questions remain explicit in §13; they are not silently converted into
  assumptions.
- Implementation does not begin merely because an option appears in this
  document.
- Discovery may become dynamic, but permissions and approval remain explicit
  and fail closed.
- Changes will be implemented in bounded phases. No phase should introduce a
  second authority for tool identity, RBAC, credentials, or approval.

## 1. Problem statement

Divo currently has several independently maintained names for the same product:

1. **Connection provider** — for example `airtable`.
2. **Tool family** — for example `airtable`.
3. **Executable leaf tools** — for example `airtableRecords`,
   `airtableSchema`, and `airtableAutomation`.
4. **Skills** — for example Airtable Core or Lark Base.
5. **Presentation metadata** — names and grouping shown in the desktop UI.

The backend has canonical leaf tool IDs and a family map, but the model-facing
gateway accepts `payload.toolId` as an unrestricted string. This lets a model
put a provider or family name such as `airtable`, `lark`, `zoho`, or `oms` into
an exact leaf-tool field. `tools.list` then returns `unknown_tool`.

This is not an Airtable-only defect. Thirteen of the fourteen current tool
families fail when their family name is passed as an exact `toolId`. Semrush
works only because its family and leaf tool happen to have the same spelling.

The second defect is skill-catalogue drift. Airtable skills exist in the static
backend skill registry, but they are absent from the live database-backed
company skill catalogue used by desktop. An Airtable request therefore fell
through to the overlapping Lark Base skill.

## 2. Decisions

### 2.1 DECIDED — Contracts are the default manual for direct operations

A skill is not required merely to discover or call every capability.

For a straightforward operation, the clean route is:

```text
permission-filtered capability index
  → exact tool contract
  → exact connection, when applicable
  → tool invocation
```

The contract returned by `tools.list` is the operation manual:

- `description` explains the capability boundary.
- `parameterDocs` explains important operation semantics and constraints.
- `argsSchema` gives the machine-readable input contract.
- `allowedActions` states the caller's currently permitted action groups.
- The result schema and structured result explain coverage, partial results,
  blocking conditions, and next actions.

This is the successful route the Airtable run eventually used. No Airtable
skill was loaded; the agent learned the exact operations from the tool
contracts and executed a direct read.

### 2.2 DECIDED — Skills describe procedure, not endpoint syntax

Contracts and skills have different jobs.

| Layer | Must answer |
|---|---|
| Capability index | What products and leaf tools can this member currently use? |
| Tool contract | What exact operation can be called, with which arguments and result shape? |
| Connection context | Which authorized account will the operation use? |
| Skill | When and why should several operations be combined into a reusable business procedure? |
| Backend policy | Is this exact call permitted, approved, rate-limited, and safe to execute? |

A skill is useful when the request involves:

- A multi-step business workflow.
- Ordering rules across multiple tools.
- A reusable company procedure.
- Domain interpretation that is not intrinsic to one operation.
- Cross-product work.
- A required policy gate, such as scheduled-work recipe loading.

A skill must not be the only place containing validation-critical safety. Tool
schemas, backend validation, permission checks, approval checks, and result
coverage remain authoritative.

### 2.3 DECIDED — Discovery may resolve a family; execution may not

Read-only discovery may safely accept either:

```json
{ "op": "tools.list", "payload": { "family": "airtable" } }
```

or:

```json
{ "op": "tools.list", "payload": { "toolId": "airtableRecords" } }
```

For backward compatibility, `tools.list` may recognize a known family supplied
in the old `toolId` field and return its permission-filtered child tools.

`tools.invoke` must continue to require one exact executable leaf tool. It must
never guess which Airtable, Lark, Google, or Zoho child tool should execute.

If a family is supplied for execution, the backend should return a structured
ambiguity response containing only the leaf tools currently visible to the
member.

### 2.4 DECIDED — Dynamic discovery must not create dynamic authorization

New capability metadata may automatically appear in discovery after it is
registered, but a new tool must never become authorized by accident.

Every governed tool still requires explicit:

- Supported action groups.
- Built-in role ceilings.
- Department grant behaviour.
- Approval policy.
- Connection governance, when applicable.
- Runtime implementation.

An unclassified tool fails readiness and remains unavailable.

### 2.5 DECIDED — Full schemas are loaded only for selected tools

The agent does not need every provider's complete API documentation on every
run.

The normal context budget is:

1. Inject a compact, permission-filtered family and leaf-tool index.
2. Load the full contract only for the exact tool selected for this request.
3. Load a skill only when a reusable procedure is relevant or required.
4. Load provider-native schemas only for the selected native operation when
   they were not already preloaded.

This preserves the clarity of the successful Airtable route without flooding a
small model with unrelated contracts.

### 2.6 DECIDED — Backend-hosted channels resolve work before the model runs

Lark must not depend on a small model remembering to discover its own tools.
The backend resolves the authenticated member's exact original request before
`streamText`, then injects only the matched recipes, permitted wrapper
contracts, accessible accounts, and selected native contracts.

- The model cannot rewrite the discovery query or choose search variants.
- `resolve_work` is not exposed as a model-callable tool.
- `call_tool` remains unavailable until resolution succeeds.
- A no-recipe result may still use canonical family metadata to load a direct
  contract; it never invents a new authorization path.
- Recipe instructions and backend contracts are trusted policy. Connection
  labels, account names, emails, and provider-returned values remain untrusted
  data and cannot supply instructions.

### 2.7 DECIDED — One run signal owns preload and execution lifecycle

The supervisor's merged request/timeout signal is propagated through work
resolution, skill and persona reads, account discovery, native contract
bootstrap, governed execution, Google OAuth refresh, and Google MCP calls.

Prisma reads are cooperatively cancelled: an in-flight query may finish inside
the driver, but abort checkpoints prevent later work. Fetch-based OAuth calls
and the MCP transport are actively closed. If cancellation happens during
automatic preload, no model or provider action starts and the member receives
a truthful no-action timeout response.

## 3. Desired agent flows

### 3.1 Connection-backed direct tool

Applies to Airtable, Lark user-scoped tools, Zoho, Google Workspace, Canva, and
AITable.

```text
capability index
  → select exact leaf tool
  → use account already present in run bootstrap
      or call connections.list once
  → load exact tool contract
  → invoke exact leaf tool
```

The connection UUID is routing and governance context. Tokens and API keys
remain server-side.

### 3.2 Backend-managed direct tool

Applies to OMS and Semrush. These use company-owned backend configuration, so
there is no member-selectable connection step.

```text
capability index
  → select omsSiteData or semrush
  → load exact tool contract
  → invoke
```

If the backend key or company configuration is unavailable, the tool returns a
structured `blocked` result. The model must not ask the member for an API key.

### 3.3 Skill-guided workflow

```text
capability/skill compact index
  → load one exact relevant skill
  → receive exact tool contracts and accessible accounts in run bootstrap
  → follow the procedure
  → invoke exact leaf tools
```

The skill improves orchestration. It does not grant tool permission.

### 3.4 Direct capability with no skill

This is a valid and desirable outcome:

```text
User: "List my Airtable bases"
  → airtable family is visible
  → airtableSchema contract is loaded
  → list_bases native contract is loaded or described once
  → exact connected account is used
  → read executes
```

The agent should not perform fuzzy skill discovery merely to prove that a skill
is unnecessary.

## 4. Provider examples

### 4.1 Airtable

Connection mode: `member_selectable`.

Contract mode: `native_proxy`.

Current executable leaf tools:

- `airtableRecords`
- `airtableSchema`
- `airtableAutomation`
- `airtableBase` currently exists as an additional compatibility/read tool; its
  long-term exposure remains an open decision.

Direct exploration may use contracts without a skill. Reusable record,
schema-migration, interface, form, or automation workflows benefit from the
existing Airtable recipes once those recipes are provisioned into the company
skill catalogue.

Expected direct chain:

```text
capabilities.get
  → family airtable and permitted leaf tools
  → run-bootstrap account or connections.list(provider=airtable)
  → tools.list(toolId=airtableSchema)
  → tools.invoke(toolId=airtableSchema, nativeTool=list_bases)
```

### 4.2 OMS

Connection mode: `backend_managed`.

Contract mode: `typed_operations`.

Executable leaf tool: `omsSiteData`.

The current tool contract is already strong:

- It exposes only `search_sites`, `get_site_profiles`, and
  `list_catalog_values`.
- Its argument schema is discriminated by `operation`.
- It rejects SQL, provider filters, raw columns, headers, keys, and webhook
  details.
- Its parameter documentation explains metric meanings, sorting, the
  100-row provider cap, and the unmeasured spam-score sentinel.
- Its result distinguishes `complete`, `empty`, `partial`, and `blocked`.

Expected direct chain:

```text
capabilities.get
  → family oms, leaf omsSiteData
  → tools.list(toolId=omsSiteData)
  → tools.invoke(toolId=omsSiteData, args={ operation: ... })
```

No `connections.list` call is needed. The OMS skill remains useful for
repeatable shortlisting procedure and interpretation, not basic endpoint
discovery.

### 4.3 Semrush

Connection mode: `backend_managed`.

Contract mode: `typed_operations`.

Executable leaf tool: `semrush`.

The current tool contract is already strong:

- It exposes a fixed operation enum.
- Every operation has a discriminated argument shape.
- It documents database selection, pagination, comparison target limits,
  keyword-gap ordering, metered backlinks calls, and partial-result handling.
- It rejects arbitrary endpoints, headers, cookies, export columns, and keys.
- Its result distinguishes `complete`, `empty`, `partial`, and `blocked`.

Expected direct chain:

```text
capabilities.get
  → family semrush, leaf semrush
  → tools.list(toolId=semrush)
  → tools.invoke(toolId=semrush, args={ operation: ... })
```

No connection selection is needed. A competitive-analysis skill may combine
Semrush with web search and reporting, but a simple domain overview should use
the direct contract.

### 4.4 Lark

Connection mode:

- `member_selectable` for user-scoped Messaging, Task, Calendar, Meeting, Doc,
  and Base calls.
- `backend_managed` for tenant-scoped capabilities such as native approval and
  directory operations where the API contract requires the installed app.

Contract mode: `typed_operations`.

`tools.list(family=lark)` should return the currently permitted subset of:

- `larkMessaging`
- `larkContacts`
- `larkTask`
- `larkCalendar`
- `larkMeeting`
- `larkDoc`
- `larkBase`
- `larkApproval`

An exact provider phrase must influence skill ranking. "Airtable base" must not
select Lark Base, and "Lark Base" must not select Airtable.

### 4.5 Zoho

Connection mode: `member_selectable`.

Contract mode: `typed_operations`.

Leaf tools:

- `zohoCrm`
- `zohoBooks`

A direct invoice lookup or CRM read can use the exact contract. Finance
procedures such as recording a vendor bill from a PDF, verifying GST, attaching
evidence, and notifying Accounts should use the relevant Zoho skill.

## 5. Central capability model

The backend should own one definition for each family and one definition for
each executable leaf tool.

Illustrative shape:

```ts
defineCapabilityFamily({
  familyId: 'airtable',
  displayName: 'Airtable',
  aliases: ['airtable'],
  connectionMode: 'member_selectable',
  connectionProvider: 'airtable',
});

defineCapability({
  toolId: 'airtableRecords',
  familyId: 'airtable',
  displayName: 'Airtable Records',
  description: 'Read and modify Airtable records and comments.',
  aliases: ['airtable records', 'airtable data'],
  contractMode: 'native_proxy',
  skillMode: 'optional',
  exposure: 'first_class',
  supportedActions: ['read', 'create', 'update', 'delete'],
  defaultPermissions: {
    MEMBER: true,
    COMPANY_ADMIN: true,
    SUPER_ADMIN: true,
  },
});
```

Proposed metadata:

| Field | Purpose |
|---|---|
| `toolId` | Exact executable identity |
| `familyId` | Product/family grouping |
| `displayName` | Model/UI-facing name |
| `description` | Compact routing description |
| `aliases` | Exact discovery aliases, never execution aliases |
| `connectionMode` | `member_selectable`, `backend_managed`, or `none` |
| `connectionProvider` | Exact provider accepted by connection discovery |
| `contractMode` | `typed_operations`, `native_proxy`, or `internal` |
| `skillMode` | `none`, `optional`, or `required` |
| `exposure` | `first_class`, `compatibility`, `system`, or `local` |
| `supportedActions` | Permission and approval action groups |
| `defaultPermissions` | Explicit role ceilings |

The model may discover aliases. Only `toolId` may execute.

## 6. Capability bootstrap v3

The current bootstrap calls leaf tools "tool families" and provides only IDs
and actions. The next version should make the hierarchy explicit:

```json
{
  "version": 3,
  "families": [
    {
      "familyId": "airtable",
      "displayName": "Airtable",
      "connectionMode": "member_selectable",
      "connectionProvider": "airtable",
      "tools": [
        {
          "toolId": "airtableRecords",
          "displayName": "Airtable Records",
          "description": "Read and modify records and comments.",
          "actions": ["read", "create", "update", "delete"]
        },
        {
          "toolId": "airtableSchema",
          "displayName": "Airtable Schema",
          "description": "Inspect or modify bases, tables, and fields.",
          "actions": ["read"]
        }
      ],
      "skills": [
        {
          "skillId": "company-skill-id",
          "name": "Airtable Core",
          "mode": "optional"
        }
      ]
    }
  ]
}
```

Rules:

- Only permission-visible tools appear.
- Descriptions are compact; complete schemas are not injected here.
- Existing v2 fields remain readable during rollout.
- The bootstrap guides routing but never grants execution permission.
- A connection choice may be included when exactly one accessible account is
  already known.

## 7. Tool-contract completeness standard

A first-class direct capability is not complete merely because it has a Zod
schema. Its `tools.list` response must let a smaller model make a correct call
without external API documentation.

Every tool contract must include:

- Exact leaf `toolId` and family.
- One-sentence capability boundary.
- Exact operation names.
- Required and optional fields per operation.
- Valid enums and numeric/string limits.
- At least one minimal valid call shape for non-obvious operations.
- Connection requirement or explicit statement that no selectable connection
  exists.
- Read/write action classification.
- Mutation, approval, and irreversibility notes.
- Pagination, row caps, truncation, and coverage semantics.
- Metered-cost notes when one operation consumes materially more provider
  units.
- Structured recoverable errors.
- Structured result status and coverage.
- Explicit rejection of raw credentials and arbitrary provider endpoints.

Critical behaviour must be enforced by schemas or code. Prose is supplementary.

## 8. Skill modes

The proposed `skillMode` values are:

### `none`

The exact tool contract is sufficient and no reusable company procedure is
needed.

### `optional`

Direct operations are valid, while one or more skills may improve multi-step or
domain-specific work.

Likely examples:

- Airtable direct reads versus schema-migration procedure.
- Zoho record lookup versus bill-recording procedure.
- Semrush domain overview versus competitive-analysis report.
- OMS direct site search versus a company-approved shortlist workflow.

### `required`

The backend refuses execution until the exact recipe was loaded for this run.
This should be rare and justified by a real workflow/policy requirement.

Current example: scheduled work creation.

Skill mode may eventually need an operation-level override, but the first
implementation should remain family/tool-level unless a current use case proves
otherwise.

## 9. System-skill provisioning

Static server skills and database-backed company skills must be generated from
one system-skill template registry.

The registry should drive:

1. Backend-hosted channel skill registration.
2. New-company provisioning.
3. Existing-company reconciliation.
4. Skill/tool invariant tests.

Historical drift addressed by the implementation:

- Airtable and AITable static recipes now have source-controlled company-skill
  definitions, new-company provisioning, and existing-company reconciliation.
- Canva has no live skill; whether it needs an optional recipe remains open.
- Zoho Finance recipes are provisioned when a Finance-like department is
  created. Semrush is included in new-company provisioning.

Reconciliation should be an explicit idempotent deployment step. Application
startup should perform read-only validation rather than silently rewriting
company skills. The implementation provides:

```text
pnpm tsx scripts/reconcile-capabilities.ts
```

It uses conflict-safe create-missing-only insertion for `RegisteredTool` rows
and idempotently reconciles Lark, Google Workspace, Airtable/AITable, Zoho
Finance, Semrush, and OMS recipes for existing companies. Concurrent deployment
jobs preserve existing tool rows, and system-skill creation re-reads the
deterministic-ID winner after a unique race instead of failing the whole run.
It does not grant tool permissions or expose credentials.

## 10. Registered-tool reconciliation

The database catalogue and runtime registry also drift.

Historical live finding:

- `larkMeeting` is canonical and registered at runtime.
- Its focused Lark skill exists.
- Its `RegisteredTool` database row is missing.

The seed now contains every canonical governed tool, including
`scheduledWorkflows`, and a regression invariant fails if a new canonical tool
lacks catalogue metadata. The idempotent reconciliation command repairs
missing rows such as `larkMeeting` during deployment. Existing rows and
permission grants remain untouched.

Startup/readiness validation should report:

- Runtime tool without capability definition.
- Capability definition without runtime implementation.
- Runtime governed tool without registered database metadata.
- Database tool with no runtime implementation.
- Family without family metadata.
- Connection provider missing from any public contract.

## 11. Skill resolver disambiguation

Provider-aware ranking is currently special-cased to Lark and Google. It should
be derived from the capability family definitions.

Rules:

- An explicitly named provider strongly boosts skills containing that family.
- An explicitly named provider penalizes skills belonging only to another
  provider.
- Composite skills remain eligible when they genuinely include the named
  family.
- Generic words such as "base", "records", "calendar", "document", or
  "contacts" do not establish a provider.
- A genuinely ambiguous request may ask one short product-choice question.

Required regression:

```text
"Explore Airtable bases, tables and records"
  → Airtable skill or direct Airtable capability
  → never Lark Base
```

## 12. Validation harness

The Lark agent harness can now be used to validate discovery behaviour
against the real engine without exposing credentials.

It defaults to Abhishek's DB-linked identity and DM. Selecting another
principal requires both `--allow-impersonation` and
`--user <email|exact name|open_id>`. Delivery accepts `--chat-id` only for the
built-in test chats or IDs configured in `HARNESS_LARK_ALLOWED_CHAT_IDS`;
`--chat-type p2p|group` controls context behaviour. Missing or ambiguous
identities and unapproved destinations fail before engine dispatch. The trace
prints the authenticated principal, department, trace ID, request ID, called
tools, and final reply summary. Stored Lark credentials are never printed or
copied.

For each family, the harness should support assertions such as:

```text
expected family: airtable
expected tool: airtableSchema
forbidden tool: larkBase
expected operation: list_bases
expected mode: read-only
```

The terminal trace should show:

- Acting Divo identity and department.
- Permission-visible families and leaf tools.
- Skill selected, skipped, or rejected.
- Selector resolution: family versus exact tool.
- Exact connection alias/ID when applicable, never its credential.
- Tool, operation, validation, permission, approval, and result status.
- Final Lark delivery status when delivery is enabled.

## 13. Open decisions

These are not finalized:

1. Should `airtableBase` remain a public fourth Airtable tool, become
   compatibility-only, or be deprecated after tracing callers?
2. Should `tools.list` keep the old `toolId=<family>` compatibility forever, or
   only through a versioned transition?
3. Should a family-level `tools.list` return full schemas for every child or
   only compact descriptions, requiring one exact follow-up for the selected
   child? Current recommendation: compact child descriptions only.
4. Does Canva need an optional system skill, or is its contract sufficient?
5. Should tool contracts expose structured `operationDocs` in addition to the
   current prose `parameterDocs`?
6. Which tools, other than scheduled-work creation, genuinely require a loaded
   skill before execution?
7. Should missing catalogue reconciliation fail backend readiness in production
   or emit a critical alert while keeping unaffected tools available?

## 14. Alternatives considered

### Add more prompt instructions

Rejected as the root solution. It may reduce failures but cannot prevent drift
between provider enums, family IDs, tool IDs, skills, and UI metadata.

### Put every tool ID into a static desktop enum

Insufficient. The desktop enum can drift from the backend, as the missing
`aitable` connection provider already demonstrates.

### Fuzzy-match tool invocation

Rejected. "Base", "records", "calendar", and "documents" are ambiguous across
providers. Fuzzy matching is acceptable for discovery, never execution.

### Always require a skill

Rejected. It adds latency and context, and the successful Airtable run proves a
complete direct contract can safely guide a simple operation.

### Central capability definitions plus runtime bootstrap

Recommended. It preserves exact execution while making discovery automatic,
permission-filtered, and consistent across backend, desktop, skills, and UI.

## 15. Implementation waves

Implementation is complete through the bounded 100% integration checkpoint.
The unchecked items below remain explicit follow-up work.

### Wave 1 — capability identity and discovery

- [x] Introduce central family and leaf capability definitions.
- [x] Derive current canonical/family maps from those definitions.
- [x] Add exact `family` selection to `tools.list`.
- [x] Add safe read-only compatibility for family names in the old field.
- [x] Add structured ambiguity for family names passed to execution.
- [x] Add all-family discovery invariants.

### Wave 2 — bootstrap and agent contract

- [x] Add capability bootstrap v3.
- [x] Preserve v2 parsing during rollout.
- [x] Render explicit families, leaf tools, descriptions, connection mode, and
      optional skills.
- [x] Preload governed Lark work from the server-held original request before
      the model runs.
- [x] Hide `resolve_work` from the model and gate `call_tool` until resolution.
- [x] Propagate one run cancellation signal through discovery and governed
      Google execution.
- [ ] Remove duplicated provider lists from model instructions where runtime
      bootstrap can supply them.
- [ ] Add contract-completeness tests for first-class tools.

### Wave 3 — skills and routing

- [ ] Create one system-skill template registry.
- [x] Provision Airtable and AITable skills into the database-backed catalogue.
- [ ] Include every system template in new-company provisioning.
- [x] Add idempotent existing-company reconciliation.
- [x] Generalize provider-aware skill ranking.
- [x] Add Airtable/Lark collision regressions.

### Wave 4 — catalogue and UI parity

- [ ] Reconcile `RegisteredTool` from capability definitions.
- [x] Add `larkMeeting` to idempotent reconciliation; deployment execution remains pending.
- [ ] Render desktop tool groups from backend family metadata.
- [x] Add deployment reconciliation and build-time canonical catalogue drift checks.
- [ ] Decide the `airtableBase` lifecycle before removing or hiding anything.

### Wave 5 — real-agent validation

- [ ] Add harness assertions for Airtable, OMS, Semrush, Lark, and Zoho.
- [x] Run an Airtable read-only prompt through the real Lark engine as Anish
      using the Flash harness and inspect the persisted trace.
- [ ] Verify trace clarity, small-model recovery, and no cross-provider routing.
- [x] Run focused tests and typecheck.
- [x] Run the requested independent cold review and its post-fix verification.

## 16. Evidence inspected

- `advance-backend/src/domain/tools/tool-id.ts`
- `advance-backend/src/application/gateway/gateway.types.ts`
- `advance-backend/src/application/gateway/gateway-dispatcher.ts`
- `advance-backend/src/application/desktop/desktop-capability-bootstrap.ts`
- `advance-backend/src/application/skills/skill-catalog.service.ts`
- `advance-backend/src/application/skills/airtable.skill.ts`
- `advance-backend/src/application/skills/index.ts`
- `advance-backend/src/application/orchestration/tools/families/airtable-mcp.tool.ts`
- `advance-backend/src/application/orchestration/tools/families/oms-site-data.tool.ts`
- `advance-backend/src/application/orchestration/tools/families/semrush.tool.ts`
- `advance-backend/src/application/oms/oms-site-data.types.ts`
- `advance-backend/src/application/semrush/semrush.types.ts`
- `advance-backend/src/http/admin/admin-auth.routes.ts`
- `advance-backend/scripts/seed-registered-tools.ts`
- `jan/pi-extensions/divo-gateway/index.ts`
- `jan/pi-extensions/divo-gateway/department-persona.ts`
- Live read-only `Skill` and `RegisteredTool` catalogue queries on 2026-07-27.

## 17. Confidence

Current recommendation confidence: **97%**.

The remaining uncertainty concerns rollout details and lifecycle choices, not
the central boundary:

- Compact runtime discovery should identify available families and leaf tools.
- Exact contracts should teach direct operations.
- Skills should teach reusable procedure.
- Backend policy should remain the sole execution authority.
