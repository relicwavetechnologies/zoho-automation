# Codex V2 parallel runtime — superseded design reference

> Status: **SUPERSEDED AS AN IMPLEMENTATION DIRECTION — retained as a design
> benchmark; Codex V2 is deferred as of 2026-08-13**
>
> Last updated: **2026-08-13**
>
> Current goal: **Apply the strongest Codex V2 design requirements to Pi and
> prove whether Pi can deliver them before funding another harness.**
>
> Current execution plan:
> [`pi-first-class-harness-quality-audit.md`](pi-first-class-harness-quality-audit.md)
>
> Related production plan:
> [`cloud-pi-runtime-optimization-consistency-and-proof.md`](cloud-pi-runtime-optimization-consistency-and-proof.md)
>
> Architecture research report:
> [`../research-divo-cloud-agent-harness-2026-08-12.html`](../research-divo-cloud-agent-harness-2026-08-12.html)

## 0. Working protocol for this living plan

This file preserves the Pi-versus-Codex V2 discussion and the requirements it
surfaced. It is no longer the active implementation plan.

- Add every settled architecture decision to §3 with its reasoning.
- Add significant new discussion and evidence chronologically to §16.
- Keep open questions explicit in §14. Do not silently turn them into decisions.
- When a decision changes, mark the old decision superseded and link to the new
  one; never rewrite history to make the decision look obvious in retrospect.
- Treat the Codex design as a benchmark for Pi: first-class tools, native
  skills, provider-neutral models, backend-owned authority, predictable code,
  and hard performance/proof gates.
- Do not add a Pi/Codex selector, second controller, second container image, or
  speculative adapter while Codex V2 remains deferred.
- User-facing copy says **Divo**, regardless of which harness executes the run.

## 1. Executive direction — superseded

The earlier direction was to proceed with a parallel Codex V2 implementation.
Decision 3.19 supersedes that direction. No Codex implementation is currently
planned.

The intended result is not “replace Pi and hope Codex is better.” The intended
result is a harness-switchable Divo runtime:

```text
                       ┌─ Pi adapter ───── Pi controller ───── Pi container
Lark/Web → Divo backend ┤
                       └─ Codex adapter ── Codex controller ── Codex container

Both runtimes → Divo capability gateway → RBAC/HITL/credentials/providers
Both runtimes → Divo model proxy → DeepSeek
```

Pi remains the default until Codex wins a controlled benchmark and satisfies
security, recovery, session, file, approval, and observability parity.

The Codex implementation should deliberately feel native from the agent's
perspective:

- Divo tool definitions live in the Codex Rust source tree.
- They implement Codex's real `ToolExecutor`/`ToolRegistry` conventions.
- Divo skills are installed as native Codex skills.
- Only the current user's allowed tools and skills are model-visible.
- Tool calls use Codex-native lifecycle, structured results, cancellation,
  deferred exposure, and telemetry.
- MCP is not required for Divo business tools.

At the same time, Codex must not become a second enterprise backend. Divo's
backend continues to own identity, authorization, OAuth, SaaS credentials,
approvals, provider execution policy, usage, and audit.

## 2. The central distinction: native tool versus authority

“The whole tool lives inside Codex” has two possible meanings. This plan adopts
the first and rejects the second.

### 2.1 Adopted meaning — complete agent-facing Codex tool

The Codex source owns the tool's:

- Native name and namespace.
- Model-facing description.
- Input and output schema representation.
- Read-only/destructive/parallel/exposure annotations.
- Tool-search and deferred-loading behavior.
- Tool-specific argument/result/error ergonomics.
- Native Rust handler and lifecycle integration.
- Link to the exact Divo skill procedures that use it.

The Rust handler crosses one constrained Divo capability gateway for governed
execution.

### 2.2 Rejected meaning — duplicate enterprise backend inside the container

The Codex container must not own:

- Zoho, Google, Lark, Meta, Semrush, or other long-lived credentials.
- OAuth refresh-token storage or provider connection selection authority.
- Member identity or company/department membership truth.
- RBAC, approval, rate-limit, billing, or audit authority.
- Direct access to backend admin routes.

Moving these into Codex would make Pi/Codex switching harder, duplicate
security-critical code, and turn a compromised agent container into a SaaS
credential breach.

The intended mental model is:

> **Codex owns how the agent understands and invokes the tool. The backend owns
> whether that invocation may happen and how the protected external operation
> is executed.**

## 3. Locked decisions

### 3.1 DECIDED — Codex V2 is parallel, not a Pi rewrite

Cloud-Pi continues operating and continues receiving its own performance and
correctness improvements. Codex V2 is built beside it behind the same
runtime-neutral backend boundary.

Reason: this supplies real rollback, permits user/company canaries, and makes
the decision evidence-based.

### 3.2 DECIDED — The switch selects an entire runtime container

Use separate versioned runtime images:

```text
divo-agent-pi:<version>
divo-agent-codex:<version>
```

Do not place both harnesses into one production image and toggle an internal
library. The backend/runtime selector chooses the adapter and controller that
launch the matching image.

Reason: separate images keep dependencies, security hardening, failures,
rollbacks, metrics, and image versions unambiguous.

### 3.3 DECIDED — Runtime assignment is sticky for a thread

Runtime selection may be configured at default, company, user, and thread
levels, but once a thread starts it remains assigned to one runtime.

Initial policy:

```text
global default → company override → user canary override → existing thread pin
```

Do not alternate Pi and Codex on consecutive turns in one active thread. Their
session formats and compaction semantics differ.

Reason: current private DM continuity is materially held in a durable Pi
session. A transparent mid-thread switch requires a canonical backend
transcript/checkpoint model that does not yet exist.

### 3.4 DECIDED — Divo business tools do not require MCP

Divo tools are native Codex Rust handlers registered through Codex's own tool
registry. MCP remains available for unrelated integrations, but it is not the
Divo business-tool transport.

Reason: current Codex source already supports separate native handler/spec
files, `ToolExecutor`, `CoreToolRuntime`, `ToolRegistry`, exposure policy, and
dynamic/native tool routing.

### 3.5 DECIDED — Follow Codex's existing handler architecture

The initial Divo implementation belongs under the existing core tool tree, not
in a speculative standalone crate:

```text
codex-rs/core/src/tools/handlers/divo/
├── mod.rs
├── gateway_client.rs
├── capability_catalog.rs
├── result_adapter.rs
├── zoho/
├── semrush/
├── google_drive/
├── lark/
└── tests/
```

Create a separate `codex-rs/divo-tools` crate later only if the implementation
becomes large enough that this improves, rather than fights, the upstream
architecture.

### 3.6 DECIDED — Native catalogue, shared governed executor

Individual business capabilities should have first-class model-visible
identities such as:

```text
divo.zoho_search_leads
divo.zoho_create_lead
divo.semrush_backlinks_comparison
```

Do not create hundreds of nearly identical HTTP executors. Most tools may share
one native Rust runtime that carries an exact `tool_id`, exact schema, exposure
metadata, and a Divo gateway client. Create a special handler file only when a
tool has materially distinct local lifecycle, validation, streaming, or result
behavior.

### 3.7 DECIDED — Compiled availability is not model visibility

The Codex binary may contain every Divo tool definition, but the backend sends
an authorized tool-ID/skill grant for the current lease. Codex registers only
that permitted subset into the current thread.

Unauthorized tools must not be included in the model request or tool search.
Every call that is registered is still reauthorized by the backend because a
long-lived thread can outlive permission, role, department, or connection
changes.

### 3.8 DECIDED — One canonical contract source

Do not hand-maintain incompatible input schemas in both Rust and TypeScript.

Preferred implementation:

1. Backend contracts remain canonical.
2. A deterministic build step exports a versioned language-neutral tool
   manifest/JSON Schema artifact.
3. Codex compiles or embeds the generated definitions and adds handwritten
   native ergonomics only where useful.
4. CI fails when the backend contract digest and embedded Codex catalogue drift.
5. Runtime authorization grants reference exact versioned tool IDs.

This preserves the user's desired “tools are part of the Codex codebase” while
avoiding a second schema authority.

### 3.9 DECIDED — Skills are native and packaged, policy remains backend-side

Divo skills should be packaged in the Codex image using Codex's normal skill
folder structure. Only the granted skill slugs are exposed for a thread.

Skills guide procedure and capability choice. They never replace backend
authorization, validation, approval, or credentials.

Skill trees need deterministic version/digest ordering so they do not
unnecessarily break DeepSeek prompt-prefix caching.

### 3.10 DECIDED — DeepSeek remains behind Divo-owned access and usage control

Codex V2 uses a Responses-compatible path translated to DeepSeek Chat
Completions, but the DeepSeek credential and authoritative usage logging remain
backend-owned.

The adapter must support:

- Full history reconstruction when Codex uses `previous_response_id`.
- DeepSeek reasoning/tool-call message replay.
- Streaming tool and text events.
- Stable prefix serialization.
- `stream_options.include_usage=true` where supported.
- Cache counter normalization from `prompt_cache_hit_tokens` and
  `prompt_cache_miss_tokens` into Responses usage details.
- Retention of raw provider usage for billing/audit truth.

The bridge does not prevent DeepSeek caching. DeepSeek performs cache lookup on
the actual prefix it receives. A bridge can nevertheless reduce cache hits by
reordering tools or injecting volatile data into the stable prefix.

### 3.11 DECIDED — Do not hide one runtime's failure with the other

A Codex-assigned run that fails must surface a Codex runtime failure. It must
not silently retry through Pi, and a Pi-assigned run must not silently fall
back to Codex.

Reason: silent fallback destroys benchmarking, trace truth, session
predictability, and the ability to identify production defects. Runtime
reassignment is an explicit operator/user action at a safe session boundary.

### 3.12 DECIDED — Formalize a backend credential vault and broker; never vend SaaS bearer tokens to Codex

The Codex-native tool calls Divo with the runtime lease, exact tool/capability
ID, arguments, and run/action correlation. The backend then:

1. Revalidates the lease, member, company, department, grant, and connection.
2. Resolves the eligible connection.
3. Decrypts and refreshes the provider credential in backend memory.
4. Executes the provider operation or delegates to an existing backend-owned
   provider adapter.
5. Returns a structured, bounded result plus audit/effect metadata.

Name the existing responsibilities explicitly:

```text
ConnectionVault
  → encrypted access/refresh/client credentials and revocation state

CredentialBroker / ProviderExecutionBroker
  → connection resolution, refresh, provider call, rate limit, audit

CapabilityGateway
  → identity, RBAC, schema, HITL, idempotency, result contract
```

Much of the vault already exists in `IntegrationConnectionRepository`, shared
token encryption, provider connection services, and refresh services such as
`ZohoTokenService`. Foundation work should put a clean broker interface in
front of these pieces rather than rebuild OAuth storage.

Codex must not receive a reusable Zoho/Google/Lark access token or refresh
token. If a future provider transport genuinely has to originate from the
runtime, it may receive only a one-time, audience-bound Divo proxy ticket that
the backend accepts for one exact run/action. That ticket is not a provider
bearer token and still cannot bypass backend policy.

### 3.13 DECIDED — The model gateway is provider-neutral; DeepSeek translation is one adapter

Divo tools, sessions, and controller events must not depend on DeepSeek's wire
format. Introduce a per-model transport/capability profile covering at least:

- Native protocol: Responses or Chat Completions.
- Reasoning replay and continuation semantics.
- Tool-call and strict-schema support.
- Parallel tool support.
- Vision/input-media support.
- Context window, maximum output, and compaction policy.
- Provider cache usage fields and normalized usage mapping.

`gpt-5.6-luna` already uses the native OpenAI Responses route in Cloud-Pi.
DeepSeek models already use Chat Completions. Codex therefore needs:

```text
Codex Responses client
  ├── OpenAI/Luna adapter → native /v1/responses, no lossy Chat translation
  └── DeepSeek adapter    → stable Responses↔Chat translation
```

The current backend proxy chooses the upstream endpoint from the incoming
route, so a Codex `/responses` request cannot simply be forwarded unchanged to
DeepSeek. The DeepSeek adapter must translate before that provider call while
preserving backend key, budget, usage, and audit authority.

Every promoted Divo tool workflow must run against at least one DeepSeek model
and one native Responses model. Unsupported model features are capability
gates, not prompt guesses.

### 3.14 DECIDED — Divo tools must be first-class Codex tools, not privileged side channels

A Divo handler must enter the same `ToolRegistry` and execution lifecycle as a
Codex built-in. It must participate in the same:

- Tool specification and strict argument validation.
- Direct, deferred, code-mode, or hidden exposure rules.
- Cancellation and timeout propagation.
- Parallel/sequential execution classification.
- Tool hooks, telemetry, output schemas, and error rendering.
- Name-collision checks and deterministic ordering.

“Same power” means same runtime contract and lifecycle. It does not mean always
visible or exempt from the sandbox. A Divo tool may be more tightly governed
than a filesystem tool while remaining equally native to the harness.

### 3.15 DECIDED — Native Codex planning is mechanics; Divo still owns the user-visible plan contract

Codex's built-in planning, goals, or todo machinery may replace the custom Pi
implementation only after its events are mapped into Divo's neutral timeline.
Cloud-Pi currently emits bounded checklist state that Lark and Web render as a
declared plan. A private Codex plan that never reaches this event stream is not
feature parity.

DeepSeek must also be tested for reliable invocation and maintenance of the
native planning tool. The existence of a Codex tool does not prove a
non-OpenAI model has learned to use it well.

### 3.16 DECIDED — Runtime state has three scopes, not one workspace

Codex must preserve the distinction Cloud-Pi already enforces:

1. **Run scratch:** temporary files and protected raw envelopes for one turn;
   removed and never treated as resumable state.
2. **Private thread state:** durable conversation/session plus explicitly
   checkpointed workflows for one member/thread.
3. **Shared/run-scoped state:** disposable session and volume with no private
   memory, history, or workspace mount.

Files existing from an interrupted run never grant permission to resume work.
A later turn may resume only from an explicit current user request and a valid
workflow manifest/checkpoint.

### 3.17 DECIDED — Exact effects and approvals resume from backend receipts, not another model turn

An approval, personal-memory update, knowledge review, scheduled action, or
other externally visible effect needs a backend-owned receipt bound to company,
user, chat/thread, run, action, and arguments.

After approval, Divo executes the exact stored operation after rechecking
identity and permission. It must not ask Codex to re-plan the action, because a
second model turn could select a different tool or mutate approved arguments.
Ambiguous provider outcomes and failed terminal checkpoints are represented as
“do not retry until inspected,” not silently retried.

### 3.18 DECIDED — Hide unauthorized tool schemas but preserve denial-versus-absence truth

The Codex model request must not contain an unauthorized tool name, schema, or
callable definition. This intentionally differs from Cloud-Pi's current denied
tool stubs.

To prevent Codex from confusing “Divo does not support Zoho” with “this member
cannot access Zoho,” the backend may supply a compact, non-callable
family-level capability status such as `supported_but_not_permitted` or
`connection_required`. It must not disclose forbidden arguments, object IDs,
accounts, or operation details. Backend invocation remains authoritative even
for tools visible under a previously issued grant.

### 3.19 DECIDED — Defer Codex V2 and make Pi earn the first-class design

This decision supersedes §§3.1–3.3 and the implementation phases in §10.

- Do not build a parallel Codex runtime now.
- Do not add runtime-selection switches or Pi/Codex abstraction layers.
- Keep Pi as Divo's only agent harness and apply the first-class native-tool,
  skill, model, authority, code-quality, and performance requirements to it.
- Preserve this document as the design benchmark and historical reasoning.
- Reconsider Codex only if a hardened Pi fails the objective gates in
  [`pi-first-class-harness-quality-audit.md`](pi-first-class-harness-quality-audit.md).

Reason: the inspected Pi extension API already gives Divo tools the same
`ToolDefinition` and `AgentTool` lifecycle as built-ins. A new harness would
duplicate mature isolation, continuity, approval, file-workflow, and recovery
machinery before Divo has removed the avoidable weaknesses in its Pi wiring.

## 4. Target runtime boundary

The current Lark layer already depends primarily on a narrow `run`-shaped port,
although it is named `LarkPiRuntimePort`. Generalize this boundary rather than
branching throughout channel code.

Conceptual target:

```text
AgentRuntimePort
  ├── run
  ├── preparePrivateSession
  ├── deletePrivateSession
  ├── stagePendingAttachments
  └── hasActiveSession

PiAgentRuntimeAdapter
  └── private Pi controller → Pi container

CodexAgentRuntimeAdapter
  └── private Codex controller → Codex container
```

The channel layer must continue to own status delivery, final delivery, Lark
cards, retryable delivery, inbound serialization, and user-facing Divo copy.

Both controllers should converge on one runtime-neutral run protocol:

- Signed runtime lease.
- User message and shared context.
- Model/provider selection.
- Session scope.
- Staged attachment descriptors.
- Abort/cancel propagation.
- NDJSON progress/tool/result/final events.
- Protected-data and artifact metadata.

The first Codex spike may use a parallel controller implementation. Do not
prematurely refactor the working Pi controller before the Codex protocol is
proven.

## 5. Real-world story: a Zoho request on Codex V2

Priya asks Divo in Lark:

> Find open Zoho deals above ₹10 lakh and summarize the risks.

1. The backend authenticates the Lark member exactly as it does today.
2. The runtime selector sees that Priya's current thread is assigned to
   `codex-v2`.
3. The Codex controller launches or resumes Priya's isolated Codex container.
4. The controller passes a short-lived signed lease and the authorized
   capability/skill grant.
5. Codex registers the compiled native `divo.zoho_search_deals` tool because
   that exact tool ID is allowed for this lease.
6. DeepSeek receives the native name, description, strict schema, relevant
   skill context, and no unrelated Divo tools.
7. DeepSeek selects `divo.zoho_search_deals`.
8. The Rust handler sends the exact tool ID, arguments, call identity, and lease
   to one constrained backend capability gateway.
9. The backend revalidates identity, company, department, role, permission,
   approval state, arguments, and connection selection.
10. The backend decrypts/refreshes the correct Zoho token server-side and calls
    Zoho.
11. Structured results return to the native Codex handler, then to DeepSeek,
    then through the normal Divo progress/final-delivery lifecycle.
12. Audit, token usage, provider usage, tool result, and approval evidence remain
    backend-correlated under the original run.

If Priya has no valid Zoho connection:

1. The backend returns a structured `connection_required` result.
2. Codex turns that into the normal runtime event/action rather than inventing
   credential instructions.
3. Divo sends Priya a backend-generated connection card/link.
4. OAuth completes against Divo; the refresh token never reaches Codex.
5. The original request is rerun or resumed according to the existing governed
   continuation policy.

## 6. Runtime selection and rollback policy

### 6.1 Selection precedence

Planned precedence:

```text
thread pin
  > explicit user canary assignment
  > explicit company assignment
  > global default (Pi until promotion)
```

The exact storage mechanism remains open. It may begin as environment/config
for a walking skeleton, but production canaries require an auditable backend
assignment rather than an untracked controller-local flag.

### 6.2 Safe switching

- New thread: choose the currently assigned runtime.
- Existing thread: use its pinned runtime.
- Explicit `/new` or migration action: may start a new thread on the newly
  assigned runtime.
- Emergency rollback: stop assigning new Codex threads and return new work to
  Pi. Existing Codex threads are either drained or explicitly restarted with a
  truthful continuity notice.

### 6.3 Future seamless migration

True mid-thread Pi ↔ Codex migration requires a runtime-neutral canonical
conversation/checkpoint store containing enough state to reconstruct:

- User and assistant messages.
- Tool calls and structured results.
- Approval and irreversible-action receipts.
- Artifact/file references.
- Active goals/plans/checkpoints.
- Compaction summaries and unresolved errors.

This is not required for the first canary. Thread stickiness is the V1 safety
boundary.

## 7. Native Codex tool authoring model

### 7.1 Common framework

Build one Divo-native framework inside the Codex tool system:

```text
DivoCapabilityCatalog
  → selects embedded definitions by backend grant
  → creates native ToolSpec instances
  → registers DivoToolHandler instances
  → applies direct/deferred/hidden exposure

DivoToolHandler
  → validates and normalizes the model call
  → emits native start/progress/end lifecycle
  → invokes DivoGatewayClient
  → converts structured result/error/action to Codex output
```

### 7.2 What deserves a separate provider/tool file

Use separate files when they improve model or runtime behavior, for example:

- A tool has a materially different schema or explanation.
- A mutation needs specialized approval/result handling.
- A tool streams large or incremental results.
- A tool produces a local artifact or protected-data receipt.
- A tool needs a purpose-built compact result projection.

Do not create a separate executor file merely because the backend has another
tool ID. Repetitive tools should be generated/declared and share the handler.

### 7.3 Tool ergonomics that may improve capability understanding

The expected improvement comes from the model-visible contract and exposure,
not from Rust as a language by itself:

- Narrow exact names instead of a generic operation envelope.
- Strict, compact schemas.
- Descriptions that distinguish neighboring tools.
- Native namespaces by provider/capability family.
- Progressive/deferred loading so irrelevant tools stay out of context.
- Deterministic tool order.
- Skills that reference exact tool names.
- Structured connection/permission/approval/partial-result errors.
- Compact result shapes instead of large string envelopes.

These must be measured against the optimized Pi surface rather than assumed.

## 8. DeepSeek bridge and prompt-cache requirements

Likely implementation references already inspected:

- `https://github.com/lidge-jun/opencodex` — strongest broad reference for
  Responses-to-Chat translation, tool/reasoning flow, and continuation state.
- `https://github.com/holo-q/deepseek-responses-proxy` — narrow alpha reference;
  the inspected usage adapter drops DeepSeek cache hit/miss counters.
- `https://github.com/liuzhengming/ccswitch-deepseek` — another focused bridge.

Do not deploy a community proxy unmodified as Divo's production billing and
session boundary.

### 8.1 Cache correctness rules

- Keep system instructions byte/token stable across turns.
- Embed or sort tool definitions deterministically.
- Freeze the visible tool set for a capability revision/thread; restart or
  deliberately revise when grants change.
- Put volatile run IDs, timestamps, trace IDs, and run directories near the
  per-turn tail rather than in the stable system prefix.
- Reconstruct full upstream Chat history when Codex references prior responses.
- Preserve DeepSeek reasoning/tool-call history exactly.
- Use a stable opaque per-user cache-isolation identifier, not a per-run ID.
- Assert nonzero cache hits in a repeated-prefix integration test.
- Preserve raw provider hit/miss counts even if Codex's normalized usage format
  changes.

### 8.2 Usage normalization

The adapter must normalize both provider shapes:

```text
DeepSeek: prompt_cache_hit_tokens
          prompt_cache_miss_tokens

OpenAI-compatible: prompt_tokens_details.cached_tokens

Codex Responses: input_tokens_details.cached_tokens
```

Provider-side cost savings can work even if the Codex UI shows zero cached
tokens. That telemetry mismatch is unacceptable for production and must be
covered by tests.

## 9. Work estimate

Estimates assume one engineer familiar with Divo, reuse of the existing
backend gateway/provider/auth implementation, and no global cutover during the
build.

The first estimate undercounted the non-tool runtime responsibilities that the
Pi audit exposed. Native Rust tool wiring is still a modest slice. A trustworthy
whole-container switch also needs state, workflow, protected-data, effect,
progress, admission, and recovery parity.

| Milestone | Cumulative effort | Outcome |
|---|---:|---|
| Runtime contract and parity ledger | 3–5 working days | Neutral port/protocol, pinned Codex fork, explicit retained/deferred Pi responsibilities |
| Foundation vertical slice | 2–3 engineer-weeks | Credential broker boundary, provider-neutral model gateway, Codex image/controller, DeepSeek + native Responses no-tool proof, one same-power Divo read tool |
| Useful internal V2 | 6–9 engineer-weeks | Generated catalogue, skills, common tools, sessions, progress, sandbox, workflows, cache/usage truth |
| Production canary parity | 10–16 engineer-weeks | Attachments/media, OAuth/HITL continuation, effect receipts, protected data, memory/history, scheduling, subagents, recovery, security and rollback proof |

With two engineers on genuinely independent backend/runtime tracks, a
production canary is more realistically six to ten calendar weeks. Parallelism
will not halve controller/session integration or the final failure matrix.

A narrower internal demonstration remains plausible in roughly two to three
weeks. It must be labelled a foundation proof, not a production replacement.

This estimate grows materially if provider clients and credentials are moved
into Codex. A duplicated Zoho/Google/Lark authentication and execution stack is
closer to a multi-month rewrite and is not part of this plan.

Expected ongoing maintenance after canary:

- Pin Codex releases rather than tracking `main` continuously.
- Rebase intentionally after reviewing upstream tool/provider/session changes.
- Keep the Divo patch concentrated in the provider bridge, Divo handlers,
  capability loader, and controller integration.
- Run a fixed parity suite before every Codex version bump.

## 10. Implementation phases

### Phase 0 — freeze the switchable contract and Pi parity ledger

- [ ] Introduce/rename a runtime-neutral `AgentRuntimePort` without changing Pi
      behavior.
- [ ] Record the minimum run, session, attachment, cancellation, progress,
      protected-data, and final-result contract.
- [ ] Record every Pi-owned responsibility in §17 as retained, replaced by a
      Codex-native equivalent, deliberately deferred, or not applicable.
- [ ] Define runtime assignment and thread pin semantics.
- [ ] Add runtime identity/version to every run trace.
- [ ] Define a versioned Codex runtime manifest: upstream commit, Divo patch
      digest, model profiles, built-ins, Divo tool catalogue digest, and skill
      digest.
- [ ] Keep the Pi adapter as the only enabled production implementation.

Exit gate: existing Pi tests and one real Pi run are unchanged except for
runtime-neutral naming and explicit runtime/version telemetry.

Rollback: select the Pi adapter directly and revert only the neutral-selection
composition layer.

### Phase 1 — Foundation run: vault/broker, model transports, and a native Codex spine

#### 1A. Backend authority foundation

- [ ] Extract a clean `ConnectionVault`/`CredentialBroker` interface over the
      existing encrypted connection repositories and provider refresh clients.
- [ ] Define a runtime-neutral signed lease/grant containing runtime kind,
      audience, channel, company/user/department/thread/run identity, expiry,
      tool catalogue revision, and skill revision.
- [ ] Keep raw provider credentials and provider master keys outside the image,
      bootstrap file, process environment, prompts, logs, and tool results.
- [ ] Define one-time Divo proxy tickets only if a runtime-originated provider
      transport proves unavoidable.

#### 1B. Provider-neutral model foundation

- [ ] Introduce `ModelTransportProfile` and capability tests.
- [ ] Route OpenAI/Luna through native Responses without DeepSeek translation.
- [ ] Implement/own Responses↔Chat translation only for DeepSeek.
- [ ] Preserve reasoning/tool history, stable prefixes, streaming, cancellation,
      raw usage, and normalized cache counters.
- [ ] Prove one no-tool turn on DeepSeek and one on Luna/OpenAI.

#### 1C. Codex runtime foundation

- [ ] Fork and pin a specific `openai/codex` commit/release.
- [ ] Build a minimal hardened Divo Codex image and private controller.
- [ ] Disable unneeded built-ins, ambient provider keys, plugin paths, and
      unrestricted network paths.
- [ ] Add `handlers/divo` through Codex's real tool registry/runtime contracts.
- [ ] Generate/embed one exact read-only backend contract.
- [ ] Register it only for an authorized lease and reauthorize its invocation.
- [ ] Emit runtime-neutral starting/thinking/tool/plan/final events.
- [ ] Map one native Codex planning/todo event into the existing Divo timeline.

Exit gate: DeepSeek and a native Responses model both complete isolated turns;
DeepSeek calls one first-class Divo Codex read tool; an unauthorized lease does
not receive its schema; a revoked grant is denied at execution; no provider
credential reaches the container; cancellation and usage/cache evidence are
traceable.

Rollback: Codex remains unassigned; Pi production is untouched.

### Phase 2 — generated native catalogue and native skills

- [ ] Generate the complete language-neutral contract manifest from backend
      schemas and fail CI on digest drift.
- [ ] Build the shared native Divo executor/result adapter plus specialized
      handlers only where lifecycle differs.
- [ ] Implement deterministic direct/deferred/hidden exposure and tool search.
- [ ] Hide unauthorized schemas while injecting bounded denial-versus-absence
      capability status.
- [ ] Package granted native Divo skills with deterministic versions/digests.
- [ ] Add connection discovery, preflight, OCR/image fallback, memory, and other
      non-business platform tools that the removed Pi mega-surface had split
      into first-class tools.
- [ ] Prove all intended registered tools are active, collision-free, and have
      valid output schemas.

Exit gate: a user receives exactly their authorized native tool/skill surface,
contract revisions are deterministic, and no TypeScript/Rust schema drift can
ship silently.

### Phase 3 — governed effects: connection, HITL, idempotency, and continuation

- [ ] Add a real Zoho/Google connection-backed read while the backend resolves
      and refreshes credentials.
- [ ] Add a mutation requiring backend HITL.
- [ ] Resume the exact stored approved action without another model turn.
- [ ] Add missing/expired connection OAuth continuation using a retained run
      origin and backend-generated action/card.
- [ ] Add run-effect receipts for memory/review/artifact/conversion claims.
- [ ] Preserve exact retry, ambiguous-outcome, idempotency, and terminal
      checkpoint semantics.
- [ ] Add scheduled/headless run identity and post-approval delivery behavior.

Exit gate: read, mutation, connection-required, approval, asynchronous resume,
and scheduled execution remain correct across restart or delayed user action.

### Phase 4 — runtime operating-system parity

- [ ] Implement private durable thread sessions and disposable shared/run
      sessions with no private volume, memory, or history access.
- [ ] Implement per-turn scratch and manifest-bound durable workflow directories,
      TTL/quota cleanup, and explicit-resume-only interruption behavior.
- [ ] Port or replace `divo-local` with a credential-free programmatic workflow
      route that keeps bulk rows outside model context.
- [ ] Match attachment staging, atomic partial-file handling, pending attachment
      TTL/consumption, media/OCR, and file dependency baseline.
- [ ] Match protected-data detection, generic progress, final-text suppression,
      provenance validation, warm-process discard, and verified session deletion.
- [ ] Define Codex compaction/context budgets and test long-thread continuity.
- [ ] Match warm reuse invalidation on profile/thread/backend/department/model/
      skill/catalog/image changes.
- [ ] Match container sandbox, read-only root, volume ownership, network policy,
      resource limits, bootstrap erasure, and owned-resource reconciliation.

Exit gate: filesystem, session, large-data, protected-data, interruption, and
container lifecycle tests match or intentionally improve on Pi.

### Phase 5 — agent behavior and channel parity

- [ ] Adapt Codex planning/todos to Divo's declared-plan timeline contract.
- [ ] Constrain native Codex subagents to Divo child grants, model grants,
      read-only/mutation rules, concurrency/depth, cancellation, progress, and
      usage aggregation.
- [ ] Rebuild chat-history search over a runtime-neutral transcript source or
      explicitly limit it to Codex threads until canonical history exists.
- [ ] Match personal memory, shared knowledge review, implicit-learning guards,
      department persona, skill routing, result truthfulness, and final-link/
      verified-count policies.
- [ ] Match Web reconnect/stop/failure recording and Lark status/final behavior.
- [ ] Prove capacity, per-thread/user exclusion, body limits, timeout, heartbeat,
      malformed stream, controller restart, and controller-unavailable errors.
- [ ] Compare tool choice, model turns, plan quality, and user clarification
      behavior on DeepSeek and Luna.

Exit gate: the channel layer needs no Codex-specific behavior beyond selecting
the runtime adapter, and built-in Codex features satisfy Divo's security and
timeline semantics rather than merely existing.

### Phase 6 — controlled canary switch

- [ ] Add auditable company/user/thread assignments.
- [ ] Default remains Pi.
- [ ] Assign internal test users to Codex only for new threads.
- [ ] Display runtime/version in internal traces, never in user-facing Divo copy.
- [ ] Build an operator kill switch that stops new Codex assignments.
- [ ] Define drain/restart policy for active Codex threads.
- [ ] Run the same fixed workload on Pi and Codex.

Exit gate: canary traffic is observable, reversible, and cannot silently cross
runtimes.

### Phase 7 — evidence-based promotion decision

- [ ] Compare task success and tool-selection correctness.
- [ ] Compare first-business-tool latency, total latency, model turns, cached and
      uncached input, output, and provider cost.
- [ ] Compare invalid-argument retries and approval/OAuth recovery.
- [ ] Compare cold start, warm resume, memory/session continuity, and failure
      recovery.
- [ ] Compare operator maintenance and upstream update burden.
- [ ] Decide: keep Pi default, promote Codex default, or retain a permanent
      workload-based split.

Exit gate: promotion requires the gates in §12; architecture enthusiasm is not
a promotion metric.

## 11. Representative proof suite

The canary must cover more than one happy read:

- [ ] No-tool exact reply on DeepSeek and on a native Responses model.
- [ ] Web/search-only answer with no business tool.
- [ ] Semrush multi-target comparison with exactly one provider call.
- [ ] Zoho read with a valid connection.
- [ ] Zoho mutation requiring approval.
- [ ] Missing Zoho/Google connection and successful OAuth continuation.
- [ ] Google Drive file search/download/create workflow.
- [ ] Lark tool that returns an interactive action/card.
- [ ] Large provider result kept in the protected local data plane or written
      to a governed destination rather than copied into model context; use a
      Divo artifact only if the separate cloud-artifact scope has shipped.
- [ ] Pending file/image attachment from Lark.
- [ ] Attachment-only DM retained for the next ask, then consumed exactly once.
- [ ] Multi-turn private DM continuity.
- [ ] Shared/group context without private session leakage.
- [ ] Group run uses a disposable volume and cannot call memory/chat-history
      tools even if the model attempts their names.
- [ ] Cancellation during model streaming and during a provider call.
- [ ] Vague follow-up after interruption asks whether to resume; it does not
      silently restart the stopped workflow.
- [ ] Permission revoked between thread start and tool invocation.
- [ ] Tool compiled into Codex but absent from the unauthorized model request.
- [ ] Supported-but-denied capability reported truthfully without exposing its
      schema or account details.
- [ ] Protected-data run requiring session deletion.
- [ ] Failed or malformed protected run still deletes private session state and
      never retains protected progress/tool arguments.
- [ ] Large multi-page source transformed through a persistent programmatic
      workflow without bulk rows entering model context.
- [ ] Successful mutation IDs checkpointed before the next mutation; restart
      does not duplicate completed creates/sends.
- [ ] Approval executes the exact stored arguments after permission is
      rechecked and without re-planning through the model.
- [ ] OAuth continuation survives the original inbound event disappearing.
- [ ] Scheduled/headless run delivers to the creator and handles later approval.
- [ ] Plan/todo and subagent progress render identically enough on Web and Lark.
- [ ] Child agents cannot mutate, approve, message, schedule, or escape their
      Divo capability/model grant.
- [ ] Warm process reused only when runtime binding and image/catalog/skill
      digests still match.
- [ ] Repeated-prefix turn proving DeepSeek cache hits and correct usage mapping.
- [ ] Same native Divo tool works through Luna/OpenAI Responses with no
      DeepSeek-specific contract assumption.
- [ ] Controller crash/restart and truthful failure/recovery.
- [ ] Duplicate inbound delivery, delayed final delivery, lost approval-card
      acknowledgement, provider timeout, quota, and ambiguous provider result.
- [ ] 1/10/100/multi-page/capped/empty datasets with truthful coverage.

## 12. Promotion gates

Codex V2 may receive production canary traffic only when all security and
correctness gates pass. It may become the default only when performance and
operational gates also pass.

### 12.1 Security gate

- No unauthorized tool is model-visible or callable.
- A compiled-but-ungranted tool cannot be discovered through tool search,
  deferred loading, code mode, plugins, or subagents.
- Backend reauthorizes every invocation.
- No SaaS or provider master credential exists inside the runtime image or
  thread files.
- OAuth tokens remain encrypted and backend-side.
- Shell/file tools cannot read bootstrap credentials or inherit member/provider
  tokens, and unrestricted `curl` cannot bypass the governed route.
- Approval and destructive-operation semantics match Pi/backend policy.
- Revocation takes effect without trusting a stale Codex registry.
- Controller remains private and runtime leases are scoped, short-lived, and
  audience-bound.
- Shared runs mount no private workspace/session/history and protected runs
  prove cleanup before returning provenance.

### 12.2 Correctness gate

- Same or better success on the fixed representative suite.
- No silent fallback between Pi and Codex.
- Structured tool results, actions, files, approvals, and errors survive the
  Codex event path.
- Thread/runtime ownership and interruption are deterministic.
- OAuth continuation and protected-data cleanup are proven.
- External side-effect claims are backed by effect receipts or verified
  provider results, and asynchronous approvals never re-plan arguments.
- Large data work remains file/programmatic, resumable, and idempotent without
  placing provider rows in model context.

### 12.3 Performance/cost gate

Initial challenger target:

- At least 25% lower p50 user-to-first-business-tool latency on representative
  workloads, with no material p95 regression.
- Lower or equal model-turn count for direct operations.
- Materially lower uncached first-turn context than the measured 58,027-token
  Pi Semrush baseline, or a demonstrated task-success gain that justifies the
  cost.
- DeepSeek cache-hit billing and normalized cached-token telemetry agree.
- Cold start and warm resume fit the declared channel SLA.
- Measurements separate system/tool/skill/context tokens, bridge overhead,
  subagent usage, compaction, and provider/tool latency.

### 12.4 Operational gate

- One-command/versioned rollback to Pi for new threads.
- Runtime/version visible in traces and dashboards.
- Codex fork update procedure and owner are documented.
- Controller/image health, capacity, and failure modes are monitored.
- A Codex upgrade cannot ship without the parity suite.
- The runtime manifest pins upstream commit, Divo patch, image digest, native
  tool catalogue, skill revision, and supported model profiles.
- Owned-container/network/volume reconciliation cannot touch unrelated Docker
  resources.

## 13. Explicit non-goals

- Do not delete or stop optimizing Pi during Codex development.
- Do not route Lark work through the Vercel AI orchestration engine.
- Do not use MCP as the Divo business-tool execution layer.
- Do not put all Pi and Codex dependencies into one runtime image.
- Do not move RBAC, OAuth ownership, credentials, approvals, or audit into
  Codex.
- Do not expose backend admin APIs to either harness.
- Do not hand-copy every backend schema into Rust without generation/drift
  proof.
- Do not claim Rust alone improves model capability understanding.
- Do not switch active threads back and forth before neutral transcript/state
  reconstruction exists.
- Do not promote Codex because a single demo feels better.

## 14. Open questions

1. **First proof tool:** Semrush is deterministic and read-only; Zoho exercises
   the connection path. Use Semrush first, then Zoho as the second proof unless
   implementation evidence suggests otherwise.
2. **Contract embedding:** generate Rust source, embed a signed JSON manifest,
   or load exact schemas from the backend at boot? The current preference is a
   generated/embedded catalogue plus runtime tool-ID grants.
3. **Bridge placement:** should Responses-to-DeepSeek translation live inside
   the Codex fork, in a Divo sidecar, or inside the backend model proxy? It must
   preserve backend key/usage authority regardless of placement.
4. **Controller shape:** parallel Codex controller first versus extracting a
   shared neutral controller core first. Current recommendation: parallel first,
   unify only after protocol parity is concrete.
5. **Thread assignment storage:** environment flag for spike; database/company/
   user/thread assignment for canary.
6. **Canonical history:** what minimum transcript/checkpoint must the backend
   persist before transparent mid-thread runtime migration is worth building?
7. **Built-in Codex tools:** which shell, file, web, collaboration, and plugin
   surfaces should be disabled for Divo's least-privilege production image?
8. **Skill distribution:** fully image-pinned skills versus backend-supplied
   skill bodies staged into native roots. The decision should consider update
   speed, authorization visibility, and prompt-cache stability.
9. **Fork cadence:** which upstream Codex release/commit becomes the first pin,
   and how frequently will Divo absorb upstream changes?
10. **Permanent split:** after evidence, some workloads may remain better on Pi
    while others use Codex. The architecture must not assume only one harness
    can survive long-term.
11. **Cloud scope versus Jan/Desktop:** this plan currently targets the cloud
    runtime used by Lark and Web. Decide separately whether Jan remains bundled
    Pi during the canary or gains a Codex runtime selector.
12. **Programmatic workflow route:** port the credential-free `divo-local`
    socket/CLI pattern, expose an equivalent Codex-native code-mode client, or
    use a constrained local SDK. It must preserve bulk-data isolation,
    cancellation, exact retry, and run correlation.
13. **Denial awareness:** define the minimum family-level capability status the
    model needs to distinguish unsupported, unpermitted, unconnected, and
    temporarily unavailable without exposing forbidden tool schemas.
14. **Canonical chat history:** Codex cannot parse Pi's JSONL sessions as its
    native history. Decide whether backend conversation history becomes the
    canonical search source before Codex canary or whether Codex search is
    limited to Codex-created threads.
15. **Artifact scope:** Cloud-Pi's `divo_artifact` extension is deliberately
    disabled and Lark artifact delivery is incomplete. Decide whether Codex
    matches current cloud behavior or ships the separate governed artifact
    product work; do not call a local path parity.
16. **Local shell policy:** Cloud-Pi auto-approves its isolated workspace
    Bash/edit/write protocol in headless cloud runs while backend mutations
    remain governed. Decide the exact Codex sandbox and approval policy rather
    than inheriting Codex desktop defaults.
17. **Warm-process economics:** determine the correct Codex idle timeout,
    memory/RSS budget, maximum warm profiles, and restart keys from measured
    startup versus resident cost.
18. **Built-in collaboration:** decide whether Codex native subagents are
    usable after Divo grant, filesystem, mutation, depth, and usage restrictions,
    or whether Divo needs a constrained wrapper around them.

## 15. Evidence inspected so far

### Local Divo evidence

- `advance-backend/src/infrastructure/channels/lark/lark.webhook.routes.ts` —
  current narrow `LarkPiRuntimePort` and channel delivery lifecycle.
- `advance-backend/src/application/runtime/lark-pi-runtime.service.ts` — signed
  lease, private/run session scopes, attachment staging, controller stream,
  knowledge recall, progress, finalization, and DM continuity assumptions.
- `advance-backend/src/composition.ts` — current direct composition of the Pi
  runtime service.
- `advance-backend/src/application/proxy/llm-proxy.service.ts` — DeepSeek
  provider usage and cache hit/miss accounting.
- `divo-pi/divo/extensions/divo-gateway/` — native Pi typed tools, skills,
  gateway execution, traces, results, and local broker.
- `divo-pi/divo/local-rpc-controller.mjs` — current isolated container and warm
  runtime lifecycle.
- `divo-pi/divo/runtime.mjs` and `container-entry.mjs` — private versus
  run-scoped sessions, prompt/model policy, bootstrap erasure, scratch and
  durable workflow directories, cleanup quotas, interruption facts, attachment
  cleanup, and provider-environment scrubbing.
- `divo-pi/divo/runtime-manifest.json` — pinned Pi upstream version, enabled
  extensions, trusted skills, model, and static tool allowlist.
- `divo-pi/divo/extensions/divo-todos`, `divo-subagents`, and
  `divo-chat-history` — user-visible plan contract, constrained child agents,
  and bounded private transcript search.
- `divo-pi/divo/extensions/divo-gateway/local-broker.ts` plus
  `advance-backend/src/application/skills/divo-local-python-system-skill.ts` —
  credential-free programmatic business calls, protected local result files,
  checkpoints, bounded retry, and large-data workflow rules.
- `advance-backend/src/application/runtime/pi-runtime-lease.ts` — current lease
  identity, audience, channel, run/thread/chat, department, and expiry claims.
- `advance-backend/src/application/runtime/run-effect-receipt.store.ts` —
  backend-owned proof for knowledge, memory, workbook, and other user-visible
  effects.
- `advance-backend/src/application/runtime/run-progress.ts` and
  `application/channels/run-timeline.reducer.ts` — runtime-neutral progress,
  declared plan, subagent rows, channel rendering, and protected-progress
  suppression.
- `advance-backend/src/application/runtime/web-run.service.ts` and
  `web-run-registry.ts` — browser streaming, reconnect, one-run-per-thread,
  cancellation, durable failure recording, and approval attachment.
- `advance-backend/src/application/approval/approval-resumer.service.ts` — exact
  approved-action replay with identity/RBAC recheck and no LLM re-planning.
- `advance-backend/src/infrastructure/persistence/integration-connection.repository.ts`
  and provider token services — encrypted backend connection storage,
  decryption/refresh, and existing vault responsibilities.
- `advance-backend/src/http/llm/llm-proxy.routes.ts`,
  `divo-pi/divo/extensions/divo-llm/index.ts`, and
  `divo-pi/divo/runtime-models.mjs` — existing Chat versus Responses split,
  backend provider-key authority, usage capture, and model/vision mapping.
- `advance-backend/docs/cloud-pi-testing/04-acceptance-matrix.md` and
  `07-local-runtime-harness-framework.md` — current lifecycle, workspace,
  provider, todos/subagents, persistence, media, capacity, and failure proof.
- `plans/cloud-pi-runtime-optimization-consistency-and-proof.md` — current Pi
  performance/correctness baseline and remaining work.
- `plans/pi-typed-tool-surface.md` — canonical backend schema → native Pi tool
  implementation and measurements.

### Codex and DeepSeek evidence

- OpenAI Codex app-server documentation:
  `https://developers.openai.com/codex/app-server`
- OpenAI Codex open-source components:
  `https://developers.openai.com/codex/open-source`
- OpenAI Codex repository: `https://github.com/openai/codex`
- Codex source inspected at commit
  `1f4ea798538d2c947ce215a65bc166db517a2df6`:
  `codex-rs/core/src/tools/handlers`, `registry.rs`, `router.rs`, and
  `spec_plan.rs`.
- DeepSeek context caching: `https://api-docs.deepseek.com/guides/kv_cache`
- DeepSeek pricing: `https://api-docs.deepseek.com/quick_start/pricing`
- DeepSeek cache isolation/rate-limit behavior:
  `https://api-docs.deepseek.com/quick_start/rate_limit`
- OpenCodex bridge reference: `https://github.com/lidge-jun/opencodex`
- DeepSeek Responses proxy reference:
  `https://github.com/holo-q/deepseek-responses-proxy`

## 16. Discussion and decision log

### 2026-08-13 — Pi-first consolidation supersedes the Codex revamp

- User withdrew the request for a parallel Codex runtime and explicitly chose
  to invest the same strict design principles in Pi.
- Codex's relevant advantage was not MCP or Rust by itself. It was the proposed
  discipline: native tool definitions, clear source ownership, one predictable
  path, provider-neutral model support, and hard proof gates. Pi can implement
  those disciplines through its native extension API.
- No Pi/Codex switch, alternate container, runtime adapter, or speculative
  compatibility layer should be added.
- Current Pi is already strong in native execution parity, backend-owned
  credentials/RBAC, isolation, DeepSeek/Luna routing, skills, todos, subagents,
  and file workflows.
- Current Pi is not yet a full-power implementation: business tools are mostly
  assembled through a generic runtime adapter; the model-visible catalogue is
  RBAC-filtered; cloud and desktop gateway trees have materially drifted; the
  Divo extension source is outside the normal workspace type-check/CI path;
  and the measured Semrush baseline remains prompt/model-turn dominated.
- Active remediation and acceptance gates now live in
  [`pi-first-class-harness-quality-audit.md`](pi-first-class-harness-quality-audit.md).

### 2026-08-12 — Initial harness architecture review

- The current Pi integration is not merely forcing an untyped mega-contract on
  the model. It already registers native typed Pi tools from backend JSON
  Schema and stages native skills.
- Measured evidence points first to prompt/context and extra model turns, then
  cold lifecycle work; it does not yet show TypeScript/Pi execution language as
  the primary bottleneck.
- Decision direction: keep Pi production, optimize it, and build a challenger
  behind a harness-neutral runtime boundary.

### 2026-08-13 — DeepSeek Responses bridge and caching

- Most likely remembered open-source bridge: `lidge-jun/opencodex`.
- DeepSeek caching survives a Responses-to-Chat bridge because DeepSeek caches
  the upstream token prefix it receives.
- Sending full conversation history is compatible with prefix caching; the
  bridge must reconstruct full history when Codex uses continuation IDs.
- Upstream cache billing and Codex cached-token telemetry are separate. The
  inspected OpenCodex adapter does not explicitly map DeepSeek's custom
  `prompt_cache_hit_tokens`; the narrow alpha proxy drops the cache split.
- Divo must patch/own usage normalization and preserve raw provider counters.
- Volatile run paths or metadata in the system prompt shorten the reusable
  prefix and should move toward the turn tail.

### 2026-08-13 — MCP correction

- Earlier research wording overstated MCP as required for Codex business tools.
- Codex supports native Rust tools and experimental app-server dynamic tools;
  MCP is a separate integration mechanism.
- User's intended design is native Divo tools inside the Codex source tree, so
  Divo business tools will not use MCP.

### 2026-08-13 — Codex native source layout verified

- Current Codex source separates built-in handler/spec implementations under
  `codex-rs/core/src/tools/handlers` and registers them through `ToolRegistry`
  and `spec_plan.rs`.
- Complex families already use subdirectories such as `unified_exec`,
  `multi_agents_v2`, and `code_mode`.
- Decision: begin under `handlers/divo`, following current Codex conventions;
  do not invent a separate crate before scale justifies it.
- Use a shared Divo native runtime for repetitive backend-governed tools, with
  specialized files only where behavior differs materially.

### 2026-08-13 — Parallel runtime and switchability

- User explicitly wants Codex V2 built beside Pi, with a runtime switch that
  chooses the whole container implementation.
- Decision: separate Pi and Codex images/controllers behind one neutral runtime
  port and shared gateway/model proxy.
- Runtime selection must be sticky per thread for the first version.
- Agent-facing tool behavior belongs natively in Codex; Zoho/Google/Lark OAuth,
  credentials, RBAC, approval, provider execution policy, usage, and audit stay
  backend-owned.
- Estimated walking proof: 7–12 working days. Estimated production canary
  parity: 8–12 engineer-weeks, or roughly 4–7 calendar weeks with two engineers
  working on independent tracks.

### 2026-08-13 — Foundation boundary: native tools, credential broker, and multiple models

- “Write the tool inside Codex” is now defined as a first-class Codex
  `ToolRegistry` handler with native schema, exposure, lifecycle, cancellation,
  telemetry, and result ergonomics.
- The backend does not vend Zoho/Google/Lark bearer or refresh tokens. Existing
  encrypted connection repositories and provider refresh clients become an
  explicit `ConnectionVault` plus `CredentialBroker/ProviderExecutionBroker`
  boundary.
- Codex authenticates to Divo with a short-lived runtime lease. If a runtime
  transport ever needs a delegated token, it is a one-action Divo proxy ticket,
  not a reusable SaaS credential.
- The DeepSeek bridge cannot become the model architecture. Luna already uses
  native Responses while DeepSeek uses Chat, so Divo needs provider-neutral
  transport profiles and model capability tests.
- Native Codex plans/todos are useful mechanics, but must be adapted to Divo's
  progress timeline and tested for reliable DeepSeek behavior.

### 2026-08-13 — Deep Pi parity audit

- The original canary estimate was under-scoped. Cloud-Pi is not just an agent
  plus typed tools; it also implements leases, audience isolation, admission,
  attachment staging, warm invalidation, scratch/durable workflow state,
  interruption facts, protected-data deletion, effect receipts, progress,
  exact approval replay, memory/history, subagent constraints, scheduling, and
  failure semantics.
- Current Pi already has individual typed outer business tools generated from
  backend JSON Schema; its old `divo_gateway` mega-tool is deleted. Codex's
  expected gain must therefore be measured as better exposure, model/tool
  ergonomics, built-in lifecycle, context size, and fewer turns—not assumed to
  come merely from replacing an untyped Pi contract.
- `divo-local` is a major parity item: it lets one persistent Python workflow
  page, transform, join, checkpoint, and verify connected data without putting
  bulk rows or credentials in model context. Native business tool buttons alone
  do not replace that capability.
- Cloud-Pi's denied tool stubs conflict with the desired Codex invisibility
  rule. Codex will hide unauthorized schemas but needs bounded non-callable
  denial-versus-absence status to remain truthful.
- Cloud-Pi's artifact extension is intentionally disabled in cloud, so Codex
  should not claim artifact parity merely by retaining a local file path.
- Estimate revised to 10–16 engineer-weeks for production canary parity, or
  roughly 6–10 calendar weeks with two independent tracks. A 2–3 week
  foundation demonstration is still realistic.

## 17. Pi parity ledger — responsibilities previously forgotten or underweighted

This ledger is the direct answer to “what did we forget?” It does not require
Codex to copy Pi line-for-line. It requires an explicit disposition before
production canary: **retain in backend/controller**, **replace with a native
Codex equivalent**, **deliberately defer**, or **not applicable**.

### 17.1 Foundation blockers

| Responsibility Pi already carries | Why it matters to Codex V2 | Intended owner |
|---|---|---|
| Signed identity lease with company/user/department/thread/run/chat/channel/audience/expiry | A native tool is unsafe if its container identity can drift or be replayed | Backend issues; controller and runtime validate |
| Encrypted connections, refresh, connection choice, provider key, rate limit, audit | Raw SaaS tokens in Codex would turn a runtime compromise into account compromise | Backend vault/broker |
| Chat versus Responses model routes and authoritative cache/usage recording | DeepSeek translation must not break Luna or future native Responses models | Backend model gateway plus provider adapter |
| First-class typed registration plus backend reauthorization | Native ergonomics must not create a second grant authority | Codex tool registry + backend gateway |
| Private controller, capacity slots, one active run per profile/thread, timeout and health | A good agent can still overload one VPS or race two turns into one session | Controller/admission layer |
| Credential/environment scrubbing and no direct-provider fallback | Shell, Python, plugins, or child agents must not inherit member/provider credentials | Image/runtime/controller |
| Read-only root, private volumes/networks, resource limits, object ownership labels | Harness-native tools do not replace OS isolation | Controller/container policy |
| Neutral progress/final protocol and abort propagation | Lark/Web must keep working without knowing Codex internals | Runtime adapter/controller |

### 17.2 State and continuity we had treated too lightly

| Pi behavior | Codex question that must be answered |
|---|---|
| Private thread session versus disposable shared run session | Where does Codex persist a DM, and how is a group prevented from mounting or recalling it? |
| Per-turn `DIVO_RUN_DIR` scratch | Where do temporary scripts and protected raw results live, and when are they erased? |
| Manifest-bound durable workflow directories | How does a multi-turn export resume without treating old files as user authorization? |
| Interruption fact and explicit-resume-only policy | What happens when the next message is “hello” after a stopped mutation/export? |
| 14-day workflow TTL and completed-directory quota | What prevents one user's volume from growing forever? |
| Abandoned run-session and pending-attachment sweeps | What survives a controller/container crash, and who safely reclaims it? |
| Compaction budget and recent/reserve token policy | How is long-thread continuity bounded and compared across DeepSeek/Luna? |
| Warm process binding to profile/thread/backend/department/model/skill digest | When must Codex reuse, reconfigure, restart, or discard a warm process? |
| Thread-sticky runtime assignment | How is Pi↔Codex continuity kept truthful before canonical state migration exists? |

### 17.3 Governed work beyond a normal tool call

| Existing Divo/Pi behavior | Forgotten Codex requirement |
|---|---|
| `divo-local` credential-free Python broker | Programmatic multi-page/join/transform/write workflows without model-context row dumps |
| Protected response files and compact path/count summaries | Large results need a secure local data plane, not giant tool-result messages |
| Checkpoint mutation IDs before the next write | Restart and model retry must not duplicate external side effects |
| One exact safe rate-budget retry; stop on permission/approval/invalid args | Retry semantics belong in a trusted layer, not free-form model reasoning |
| Read-back reconciliation and truthful partial coverage | A provider acknowledgement or process exit zero is not completion proof |
| Backend preflight and native nested provider contracts | Outer Rust schemas alone do not validate every Google/Airtable native input |
| Connection choice and OAuth continuation | The original chat/run origin must survive long enough to send a Connect action and resume |
| Async manager approval | Later approval executes exact stored args after reauthorization, never a new plan |
| Scheduled/headless runs | A schedule has synthetic session identity, creator delivery, expiry, and delayed approval rules |

### 17.4 Privacy, memory, and claims

| Pi/backend behavior | Codex parity requirement |
|---|---|
| Shared audience gets no personal memory or history tools | Tool visibility, prompt context, volume mount, and child grants all enforce the same rule |
| Personal memory, shared knowledge review, and implicit learning are separate | Native Codex memory must not merge scopes or silently promote a fact |
| Run-effect receipts | “Saved,” “review opened,” “conversion offered,” or similar claims need backend evidence |
| Chat-history search is bounded and path-contained over Pi JSONL | Codex needs a neutral source; it cannot assume Pi session files are its native transcript |
| Protected Shopify reads suppress detailed progress/final retention and delete session state | Codex must propagate protected metadata even on error/interruption and prove deletion |
| Final answer repeats canonical links and verified counts | Tool cards/progress are not guaranteed delivery; the terminal answer remains authoritative |
| Skills/persona/tool output are untrusted data for language and policy | Codex's default prompt does not replace Divo's prompt-injection and reporting discipline |

### 17.5 Built-ins that are not automatically parity

- **Plans/todos:** Codex may have stronger native mechanics, but Divo needs the
  same bounded user-visible declared-plan events and truthful completion state.
- **Subagents:** Codex collaboration must inherit model and capability grants,
  block child mutations/approvals/messages/scheduling, limit depth/concurrency,
  aggregate usage/progress, and cancel reliably.
- **Shell/files:** Codex sandbox approvals must match the cloud trust boundary;
  desktop interactive defaults are not automatically correct for headless Lark.
- **Web/search:** any direct Codex web path must either be explicitly approved
  as a non-company capability or use Divo's governed research tool; it cannot
  become a hidden bypass for connected/company work.
- **Tool search/code mode/plugins:** authorization hiding must apply to every
  discovery and invocation surface, not only the initial tool list.
- **Artifacts:** a local Codex file is not a delivered Divo artifact. Cloud
  storage, authorized URLs, channel delivery, sandboxed rendering, and receipts
  are separate product work.

### 17.6 Operations and proof

- Runtime/image/upstream/tool/skill/model digests must be present in traces.
- Startup must reconcile only Divo-owned containers, volumes, and networks.
- Body-size trimming must prefer dropping advisory recall/shared context over
  corrupting the user's exact request.
- Pending attachments are atomic, bounded, expire, and are consumed once only
  after a successful runtime response.
- Web can reconnect to an active run, stop it, and retain a durable failure turn.
- Error taxonomy must distinguish busy, capacity, invalid lease/model/session,
  missing connection, permission, approval pending/rejected, rate limit,
  timeout, cancellation, malformed/empty stream, protected cleanup, and
  ambiguous provider outcome.
- The same fixed harness must test no-tool, files, internet/dependencies,
  governed reads, todos/subagents, persistence, media, concurrency, 1/10/100/
  multi-page/capped/empty data, permissions, approvals, expiry, quota, retry,
  interruption, resume, and crash recovery.
- Performance evidence must attribute model turns and tokens by component. The
  current 58,027-token first-turn Semrush baseline was dominated by prompt/model
  work, not the single successful provider call.
