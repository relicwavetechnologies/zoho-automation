# Pi-native skills and terminal-first export simplification

> Status: **Phase 2 complete; Phase 3 in progress**
>
> Last updated: **2026-08-10**
>
> Confidence: **91%**
>
> Scope: cloud Pi only, DB-backed skills, governed terminal
> workflows, and staged retirement of the model-facing export pipeline.

## 1. Target outcome

Divo should use Pi's own skill architecture and ordinary file-based agent work:

```text
authorized DB skills -> runtime-owned SKILL.md files -> Pi native skill loader

user request -> source/destination skills -> one persistent Python file
             -> credential-free divo-local -> governed backend tools
             -> file or Google destination -> read-back verification
```

The backend remains the only authority for identity, RBAC, connections, SaaS
credentials, approvals, schemas, rate limits, and audit.

## 2. Locked decisions

1. **Do not rewrite `divo-pi/runtime.mjs`.** Keep it as the process, isolation,
   directory, extension, and skill bootstrap layer. Make only bounded changes.
2. **DB skills must become Pi-native.** `divo_skill_view` tool-result injection
   is a compatibility path, not the final skill architecture.
3. **Skills are guidance, not authorization.** Missing or stale skill text must
   not deny an otherwise permitted ordinary tool call.
4. **Use terminal-first workflows for data movement.** Rows stay in local
   files and governed tool calls, not model context.
5. **Do not delete `dataExport` yet.** Several providers do not expose safe
   pagination to Python, cloud runs are bounded, and protected Shopify records
   are currently blocked from `divo-local`.
6. **Delete the old export state machine only after a real cloud E2E passes.**
7. **General skill rewriting is deferred.** This project rewrites only export,
   data-router, and directly contradictory provider guidance.

## 3. Current state

- Bundled `divo-gateway` and `divo-chat-history` skills already load natively
  through Pi's `--skill` option.
- Authorized DB skills are materialized as runtime-owned `SKILL.md` files and
  loaded by Pi's native resource loader.
- The custom `divo_skill_view` tool and process-local skill provenance ledger
  have been removed. Skills are guidance; backend policy remains authoritative.
- `dataExport` still owns candidates, plans, samples, queues, Lark cards,
  workers, provider replay, Google delivery, and follow-up continuity.
- Cloud `divo-local` enablement is committed in `0d1c083fe`. The launcher lives
  under runtime-owned `DIVO_HOME`, survives warm turn rotation, and is removed
  on session shutdown.

## 4. Delivery phases

### Phase 0 — Stabilize the interrupted slice

- [x] Review the seven-file diff; remove stale desktop/server assumptions.
- [x] Stage the launcher under runtime-owned `DIVO_HOME` so it survives warm
      turn rotation; keep the Unix socket under `/tmp`.
- [x] Verify the CLI carries no member or SaaS credentials.
- [x] Run runtime, broker, routing-policy, and skill-authorization tests.
- [x] Commit only when the focused suite is green.

Verification: Divo runtime 160/160; gateway extension 143/143; focused runtime
32/32; focused gateway/broker/routing 55/55; bundled skill validation passed.

**Exit gate:** clean worktree and one focused commit; no export behavior claim.

### Phase 1 — Native DB-skill materialization spike

- [x] Add an authenticated bootstrap response containing only currently
      authorized skill definitions and one `registryRevision`.
- [x] Materialize each skill into a runtime-owned, non-user-writable
      `<slug>/SKILL.md` directory before Pi starts.
- [x] Convert DB identity fields into valid Pi skill frontmatter.
- [x] Pass materialized directories through Pi's existing `--skill` arguments.
- [x] Prove Pi lists the skills in `<available_skills>` and reads the selected
      `SKILL.md` only when relevant.
- [x] Reject malformed slugs, duplicate names, unsafe paths, and oversized
      Markdown without starting Pi with a partial ambiguous catalogue.

Unit proof: Cloud-Pi runtime 165/165; authenticated runtime route 56/56; Pi's
native loader discovered the rendered test skill with zero diagnostics. The
live blocker was `prepareDivoPiRun()` dropping the authenticated `nativeSkills`
flag before argv construction. After preserving it, the real Cloud-Pi run
reported 59 loaded skills, 57 DB-native skills, and 59 model-exposed entries;
the transcript then used Pi's `read` tool on
`/run/divo-skills/current/google-sheets/SKILL.md`.

**Exit gate:** one authorized DB skill is discovered and read through Pi's
native loader in an isolated cloud-Pi test.

**Rollback:** disable materialization and retain the existing catalogue plus
`divo_skill_view` compatibility path.

### Phase 2 — Cut over DB skills to Pi-native loading

- [x] Materialize all RBAC-visible routers and specialists for the run.
- [x] Build a fresh authorized catalogue per runtime instead of introducing a
      cross-scope cache.
- [x] Keep only compact persona/account/tool context in the injected prompt.
- [x] Stop asking Pi to repeatedly load already-native skills.
- [x] Remove custom skill-loading provenance as an authorization concept;
      retain backend audit metadata only where useful.
- [x] Remove `divo_skill_view`; keep `divo_skill_resolve` only as a bounded
      fallback when no native router covers a genuinely specialized workflow.

Proof: the live Cloud-Pi transcript read the native Gmail, Google Workspace,
Sheets, Mail Ops, and Schedule Divo Work files directly, with no resolver,
compatibility loader, or governed mutation. Gateway extension tests pass
140/140; controller projection tests 45/45; runtime boundary tests 34/34.

**Exit gate:** DB routers and specialists use native Pi discovery in cloud Pi,
with no repeated skill-fetch loop.

### Phase 3 — Finish the governed terminal foundation

- [x] Make `divo-local` available in cloud Pi through the Divo extension.
- [x] Keep scripts credential-free; the broker attaches runtime identity and
      the backend rechecks RBAC, connection access, approval, and schema.
- [x] Strip model/script-supplied `skillId`; skills are not authorization or
      execution provenance.
- [x] Keep one persistent `.py` file, adjacent inputs, outputs, and checkpoint.
- [ ] Verify create/write/read-back without moving rows through model context.

**Exit gate:** cloud Pi runs a Python file that invokes one governed read and
one governed Google write through `divo-local`.

### Phase 4 — Make source and destination contracts export-capable

Standardize machine-readable paging without creating a universal provider
abstraction prematurely:

- [ ] Semrush: explicit cursor/offset, coverage, quota failure, and caps.
- [ ] OMS and Menhood: bounded page/stream contract instead of preview-only
      results; preserve safe query validation.
- [ ] Zoho Books and CRM: explicit stable pagination in public tool contracts.
- [ ] Shopify: decide and test the protected Orders/Customers policy before
      allowing local file retention.
- [ ] Airtable: use a bounded backend connector/REST paging path; do not turn
      MCP preview calls into bulk export.
- [ ] Google Sheets: create, chunked write/append, and exact-range read-back.
- [ ] CSV/XLSX/Drive: define a governed file-upload path that does not place
      file bytes inside the broker's 1 MB JSON request.

**Exit gate:** every migrated source can page to disk with truthful counts,
resume tokens, caps, and failure classification.

### Phase 5 — Rewrite only export-related skills and routers

- [ ] Replace candidate/plan/sample instructions with the direct route:
      source specialist -> local Python -> destination specialist.
- [ ] Keep instructions short: choose source, page to disk, transform locally,
      write destination, verify counts, report limits.
- [ ] Update `data-router` and `research-router` first.
- [ ] Remove contradictory export text from Semrush, OMS, Menhood, Shopify,
      Zoho, Airtable, files/documents, and Google guidance as each contract
      migrates.
- [ ] Keep a temporary `dataExport` compatibility instruction only for sources
      that still lack the new contract; never fake missing rows.

**Exit gate:** no active skill gives two competing export recipes for a
migrated provider.

### Phase 6 — Local Cloud-Pi stack and E2E proof

Run the same container and backend architecture locally before any deployment:

- [ ] Read `AGENTS.local.md`; start the Development database tunnel, Redis,
      backend stack, and locally built Cloud-Pi container using its documented
      commands and local-only credentials.
- [ ] Execute tests against Development services only. Never point a replaying
      agent, worker, webhook, queue, or migration command at Main/Production.
- [ ] Use the same Lark/cloud channel, runtime admission, extension, native
      skills, workspace layout, and backend gateway used by deployed Cloud Pi.

Build a regression prompt corpus from production evidence:

- [ ] Query Production traces read-only for representative failed and successful
      prompts, tool lifecycles, skill-load loops, export attempts, Sheet edits,
      account ambiguity, retries, and final-answer mismatches.
- [ ] Copy only the minimum sanitized prompt and expected invariant into local
      scenario fixtures. Never copy credentials, tokens, private row data,
      production connection IDs, artifact IDs, chat IDs, or raw trace payloads.
- [ ] Replay those prompts against the local Cloud-Pi container and Development
      backend/data; do not replay against Production.
- [ ] For every replay, inspect the complete lifecycle: native skill discovery,
      skill reads, Python file creation/edit/rerun, governed calls, pagination,
      destination writes, read-back, retries, final response, and cleanup.
- [ ] Record expected versus actual tool sequence, row counts, errors,
      completion time, context size, and final-answer truthfulness.

Required primary scenario:

```text
source pages -> JSONL/Parquet -> Python transform -> Google Sheet
             -> exact read-back -> source/written/verified counts reconcile
```

- [ ] Test 1, 10, 100, multi-page, capped, and empty datasets.
- [ ] Test permission denial, approval, expired connection, quota, timeout,
      retry, interruption, and resumed checkpoint behavior.
- [ ] Confirm no credential appears in environment, script, logs, or artifact.
- [ ] Confirm no bulk rows appear in Pi context or transcript.
- [ ] Confirm mutations are not duplicated after ambiguous failures.
- [ ] Repeat the primary flow through the locally running Cloud-Pi container,
      not through Agent Seat alone.

**Exit gate:** real Google artifact link, verified values, reconciled counts,
and trace evidence showing only governed calls.

### Phase 7 — Staged cutover from `dataExport`

- [ ] Stop publishing `exportCandidate` for one verified provider at a time.
- [ ] Remove that provider's candidate, replay adapter, and permission coupling.
- [ ] Observe error rate, completion time, row accuracy, and context size.
- [ ] Decide the long-running-job boundary from evidence:
  - interactive/bounded work stays in terminal;
  - if work can exceed the Pi run limit, retain one minimal backend async job
    surface rather than the current candidate/offer/sample state machine.
- [ ] Preserve Google resource continuity and workbook conversion separately;
      they are not inherently part of export planning.

**Exit gate:** all supported providers use the new route or one deliberately
retained generic async boundary; `dataExport` has no model-facing callers.

### Phase 8 — Hard removal and database cleanup

- [ ] Remove the `dataExport` tool, labels, derived permissions, candidates,
      plans, offers, cards, source adapters, queue/worker wiring, and dead tests.
- [ ] Split workbook-conversion handling before deleting mixed Lark handlers.
- [ ] Drain or explicitly expire in-flight jobs and offers.
- [ ] Back up Development and verify rollback before Prisma model removal.
- [ ] Delete candidate/plan/offer tables in a separate reviewed migration.
- [ ] Update old export plans/docs to mark them superseded, not silently true.

**Exit gate:** no dead export authority remains and the schema migration has a
tested rollback path.

### Phase 9 — Observability and final cleanup

- [ ] Measure skill discovery/read count, resolver fallback count, tool retries,
      rows read/written/verified, and terminal versus async completion.
- [ ] Add regressions for skill reload loops and conflicting export guidance.
- [ ] Run a cold architecture/code review after the complete cutover.
- [ ] Rewrite other bloated skills only as a separate project backed by failed
      evaluations, not as drive-by cleanup.

## 5. Explicit non-goals

- Rewriting Pi core or the entire Divo container runtime.
- Jan/Desktop implementation or parity work.
- Moving OAuth tokens, RBAC, approval, or SaaS SDK credentials into Pi/Python.
- Making prompts responsible for security enforcement.
- Deleting queues or database tables before in-flight work is handled.
- Rewriting every skill during the export migration.
- Treating a bounded preview as a complete export.

## 6. Success criteria

The project is complete only when all are true:

1. Authorized DB skills appear and behave as native Pi skills.
2. Pi does not repeatedly fetch/read the same skill during one run.
3. Interactive exports use one persistent file-based workflow.
4. Source, written, and verified row counts reconcile.
5. No credentials or bulk rows pass through model context.
6. Backend RBAC, approvals, schemas, and audit remain authoritative.
7. The old export tool/state machine is removed or reduced to one explicitly
   justified generic async boundary.
8. Sanitized production-derived prompts pass through the locally running
   Cloud-Pi container and Development backend with lifecycle evidence.

## 7. Recommended execution order

Work strictly in phase order. Do not start hard removal while native DB-skill
loading, provider pagination, or cloud E2E remains unproven. The next concrete
action is the isolated **Phase 1 native-skill spike**.
