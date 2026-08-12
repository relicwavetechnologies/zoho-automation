# Pi first-class harness — strict quality audit and hardening plan

> Status: **Active decision and execution plan**
>
> Decision date: **2026-08-13**
>
> Decision: **Keep Pi as Divo's only agent harness. Defer Codex V2. Apply the
> first-class tool, skill, model, security, performance, and code-quality
> requirements to Pi and judge it by objective gates.**
>
> Supersedes the implementation direction in
> [`codex-v2-parallel-runtime-plan.md`](codex-v2-parallel-runtime-plan.md).
>
> Related optimization evidence:
> [`cloud-pi-runtime-optimization-consistency-and-proof.md`](cloud-pi-runtime-optimization-consistency-and-proof.md).

## 1. Executive verdict

Do not build the Codex revamp now.

Pi is already capable of the architecture Divo needs. Extension tools use the
same `ToolDefinition` and `AgentTool` execution lifecycle as Pi's built-ins;
DeepSeek and Luna already route through Divo's backend proxy; SaaS credentials,
RBAC, usage, approval, and audit remain backend-owned; and the container path
already has strong isolation, state, interruption, attachment, progress, and
file-workflow behavior.

However, **current Pi is not yet delivering its full power**. After the native
catalogue implementation, the strict weighted score is **81/100**. That
score is not a criticism of Pi itself. It measures how completely Divo has
wired Pi according to the user's priorities. The largest losses are Divo-owned:

1. Cloud and desktop maintain materially divergent copies of the gateway
   extension.
2. The measured Semrush baseline is still dominated by prompt size and model
   turns: 58,027 uncached input tokens on turn one, seven model turns, six tool
   calls, and 78.8 seconds for one successful provider call.
3. The new always-visible 38-tool catalogue has contract and unit proof, but
   still needs real DeepSeek/Luna prompt-size, cache, latency, denial, and
   representative provider E2E measurements.

The right move is a **Pi hardening program**, not another harness.

## 2. What the user weighted most heavily

These are the non-negotiables extracted from the Codex discussion and now
applied to Pi, in priority order.

### 2.1 First-class native tools, not a foreign contract

- Every Divo business tool must be a real Pi `ToolDefinition` and participate
  in the same validation, activation, execution, cancellation, result, prompt,
  and telemetry lifecycle as a built-in tool.
- The Divo–Pi source tree must make every supported tool easy to find, review,
  test, and evolve. A developer should not have to mentally reconstruct the
  model-facing tool from a generic adapter plus a backend response.
- Avoid a mega-tool such as `{ op, payload }` that forces the model to reproduce
  a second protocol inside one generic call.
- Use a shared governed executor for repetitive transport, but give each tool
  or cohesive tool family an explicit source-owned spec and tests.

### 2.2 One clean Pi implementation; no speculative runtime switches

- Pi is the only active harness.
- Do not add a Pi/Codex selector, Codex container, alternate controller,
  harness-neutral abstraction, or fallback path.
- Configuration that represents real deployment differences is acceptable.
  Expired migration/rollback flags and duplicated behavior paths are not.
- Code must be predictable: one owner, one path, no silent dead code, and no
  comments that describe a historical architecture.

### 2.3 The backend remains the only enterprise authority

- Pi owns agent-facing ergonomics and local execution mechanics.
- `advance-backend` owns member identity, company/department context, RBAC,
  approvals, OAuth refresh, connection selection policy, SaaS credentials,
  provider execution, rate limits, usage, and audit.
- Pi never receives reusable Zoho, Google, Lark, Meta, or provider credentials.
- Every invocation, including a tool the model can see as denied, crosses the
  backend gateway and is reauthorized there.

### 2.4 Every Divo tool remains visible; the backend denies use

- The model should know Divo supports a capability even when the current user
  cannot use it.
- The backend must return a clear permission/connection/policy denial when the
  model invokes it.
- Visibility is not authority.
- The implementation must benchmark the token cost of this policy. It may use
  compact descriptions and schemas, but must not silently revert to RBAC-based
  disappearance.

### 2.5 Native skills and native workflow ergonomics

- Skills must be discoverable through Pi's normal `available_skills` mechanism
  and loaded through Pi's normal `read` path.
- Tool schemas contain mechanics; skills contain procedures. Do not duplicate
  large policy blocks across system prompt, tool guidance, and skills.
- Pi's todos, plans, subagents, progress, files, Bash, and persistent Python
  workflow must remain first-class parts of Divo—not be reimplemented in the
  backend.

### 2.6 DeepSeek and Luna must both be permanent first-class models

- DeepSeek Flash and Pro use Chat Completions through the Divo proxy.
- GPT-5.6 Luna uses native OpenAI Responses and retains image input.
- The transport architecture is provider-neutral; a DeepSeek-specific adapter
  cannot redefine the whole runtime contract.
- Provider cache counters and Divo's normalized cache counters must agree.

### 2.7 Performance must be proven, not inferred from harness language

- Stable prompt prefixes must maximize provider prefix-cache reuse.
- Dynamic run paths and per-turn metadata should occur after stable policy or
  outside it where Pi permits.
- Tool contracts should arrive without an avoidable extra `tools.list` request.
- Large provider rows remain in local files/workflows, not model context.
- Simple work must not take repeated routing, resolver, preflight, discovery,
  and repair turns when the target capability is already clear.

### 2.8 Code quality and proof are release gates

- All production extension code is type-checked.
- All extension tests run in CI and in the built image.
- One canonical gateway implementation serves cloud and desktop, with thin
  environment adapters only where behavior is genuinely different.
- Large controller responsibilities are separated behind explicit modules and
  tests.
- A green unit suite is not enough: DeepSeek, Luna, denial, cache, approval,
  interruption, files, and representative provider flows need contract/E2E
  evidence.

## 3. Strict current-state tally

The weights reflect the user's priorities, not generic framework popularity.

| Criterion | Weight | Current | Judgment |
|---|---:|---:|---|
| Native Pi execution lifecycle | 10 | 10 | Pass: Divo definitions and built-ins are wrapped into the same `AgentTool` registry |
| Source-owned business-tool catalogue and granularity | 15 | 15 | Pass: all 38 canonical business tools have committed Pi-native definitions; 37 are deterministic family modules and Semrush is hand-authored |
| All-tool visibility with backend denial | 8 | 8 | Pass at contract/unit level: all 38 register before bootstrap or RBAC; calls still cross the backend authority |
| Backend authority and credential safety | 14 | 13 | Strong pass: provider/SaaS authority stays backend-side; member token is scrubbed before shell children |
| Native skills, todos, subagents, files, and workflow ergonomics | 10 | 8 | Strong: native mechanisms exist; source ownership and prompt duplication still need cleanup |
| DeepSeek, Luna, cache, and usage correctness | 10 | 8 | Strong code path; repeated-prefix and full cross-model release evidence are still required |
| Prompt, tool, and model-turn efficiency | 13 | 5 | Fail: measured 58,027-token first turn and seven model turns for a simple successful provider flow |
| One predictable implementation and modular ownership | 10 | 4 | Fail: cloud/desktop gateway drift plus a 3,114-line controller |
| Type safety, CI, and release proof | 7 | 7 | Pass for repository gates: production extensions are strictly checked; all 400 Pi tests and 3,534 backend tests pass; deterministic catalogue drift is a CI failure |
| Isolation, lifecycle, and recovery | 3 | 3 | Pass: container and controller controls are unusually mature |
| **Total** | **100** | **81** | **The first-class tool architecture is implemented; runtime performance and consolidation gates remain** |

### 3.1 What is already genuinely first-class

Pi's extension API is not a second-class MCP-like side channel:

```text
Divo ToolDefinition ─┐
                     ├─ definitionRegistry ─ AgentTool wrapper ─ active tools ─ model
Pi built-in tool ────┘
```

Evidence:

- `registerTool()` stores the definition and refreshes the live registry in
  `divo-pi/packages/coding-agent/src/core/extensions/loader.ts`.
- `AgentSession._refreshToolRegistry()` merges built-in and extension
  definitions into the same definition and execution registries in
  `divo-pi/packages/coding-agent/src/core/agent-session.ts`.
- Both paths use `wrapRegisteredTools()`/`AgentTool` before execution.
- Divo's typed adapter supplies name, label, description, parameter schema,
  prompt guidance, execution mode, and executor through this native API.

Conclusion: **rewriting tools into Pi core is not required to gain native tool
execution power**. A Divo-owned extension package can be fully native. The
missing improvement is explicit source ownership and delivery discipline, not
moving every tool into vendored Pi internals.

### 3.2 What “inside the Pi codebase” should mean

Implemented layout:

```text
divo-pi/divo/extensions/divo-gateway/
├── native-tools/
│   ├── semrush-contract.ts  # Pi-owned model contract
│   ├── semrush.ts           # native registration + governed handler
│   ├── generated/            # committed family modules for 37 tools
│   ├── catalogue.ts          # permanent registration + nested enrichment
│   └── catalogue.test.ts
├── typed-tool-runtime.ts    # shared governed executor
└── index.ts                 # registers permanent native catalogue
```

This gives each business tool first-class source presence while retaining one
shared executor. Pi owns the model-facing contract; the backend independently
validates the business input and owns the protected operation. A cross-repo
behavioral parity suite compares the Pi JSON Schema with the backend's
canonical validator. For large generated provider surfaces, deterministic
generation remains acceptable, but it must produce reviewable Pi-owned source
and cannot move runtime authority out of the backend.

The runtime story stays simple:

1. Pi starts and registers Divo's compiled/source-owned catalogue through
   `registerTool()`.
2. The backend bootstrap returns identity, department, connection status, and
   allowed actions—not the primary definition of what a Pi tool is.
3. The model sees the Divo tools.
4. A call crosses one shared governed executor with the runtime lease.
5. The backend revalidates schema version, user, department, RBAC, connection,
   approval, and rate policy.
6. The backend obtains/refreshes the Zoho or other provider credential and
   performs the protected operation.
7. Pi receives a structured result or a structured denial. It never receives
   the provider credential.

### 3.3 Complete native business catalogue (completed 2026-08-13)

Semrush remains the hand-authored reference definition. The same boundary now
covers all 38 canonical business tools:

- `native-tools/semrush-contract.ts` owns the stable Pi name, the three
  operations, the discriminated JSON Schema, semantic domain/date/database
  constraints, and model-facing field descriptions.
- `native-tools/semrush.ts` owns the native `registerTool()` definition,
  Semrush-specific guidance, read-only concurrency, and exact construction of
  the governed `tools.invoke` call.
- It registers when the extension loads, even when the member's RBAC bootstrap
  does not name Semrush. The model therefore sees the capability; the backend
  still returns the authoritative denial when access is absent.
- Thirty-seven additional tools are emitted as committed family modules from
  canonical backend validators. The generator validates the exact canonical
  ID set, rejects unresolved schemas, and fails CI on drift.
- All 38 definitions register when the extension loads, without bootstrap or
  RBAC input. Visibility proves capability existence, not permission.
- The former dynamic outer-definition registrar and its schema fixtures are
  removed. Backend work bootstrap no longer repeats outer descriptions,
  parameter documentation, or JSON Schema.
- Google Workspace and Airtable retain one narrow dynamic step: provider-owned
  nested MCP inputs may enrich an already-registered permanent wrapper.
  Bootstrap cannot rename a tool, change its outer operations or handler, or
  remove it.
- Provider secrets and execution remain in `createSemrushTool()` and
  `SemrushService` in `advance-backend`; no Semrush key or reusable SaaS
  credential enters Pi.
- The backend parity suite imports the dependency-free Pi contract and proves
  both boundaries accept and reject the same representative calls, including
  invalid domains, duplicate targets, malformed dates, unknown operations,
  and extra fields.

Provider execution, RBAC, connections, approvals, credentials, quotas, usage,
and audit remain backend-owned for every tool. Pi owns the model-facing surface
and the one governed dispatch handler.

## 4. Findings that block a full-power claim

### F1 — RESOLVED 2026-08-13 — Divo extension code was outside normal type-check and CI

Previous severity: **High**

- Root npm workspaces include `packages/*` and examples, not
  `divo/extensions/*`.
- Root `tsconfig.json` includes only packages and examples.
- Root `divo:test` runs only `divo/test/*.test.mjs`.
- CI and deploy image smoke invoke only `npm run divo:test`.
- The gateway has 189 passing tests when invoked manually, plus passing LLM,
  todo, subagent, artifact, and chat-history tests—but those suites are not the
  release gate.

Impact: production TypeScript can break or drift while CI remains green.

Resolution: `divo/tsconfig.json` now strictly checks production extension
TypeScript. One `npm run divo:check` command runs that check plus the runtime,
controller, gateway, LLM, todo, subagent, artifact, and chat-history suites.
Normal CI and both published-image smoke paths now run the same command.

### F2 — RESOLVED 2026-08-13 — The designated Divo suite was red

Previous severity: **High until reconciled**

Audit result on 2026-08-13:

```text
divo:test: 189 tests; 188 pass; 1 fail
failing: “thinking never leaves the container”
actual projected event: { type: "thinking" }
expected: undefined
```

Resolution: the stale duplicate test now matches the intentional contract.
Reasoning crosses the controller as a distinct bounded `thought` event so the
private web thread can render it; Lark remains responsible for dropping it.
`divo:test` now passes 189/189.

### F3 — RESOLVED 2026-08-13 — Native execution and reviewable source ownership

All 38 canonical tools now have committed Pi-native definitions. Semrush is
hand-authored; the other 37 are grouped into 12 explicit generated family
modules. The shared catalogue registers them through Pi's normal `registerTool`
API and dispatches through one governed invoker. The former dynamic outer
definition path is deleted.

The backend remains an independent validator and execution authority. A
cross-repository parity suite and `check:pi-native-tools` CI step make source
drift explicit.

### F4 — RESOLVED IN CODE 2026-08-13 — Full visibility with backend denial

All 38 business tools register before any member bootstrap. The prompt says
explicitly that a visible tool proves only that Divo supports the capability;
it does not prove this member may use it. RBAC-filtered bootstrap data remains
routing context, and every call is reauthorized by the backend.

Unit and contract tests prove permanent visibility, governed dispatch, schema
compilation, backend permission denial, and runtime-manifest coverage. The
real-container denial/bypass case remains a Phase 5 promotion test, not an
architecture gap.

### F5 — Cloud and desktop gateway implementations have drifted

Severity: **High**

The audit compared:

- `divo-pi/divo/extensions/divo-gateway`
- `jan/pi-extensions/divo-gateway`

Result: 49 differing files, with a no-index diff of 3,396 deletions and 1,651
insertions in the compared direction. Cloud has the typed-tool modules that Jan
lacks; Jan has skill authorization/view/teaching modules that cloud lacks; many
shared clients, policy files, memory files, and tests also differ.

Impact: there is no single answer to “how Divo's Pi gateway behaves.”

Required outcome: one canonical package plus small cloud/desktop adapters for
transport or UI differences. Do not copy one tree over the other; inventory
intentional differences first and preserve them through explicit interfaces.

### F6 — Controller ownership is too broad

Severity: **Medium-high**

`local-rpc-controller.mjs` is 3,114 lines and owns Docker resources, leases,
admission, native skill staging, attachments, warm processes, stream handling,
workspace policy, cleanup, and more.

The behavior has substantial tests and useful safety checks, but the file is
too broad for predictable change review.

Required outcome: extract cohesive modules without changing the public RPC
contract: identity/lease, resources, workspace/attachments, native skills,
warm process lifecycle, stream projection, and cleanup/reconciliation.

### F7 — Prompt and tool-loading cost remain the dominant performance problem

Severity: **High**

- Measured Development baseline: 58,027 uncached input tokens on the first
  Semrush turn, then roughly 58k–67k cached input tokens.
- One successful provider request took 78.8 seconds, seven model turns, and six
  tool calls.
- The main gateway extension contains roughly 24k characters in its central
  policy/prompt region before dynamic persona/tool data.
- The runtime allowlist contains 54 tools.
- The avoidable `tools.list` fetch for outer business-tool definitions is gone.
  A prompt-relevant fetch remains only for versioned Google/Airtable provider
  nested schemas and account context.

This evidence does not blame TypeScript or Pi. It points to duplicated policy,
catalogue/schema size, routing behavior, and model-loop decisions.

### F8 — Transitional switches need an expiry audit

Severity: **Medium**

There is no Pi/Codex runtime switch, which satisfies the current decision.
There are still multiple runtime behavior flags, including native DB skills,
source/compiled entry mode, keepalive, host gateway, and local CLI disablement.
Some are legitimate deployment configuration; at least one is explicitly
documented as a rollback switch.

Required outcome: classify every flag as permanent operational configuration,
test-only override, or expired migration switch. Delete expired switches and
their alternate paths only with explicit cleanup approval.

## 5. What Pi already does well and must not be damaged

- **Native tools:** extension and built-in definitions share Pi's live
  definition registry and `AgentTool` wrapper.
- **Backend authority:** the gateway owns final authorization and protected
  provider execution.
- **Credential containment:** Pi does not hold provider keys; the member token
  is deleted from `process.env` after configuring the in-process proxy client.
- **No provider fallback:** incomplete proxy configuration fails closed.
- **Models:** DeepSeek Flash/Pro and GPT-5.6 Luna are explicitly modeled;
  Luna uses Responses and image input.
- **Cache accounting:** backend normalization supports DeepSeek custom hit/miss
  fields and standard cached-token details.
- **Native skills:** the controller stages slug-validated skills into a
  read-only runtime mount; Pi advertises metadata and reads `SKILL.md` only when
  needed.
- **Workflow power:** persistent Python and `divo-local` keep bulk connected
  data and provider credentials outside the model context.
- **Agent mechanics:** todos, subagents, chat history, progress, planning,
  Bash, read/write/edit, and artifacts/workspace policy already exist.
- **Isolation:** non-root container, read-only root, private resources,
  resource limits, scoped volumes, signed identity context, warm-binding
  invalidation, and protected cleanup are mature.
- **Continuity:** private-thread sessions, disposable shared-run sessions,
  interruption facts, durable workflow state, and attachment staging cover
  hard problems a harness rewrite would have to reproduce.

## 6. Target architecture

```text
Pi native catalogue
  ├─ source-owned ToolDefinitions
  ├─ native skills / todos / files / subagents
  └─ shared governed executor
             │ short-lived Divo runtime lease
             ▼
advance-backend capability gateway
  ├─ identity + department
  ├─ schema/digest validation
  ├─ RBAC + connection + approval
  ├─ credential vault / refresh
  ├─ provider execution
  └─ structured result + usage + audit
             │
             ├─ Zoho / Google / Lark / Semrush / other tools
             └─ model gateway
                  ├─ DeepSeek Chat Completions
                  └─ Luna OpenAI Responses
```

There is one enterprise authority, one Pi tool catalogue, one governed
executor, one model gateway, and no second harness.

## 7. Phased implementation plan

### Phase 0 — Freeze the proof baseline

Goal: prevent a refactor from being judged by feeling.

- Record current tool catalogue, prompt components, first-turn tokens, cache
  hit/miss, model turns, tool calls, provider calls, first-tool latency, total
  latency, and task correctness for a fixed suite.
- Use both DeepSeek and Luna where the task is supported.
- Include Semrush comparison, Zoho read, Zoho write with approval, Google
  Sheets artifact, Lark action, denied tool, connection missing, interruption,
  and a file-heavy workflow.
- Resolve or explicitly re-contract the current thinking-projection test.

Exit gate: reproducible baseline report and zero unexplained failing designated
tests.

### Phase 1 — Make quality checks truthful

Implementation status: **Core repository gate completed 2026-08-13. The
full cross-repository catalogue parity gate belongs with the remaining Phase 2
catalogue work.**

Goal: make CI test the code Divo ships.

- Add Divo extension packages to the workspace or create an explicit Divo
  project/type-check configuration.
- Create `divo:check` for formatting/linting, TypeScript, runtime/controller
  tests, gateway tests, LLM tests, todos, subagents, chat history, and artifact
  tests.
- Run `divo:check` in normal CI, container smoke, and deploy verification.
- Add deterministic behavioral parity tests between backend tool contracts,
  the Pi native catalogue, and the runtime allowlist.

Exit gate: one local/CI command; all production Divo TypeScript is checked; all
suites pass from a clean checkout and from the built image.

### Phase 2 — Establish the first-class Pi tool catalogue

Implementation status: **Core implementation completed 2026-08-13. Runtime
E2E promotion evidence remains in Phase 5.**

Goal: make business tools as reviewable as native Pi tools without duplicating
backend authority.

- Keep one canonical native-tools catalogue inside the Divo Pi extension;
  extract it into a separate package only when the module count earns that
  boundary.
- Make each model-facing contract explicit Pi source and enforce behavioral
  parity with the backend validator. Use deterministic generation for very
  large provider-native surfaces where hand-authorship would be less reliable.
- Give each cohesive family its own native definition module and targeted
  ergonomic tests.
- Keep one shared governed executor for identity, cancellation, trace,
  approval, error, and structured-result mechanics.
- Eliminate the avoidable pre-agent `tools.list` fetch by shipping schemas or a
  verified capability bundle with the runtime/bootstrap.
- Register the full supported catalogue independently of permission; use
  bootstrap only for current routing/account context and provider-owned nested
  schemas; reauthorize every call backend-side.

Completed catalogue:

- [x] Permanent Pi-native Semrush contract and definition.
- [x] Unconditional model visibility with backend-owned denial.
- [x] Shared governed executor; no provider credential in Pi.
- [x] Dynamic registration collision/fetch prevention.
- [x] Pi validation/dispatch tests and cross-repo backend parity tests.
- [x] Add committed family modules for the remaining 37 business tools.
- [x] Add deterministic generation, exact canonical coverage, schema
      compilation, runtime-manifest coverage, and CI drift checks.
- [x] Remove the generic dynamic outer-definition and bootstrap-schema path.
- [x] Retain only provider-authoritative nested Google/Airtable schema
      enrichment inside permanent Pi wrappers.

Exit gate: every canonical business tool maps to one source-owned native
definition; contract drift fails CI; an unauthorized visible tool produces a
backend denial; no mega-tool envelope returns. The first three are complete in
repository proof; the real-container denied-tool case is still required before
promotion.

### Phase 3 — Collapse duplicate integration code

Goal: one predictable Divo–Pi implementation.

- Inventory cloud-only, desktop-only, and shared gateway behavior.
- Move shared behavior and tests into one canonical package.
- Retain thin adapters only for RPC/UI/local-broker differences.
- Extract the controller by cohesive responsibility while preserving its RPC
  and security contracts.
- Audit flags and remove expired migration paths with explicit approval.

Exit gate: no copied gateway implementation; dependency direction is clear;
controller modules have bounded responsibilities and focused tests.

### Phase 4 — Reduce model tax without reducing capability

Goal: let Pi spend tokens on the user's work, not Divo plumbing.

- Decompose the system prompt into stable security invariants, compact tool
  metadata, and task-loaded skill instructions.
- Remove duplicated policy statements across prompt, tool guidelines, and
  skills; keep one authoritative location for each rule.
- Stabilize the prefix by moving run-specific paths/IDs after stable content or
  into runtime state where possible.
- Shrink schemas and descriptions without losing validation or denial truth.
- Make direct, unambiguous requests use the target tool without resolver or
  discovery turns.
- Keep bulk rows/results in local files and expose bounded summaries plus
  continuation/artifact references.

Exit gates under the same task/model fixture:

- At least 35% lower uncached first-turn tokens than the 58,027 baseline.
- At most three model turns for the simple one-provider Semrush comparison.
- Exactly one Semrush provider request for the multi-target comparison.
- At least 25% lower p50 user-to-first-business-tool latency and no p95
  regression.
- No task-success or invalid-argument regression.

### Phase 5 — Prove models, caching, authority, and recovery

Goal: earn the “full-power Pi” label.

- Run the fixed suite on DeepSeek Flash, DeepSeek Pro, and Luna.
- Repeated-prefix test must produce non-zero provider cache hits.
- Raw DeepSeek hit/miss counters must equal normalized Divo usage within the
  defined mapping.
- Luna Responses usage, image input, tool calls, compaction, and 413 recovery
  must pass.
- Test visible denial, missing connection, approval continuation, abort,
  interrupted mutation, warm reuse/invalidation, private/shared isolation,
  attachment cleanup, and protected result deletion.
- Verify every user-visible completion has a terminal progress/final event.

Exit gate: all mandatory gates in §8 pass in CI/E2E evidence.

## 8. Mandatory promotion gates

Pi may be described as delivering its full intended power only when all of
these pass.

### Native tool gates

- [x] Every canonical business tool is a source-owned native Pi `ToolDefinition`.
- [x] No generic `{ op, payload }` mega-tool is model-facing.
- [x] One deterministic behavioral parity mechanism prevents backend/Pi drift.
- [x] Every supported business-tool identity is model-visible under the chosen policy.
- [ ] Backend denial remains final for ungranted, disconnected, or disallowed
      calls.

### Code-quality gates

- [ ] One canonical cloud/desktop gateway implementation.
- [x] All production extensions are type-checked.
- [x] All Divo tests run in normal CI and the built image.
- [x] No designated test is red or silently excluded.
- [ ] Controller responsibilities are modular and comments match behavior.
- [ ] Every remaining feature flag has a named permanent operational purpose.

### Model and cache gates

- [ ] DeepSeek Flash and Pro pass the representative tool suite.
- [ ] Luna passes Responses, tool, image, and recovery tests.
- [ ] Repeated stable prefixes show non-zero DeepSeek cache hits.
- [ ] Raw provider and normalized Divo usage agree.
- [ ] No model can fall back to a direct provider key.

### Performance gates

- [ ] First-turn uncached tokens are at least 35% below 58,027 on the fixed
      Semrush fixture.
- [ ] Simple one-provider work completes in at most three model turns.
- [ ] p50 first-business-tool latency improves by at least 25%; p95 does not
      regress.
- [ ] Bulk data remains out of model context unless explicitly required.

### Authority and reliability gates

- [x] Identity, RBAC, OAuth, provider credentials, approvals, usage, and audit
      have exactly one owner: `advance-backend`.
- [ ] A visible but denied tool cannot bypass the gateway through Bash, local
      SDKs, direct APIs, or another tool.
- [ ] Abort, approval, interruption, warm invalidation, private/shared state,
      attachments, and cleanup pass their E2E cases.

## 9. Risks and explicit trade-offs

### All tools visible versus token cost

The explicit visibility choice may increase schema tokens and tool-selection
confusion as the catalogue grows. Do not silently change the decision. Measure
it. If it becomes material, discuss a compact always-visible catalogue plus a
Pi-native deferred schema mechanism as a product decision—not an RBAC filter
disguised as optimization.

### Source ownership versus duplicate contracts

Putting model-facing tool definitions in Pi creates an intentional second
validation boundary, not a second execution authority. Keep it honest with
deterministic cross-repository behavioral parity; use generation and digests
for very large provider-native schemas where that is more reliable. Backend
runtime validation remains final.

### Consolidation versus accidental behavior loss

The cloud and Jan trees contain features the other lacks. Consolidation must
begin with an intent inventory and contract tests; a directory copy would lose
behavior.

### Controller modularization versus security regressions

The controller is large because it carries real safety behavior. Extract
modules behind characterization tests and avoid changing policy and structure
in the same patch.

### Performance optimization versus honesty

Do not remove necessary permission, approval, or evidence content just to make
the prompt smaller. First remove duplication, volatile prefix content,
avoidable discovery, and model-carried bulk data.

## 10. Alternatives considered

### Build Codex V2 now

Rejected for the current phase. It would reproduce mature Pi lifecycle and
isolation machinery before Divo proves that its own wiring—not Pi—is the
remaining bottleneck.

### Keep Pi exactly as it is

Rejected. It leaves the user's first-class source-ownership requirement,
catalogue visibility policy, CI gap, code duplication, and measured model tax
unresolved.

### Move provider execution and credentials into Pi

Rejected. It would duplicate enterprise authority and expand the impact of a
compromised agent container.

### Modify vendored Pi core for every Divo tool

Rejected by default. Pi's extension tools already share the native execution
lifecycle. A Divo-owned canonical extension is easier to update, test, and
rebase. Core changes require a capability the extension API genuinely cannot
provide.

## 11. Immediate next actions

1. [x] Approve this scorecard and the interpretation of “inside Pi”: native
   source-owned extension definitions, not backend authority and not mandatory
   edits to vendored core.
2. Finish Phase 0 by capturing one clean DeepSeek/Luna baseline and compare the
   new 38-tool prompt against the old baseline; the thinking-projection
   contract is reconciled.
3. [x] Implement Phase 1 before any tool refactor so subsequent work cannot
   bypass type-check or CI.
4. [x] Implement the complete 38-tool native catalogue, full-visibility policy,
   governed dispatch, deterministic parity, and obsolete dynamic-path cleanup.
5. Consolidate cloud/desktop only after parity tests describe their intentional
   differences.

## 12. Evidence snapshot

Audit and implementation date: 2026-08-13. The repository had unrelated
user-owned working-tree changes. The implementation preserved unrelated
changes and limited this phase to the Pi-native catalogue, its governed
registration/enrichment path, backend bootstrap cleanup, parity/CI proof, and
this plan.

Primary inspected files:

- `divo-pi/divo/runtime-manifest.json`
- `divo-pi/divo/runtime.mjs`
- `divo-pi/divo/local-rpc-controller.mjs`
- `divo-pi/divo/local-rpc-server.mjs`
- `divo-pi/Dockerfile`
- `divo-pi/divo/extensions/divo-gateway/index.ts`
- `divo-pi/divo/extensions/divo-gateway/typed-tools.ts`
- `divo-pi/divo/extensions/divo-gateway/typed-tool-runtime.ts`
- `divo-pi/divo/extensions/divo-llm/index.ts`
- `divo-pi/packages/coding-agent/src/core/extensions/types.ts`
- `divo-pi/packages/coding-agent/src/core/extensions/loader.ts`
- `divo-pi/packages/coding-agent/src/core/agent-session.ts`
- `divo-pi/packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`
- `advance-backend/src/application/desktop/desktop-capability-bootstrap.ts`
- `advance-backend/src/http/llm/llm-proxy.routes.ts`
- `advance-backend/src/application/proxy/llm-proxy.service.ts`
- `.github/workflows/ci.yml`
- `jan/pi-extensions/divo-gateway/`

Test evidence:

| Suite | Result during audit |
|---|---|
| `npm run divo:test` | 189/189 pass |
| `divo-gateway` through `divo:check` | 169/169 pass |
| `divo-artifact` | 4/4 pass |
| `divo-todos` | 10/10 pass |
| `divo-subagents` | 15/15 pass |
| `divo-chat-history` | 10/10 pass |
| `divo-llm` | 5/5 pass |
| Complete native catalogue tests | 7/7 pass |
| Native Semrush Pi tests | 4/4 pass |
| Semrush backend/Pi contract parity | 12/12 pass |
| Native catalogue backend/Pi parity | 3/3 pass |
| **Unified `npm run divo:check`** | **Strict TypeScript pass; 402/402 tests pass** |
| **Full backend `pnpm test`** | **3,534 pass; 0 fail; 30 credential-gated skips** |
| Reasoning boundary + Lark privacy checks | 11/11 pass |

Confidence in the recommendation: **92%**. Confidence is high because the
native tool registry, gateway boundary, model proxy, CI configuration, test
behavior, duplicated source trees, and measured runtime baseline were directly
inspected. The remaining uncertainty is how much of the 58k-token baseline
each prompt/schema component contributes; Phase 0 must instrument that before
implementation claims a specific optimization win.

## 13. Local web sanity findings (2026-08-13)

The first live web-chat inspection proved the permanent native surface: all 38
business tools were visible, including Menhood, OMS, Semrush, Airtable,
Shopify, and Zoho. It also exposed two bootstrap defects before provider calls
began:

1. Web member authentication correctly carried no Pi runtime claims, but the
   web run never resolved the member's backend-owned active department before
   minting its runtime lease. The controller therefore staged zero database
   skills and Pi saw only the two bundled skills.
2. Provider-native schema enrichment forwarded the complete user prompt as the
   `tools.list` search query. A long inspection prompt exceeded the backend's
   2,000-character query contract and prevented Google/Airtable enrichment.

Implemented corrections:

- `WebRunService` now resolves the same active department preference used by
  the backend identity system, validates that the membership is still active,
  and only then carries it into the short-lived Pi lease. The browser supplies
  no department authority.
- Pi bounds prompt-derived `tools.list` query context to the backend contract;
  a long ordinary prompt can no longer invalidate native schema bootstrap.
- Focused tests cover a valid active preference, a stale preference, query
  trimming/bounding, and short-query omission. Backend typechecking and the
  complete Pi check pass. The corrected runtime image was rebuilt and the local
  controller restarted with zero active runs.

Next live gate: repeat the inspection in a fresh web thread and require a
non-zero native skill catalogue plus no `tools.list` validation failures before
testing real provider reads, denial behavior, mutations, or approvals.

### Fresh-thread result

The repeated web inspection passed that gate:

- controller telemetry: `native_skills.ready`, registry revision 1261,
  56 backend skills staged, no staging fallback;
- Pi exposure: 58 total skills = 2 bundled + 56 backend-native;
- provider-native contract enrichment: 4 refreshed, 0 failed;
- active department: Finance;
- backend-observed model: `deepseek-v4-flash`.

The model reported Shopify as the only missing family. Database inspection
confirmed this is not missing source or provisioning: `shopify-commerce` and
`shopify-router` are active system skills with company grants. Finance has no
Shopify RBAC grant, so the specialist fails the skill catalogue's declared-tool
visibility gate and its router is removed because it has no visible target.
The three permanent native Shopify tools remain model-visible under the chosen
tool policy, and the backend remains responsible for denying an invocation.
Do not grant Shopify merely to make an inventory test green.

Follow-up design note: `shopify-commerce` declares analytics, orders, and
customers together even though those capabilities are independently granted.
Before enabling only a subset for a department, decide whether to split the
recipe into separately gated specialists; the current all-declared-tools rule
would otherwise hide the combined recipe until all three grants are present.

Next gate: one real, read-only Semrush comparison that loads
`research-router` and `divo-semrush-seo-research`, performs one governed
`backlinks_comparison` call for all targets, avoids Web Search/Bash, and reports
bounded coverage honestly.

### Semrush result and true web streaming correction

The Semrush gate passed: one `backlinks_comparison` invocation covered all
three requested domains, both required skills were loaded, and no substitute
Web Search/Bash flow was used.

That run also exposed a separate presentation defect. Pi and the model provider
were producing real `text_delta` events, but the controller retained only the
sentence-sized projection intended for Lark status cards. The web backend then
sent the completed final answer in one terminal frame, and the client replayed
the already-received answer with a 55 ms word timer. The visible shimmer looked
like streaming but did not track the provider stream.

Corrected boundary:

```text
Pi text_delta
  ├─ exact answer_delta -> controller NDJSON -> backend SSE -> live web answer
  └─ completed sentence -> say timeline -> throttled Lark/status rendering
```

- Exact delta whitespace is preserved for Markdown.
- Pre-tool prose is reset from the answer lane when a tool begins and remains
  available as sentence-sized narration in the work log.
- The registry stores only the latest accumulated answer snapshot for a reader
  who reconnects; the live connection receives linear raw deltas, not repeated
  full-answer snapshots.
- The UI shimmer now applies only to words that actually arrived on the wire.
  The terminal event settles the answer immediately and never retypes it.
- Lark explicitly ignores the token lane and retains its bounded card-edit
  behavior.

Proof: 108 focused Pi/controller tests, 36 backend streaming/registry tests,
backend typecheck, 165 web unit tests, and the production web build pass. The
local backend hot-reloaded, the controller was restarted, and both health
checks report ready with zero active runs.
