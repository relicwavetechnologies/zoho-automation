# Skill Intent Routing and Search

> Status: **router-only DB runtime implemented; intent safeguards and evaluation remain**
>
> Last updated: **2026-07-29**
>
> Scope: how Divo understands a request, selects one authorized router skill,
> narrows into specialist skills, and recovers when a tool is called before its
> required skill context is loaded.

## 0. Purpose and working protocol

This file is the focused source of truth for the skill-search and intent-routing
work.

- Locked decisions are recorded in §3.
- Unresolved product or infrastructure choices remain in §12.
- TODOs are checked only after the behavior is implemented and verified.
- The original user request remains authoritative and is retained for audit.
- Skills remain advisory execution recipes. Backend identity, RBAC, connection
  access, approval, validation, and auditing remain authoritative.
- Document RAG is intentionally excluded from this work and will be discussed
  separately.

Related plans:

- `plans/dynamic-capability-discovery-spec.md`
- `plans/personal-skills-memory-lark-retrieval.md`
- `plans/lark-user-experience-rollout.md`

## 1. Product outcome

A user should be able to describe work naturally in English, Hinglish,
Devanagari, or imperfect spelling, and Divo should:

1. Understand the domain, provider, action, entity, output, and side-effect
   boundary of the request.
2. Select one authorized router skill without searching every detailed skill.
3. Load a specialist skill only when the router says the request needs it.
4. Ask one concise clarification when the intent, account, or destination is
   genuinely ambiguous.
5. Never substitute an unrelated accessible skill when the intended skill is
   unavailable.
6. Never create todos, exports, messages, schedules, or other side effects for
   a direct read-only answer.
7. Explain missing access, connection, or department context truthfully.

The user should not need to know about embeddings, pgvector, tool IDs, router
IDs, skill grants, or department IDs.

## 2. Verified current-state evidence

### 2.1 The live Finance skill is not the proposed router

The live database row with slug `finance-ops-core` is:

- A non-system Finance-department skill.
- Created on 18 March 2026 under Abhishek Verma's user account.
- A monolithic recipe containing stale pseudo-tool names such as `booksRead`,
  `booksWrite`, `searchContext`, and `document-ocr-read`.
- Revision 1 with no `SkillVersion` audit rows.

The repository separately contains a router-style `financeOpsCoreSkill`. That
version was introduced on 10 July 2026 in commit `a4a25f85`, a checkpoint
commit co-authored by Claude Opus 4.8. It explicitly calls itself a finance
router and delegates specialist workflows.

These are two different provenances sharing the same slug. The live non-system
row blocks current provisioning because provisioning deliberately skips an
existing skill where `isSystem=false`.

Therefore:

- The live skill must not be described as an already-working router.
- The source router must not be treated as an approved product design merely
  because it exists in code.
- The slug collision must be resolved deliberately before a Zoho router pilot.

### 2.2 Current search is lexical rather than intent-aware

Current governed search:

- Uses the exact original request for initial `resolve_work`.
- Allows the agent to generate a free-text query for fallback
  `discover_skill`.
- Generates candidates by token matching against skill identity fields,
  aliases, tags, tool IDs, descriptions, and full instruction Markdown.
- Scores ASCII token overlap with limited provider/contact heuristics.
- Does not model negation, output type, or side-effect intent.
- Automatically loads the highest-scoring fallback skill.
- Has no first-class router-to-specialist relationship.

Consequences:

- “Do not create or send” can positively score skills containing `create` or
  `send`.
- Devanagari is discarded by the current tokenizer.
- Hinglish works only through incidental English-token overlap.
- Detailed Google, Lark, document, Python, and export recipes can compete with
  a simple finance read.
- Full instruction blobs introduce generic shared terms and search noise.

### 2.3 Correct-but-inaccessible skills can disappear

Skill access and tool permissions are filtered before the model sees search
results. This is required for security, but the current failure behavior is
unsafe for routing:

- If the intended skill is outside the selected department or grant scope, it
  disappears.
- Search may then select an unrelated visible skill instead of returning a
  department/access mismatch.
- Router skills declaring several tools may disappear when the member lacks
  even one declared tool, even if an allowed child route would have been valid.

### 2.4 Tool recovery is underspecified

When `call_tool` is attempted without resolved skill context, the backend
currently returns a generic instruction to discover an approved skill for the
tool.

It does not return:

- The exact required router ID.
- Whether that router is visible to the member.
- Whether a department selection or permission is missing.
- An exact next operation for loading the router.

This encourages repeated fuzzy searches and tool-call loops.

### 2.5 The failed Zoho confidence run

For a direct, explicitly read-only outstanding-receivables request, Divo:

- Did not ask which of the two accessible Zoho accounts to use.
- Failed to load appropriate finance context.
- Loaded unrelated skills.
- Repeated blocked tool calls.
- Created todos.
- Queued a 5,000-row data export.
- Never returned the requested total.

The expected behavior was:

```text
identify Zoho Books read/aggregate intent
  → load exact finance router
  → notice two plausible accounts
  → ask “Emiac or Macobs?”
  → perform no other action
```

## 3. Locked architecture decisions

### 3.1 DECIDED — Start with a lightweight router catalogue

V1 will not introduce pgvector, embeddings, or a second LLM call.

The existing primary agent will receive or search only a small,
permission-filtered catalogue of lightweight router cards. It may supply the
exact request plus at most two intent-preserving query variants. Search returns
several advisory candidates with match reasons; it never auto-loads top-one.

The agent then chooses one exact router, rejects all candidates, or asks one
short clarification.

Vector retrieval and an additional LLM reranker are evidence-driven upgrades,
not V1 dependencies.

### 3.2 DECIDED — Do not add a separate identifier agent

The primary Divo agent already interprets the user request. When it calls
`resolve_work`, it will supply a structured intent envelope.

This does not require an extra LLM request on every turn.

The backend retains the original message independently and may cross-check
explicit signals such as provider names, slash commands, read-only language,
and requested output.

### 3.3 DECIDED — Preserve raw request and derived intent separately

The raw request remains immutable, server-owned evidence.

The derived intent is a bounded machine-readable interpretation:

```json
{
  "domains": ["finance"],
  "providers": ["zoho_books"],
  "action": "read_aggregate",
  "entities": ["invoice", "receivables"],
  "output": "direct_answer",
  "sideEffect": "none",
  "constraints": ["read_only"],
  "account": null
}
```

The derived intent may improve retrieval. It may not expand authorization or
override explicit user constraints.

### 3.4 DECIDED — Router authority lives in the DB

Built-in routers, specialist IDs, instructions, and executable tool bindings
live in the governed DB skill registry. Application source must not maintain a
parallel `toolId → routerSlug` map.

Illustrative target:

```text
zohoBooks / zohoCrm  → finance-zoho-router
Google Workspace     → google-workspace-router
Lark                  → lark-router
Airtable              → airtable-router
AITable               → aitable-router
```

Router Markdown names exact specialist slugs in V1. First-class DB
router-to-specialist metadata may replace that prose after the approved schema
phase. Loading a tool-free router never grants executable tools; only loading
an authorized specialist exposes the specialist's own `toolIds`.

### 3.5 DECIDED — Search routers before specialists

Initial semantic search operates only over router routing cards.

After one router is selected, specialist search is limited to that router's
declared children. Detailed skills from unrelated products do not compete.

Explicit `/<skill-slug>` invocation bypasses semantic search and performs an
exact authorized lookup.

### 3.6 DECIDED — Keep router cards compact and vector-ready

Each router will have a compact routing card containing only retrieval
metadata:

```json
{
  "kind": "router",
  "domains": ["finance", "accounting"],
  "providers": ["zoho_books", "zoho_crm"],
  "actions": ["read", "create", "update"],
  "entities": ["invoice", "bill", "payment", "receivable"],
  "outputs": ["direct_answer", "report"],
  "aliases": ["books", "ledger", "outstanding"],
  "positiveExamples": [
    "show overdue invoices",
    "how much money is outstanding",
    "show recent customer payments"
  ],
  "exclusions": [
    "export all invoices",
    "create a Google Sheet",
    "schedule a weekly report"
  ]
}
```

Full Markdown remains the execution recipe loaded after selection. V1 lexical
search operates only on the compact router card. If later evidence justifies
embeddings, this same routing card—not the full Markdown—is what will be
vectorized.

### 3.7 DECIDED — V1 uses exact routing plus agent-guided router search

V1 ranking precedence:

1. Exact slash command, skill ID, provider, or tool-family binding.
2. Exact router alias/name match.
3. Compatibility with the agent's intent-preserving variants.
4. Supporting lexical overlap over the compact router card.
5. Strong penalties for exclusions, negation conflicts, wrong side-effect
   class, and wrong provider.

If the authorized router catalogue remains small enough for the context
budget, the backend may return every compact router card and let the primary
agent choose without ranking. The replay corpus will determine the cutoff.

Search results are suggestions. The primary agent must inspect the candidates
and explicitly load one exact router.

### 3.8 DEFERRED — Vector retrieval and additional LLM reranking

First measure the router-only V1. Vector retrieval may be added when the router
catalogue or private router population is too large for compact enumeration, or
when multilingual/implicit-intent replay accuracy is inadequate.

An additional Flash reranker may be added only if:

- Router-only search already returned a small authorized candidate set.
- The primary agent repeatedly fails to choose correctly in evaluation.
- A clarification is not the safer result.

The reranker would choose only from supplied IDs or request clarification. It
could not invent a skill ID, see unauthorized instructions, execute a tool, or
override RBAC.

### 3.9 DECIDED — Tool recovery requires an exact DB specialist

When a known tool lacks required work context, the backend refuses execution
until an approved DB skill explicitly declaring that tool has been loaded.
It does not infer a router from source code:

```json
{
  "code": "work_context_required",
  "toolId": "zohoBooks",
  "nextAction": "load_approved_db_skill"
}
```

Skill loading must support exact authorized lookup:

```json
{ "skillId": "finance-zoho-router" }
```

The router may direct the agent to that exact specialist slug. Loading only the
router is insufficient because routers carry no executable `toolIds`.

### 3.10 DECIDED — Missing access never becomes a different intent

Semantic selection and authorization are separate concerns:

1. Determine the intended router using non-secret routing metadata.
2. Intersect with skill grants, department context, tool permissions, and
   connection access.
3. If the intended router is unavailable, return a bounded access,
   department-selection, or connection result.

The system must never choose an unrelated authorized skill merely because the
correct router is inaccessible.

Unauthorized skill instructions and company-private examples remain hidden.

### 3.11 DECIDED — Side-effect class constrains eligible tools

Intent must distinguish at least:

- `none`
- `write_record`
- `send_message`
- `export`
- `schedule`
- `create_task`

A direct answer or read-only request makes export, scheduling, todo creation,
messaging, and record mutation ineligible unless the user explicitly requests
them.

Backend policy and approval remain the final enforcement layer.

### 3.12 DECIDED — Document RAG is deferred

Document RAG is excluded from the router/search implementation and the Zoho
pilot. Its tool IDs, extraction flows, document authority, and specialist
skills will be reviewed separately.

No search-quality decision in this file should depend on Document RAG.

## 4. Target intent envelope

The exact schema remains an implementation detail, but it must represent:

| Field | Purpose |
|---|---|
| `domains` | Finance, communications, scheduling, knowledge, design, etc. |
| `providers` | Explicit or inferred systems such as Zoho Books or Gmail. |
| `action` | Read, aggregate, search, create, update, delete, send, export, schedule. |
| `entities` | Invoice, bill, contact, email, event, record, document, etc. |
| `output` | Direct answer, report, document, message, export, reminder, task. |
| `sideEffect` | Explicit external-state boundary. |
| `constraints` | Read-only, date range, privacy, audience, language, formatting. |
| `account` | Explicit account label when named; otherwise null. |
| `confidence` | Agent confidence as a signal, never as authorization. |

Requirements:

- Zod-validated.
- Bounded arrays and enum values.
- No free-form tool or skill identifiers except exact known IDs.
- Multi-intent requests can carry a small ordered list of intent envelopes.
- Explicit negatives such as “do not send” and “do not export” must remain
  constraints rather than positive retrieval terms.

## 5. Target search flow

```text
raw user request + bounded conversation/reference context
  → primary agent calls resolve_work with up to two intent-preserving variants
  → backend extracts exact provider/command/tool-family signals
  → exact router mapping, when available
  → otherwise search/enumerate authorized lightweight router cards only
  → return several advisory candidates with reasons
  → primary agent chooses and loads one exact router, rejects all, or clarifies
  → router selects direct contract or exact specialist child
  → backend rechecks RBAC, connection access, schema, HITL, and policy
  → execute
```

The raw request is never replaced by the intent envelope. The envelope is
never treated as permission.

## 6. Example flows

### 6.1 Explicit Zoho Books read

User:

> Using Zoho Books, tell me our total outstanding receivables. Read-only.

Resolution:

```text
provider=zoho_books
action=read_aggregate
entity=receivables
output=direct_answer
sideEffect=none
  → exact finance-zoho-router
  → two accessible accounts and none named
  → ask “Emiac or Macobs?”
  → no tool side effect
```

### 6.2 Implicit Hinglish finance read

User:

> Macobs mein 90 din se zyada pending customer payments dikhao, kuch change mat
> karna.

Resolution:

```text
finance + receivables/payments + read + Macobs + read_only
  → hybrid retrieval selects finance-zoho-router
  → use explicitly named Macobs account
  → load read contract
```

### 6.3 Ambiguous “send report”

User:

> Send me the latest customer invoice report.

Possible meanings:

- Return a finance summary in the current conversation.
- Export a report artifact.
- Send an existing report to another recipient.

Expected behavior:

- Do not infer an export or destination.
- Ask one short clarification when context does not disambiguate the output and
  side effect.

### 6.4 Exact private skill invocation

User:

> `/client-status Acme`

Resolution:

```text
exact authorized slug lookup
  → load client-status
  → no semantic router search
```

## 7. Phased TODOs

### Phase 0 — Baseline and decision reconciliation

- [x] Snapshot the current live skill registry, grants, scopes, versions, and
      tool IDs without modifying it.
- [x] Identify every current router-like skill and every detailed workflow
      competing at the top level.
- [ ] Record all stale pseudo-tool references separately; do not silently
      rewrite user-created skills.
- [x] Resolve the live non-system `finance-ops-core` collision without
      rewriting it: preserve it and provision the separately named,
      instruction-only system router `finance-zoho-router`.
- [ ] Reconcile this plan with
      `plans/dynamic-capability-discovery-spec.md` §2.6, which currently locks
      exact raw-query preload and disables agent-supplied variants.
- [ ] Capture a baseline replay report from current production-shaped traces.

### Phase 1 — Lightweight router-only V1

- [x] Remove the source-owned `toolId/toolFamily → routerSkillId` mapping.
      Router candidates and exact specialist loading now use DB skill rows.
- [x] Add tool-free DB routers for Google Workspace, Airtable, AITable, data,
      and research alongside the existing Lark and Zoho routers.
- [x] Split bounded `dataProcessor` work into `data-processing` and route
      complete-file delivery to the existing `secure-data-export` specialist.
- [x] Replace the source-only research recipes with DB `research-router` and
      `context-research`; keep Document RAG outside this rollout.
- [x] Remove `UNIFIED_AGENT_MODE`, the in-memory `SkillRegistry`, and the
      legacy source-backed `discover_skill` runtime.
- [x] Add exact authorized skill loading by ID/slug.
- [x] Require an exact approved DB specialist before unresolved tool calls can
      execute, persist that binding through approvals/automation plans, and
      revalidate it immediately before deferred execution.
- [ ] Add a validated intent envelope to `resolve_work` while retaining the
      raw request server-side.
- [x] Show only compact router summaries in the initial Lark skill catalogue.
- [x] Allow at most two intent-preserving query variants from the primary
      agent.
- [x] Return several router candidates and match reasons; never auto-load
      top-one.
- [x] Let the primary agent load one exact router, reject all candidates, or
      ask one clarification.
- [x] Prevent an inaccessible intended router from falling through to an
      unrelated visible skill.
- [ ] Add side-effect eligibility checks for direct-answer/read-only intent.
- [x] Retire the dormant legacy mode instead of adding another authority flag;
      the governed DB catalogue is now the only agent-visible skill runtime.

### Phase 2 — First-class router metadata

> Schema/migration work requires explicit approval before implementation.

- [ ] Add `kind = router | specialist`.
- [ ] Add a parent-router reference for specialist skills.
- [ ] Add structured routing-card metadata: domains, providers, actions,
      entities, outputs, aliases, examples, and exclusions.
- [ ] Version routing metadata with the skill revision.
- [ ] Validate that specialists cannot reference a missing or unauthorized
      parent router.
- [ ] Ensure router visibility does not require permission for every optional
      child tool.
- [ ] Define a rollback path that preserves existing skill content and grants.

### Phase 3 — Optional multilingual vector retrieval

> Start this phase only if replay or production-shaped traces show that the
> lightweight router catalogue is too large or inaccurate.

- [ ] Verify and document the PostgreSQL/pgvector deployment prerequisite.
      Current project notes indicate plain PostgreSQL images without pgvector.
- [ ] Select candidate multilingual embedding models.
- [ ] Benchmark candidates on English, Hinglish, Devanagari, spelling errors,
      finance terminology, and provider ambiguity.
- [ ] Store one versioned embedding per routing card, not per complete skill
      Markdown blob.
- [ ] Generate/update embeddings on skill publish and routing-card revision.
- [ ] Add a retryable backfill for existing router cards.
- [ ] Implement authorized top-K vector retrieval.
- [ ] Implement lexical/vector rank fusion and exclusion penalties.
- [ ] Never persist deterministic fallback vectors as semantic embeddings.

### Phase 4 — Optional conditional reranking

- [ ] Measure hybrid-routing misses before adding another model call.
- [ ] Define ambiguity using calibrated score and margin, not intuition.
- [ ] Add a temperature-zero Flash reranker for at most a small authorized
      candidate set only if replay evidence justifies it.
- [ ] Validate reranker output against supplied router IDs.
- [ ] Make clarification a valid result.
- [ ] Record reranker model/version, latency, candidates, selection, and
      confidence.
- [ ] Provide a feature flag to disable reranking independently.

### Phase 5 — Router-to-specialist narrowing

- [ ] Load one exact router before searching specialists.
- [ ] Search only the router's declared children.
- [ ] Let the router select a direct tool contract when no specialist workflow
      is needed.
- [ ] Return exact child IDs rather than asking the agent to rediscover names.
- [ ] Detect orphaned, conflicting, duplicated, and unreachable specialist
      skills.
- [ ] Keep specialist instructions outside the initial system prompt.

### Phase 6 — Zoho pilot

- [x] Create the separately named instruction-only `finance-zoho-router`
      without modifying the live non-system `finance-ops-core`.
- [ ] Remove Document RAG from this pilot's routing and evaluation scope.
- [ ] Define Zoho Books versus Zoho CRM routing examples and exclusions.
- [ ] Define direct read, aggregate, write, export, and notification intent
      boundaries.
- [x] Keep `finance-zoho-router` and its specialist instructions in the DB;
      do not bind Zoho tools through an application-owned routing map.
- [ ] Verify account-choice behavior for a user with Emiac and Macobs access.
- [ ] Run the Shivam + Flash account-choice harness test.
- [ ] Assert zero todos, exports, schedules, messages, and Zoho writes before
      account selection.
- [ ] Run verified invoice lookup and invoice line-item drill tests.
- [ ] Compare every material answer with direct read-only Zoho API results.
- [ ] Stop and report the first mismatch before changing product behavior.

### Phase 7 — Shadow rollout and promotion

- [x] Retire the unused legacy runtime after focused parity tests rather than
      keeping a second skill authority alive for shadow execution.
- [ ] Record router candidates, decisions, and rejection reasons in
      production-shaped replay runs.
- [ ] Review false positives, false negatives, clarification rate, and latency.
- [ ] Promote one provider family at a time.
- [x] Remove the legacy lexical full-Markdown runtime and its source-only
      data/research recipes.
- [ ] Keep rollback at the application/DB-version level; do not reintroduce an
      in-memory skill authority.

## 8. Evaluation corpus

The replay/golden corpus must include:

- Explicit providers and exact tool-family wording.
- Implicit domain requests without provider names.
- English, Hinglish, Devanagari, and mixed-script requests.
- Misspellings and informal abbreviations.
- Read versus write.
- Read versus export.
- Direct answer versus document/report creation.
- Direct answer versus message sending.
- One-time work versus scheduling.
- Negation: “do not send,” “do not create,” “do not export.”
- Multiple accounts with and without an explicit account label.
- Multi-domain requests.
- Slash commands and exact private skill invocation.
- Unauthorized provider, skill, department, and connection scenarios.
- Prompt text containing fake tool/skill names.
- Conversational messages that require no skills or tools.

## 9. Success metrics and release gates

Track:

- Router top-1 accuracy.
- Wrong-router rate.
- No-match rate.
- Clarification rate.
- Correct specialist-child rate.
- Unauthorized skill exposure: must remain zero.
- Unintended external side effect: must remain zero for read-only/direct-answer
  cases.
- Repeated `work_context_required` loops.
- Tool success after router resolution.
- Added p50/p95 routing latency.
- Additional model calls and cost.
- Cache hit rate by normalized intent plus registry revision.

No provider family is promoted from shadow mode until:

- The golden corpus passes its agreed accuracy threshold.
- All read-only cases show zero unintended actions.
- Permission and scope failures return bounded truthful results.
- Rollback is tested.
- Production-shaped harness traces remain explainable from stored routing
  evidence.

## 10. Observability requirements

For each resolution, record:

- Raw-query reference or approved redacted representation.
- Structured intent.
- Agent/model/version that supplied the intent.
- Exact deterministic signals.
- Authorized candidate IDs.
- Lexical and vector scores.
- Exclusion and side-effect penalties.
- Selected router and specialist IDs.
- Confidence and top-candidate margin.
- Clarification/fallback reason.
- Scope, grant, permission, or connection rejection category.
- Registry and routing-card revision.
- Latency and cost for every routing stage.
- Repeated context-resolution errors.

Do not log credentials, tokens, private skill bodies, unauthorized examples, or
provider record contents.

## 11. Failure behavior

- Exact intended router unavailable → report access/department/connection
  condition; do not substitute.
- No confident router → ask one concise clarification.
- Two close routers → bounded rerank or clarification.
- Invalid intent envelope → retry argument correction once, then ask/report.
- Embedding service unavailable → deterministic and lexical routing continue.
- Reranker unavailable → use calibrated hybrid result or clarify.
- pgvector unavailable → exact and lexical routing continue under feature flag.
- Router loaded but child unavailable → report the missing child capability.
- Same `work_context_required` repeats → stop; do not loop or create fallback
  todos/exports.

## 12. Open decisions

- [ ] Final canonical router IDs for provider families after the DB-owned
      `lark-router` and `finance-zoho-router` precedents.
- [ ] Whether built-in routers are company-scoped with explicit grants or
      department-scoped with mandatory department selection.
- [ ] Behavior when a member belongs to several departments but has no active
      department preference.
- [ ] Whether routing-card fields are normalized columns or one versioned JSON
      object.
- [ ] Multilingual embedding provider/model and dimensionality.
- [ ] pgvector packaging, migration, index type, backup, and rollback plan.
- [ ] Exact hybrid weighting and top-K values.
- [ ] Confidence/margin threshold for automatic selection versus
      clarification.
- [ ] Whether conditional reranking is needed after hybrid evaluation.
- [ ] Lifecycle for user-created router skills and parent-child validation.
- [ ] Admin UX for reviewing routing examples, exclusions, grants, and
      conflicts.
- [ ] Safe migration path for existing user-created skills sharing reserved
      system slugs.

## 13. Explicitly out of scope

- Document RAG architecture and permissions.
- Personal-memory storage and retrieval.
- Lark transport, thread routing, login/logout, and media reliability.
- Provider tool implementation completeness.
- Data-export worker design.
- Desktop deployment.
- Production migration or skill-content mutation during planning.

## 14. Definition of done

This initiative is complete when:

1. Built-in provider/tool-family requests resolve deterministically to one
   authorized router.
2. Implicit and multilingual requests resolve through evaluated hybrid search.
3. Detailed skills are searched only within one selected router.
4. Exact slash invocation bypasses semantic search.
5. Read-only/direct-answer requests cannot silently become exports, todos,
   messages, schedules, or provider writes.
6. Missing scope, access, department, account, and connection states produce
   truthful bounded responses.
7. Every routing decision is observable and replayable.
8. The Zoho pilot passes account selection and direct-API verification using
   Shivam + Flash.
9. Feature-flag rollback is verified.
10. Conflicting legacy search behavior and stale skills are either migrated
    explicitly or retired with approval.

## 15. Decision log

### 2026-07-29

- Corrected the record: the live `finance-ops-core` is an older non-system
  monolithic skill; the router-style implementation exists separately in
  source and was introduced later in an agent-co-authored checkpoint.
- Selected hybrid intent routing instead of lexical-only, vector-only, or
  LLM-only search.
- Decided to reuse the primary agent for structured intent rather than add a
  separate identifier agent.
- Decided on deterministic known-provider routing, router-card vectorization,
  lexical/vector fusion, and conditional bounded reranking.
- Decided on router-first then specialist search.
- Decided that unresolved tool calls must return an exact required router.
- Decided that side-effect intent constrains eligible capabilities.
- Deferred Document RAG.
