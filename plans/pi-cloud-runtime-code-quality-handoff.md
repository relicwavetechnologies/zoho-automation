# Cloud-Pi runtime code-quality and modularity handoff

> Status: **Active implementation handoff**
>
> Created: **2026-08-14**
>
> Scope: **Cloud-Pi, web, Lark, and their backend runtime boundary only**
>
> Explicit exclusion: **Jan/Desktop is parked. Do not inspect, migrate,
> refactor, test, or clean Desktop code as part of this job.**

## 1. Outcome

Finish the Cloud-Pi implementation as one predictable, production-grade
runtime without starting another harness rewrite and without spending time on
Desktop parity.

The finished system should have:

- first-class Pi-native business tools;
- backend-owned identity, RBAC, credentials, approvals, usage, and audit;
- native backend skills staged through one permanent path;
- genuine bounded answer streaming from provider to browser;
- cohesive runtime modules with one clear owner per responsibility;
- stable prompts that allow DeepSeek prefix caching;
- proven DeepSeek and Luna behavior in the real container;
- no dead Cloud compatibility paths, duplicated policy, or misleading docs.

Code quality here means predictable ownership and behavior. It does not mean
extracting every small function, adding speculative abstractions, or rewriting
working code for visual neatness.

## 2. Scope boundary

### Included

- `divo-pi/divo/`
- `divo-pi/divo/extensions/`
- Cloud-Pi runtime and container packaging
- `advance-backend` Cloud-Pi gateway, lease, web, Lark, streaming, model proxy,
  and governed execution paths
- web-chat streaming code in `admin/` when required for Cloud-Pi correctness
- tests, CI, runtime documentation, and measurements for these paths

### Parked — do not spend time here

- `jan/`
- Desktop's legacy `divo_gateway` mega-tool
- Desktop typed-tool parity
- Teach UI or Desktop approval-card migration
- Desktop Rust allowlists, packaging, tool cards, and protected-session parsing
- any shared-package project created only to make Cloud and Desktop look alike

One preparatory Desktop protection commit already exists:
`95cc8f09f test: preserve typed Shopify session protection`. Leave it as-is.
Do not continue that migration in this job.

If a proposed Cloud change appears to require a Desktop change, first find a
Cloud-owned boundary. If none exists, record the dependency and stop that
specific change rather than expanding this job into Desktop.

## 3. Non-negotiable architecture

```text
Web or Lark
    -> advance-backend admission and short-lived runtime lease
    -> private Cloud-Pi controller
    -> isolated per-user/run container
    -> Pi-native Divo tool definition
    -> one governed backend gateway
    -> backend RBAC / approval / credentials / provider execution / audit
```

- Pi owns model-facing tool contracts, skill ergonomics, agent lifecycle,
  todos, files, subagents, plans, and local workflow mechanics.
- The backend owns every enterprise authority decision and every reusable SaaS
  credential.
- A visible tool is not permission. The backend must reject unauthorized use.
- Do not introduce Pi/Codex, Cloud/Desktop, legacy/native, or alternate-engine
  runtime switches.
- Do not add a second company-tool execution path.
- Do not move provider implementations or OAuth credentials into Pi.
- Do not modify vendored Pi core unless an extension/runtime boundary cannot
  supply a required capability and the reason is documented.

## 4. Completed foundation

The following work is already implemented and committed:

| Commit | Result |
|---|---|
| `6c7bba5d0` | All 38 business tools became permanent Pi-native definitions; backend remains governed executor |
| `1c928de6e` | True provider-driven web streaming, bounded/coalesced NDJSON and SSE backpressure, reconnect compaction, pipeline regression proof |
| `4b55a32fa` | Pure runtime progress and answer projection extracted from the controller |
| `708d9ef6c` | Native-skill validation, fetch, digest, telemetry, and atomic staging extracted |
| `dc2dd65c6` | Native skills made one permanent runtime path; rollback behavior mode removed |
| `e6ef3eeb1` | Attachment validation, confined paths, MIME policy, limits, and prompt manifest extracted |

Other completed quality work:

- generated native-tool parity and stale-file detection;
- all permanent tools remain visible regardless of current RBAC;
- obsolete dynamic outer tool-definition path removed;
- Google and Airtable retain only provider-owned nested schema enrichment;
- backend SSE and Pi NDJSON flow control are bounded;
- an actual controller-to-backend-to-web SSE test proves an answer delta arrives
  before terminal completion;
- admin unit tests run in CI;
- native-skill authorization failures remain fatal;
- transient skill-bootstrap outages use an explicit empty-catalogue degraded
  result on the same runtime path;
- unrelated working-tree files were preserved.

## 5. Current state

The Cloud-Pi tool and streaming foundation is functionally complete. The work
remaining is modularity, measured performance optimization, and production-like
proof.

The controller has been reduced from more than 3,100 lines to roughly 2,500,
but still combines several process-oriented responsibilities. All 38 permanent
tool schemas are model-visible on every turn. That visibility is an explicit
product decision, but its token, latency, and cache impact has not yet been
measured against the fixed baseline.

Current unrelated/untracked items must not be staged or deleted as part of this
job:

- `output/`
- `plans/mail-action-intelligence-and-lark-task-orchestration.md`
- `research-divo-cloud-agent-harness-2026-08-12.html`
- `review-pi-first-class-harness-2026-08-13.html`

Always re-run `git status --short` before staging because other work may appear
concurrently.

## 6. Remaining implementation plan

### Phase A — Finish Cloud controller boundaries

Goal: make container/process changes reviewable without changing the public RPC
or security contract.

Extract only cohesive responsibilities with existing characterization tests:

1. **Attachment byte staging**
   - Docker argv and isolated writer process;
   - streaming byte cap and abort handling;
   - atomic `.part` commit and cleanup.
   - Keep pure attachment policy in `runtime-attachments.mjs`.

2. **Runtime identity and lease validation**
   - profile/thread/session-scope validation;
   - signed runtime identity derivation;
   - trusted session projection;
   - no Docker or backend fetch behavior in this module.

3. **Warm process lifecycle**
   - binding compatibility;
   - idle scheduler;
   - retain/discard/stop behavior;
   - abort and finalization rules.

4. **Docker resources and reconciliation**
   - resource naming;
   - owned volume/network/container checks;
   - cold create/replace/reconcile/ephemeral cleanup.

Rules for every extraction:

- move policy and tests together;
- keep `local-rpc-controller.mjs` as compatibility façade until the seam is
  proven;
- do not change behavior and module structure in the same commit;
- run focused tests before the full Pi gate;
- commit each coherent extraction separately;
- stop extracting when the remaining controller reads as orchestration rather
  than a collection of unrelated policy engines.

Exit gate:

- public RPC payloads and lifecycle events are unchanged;
- controller primarily coordinates modules;
- abort, cleanup, protected-session deletion, warm reuse, attachments, and
  shared/private isolation tests remain green;
- no circular dependencies or duplicate ownership appear.

### Phase B — Audit Cloud-only flags and compatibility code

For every remaining Cloud runtime flag, record one of:

- permanent deployment configuration with a named operational purpose;
- development-only selection with a test;
- expired migration behavior to remove.

Likely audit targets include source/compiled entry selection, keepalive,
host-gateway networking, and local CLI exposure.

Search before deleting. A function, route, or adapter is removable only when:

- no production caller or packaging path reaches it;
- tests and docs do not define it as a supported contract;
- the replacement path is already proven;
- removing it does not create another hidden fallback.

Do not remove backend provider implementations. Pi owns the model-facing
contract; the backend still owns real provider execution.

Exit gate:

- every remaining flag has one documented purpose;
- no stale comment describes a retired path;
- no duplicate Cloud authority or execution path exists;
- generated ownership is deterministic.

### Phase C — Measure and reduce model tax

Do not optimize tool visibility by intuition. First capture one fixed baseline
for DeepSeek Flash, DeepSeek Pro, and Luna where supported.

Measure:

- stable system-prompt bytes/tokens;
- tool schema bytes/tokens;
- dynamic per-run prompt bytes/tokens;
- uncached and cached input tokens;
- output tokens;
- model turns;
- tool calls and provider requests;
- user-to-first-business-tool latency;
- time to first answer delta and total completion latency;
- task correctness.

Use a fixed representative fixture, including the three-domain Semrush
comparison whose previous baseline was 58,027 uncached input tokens, seven
model turns, six tool calls, and 78.8 seconds.

Optimize in this order:

1. remove duplicated instructions across system prompt, tool descriptions,
   prompt guidelines, and skills;
2. keep security and authority policy in one stable prefix;
3. move volatile run paths and identifiers after stable content or into runtime
   state where Pi permits;
4. shorten descriptions and schemas without weakening validation;
5. make unambiguous requests call the target native tool without resolver or
   discovery turns;
6. retain large rows in files and return bounded summaries/artifact references.

Do not silently hide tools by RBAC. If the 38-tool schema cost remains material
after removing duplication, document the measurement and propose a separate
product decision for compact permanent identities with deferred detailed
schemas.

Exit gates under the same fixture:

- at least 35% lower first-turn uncached input than 58,027 tokens;
- no more than three model turns for the simple Semrush comparison;
- exactly one Semrush provider request for all requested targets;
- at least 25% lower p50 first-business-tool latency with no p95 regression;
- genuine early answer delta still arrives before completion;
- no correctness, schema-validation, or denial regression.

### Phase D — Real-container authority and provider proof

Follow `AGENTS.local.md` and
`advance-backend/docs/cloud-pi-testing/07-local-runtime-harness-framework.md`.
Never print or commit local credentials, personal chat IDs, or provider tokens.

Run controlled Cloud-Pi tests for:

- all expected tools and native skills visible;
- visible but RBAC-denied tool returns backend denial;
- missing connection is reported without guessing or direct-provider fallback;
- Semrush multi-target comparison;
- OMS and Menhood bounded reads;
- Zoho read;
- Shopify read and denied case;
- Google and Airtable provider-native schema enrichment;
- one write that enters the real approval path and resumes safely;
- abort before execution and interruption after work starts;
- attachment upload, path confinement, processing, and cleanup;
- protected data triggers exact session cleanup;
- private/thread and shared/run isolation;
- web true streaming and Lark bounded status-card behavior.

Use Development only unless a separate Main test is explicitly approved. Do
not turn a provider failure into an alternate orchestration-engine fallback.

### Phase E — Model and caching proof

DeepSeek Flash and Pro:

- repeated identical stable prefixes produce non-zero provider cache hits;
- raw provider cache hit/miss counters map exactly to normalized Divo usage;
- the complete tool/approval/attachment fixture passes;
- no direct provider key reaches Pi or a child process.

Luna:

- OpenAI Responses transport passes ordinary text and typed tools;
- image input remains supported;
- compaction and request-too-large recovery work;
- 413 recovery does not repeat completed mutations;
- usage normalization is correct.

Exit gate: both model families satisfy the same governed runtime contract.

### Phase F — Final release-quality audit

- run the complete Pi gate;
- run backend typecheck and focused runtime/gateway suites;
- run native-tool generation/parity check;
- run admin unit tests and production build when web code changed;
- build the Cloud-Pi image and run its smoke tests;
- verify from a clean checkout if practical;
- run an independent cold review of correctness, modularity, authority,
  performance regressions, and dead code;
- update this handoff and the primary audit plan with evidence rather than
  aspirational checkmarks.

Stop when the promotion gates pass. Do not continue into Desktop cleanup or an
unbounded aesthetic refactor.

## 7. Primary files

Runtime orchestration:

- `divo-pi/divo/local-rpc-controller.mjs`
- `divo-pi/divo/local-rpc-server.mjs`
- `divo-pi/divo/runtime.mjs`
- `divo-pi/divo/runtime-progress.mjs`
- `divo-pi/divo/native-skills.mjs`
- `divo-pi/divo/runtime-attachments.mjs`
- `divo-pi/divo/ndjson-stream-writer.mjs`
- `divo-pi/divo/runtime-manifest.json`

Pi-native tools and policy:

- `divo-pi/divo/extensions/divo-gateway/index.ts`
- `divo-pi/divo/extensions/divo-gateway/typed-tool-runtime.ts`
- `divo-pi/divo/extensions/divo-gateway/native-tools/`
- `divo-pi/divo/extensions/divo-llm/index.ts`

Backend boundary:

- `advance-backend/src/application/gateway/`
- `advance-backend/src/application/runtime/`
- `advance-backend/src/http/gateway/`
- `advance-backend/src/http/desktop/web-chat.routes.ts`
- `advance-backend/src/application/proxy/llm-proxy.service.ts`
- `advance-backend/scripts/generate-pi-native-tools.ts`

Web streaming:

- `admin/src/pages/workspace/chat/`
- `advance-backend/tests/application/web-stream.pipeline.test.ts`

Primary decision record:

- `plans/pi-first-class-harness-quality-audit.md`

## 8. Verification commands

Run narrow tests first, then broaden according to the changed boundary.

```bash
# Complete Pi runtime and extension gate
cd divo-pi
npm run divo:check

# Focused controller/stream/attachment tests
node --test \
  divo/test/attachment-staging.test.mjs \
  divo/test/local-rpc-controller.test.mjs \
  divo/test/local-rpc-server.test.mjs \
  divo/test/ndjson-stream-writer.test.mjs

# Backend contract generation/parity and types
cd ../advance-backend
pnpm check:pi-native-tools
pnpm typecheck

# Focused end-to-end streaming pipeline
node --import tsx --test tests/application/web-stream.pipeline.test.ts
```

Run additional focused backend tests selected from the changed services. Do not
default to the entire backend suite for every mechanical module extraction;
run it before final promotion or when the blast radius warrants it.

After a runtime or extension change, rebuild the Cloud-Pi image before a real
container test:

```bash
cd divo-pi
docker build -t divo-pi-local:phase0 .
```

## 9. Working method

1. Inspect relevant code and tests before editing.
2. State the exact responsibility being moved or behavior being changed.
3. Use `apply_patch` for edits.
4. Preserve unrelated and concurrent changes.
5. Run focused tests.
6. Run the broader boundary gate.
7. Review `git diff --check` and the staged diff.
8. Commit one coherent slice with a descriptive message.
9. Record measurements and failures in this handoff.

Never claim a phase complete because code compiles. Completion requires the
behavioral or measurement gate named in that phase.

## 10. Next action

Start with **Phase A: attachment byte staging**. It is the next clean controller
boundary because pure attachment policy is already isolated and characterized.
Move Docker writer-process behavior into a dedicated module while preserving
the controller's exported API and all current attachment tests. Then proceed to
runtime identity/lease policy.

Do not open or modify `jan/` while performing this work.
