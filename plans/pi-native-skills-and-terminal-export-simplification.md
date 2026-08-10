# Pi-native skills and terminal-first export simplification

> Status: **Native-skill hardening and Phases 4–6 in progress**
>
> Last updated: **2026-08-10**
>
> Confidence: **94%**
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
- `dataExport` still owns compatibility candidates, plans, queues, Lark cards,
  workers, provider replay, Google delivery, and follow-up continuity. Its
  model-facing sample/confirm workflow has been removed: a valid explicit plan
  queues the full governed job after destination and policy checks.
- Cloud `divo-local` enablement is committed in `0d1c083fe`. The launcher lives
  under runtime-owned `DIVO_HOME`, survives warm turn rotation, and is removed
  on session shutdown.
- Zoho CRM and Books now expose their existing provider pagination through the
  public governed tool contracts for terminal callers.
- Semrush's three exposed operations are bounded complete calls, not paged
  lists. OMS is a provider-limited 100-row snapshot with no upstream cursor or
  total; Divo must not invent pagination for either source.

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

### Phase 2A — Harden native bootstrap and reuse

- [x] Degrade oversized catalogues deterministically by existing `sortOrder`
      within count and byte budgets; log every omitted slug instead of aborting
      the whole run.
- [x] On bootstrap failure, clear DB-native materialization and continue with
      bundled skills only. Never reuse a stale catalogue without an exact
      user, department, permission, channel, and revision match.
- [x] Use `registryRevision` plus a scope/catalogue digest to skip unchanged
      Docker staging within a controller lifetime and persist the digest beside
      the materialized catalogue.
- [x] Allow warm Pi reuse only for an identical startup catalogue digest;
      discard and restart before staging any changed digest.
- [x] Measure cold start, unchanged warm turn, and revision-change restart.
- [x] Reject DB slugs reserved by bundled Pi skills before discovery.
- [x] Directly test read-only tree cleanup, atomic swap, and failure preserving
      the prior catalogue in the staging script.
- [x] Audit shared/group Lark runs so DB-native roots follow the same scoped
      resource policy as extensions, trusted skills, and tool allowlists.
- [ ] Keep the slug as Pi's native `name`; preserve the human title in the
      description because Pi skill names cannot contain spaces or capitals.

Cloud-only note: the runtime-context endpoint currently resolves permission as
`lark`, which is correct for Cloud Pi. Desktop/Jan channel separation is outside
this plan.

**Exit gate:** catalogue growth or a transient bootstrap fault cannot take down
Cloud Pi, stale authorization cannot leak across scopes, unchanged turns avoid
restaging, and staging behavior has direct regression coverage.

Current proof: the backend keeps the existing priority order while enforcing
the 100-skill and 2 MB budgets and logs omissions. Cloud Pi converts transient,
malformed, or server-side bootstrap failures into an atomically staged empty DB
catalogue, while 4xx authorization failures remain fatal. Controller tests pass
50/50 and the authenticated runtime route suite passes 57/57. An unchanged
scope and catalogue now skips its Docker staging process; a changed department,
revision, or skill body produces a new digest and restages atomically. Shared
runs have distinct disposable skills volumes, retain authorized department
skills, and still exclude direct-message history resources. Lifecycle logs now
report only revision, count, digest prefix, stage decision, timing, and audience.
Local Cloud-Pi evidence: the cold turn staged skills and started Pi in 25.0 s;
the identical turn skipped staging and reused Pi in 18.8 s; changing one
Development skill body changed the digest, restaged, and cold-started Pi in
20.0 s. The exact original skill body was restored immediately afterward.

### Phase 3 — Finish the governed terminal foundation

- [x] Make `divo-local` available in cloud Pi through the Divo extension.
- [x] Keep scripts credential-free; the broker attaches runtime identity and
      the backend rechecks RBAC, connection access, approval, and schema.
- [x] Strip model/script-supplied `skillId`; skills are not authorization or
      execution provenance.
- [x] Keep one persistent `.py` file, adjacent inputs, outputs, and checkpoint.
- [x] Add a broker-owned `--output` path for governed results larger than the
      96 KiB model ceiling; only a signed Cloud-Pi `tools.invoke` may request
      it, files stay inside `DIVO_RUN_DIR`, and an 8 MiB hard cap remains.
- [x] Verify create/write/read-back through one governed Python execution.

Proof: a fresh locally built Cloud-Pi container read the native Google Sheets
and Python skills, wrote one persistent script, created a real disposable
Sheet, wrote `A1:B4`, and read back the exact range. The final response repeated
the canonical URL and reconciled `3` source data rows, `4` total written rows,
and `4` verified rows. The transcript used no `dataExport` call, no custom skill
loader, one file write, and one Bash execution; the script contained no token,
credential, raw backend URL, or direct SaaS call.

**Exit gate:** cloud Pi runs a Python file that invokes one governed read and
one governed Google write through `divo-local`.

### Phase 4 — Make source and destination contracts export-capable

Standardize machine-readable paging without creating a universal provider
abstraction prematurely:

- [x] Semrush: classify the three exposed operations as bounded complete calls;
      preserve their existing coverage and failure reporting without fake
      cursor fields.
- [x] OMS: keep the 100-row result explicitly provider-limited until the
      upstream webhook exposes stable pagination and a total.
- [ ] Menhood: retain the backend async stream. Its current PostgreSQL cursor
      is transaction/connection-scoped and cannot be resumed across terminal
      calls; replace it only if a safe stateful stream boundary is designed.
- [x] Zoho Books and CRM: expose stable provider pagination in the public tool
      contracts (`page` for Books; `page`/`pageToken` for CRM).
- [ ] Shopify: decide and test the protected Orders/Customers policy before
      allowing local file retention. Normal deep pagination now stops
      truthfully at 25,000 rows; larger reads require Bulk Operations.
- [ ] Airtable: use a bounded backend connector/REST paging path; do not turn
      MCP preview calls into bulk export.
- [ ] Google Sheets: create, chunked write/append, and exact-range read-back.
- [ ] CSV/XLSX/Drive: define a governed file-upload path that does not place
      file bytes inside the broker's 1 MB JSON request.

**Exit gate:** every migrated source can page to disk with truthful counts,
resume tokens, caps, and failure classification.

### Phase 5 — Rewrite only export-related skills and routers

- [x] Replace Zoho candidate/plan/sample instructions with the direct route:
      source specialist -> local Python -> destination specialist.
- [x] Keep the migrated Zoho instructions short: choose source, page to disk,
      transform locally, write destination, verify counts, report limits.
- [ ] Apply the same concise route to each provider only after its source
      contract migrates.
- [x] Update `data-router` for Zoho while retaining explicit compatibility
      routing for providers without terminal-safe pagination.
- [ ] Update `research-router` after its sources have a proven direct route.
- [ ] Remove contradictory export text from Semrush, OMS, Menhood, Shopify,
      Airtable, files/documents, and Google guidance as each contract migrates.
- [ ] Keep a temporary `dataExport` compatibility instruction only for sources
      that still lack the new contract; never fake missing rows.
- [x] Remove `dataExport op=sample` and `op=confirm_sample` from the typed tool,
      orchestration service, skills, and routers. Explicit valid plans now go
      directly to the full governed job; legacy persistence/worker fields stay
      only until pre-cutover jobs are drained.

Current proof: Zoho Books exposes `page`/`nextPage`; Zoho CRM exposes
`page`/`nextPage`/`pageToken`; their native skills, data router, Python skill,
Google workflow guidance, and model-facing tool descriptions now agree on the
terminal-first route. The focused skill/router suite passes 26/26 and the
focused Zoho tool suite passes 71/71.


**Exit gate:** no active skill gives two competing export recipes for a
migrated provider.

### Phase 6 — Local Cloud-Pi stack and E2E proof

Run the same container and backend architecture locally before any deployment:

- [x] Read `AGENTS.local.md`; start the Development database tunnel, Redis,
      backend stack, and locally built Cloud-Pi container using its documented
      commands and local-only credentials.
- [x] Execute tests against Development services only. Never point a replaying
      agent, worker, webhook, queue, or migration command at Main/Production.
- [x] Use the same Lark/cloud channel, runtime admission, extension, native
      skills, workspace layout, and backend gateway used by deployed Cloud Pi.

Build a regression prompt corpus from production evidence:

- [x] Query Production traces read-only for representative failed and successful
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
- [x] Confirm no credential appears in environment, script, logs, or artifact.
- [x] Confirm no bulk rows appear in Pi context or transcript.
- [ ] Confirm mutations are not duplicated after ambiguous failures.
- [x] Repeat the primary flow through the locally running Cloud-Pi container,
      not through Agent Seat alone.

Current proof: local Cloud Pi read the native Zoho Books, Python, and Google
skills; wrote one persistent 329-line Python script; paged three June invoices
to JSONL; created and wrote a real Google Sheet; then read back three rows. The
backend logged only governed `zohoBooks` and `googleSheets` calls, the script
contained no credential or backend URL, and source/written/verified counts were
`3/3/3`. The empty July dataset also completed as `0/0/0` without creating an
empty artifact. Multi-page and failure scenarios remain open.

A focused 10-row terminal regression also exposed and closed a skill-ordering
failure. Before the fix, Pi skipped the Zoho source skill, counted nine keys in
the provider object as invoices, and probed preview data while repairing the
script. After the advisory contract was tightened, a fresh local Cloud-Pi run
used exactly six calls: connection selection, Python-skill read, Zoho-skill
read, run-directory lookup, one file write, and one Bash execution. It saved
10 invoices (6,741 bytes), reported page 2 truthfully, emitted no provider rows
in tool results, and never called `dataExport`.

The read-only Production census covered 416 user messages from the retained
30-day window; 52 mentioned export, Sheet, Excel, CSV, or workbook work. One
representative “create this in Google Sheet” run made 14 governed calls with
four failures: one upstream 502 and three preventable native-input mistakes
(missing range, wrong formatting shape, and wrong resize fields). No raw row
data or production identifiers were copied into this plan.

The Development replay now proves both creation and follow-up editing. A fresh
Cloud-Pi run read the Google Sheets and Python skills once, wrote one script,
executed it once, created a real Sheet, and reconciled `3/3/3` in seven Pi tool
calls without `dataExport`. A second run on the same Sheet formatted the header,
resized columns, and preserved a complete three-row read-back. It used 15 Pi
calls because URL resolution required an account choice and two exact mutation
schemas; those metadata descriptions no longer consume connection data budgets.
Real Google create/update/read calls remain rate-limited and governed.

The full April–July Zoho expense replay now passes the primary multi-page
scenario. Cloud Pi read the native Zoho Books, Python automation, and Google
Sheets skills, wrote one persistent script, and used three Bash executions
while correcting the script in place. The final run fetched 1,110 expenses
across 45 governed pages, wrote 1,111 Sheet rows including the header, and
verified the top and last rows. The Pi transcript contained 13 top-level tool
calls and no `dataExport`; the script contained no credential, member token,
or backend URL. The real Sheet link and `1,110/1,110/verified` outcome were
delivered through the production Lark final-card path. This run also exposed
and removed two stale hard-coded page-20 limits: schema, docs, and `nextPage`
now share one 100-page ceiling, with a regression proving page 20 returns 21.

**Exit gate:** real Google artifact link, verified values, reconciled counts,
and trace evidence showing only governed calls.

### Phase 7 — Staged cutover from `dataExport`

- [ ] Stop publishing `exportCandidate` for one verified provider at a time.
- [ ] Remove that provider's candidate, replay adapter, and permission coupling.
- [ ] Observe error rate, completion time, row accuracy, and context size.
- [ ] Decide the long-running-job boundary from evidence:
  - interactive/bounded work stays in terminal;
  - if work can exceed the Pi run limit, retain one minimal backend async job
      surface rather than the remaining candidate/offer state machine.
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
