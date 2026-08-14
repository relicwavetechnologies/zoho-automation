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

**One carve-out was taken.** `jan/web-app/src/lib/audio-sentinel.ts` was edited
by the turn-plan slice, to replace raw NUL and SOH bytes with the equivalent
escapes. It is a byte-identical rewrite, verified against the old blob and by
running that file's own vitest suite, and it was done because a raw NUL makes
`grep` skip a file silently — the hazard that had already caused one wrong
dead-code claim in this document. No Jan behaviour, dependency or contract was
touched. Treat it as the exception it is, not as permission to continue there.

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
| `434afdd4d` | Phase A: identity, Docker, attachment staging, and warm-process lifecycle each given one owner; controller 2,478 → 1,335 lines |
| `41fa8819a` | Controller image packaged every module it imports again, guarded by a test derived from the real import graph |
| `2ee208cc8` | Every Pi runtime flag given one owner and one purpose; the flag register enforced as tests |
| `5bb9b3655` | Warm turns stopped repeating cold-start work: one RPC round trip, one `docker exec` and four `docker inspect` calls removed per turn |

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

The controller is 1,404 lines, down from more than 3,100. It was 1,335 at the end
of Phase A, 1,329 after `2ee208cc8`, and 1,353 after `5bb9b3655`; **the turn-plan
slice added 51 to that last figure**, because deleting the 76-line re-export block
bought less than the effects seam, the phase record and their rationale cost.

One log field changed meaning and is worth knowing before reading old graphs
against new ones: `readyMs` in `pi_runtime.ready` was a wall span and is now the
sum of the named ready phases, which excludes the synchronous spawn and the gaps
between phases. The drift is sub-millisecond; the definition still moved. Its
turn orchestration is now one function whose effects arrive as an argument —
but that is roughly 430 of those lines. Keychain storage, profile persistence,
Lark login, run-result classification, the JSONL wire protocol, the terminal
approval responder and the CLI are all still in the same file, so Phase A's
"controller primarily coordinates modules" gate is **not** cleared. All 38 permanent
tool schemas are model-visible on every turn. That visibility is an explicit
product decision, but its token, latency, and cache impact has not yet been
measured against the fixed baseline.

### The per-turn backend cost (2026-08-15)

Three round trips were being paid per turn. Two are now gone; the third is
smaller. None of this changed what a turn is allowed to do.

- **The lease used to resolve through `GET /api/desktop/auth/me`** — a desktop
  shell's boot payload, roughly eight queries, of which a container read one
  (its departments). It now resolves through `GET /api/desktop/auth/runtime-session`,
  which answers with the run facts `memberAuth` has already established plus that
  one query. The round trip itself stays and must: `memberAuth` is what verifies
  the lease signature and re-checks that the session and membership are live, and
  the controller has no caller authentication of its own to put in its place. A
  request body carrying "run facts" would have deleted revocation, so that idea —
  written down in an earlier version of this plan — should not be revived.
- **A lease can no longer reach `/me` at all.** The allowlist is now the named
  `allowsPiRuntimeLease`, and `/me` is off it. That payload carries the member's
  email, name, avatar and every connected Lark and Google account; it was
  reachable from inside a container for one reason, and the reason is gone. The
  now-unreachable `runtime` block was deleted from `/me` with it.
- **The container fetched `/runtime-context` for itself** — at startup *and* on
  every warm turn, via `prepare` — while the controller was fetching the same
  route, same department, for the skill bootstrap. The controller's fetch now
  returns both halves (`fetchRunContext`) and the context travels in the
  bootstrap, which is re-staged per turn, so freshness is unchanged.
  `container-entry.mjs` makes no network call at all now, and a test asserts that
  against the source, because no fixture can.
- **One `/runtime-context` request resolved the same facts twice** when
  `nativeSkills=1`: two `permissions.resolve` calls differing only in a `channel`
  the resolver never reads, plus `listGrantedSkillIds` and `registryRevision`
  twice each. One resolution now feeds both bootstraps, and a test pins the count
  so this stops being silent if `channel` ever starts deciding something.

Two behaviours were deliberately preserved rather than simplified away, and both
have tests: a 5xx on the skills half still costs bundled-skills-only rather than
the turn (the merged fetch asks again without `nativeSkills=1`), and a 4xx is
still fatal and is **not** retried into a weaker answer — asking again without
the skills would turn "you may not use this department" into a turn that runs
with capabilities it was denied.

Current unrelated/untracked items must not be staged or deleted as part of this
job:

- `output/`
- `plans/mail-action-intelligence-and-lark-task-orchestration.md`
- `research-divo-cloud-agent-harness-2026-08-12.html`
- `review-pi-first-class-harness-2026-08-13.html`

Always re-run `git status --short` before staging because other work may appear
concurrently.

## 6. Remaining implementation plan

### Phase A — Finish Cloud controller boundaries — **partially complete (2026-08-14); exit gate open**

Goal: make container/process changes reviewable without changing the public RPC
or security contract.

Delivered in `434afdd4d` as four modules, dependencies running one way
(`runtime-identity` → `runtime-docker` → `runtime-attachment-staging` /
`runtime-warm-process` → controller), with `local-rpc-controller.mjs` retained
as a re-export façade. **That façade was deleted by the later turn-plan work;
every module is now imported from its owner.** Evidence as of Phase A:

- `npm run divo:check` green: typecheck clean, 199 runtime tests, extension
  suites 4 / 10 / 169 / 5 / 15 / 10, zero failures;
- the controller's export surface was diffed name-by-name against
  `bd6702484` in one process — 77 names, no addition, no removal, identical
  `typeof` and arity;
- three independent Opus cold-review rounds; final verdict ship with no open
  findings.

Deviation from the plan above: the four extractions landed as one commit rather
than four, because each one rewrites the same controller import block and the
intermediate states are not independently revertable.

**Found while doing it — a live packaging break.** `Dockerfile.controller`
copies an explicit allowlist, and it had not been updated since 10 Aug, so the
five modules extracted on 12–13 Aug were absent from the controller image; the
entrypoint could not import inside it. Fixed in `41fa8819a`, with a guard test
that derives the allowlist from the real import graph and checks build stage,
`--from=`, destination, workdir ordering and line continuations. This was the
second occurrence (`337cbe7c1` was the first), which is why the guard replaces
the hand-written list rather than just correcting it.

**Deliberately left for Phase B.** Of the names the deleted façade used to
re-export, three are unused outside their own module: `SESSION_SCOPES`,
`SESSION_LIFECYCLE_OPERATIONS`, `settledSentences`. They predate this work.

That is not a complete audit of the tree — it is scoped to the façade. A sweep
of every `divo-pi/divo/*.mjs` export also finds `JsonlRpc`, `RUNTIME_CHANNELS`,
`RESOURCE_PREFIX` and `validateProtectedRunReferences` unreferenced outside their
own file. Phase B's search-before-delete rule applies to all of them, and to
anything else the sweep turns up.

The earlier version of this paragraph listed six, adding `ensureProfileVolume`,
`isGovernedDivoTool` and `normalizeMimeType`. Those three were only ever dead as
*re-exports from the controller façade* — each is imported and called from its
owner today (`runtime-attachment-staging.mjs` for the first and third,
`local-rpc-controller.mjs` for the second). Deleting the façade made the
distinction disappear from the sentence and turned a true claim into an
instruction to delete live code.

A first review round claimed eleven were dead; five of those are in fact
imported by `divo/test/attachment-staging.test.mjs`, which plain `grep` skipped
because the file carried raw control bytes and read as binary. **That is fixed
as of the turn-plan work: no first-party file carries a raw NUL any more, so
plain `grep` no longer skips source files.** Four
files carried raw NUL, SOH or ESC bytes — `divo/test/attachment-staging.test.mjs`
(NUL and ESC), `divo/test/runtime-files-endpoint.test.mjs` (NUL),
`admin/src/lib/notify.ts` (NUL), `jan/web-app/src/lib/audio-sentinel.ts` (NUL and
SOH) — and each now writes the same bytes as `\x00`/`\x01`/`\x1b` escapes, proven
byte-identical at runtime. The only tracked non-asset file `grep` still treats as
binary is `jan/docs/bun.lockb`, which always was. Two evidence documents under
`docs/evidence/` still carry raw ESC bytes from pasted ANSI colour codes; ESC
alone does not make `grep` skip a file, so they are legible and left alone.
The `grep -a` habit is no longer needed; if a future fixture reintroduces a raw
control byte, it will take this hazard back with it.

Extract only cohesive responsibilities with existing characterization tests.

**Delivered in `434afdd4d`** — do not redo these: attachment byte staging
(`runtime-attachment-staging.mjs`), runtime identity and lease validation
(`runtime-identity.mjs`), warm process lifecycle (`runtime-warm-process.mjs`),
Docker resources and reconciliation (`runtime-docker.mjs`).

**Still in `local-rpc-controller.mjs`, and what the open gate refers to:**

1. **Credential storage** — `storeToken`, `readKeychainToken`, `loadToken`.
2. **Profile persistence** — `profilePath`, `readProfile`, `writeProfile`.
3. **Lark login** — `login`.
4. **Run-result classification** — `collectRunAssistantText`,
   `collectProtectedRunMetadata`, `gatewayActionState`,
   `completedGatewayFallback`, `terminalRunError`.
5. **The JSONL wire protocol** — `class JsonlRpc`.
6. **The interactive approval responder** — `ask`, `createExtensionResponder`,
   `createHeadlessExtensionResponder`.
7. **The CLI** — `status`, `parseArguments`, `main`.

Rules for every extraction:

- move policy and tests together;
- the compatibility-façade rule that stood here is retired: the façade was
  deleted once the seams were proven, and re-creating it would undo that;
- do not change behavior and module structure in the same commit. **The
  turn-plan slice broke this rule**: the façade deletion is a pure move, and the
  effects seam, the phase record and the image hoist are behaviour, and they
  share one working tree because each rewrites the same function. Split them at
  commit time if the history matters more than the review already done;
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

### Phase B — Audit Cloud-only flags and compatibility code — **complete (2026-08-14)**

Delivered in `58c1e5450` and `2ee208cc8`. The register lives in
`divo-pi/divo/test/runtime-flags.test.mjs` rather than in prose: twelve flags,
each with who sets it and the one thing it decides, enforced so a new read
without an entry fails and an entry that outlives its last read fails too. One
reader per flag is enforced as well.

Classifications:

- permanent deployment configuration — `DIVO_PI_IMAGE`, `DIVO_PI_RESOURCE_PREFIX`,
  `DIVO_PI_ADD_HOST_GATEWAY`, `DIVO_PI_ENTRY_MODE`, `DIVO_CONTROLLER_HOST`,
  `DIVO_CONTROLLER_PORT`, `MAX_ACTIVE_RUNS`;
- deliberate and documented but unset — `DIVO_PI_KEEPALIVE`, the way to take
  warm process reuse out of the picture during an incident without shipping
  code; `DIVO_NATIVE_SKILLS_ROOT`, `DIVO_BOOTSTRAP_PATH`,
  `DIVO_INTERRUPTION_PATH`, `DIVO_BACKEND_URL`;
- removed — `DIVO_LOCAL_CLI_DISABLED`, and `DIVO_DEV_PI_MAX_ACTIVE_RUNS` from
  `infra/development/.env.example`.

**The flag audit's real finding was not a dead flag.** `DIVO_LOCAL_CLI_DISABLED`
was stripped from the child environment before Pi started, so `localCliEnabled()`
was always true inside the container: the "no divo-local here" prompt was
unreachable, and a broker that failed to start still told the model its client
existed. The prompt now tracks `DIVO_LOCAL_BROKER_SOCKET`, which the broker
publishes only after listening and every failure path restores. Three sibling
texts — the persona, the workspace prompt, the router skill — named divo-local
unconditionally; the workspace prompt is rendered before any broker has tried
to listen, so the unavailable block states outright that it outranks them.

**Left as an open product decision.** `MAX_ACTIVE_RUNS` is 2 on localprod and
the built-in 8 on main and dev. The dev env example asked for 2 and never
reached anything, so dev has always run 8; wiring it now would have cut
deployed concurrency silently. Decide the number before Phase D loads dev.

Four Opus cold-review rounds. Two rounds caught defects in the fixes
themselves — a dev concurrency regression introduced by the first attempt at
that last point, and the "absent by design" prompt copy left asserting intent
once its only reachable causes had become failures.

### Phase B — original scope

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
  divo/test/ndjson-stream-writer.test.mjs \
  divo/test/runtime-turn-plan.test.mjs \
  divo/test/runtime-turn-phases.test.mjs \
  divo/test/auth.test.mjs \
  divo/test/container-entry.test.mjs

# The backend half of the same boundary — the lease contract and the one
# request a turn still makes. Both sides must move together.
cd ../advance-backend
npx tsx --test \
  tests/http/desktop-auth.routes.test.ts \
  tests/http/member-auth.middleware.test.ts

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

Phase B is complete. **Phase A's exit gate is open** — its four modules landed
and the turn plan now takes its effects as an argument, but keychain storage,
profile persistence, Lark login, run-result classification, the JSONL wire
protocol, the approval responder and the CLI are all still in
`local-rpc-controller.mjs`, so "controller primarily coordinates modules" is not
yet true. Either finish those extractions or reopen the gate deliberately;
do not treat Phase A as closed.

Then start **Phase C — but capture the baseline first and change nothing while
capturing it**. Optimising the 58,027 uncached input
tokens by intuition is the failure this plan exists to prevent, and every gate
in that phase is stated relative to a measurement nobody has taken yet.

Two decisions are waiting and neither belongs to Phase C: what `MAX_ACTIVE_RUNS`
should be on main and dev, and whether the 38-tool permanent schema cost is
worth a separate product conversation once duplication is out of the prompt.

Do not open or modify `jan/` while performing this work.
