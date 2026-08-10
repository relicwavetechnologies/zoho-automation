# Cloud-Pi runtime optimization, consistency, and proof

> Status: **Active plan — owned by the primary runtime agent**
>
> Last updated: **2026-08-10**
>
> Scope: **all remaining Cloud-Pi work except skill-body rewriting and DB skill-content rollout**
>
> Explicitly out of scope: **Jan/Desktop parity and rewriting DB skill prose**

## 1. Executive recommendation

Do not rewrite the Cloud-Pi runtime again. Its core architecture is now sound:
native DB skills, typed governed tools, isolated containers, file-backed local
work, digest-bound warm reuse, and backend-owned authority are implemented.

The remaining job is to make that architecture consistently fast, resumable,
observable, failure-safe, and proven across the full tool surface. Work in
small vertical slices, fix only evidence-backed root causes, and keep the
production tool tracker as the proof ledger.

This plan deliberately treats **warm Pi reuse and native bootstrap as achieved
features to audit and benchmark**, not blank-slate features to build again.

## 2. Rolling context: achieved foundation

- Lark turns use isolated Cloud Pi only; there is no fallback to the old Vercel
  orchestration engine.
- The authenticated bootstrap returns an RBAC-filtered native skill catalogue
  with `registryRevision`.
- The controller validates count/byte/path/reserved-slug constraints and stages
  an atomic read-only native skill tree.
- Transient bootstrap failure stages an empty DB catalogue plus bundled skills;
  authorization failure remains fatal.
- Scope and catalogue content are hashed. Identical staging is skipped.
- Warm Pi reuse is private, thread-scoped, and bound to profile, thread,
  backend, department, provider, model, and native-skill digest.
- Digest mismatch, protected-data runs, shared/run-scoped sessions, reset, and
  lifecycle boundaries discard the cached Pi process.
- Backend contracts register as individual typed Pi tools; the mega-tool and
  Teach cloud pipeline are gone.
- Prompt-relevant nested Google/Airtable input contracts are bound before
  inference.
- The extension reports any registered tool filtered from Pi's active
  allowlist; focused regression coverage already exists.
- Read-only capability tools run in parallel only when every reachable action
  is read-only.
- `divo-local` carries no member/SaaS credential, uses governed backend calls,
  auto-files large results, owns bounded retry, and keeps bulk rows outside the
  model transcript.
- The local run-engine harness can execute the real backend/controller/image
  path and deliver through the intended Lark lifecycle.
- Google Workspace MCP is pinned to `1.22.2`; Development proved reads beyond
  the old 50-row renderer cap.
- Provider exports retain one governed backend boundary while direct terminal
  paths mature. The current uncommitted export-policy slice makes new provider
  exports company-owned and invoker-reader only.

Key recent commits: `7ddb2426c`, `299cddf39`, `04d3e6306`, `88c7ddde9`,
`7941b839e`, `aca9b6656`, `c9ca10ce9`, and `9330237a1`.

## 3. Strict boundary with the skills plan

This plan may change runtime, gateway, typed tools, providers, storage,
container lifecycle, telemetry, queues, infrastructure, and tests.

It must not rewrite skill bodies to hide a runtime/tool gap. When a runtime fix
requires updated guidance, record the exact new invariant for the skills agent
and let that track make the prose change in its next two-skill pair.

Likewise, the skills agent must not modify `divo-pi/`, gateway authorization,
provider adapters, container lifecycle, or policy code.

## 4. Priority order

1. Land and verify the current export-policy slice on a clean baseline.
2. Prove bootstrap and warm reuse through real process lifecycle evidence.
3. Fix context growth, run-file persistence, and terminal helper reliability.
4. Complete typed-contract/allowlist parity and error-state proof.
5. Close provider/data-movement capability gaps without new exception prose.
6. Prove recovery, idempotency, isolation, and queue semantics.
7. Execute the full tool-family E2E matrix and measure performance.
8. Remove compatibility code only after evidence and explicit deletion review.

## 5. Phase 0 — clean baseline and current slice

- [ ] Inspect and commit the current company-owned export-policy changes as one
      isolated slice after its focused tests pass.
- [ ] Do not mix skill-rewrite work into that commit even though some export
      and router definitions are necessarily corrected by the policy change.
- [ ] Record the exact SHA, test commands, and known rollout prerequisite:
      Development and Main each need an admin-connected company Google account
      selected as the export profile.
- [ ] Verify the worktree is clean before either plan starts parallel work.

Exit gate: one reviewable commit, clean `dev`, no untracked build artifacts,
and the skills agent can branch without overwriting active changes.

## 6. Phase 1 — native bootstrap and warm-reuse proof

The implementation exists. This phase proves it and adds only missing
observability/regressions.

- [ ] Run a fresh private thread: cold stage and cold Pi start.
- [ ] Run an unchanged second turn: bootstrap fetch, identical digest, staging
      skip, and actual process reuse.
- [ ] Change one Development skill body/revision: new digest, atomic restage,
      cached process discard, and cold Pi restart.
- [ ] Change department, model, backend/profile, and thread separately; each
      must break the binding for the documented reason.
- [ ] Prove shared, run-scoped, protected-data, reset, and lifecycle runs never
      reuse a private warm process.
- [ ] Restart the controller with an existing valid marker and prove safe
      behavior; malformed/missing markers must restage.
- [ ] Prove bootstrap 5xx/transient failure produces bundled-only startup and
      401/403 remains fail-closed.
- [ ] Capture `fetchMs`, `stageMs`, ready/cold/warm timing, digest prefix,
      replacement reason, RSS, and active context size without logging skill
      content or slugs.

Exit gate: the same real container demonstrates cold → warm → changed-restart,
with unit tests and structured logs agreeing on every decision.

Likely files:

- `divo-pi/divo/local-rpc-controller.mjs`
- `divo-pi/divo/runtime.mjs`
- `divo-pi/divo/test/local-rpc-controller.test.mjs`
- `divo-pi/divo/test/runtime.test.mjs`
- local runtime harness scripts/tests

## 7. Phase 2 — bounded conversation context

Current evidence (`CONTEXT-001`, `HISTORY-001`) shows long-lived tests reaching
roughly 100k–131k cached tokens and history retrieval paging hundreds of
messages into the active model context.

- [ ] Establish fresh-thread baselines for the same short Docs/Sheets prompt.
- [ ] Attribute tokens to system prompt, native skill reads, current turn,
      historical transcript, tool results, and local result references.
- [ ] Define a bounded compaction policy that preserves task state, approvals,
      irreversible actions, artifact IDs/URLs, counts, and unresolved errors.
- [ ] Keep the full audit transcript outside the active inference context.
- [ ] Add a bounded history-evidence/summarization path; never page an entire
      long chat into the current run.
- [ ] Provide stable references for the current run's result files so scripts
      do not search old UUID-named run directories.
- [ ] Prove a follow-up still understands the active artifact and prior
      irreversible actions after compaction.

Exit gate: repeated ordinary turns stay within a declared active-context
budget, while audit history and continuity remain correct.

## 8. Phase 3 — durable governed work files and terminal ergonomics

Current evidence (`RUNFILES-001`, `LOCALHELPER-001`) shows that turn-scoped
`DIVO_RUN_DIR` can delete fetched rows before a “proceed” follow-up, and that
model-written helpers can hide structured errors or derive unsafe filenames.

- [ ] Decide the boundary: complete the artifact in one turn, or introduce an
      explicit governed thread-work/checkpoint directory.
- [ ] If thread work is added, bind it to exact company/user/thread, apply size
      and age quotas, isolate shared/protected runs, and clean it deterministically.
- [ ] Never call a turn-scoped directory persistent in code, tests, or prompts.
- [ ] Provide one runtime-owned helper/fixture for safe filenames, argument
      files, local-file result parsing, structured errors, and checkpoints.
- [ ] Keep credentials, member tokens, raw backend URLs, and unrestricted
      network access absent from scripts and files.
- [ ] Test interruption between source page, checkpoint, destination write,
      read-back, and final status.
- [ ] Prove resume does not refetch completed pages or duplicate mutations.

Exit gate: a multi-turn approved workflow resumes from governed state with
truthful counts and no credential/context leak.

## 9. Phase 4 — typed-tool and allowlist parity

The surface is live; finish the parity and behavior matrix rather than adding
another wrapper.

- [ ] Generate/verify the invariant:
      `reachable backend contracts ⊆ runtime manifest allowlist = intended active Pi tools`.
- [ ] Fail CI when a newly registered backend tool is silently absent from the
      packaged runtime manifest or active Pi surface.
- [ ] Keep visible denial stubs for known but unauthorized tools; distinguish
      denied, unavailable, malformed schema, expired connection, and approval
      pending.
- [ ] For Google/Airtable, prove the exact selected native input branch is bound
      before inference for representative reads and mutations.
- [ ] Retire `divo_preflight` only after every nested family has equivalent
      typed validation; do not remove it by assumption.
- [ ] Add `prepareArguments` only where a repeated real compatibility failure
      proves it is needed.
- [ ] Evaluate `renderCall`/`renderResult` against the existing downstream tool
      cards; avoid a second visual vocabulary.
- [ ] Record invalid-argument retries, tool calls, wall time, and prompt tokens
      against the controlled baselines in `plans/pi-typed-tool-surface.md`.

Exit gate: zero rejected/filtered intended tools, exact nested schemas for the
tested operation, truthful error states, and measured improvement over the old
behavior.

## 10. Phase 5 — provider and data-movement capability gaps

Do not cut a provider away from `dataExport` until its replacement path passes
real paging, destination, and recovery tests.

### Menhood

- [ ] Keep the current backend async stream while its PostgreSQL cursor remains
      transaction/connection-scoped.
- [ ] Design a resumable stateful stream only if real workloads require terminal
      ownership; do not expose a dead cursor token.

### Shopify

- [ ] Decide protected Orders/Customers local-file retention policy.
- [ ] Prove truthful 25,000-row deep-pagination behavior.
- [ ] Use Bulk Operations for larger datasets rather than hiding a provider cap.

### Airtable

- [ ] Add/verify an authorized bounded REST/connector paging path for complete
      exports; MCP preview pagination is not bulk proof.
- [ ] Normalize linked/select objects and scan for unresolved object cells
      before declaring a Sheet complete (`EXPORTOBJECT-001`).

### Google/file destinations

- [ ] Prove create, chunked write/append, exact-range read-back, and counts past
      the old 50-row renderer issue in deployed Main (`VERIFY-001`).
- [ ] Define a governed resumable CSV/XLSX/Drive upload boundary that does not
      place file bytes inside the broker's JSON envelope.
- [ ] Preserve company owner + exact invoker reader policy for provider exports.

### Remaining provider gaps

- [ ] Add only the minimal read-only discovery operations required by natural
      Lark Base/Approval prompts (`LARKDISC-001`).
- [ ] Fix Knowledge read-versus-apply classification (`KNOWLEDGE-001`).
- [ ] Resolve Google API enablement and Forms/Apps Script scope gaps without
      retry prose (`GOOGLEAPI-001`).
- [ ] Resolve ambiguous connected-account selection through configured policy
      or one user clarification (`GOOGLEACCOUNT-001`).

Exit gate: each migrated source/destination reports truthful coverage, uses
governed identity, and survives its failure matrix before compatibility is
removed.

## 11. Phase 6 — queue, confirmation, and lifecycle truth

- [ ] Make `user_busy` truthful: either durably queue the turn or tell the
      member to retry. Never promise automatic execution without a queued job
      (`QUEUE-001`).
- [ ] Add a structured scale estimate before materially large exports. The
      model can ask one short confirmation, but the backend must own measured
      rows/bytes and destination limits (`EXPORTCONFIRM-001`).
- [ ] Keep independent read calls parallel; keep possible mutations sequential.
- [ ] Test concurrent ingress, duplicate webhook delivery, cancellation, and
      interruption during progress/final-card delivery.
- [ ] Verify that resumed runs know whether a mutation may already have
      succeeded before retrying.

Exit gate: status copy, queue state, approval state, and actual execution state
cannot contradict one another.

## 12. Phase 7 — failure recovery and idempotency

For each representative read and mutation, inject:

- [ ] process kill before the call;
- [ ] process kill during the call;
- [ ] provider success followed by dropped response;
- [ ] checkpoint persistence failure;
- [ ] backend restart;
- [ ] controller restart;
- [ ] expired/revoked member session;
- [ ] lease/lane expiry;
- [ ] VM/container restart;
- [ ] quota, timeout, and retry exhaustion.

Required assertions:

- [ ] no duplicated mutation after ambiguous success;
- [ ] no stale skill/tool authority reused;
- [ ] no credential in environment, script, log, trace, or artifact;
- [ ] no bulk rows in Pi context/transcript;
- [ ] source, transformed, written, and verified counts reconcile;
- [ ] permanent versus retryable failures are classified truthfully;
- [ ] cleanup failures remain observable and recoverable.

## 13. Phase 8 — full Cloud-Pi E2E program

Use `plans/cloud-pi-production-tool-e2e-tracker.md` as the single matrix and
issue ledger. Do not create a competing checklist.

### Development harness

- [ ] Use `advance-backend/scripts/run-engine-harness.ts` and
      `advance-backend/docs/cloud-pi-testing/07-local-runtime-harness-framework.md`.
- [ ] Show/record the exact natural prompt before firing it.
- [ ] Start each behavioral baseline in a fresh Pi context.
- [ ] Test no-tool chat, every typed read family, and disposable mutations.
- [ ] Test 1, 10, 100, multi-page, empty, capped, denied, expired, approval,
      rate, timeout, retry, interruption, and resume cases.
- [ ] Include private DM, shared/group scope, media/webhook, subagent, todo,
      memory, knowledge, and history surfaces.
- [ ] Inspect the complete JSONL trace, tool names, native skill lifecycle,
      local files, counts, final response, and cleanup.

### Main proof

- [ ] Deploy only a tested SHA through the normal release path.
- [ ] Configure Main-owned connections/profiles separately from Development.
- [ ] Run only the targeted safe production prompt approved for that batch.
- [ ] Prefer read-only calls; any created artifact must be disposable and in
      the invoking administrator's governed Google/Lark destination.
- [ ] Update the existing tool tracker and issue ledger immediately.

Completion follows the tracker gate: every active tool `[x]` or intentional
`[-]`, bulk sources reconciled, open issues owned/fixed/accepted, and no leaked
credentials, unbounded context rows, or duplicated mutations.

## 14. Phase 9 — performance and observability

Measure rather than infer:

- [ ] cold versus warm ready time;
- [ ] bootstrap fetch and native staging time;
- [ ] active prompt/cached tokens by component;
- [ ] tool calls, invalid-argument retries, and per-tool error rate;
- [ ] parallel versus sequential read wall time;
- [ ] provider wait versus model/runtime time;
- [ ] container RSS/CPU/disk and thread-work quota;
- [ ] queue depth, lane contention, cancellation, and recovery latency;
- [ ] context compaction frequency and retained continuity;
- [ ] artifact source/written/verified counts.

Add alerts only after the event/metric names are stable. Never log skill bodies,
tokens, raw provider rows, connection IDs, or private prompt content.

Exit gate: a cold/warm/failure dashboard or reproducible report explains where
time and errors actually come from for each tested family.

## 15. Phase 10 — controlled legacy cleanup

Cleanup is last because some old code still protects in-flight jobs or provider
fallbacks.

Candidates to review:

- `DataExportDestinationPreferenceRepository` and its table/test;
- personal-export destination preference branches;
- removed sample/confirmation persistence fields and worker branches;
- legacy candidate/offer compatibility after queued jobs drain;
- stale old Google company-connect route if the authenticated admin route fully
  replaces it;
- unused prompt/manifest compatibility checks;
- model-facing `dataExport` surface only after every provider cutover passes.

For each candidate:

1. prove zero active production callers and no in-flight persistence need;
2. name the schema/data impact and rollback;
3. get explicit deletion approval for destructive/schema cleanup;
4. remove code, tests, comments, routes, generated artifacts, and schema
   together—never leave silent dead code;
5. rerun the complete compatibility and deployment gate.

Do not modify vendored Pi core merely to make Divo cleanup easier.

## 16. Sub-agent protocol

Use sub-agents for consistency without allowing parallel authority:

1. **Evidence mapper (read-only):** map callers, contracts, tests, runtime logs,
   and existing plan claims before a slice.
2. **Adversarial reviewer (read-only):** search for bypasses, stale paths,
   cross-scope leaks, ambiguous retries, and destructive rollout risks.
3. **Primary agent:** owns all edits and runs the narrow tests.
4. **Cold reviewer:** independently reviews the final diff and test evidence.
5. **Primary agent:** resolves findings, runs the broadened gate, and commits
   explicit pathspecs.

Never let two agents edit the same file concurrently. Sub-agent conclusions
are evidence, not authority; the primary agent verifies them against code.

## 17. Verification commands and sources

Representative suites:

```bash
cd divo-pi
node --test divo/test/runtime.test.mjs divo/test/local-rpc-controller.test.mjs

cd divo-pi/divo/extensions/divo-gateway
node --import tsx --test *.test.ts

cd advance-backend
pnpm typecheck
node --import tsx --test \
  tests/http/desktop-auth.routes.test.ts \
  tests/application/gateway-work-resolve.test.ts \
  tests/scripts/run-engine-harness.test.ts
```

Broaden based on the touched slice. A passing unit suite is not a real
container claim.

Primary references:

- `plans/pi-native-skills-and-terminal-export-simplification.md`
- `plans/pi-typed-tool-surface.md`
- `plans/cloud-pi-production-tool-e2e-tracker.md`
- `plans/cloud-pi-single-vm-v1.md`
- `advance-backend/docs/cloud-pi-testing/07-local-runtime-harness-framework.md`
- `divo-pi/divo/local-rpc-controller.mjs`
- `divo-pi/divo/runtime.mjs`
- `divo-pi/divo/extensions/divo-gateway/`

## 18. Risks

| Risk | Mitigation |
| --- | --- |
| Rebuilding already-complete warm reuse | Treat code as achieved; run E2E and add only missing proof/telemetry |
| Digest covers skills, not tool-contract revision | Keep gateway authorization fresh; add explicit contract/manifest parity gate |
| Context compaction loses irreversible state | Preserve action ledger, approvals, artifacts, counts, and unresolved errors |
| Thread files leak or grow forever | Exact scope binding, quota, expiry, protected/shared isolation, deterministic cleanup |
| Provider gap becomes prompt exception | Record dependency; fix contract/backend rather than adding prose |
| Main data is mutated during testing | Read-only default; disposable governed artifacts; explicit per-batch approval |
| Compatibility deletion breaks in-flight work | Caller/data census, drain gate, rollback, explicit approval |
| Sub-agents create inconsistent edits | Read-only mapping/review; single editing owner per file |

## 19. Completion gate

This non-skills program is complete only when:

- [ ] native bootstrap and warm reuse pass real cold/warm/change lifecycle proof;
- [ ] active context remains within a declared budget across long threads;
- [ ] multi-turn governed checkpoints resume without refetch or duplication;
- [ ] every intended backend tool is typed, allowlisted, active, and truthful;
- [ ] every active tool family is passed or intentionally excluded in the
      production E2E tracker;
- [ ] provider/file cutovers have truthful paging, caps, and recovery evidence;
- [ ] failure injection proves no duplicated mutation or stale authority;
- [ ] performance numbers identify provider, model, runtime, and queue time;
- [ ] all legacy cleanup decisions are evidence-backed and approved;
- [ ] Development and Main deployment gates are documented and repeatable;
- [ ] the skills plan has no unresolved runtime dependency hidden in prose.

## 20. Rolling evidence template

```md
### Slice: <name> — YYYY-MM-DD
- Commit / image / environment:
- Exact prompt or injected failure:
- Cold or warm / digest decision:
- Active tools and native contracts:
- Tool sequence and parallelism:
- Context tokens and local files:
- Counts / artifact / read-back:
- Duration by model, provider, runtime, queue:
- Recovery / idempotency result:
- Security and scope checks:
- Tracker issue IDs updated:
- Skills-plan dependency discovered:
- Decision: complete / revise / blocked
```

