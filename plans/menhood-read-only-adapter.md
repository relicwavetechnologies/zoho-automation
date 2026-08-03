# Menhood Read-Only Airtable Adapter

## Status

- Overall: in progress
- Current wave: Wave 9 — awaiting deployment authorization
- Last synchronized: 2026-08-03
- Implementation: Waves 0–8 complete; Wave 9 deployment not started
- Release candidate: committed locally by the Git commit containing this ledger; deployment configuration remains local/untracked
- Review gates: 40%, 80%, and 100% passed.
- Maintainer rule: this file is the live execution ledger, not a retrospective document.

### Progress summary

- [x] Connected to the Menhood database using a read-only transaction.
- [x] Inventoried all five source tables and selected four for V1; advertisement costs are excluded.
- [x] Verified the supplied connection values already exist in the ignored local backend `.env`.
- [x] Traced the existing Airtable router, permission, preview, and connection behavior.
- [x] Traced the governed Sheet/CSV/XLSX export-offer pipeline end to end.
- [x] Confirmed that Menhood can reuse the existing export cards, queue, worker, sink, and delivery flow.
- [x] Identified the current 5,000-row global worker cap and the higher sink-specific capacities.
- [x] Verified the supplied Menhood login is a PostgreSQL superuser even though explicit read-only transactions report `transaction_read_only=on`.
- [x] Mapped the permission alias, export consistency, PII, and large-result decisions that require owner confirmation.
- [x] Added blocking cold-review/fix/re-review gates at the 40%, 80%, and 100% implementation milestones.
- [x] Simplified the V1 contract from owner feedback: existing Airtable feel, four tables, simple SQL checks, fresh export replay, and a 200 MB Menhood export cap.
- [x] Start Wave 0 implementation preparation.

## Decision

- Extend the existing Airtable experience; do not replace Airtable MCP.
- Keep normal Airtable record, schema, and automation work unchanged.
- Prefer the Menhood PostgreSQL sync for company analytics that need direct filtering, joins, grouping, or large result sets.
- Treat Menhood as one backend-managed company connection. Do not add a user connection picker, OAuth flow, admin connection UI, or Divo database model.
- Keep the internal database adapter separate from Airtable OAuth resolution, but route it through the existing Airtable router and cookbook so it is one user-facing capability.
- Reuse existing Airtable read authorization semantics, Divo audit, structured previews, and governed exports.
- The database credential stays in `advance-backend`; Pi receives neither the credential nor a database connection.

## Existing data

| Table | Rows observed | Purpose |
| --- | ---: | --- |
| `menhood_orders` | 160,713 | Order line items, status, payment, attribution, values |
| `menhood_customers` | 108,820 | Customer and delivery details |
| `menhood_products` | 414 | Product/SKU catalogue |
| `menhood_advertisement_costs` | 1,173 | Excluded from V1 by owner decision |
| `all_cities_with_pincode` | 19,358 | Pincode/city/state enrichment |

The three core tables are orders, customers, and products; the city/pincode table is an optional lookup. Orders are line-item grain: 160,713 rows represent 134,418 distinct orders. The agent selects the financial field that matches the user's wording and states what it used when the choice affects the answer.

## User flow

1. A member asks an Airtable/Menhood business question.
2. The existing Airtable router chooses Menhood for joins, aggregates, cohorts, or broad filtering; ordinary Airtable CRUD continues through Airtable MCP.
3. The Menhood adapter validates and executes one read-only query and returns a bounded structured preview.
4. When rows are exportable, the result includes an opaque `preview.exportOfferId`.
5. The verified Lark final card renders the existing **Google Sheet**, **CSV in Drive**, and **Excel (.xlsx)** buttons.
6. Confirmation re-checks the member's source permission, resolves the allowed Google destination, queues the existing export worker, and delivers the verified private artifact.

No Menhood-specific Lark card, queue, Google writer, sharing rule, or delivery mechanism is needed.

## Backend adapter

- Add validated `MENHOOD_DB_*` configuration plus a company binding such as `MENHOOD_COMPANY_ID`; the current five connection values already exist in the ignored local `.env`.
- Add a small PostgreSQL client using a direct `pg` dependency.
- Execute every request inside an explicit read-only transaction with statement, lock, and idle-transaction timeouts.
- Accept one validated `SELECT`/read-only `WITH` query with bound parameters.
- Allow only orders, customers, products, and the city/pincode lookup; reject advertisement costs, multiple statements, modifying CTEs, `COPY`, `SELECT INTO`, and non-read operations.
- Return JSON-safe columns, rows, coverage, elapsed time, and truncation metadata.
- Keep the small preview outside bulk export. Never put full customer/order datasets into model context.
- Use the supplied deployment credential only inside the backend adapter. A database-native read-only credential remains desirable later, but it is not a separate Divo connection flow.

## Airtable inheritance

- Menhood is discoverable and prioritized from the existing Airtable router.
- Access follows existing Airtable record-read permission rather than requiring a second member-facing permission choice.
- The skill follows Airtable's existing rules for accurate totals, partial-result disclosure, secure exports, connection secrecy, and business-language output.
- Airtable OAuth/PAT accounts remain member-selectable; the Menhood company connection never appears in that account selector.
- Export confirmation and execution re-check the same source-read permission again, as the current pipeline already does.

## Export pipeline fit

The current pipeline already supports the required flow:

```text
Menhood query preview
  -> opaque export offer
  -> verified Lark Sheet / CSV / XLSX buttons
  -> offer confirmation and RBAC re-check
  -> BullMQ data-export worker
  -> Menhood source adapter re-runs the exact validated query
  -> generic Google sink
  -> private verified artifact card
```

Required export additions:

- Add a `menhood_query` source variant with `connectionId: "backend_managed"`.
- Store the exact normalized query and bound parameters in the opaque 24-hour offer.
- Add a Menhood export source that streams query rows in pages instead of materializing them in memory.
- Register it in the existing `DatasetSourceRegistry`.
- Map the source permission check to the inherited Airtable read authority.
- Revalidate the stored query before every export execution.
- The export is a fresh read at confirmation time, not a database snapshot frozen when the preview was shown. If the sync changes meanwhile, the export can differ from the preview.

### Current limits

| Layer/format | Existing limit | Consequence |
| --- | ---: | --- |
| Central export worker | 5,000 rows | Effective limit for every format today |
| Google Sheet sink | 50,000 rows / 2,000,000 cells | Capacity exists but is hidden by the worker cap |
| XLSX writer | 5,000 rows / 100,000 cells | Suitable only for bounded filtered results |
| CSV sink | Existing capacity: 1,000,000 rows / 1 GB spool | Menhood V1 will impose a smaller 200 MB cap |
| Model preview | 25 rows | Correct for chat; bulk rows stay server-side |

Therefore the existing buttons will work cleanly for filtered Menhood results up to 5,000 rows. They will not yet export all 160,000 order lines.

For genuinely large exports, replace the single global limit with format-aware limits:

- XLSX: retain 5,000 rows and 100,000 cells.
- Google Sheet: allow up to 50,000 rows and 2,000,000 cells.
- CSV/auto fallback: retain the existing row ceiling but stop Menhood exports at 200 MB.
- Preserve explicit truncation in the final card whenever a source or format limit is reached.

This limit change should reuse the current spool, retry, idempotency, progress-card, cleanup, and verified-sharing behavior rather than creating a separate "large Menhood export" path.

## Cookbook

The Menhood specialist should document:

- Table grain and approved joins.
- Order counts versus order-line counts.
- Delivered, Cancelled, and RTO Delivered definitions.
- COD versus prepaid comparisons.
- Choose the revenue/value field from the user's request; when ambiguous and material, state the interpretation or ask one short follow-up.
- Product/SKU performance and the known duplicate-SKU groups.
- UTM/campaign attribution from order data only; do not query or reason from `menhood_advertisement_costs` in V1.
- Customer cohort, repeat-purchase, geographic, coupon, shipping-partner, and RTO recipes.
- Known missing/invalid values and honest completeness language.
- Match the existing Airtable experience: bounded previews, no row/parameter logging, and private governed export for bulk results.

## Resolved owner decisions and remaining discovery

- [x] Menhood inherits the final `airtableRecords:read` decision, including company, department-role, user-override, and company-admin behavior; there is no Menhood permission toggle.
- [x] Menhood is a separate backend-managed tool internally but remains part of the Airtable user experience; there is no new connection, picker, OAuth flow, or admin UI.
- [x] V1 uses simple application checks around the existing connection: one parsed `SELECT`/read-only `WITH`, four allowed relations, a small explicit blocklist for server/file/catalog/locking operations, bound parameters, and an explicit read-only transaction.
- [x] The agent chooses financial semantics from the user's query instead of enforcing one global revenue definition.
- [x] Preview and PII behavior follows the current Airtable pattern: bounded model-visible rows, no returned-row/parameter logging, and private governed bulk exports.
- [x] An export re-runs the stored query at click/worker time instead of storing the preview rows; this is the existing pipeline behavior and avoids snapshot infrastructure.
- [x] XLSX remains capped at 5,000 rows/100,000 cells, Sheet at 50,000 rows/2,000,000 cells, and Menhood CSV/auto at 200 MB.
- [x] `menhood_advertisement_costs` is excluded from the V1 allowlist, cookbook, recipes, exports, and freshness checks.
- [x] Resolve the existing Divo company UUID from the Development Company record: RelicWave uses `9f9360aa-28d1-49df-919f-3b121b7403df`. Store it only in deployment configuration; it is one string comparison preventing another Divo company from using Menhood's global backend credential.

## Living-plan synchronization rules

This checklist must remain synchronized with implementation continuously.

- Read this file before starting each Menhood implementation turn.
- Set `Current wave` and `Last synchronized` before editing code.
- Mark a task `[x]` only after its acceptance check has actually passed.
- Leave an unfinished task `[ ]`; append `IN PROGRESS` when work has started.
- For a blocked task, leave it `[ ]` and add `BLOCKED — <exact reason>` beneath it.
- Record the exact verification command and real result in the wave evidence block.
- Update this file in the same commit as the code that completes its tasks.
- Do not batch status updates at the end of several commits.
- When implementation differs from this plan, update the plan first or in the same change; never allow the document to describe code that no longer exists.
- Close a wave only when every required task and exit criterion is checked.
- At every handoff, record the next unchecked task so another engineer can continue without rediscovery.
- Keep deferred ideas unchecked in the final backlog; do not silently treat them as delivered.

### Status vocabulary

- `[ ]` — not started or not proven.
- `[ ] ... — IN PROGRESS` — actively being implemented.
- `[ ] ... — BLOCKED` — cannot continue; the reason must follow.
- `[x]` — implemented and verified with recorded evidence.

### Sync log

Add one row after every implementation commit or material plan correction.

| Date | Commit/worktree | Wave | What changed | Verification evidence | Next task |
| --- | --- | --- | --- | --- | --- |
| 2026-08-03 | Planning worktree | Discovery | Database and export pipeline explored; micro-wave plan created | Read-only SQL inspection; `git diff --check` | Wave 0.1 |
| 2026-08-03 | Planning worktree | Discovery | Recorded permission/export anomalies and mandatory 40/80/100 cold-review fix gates | Code-path exploration; remote read-only role probe confirmed `postgres` has `rolsuper=t` and transaction read-only is `on`; `git diff --check` | Owner decisions, then Wave 0.1 |
| 2026-08-03 | Planning worktree | Owner decisions | Removed speculative V1 infrastructure; fixed Airtable inheritance, four-table scope, 200 MB export cap, fresh replay, and advertisement-cost exclusion | Markdown whitespace and secret-literal checks passed | Resolve company UUID from existing app data, then Wave 0.1 |
| 2026-08-03 | Planning worktree | Wave 0 | Implementation authorized; baseline/company-binding discovery started | In progress | Complete Wave 0 contract and baseline evidence |
| 2026-08-03 | Planning worktree | Wave 0 | Resolved RelicWave company binding, froze V1 contracts, and captured the green Airtable/permission/export baseline | 180 focused tests passed; Development DB tunnel stopped after read-only lookup | Wave 1 env/dependencies |
| 2026-08-03 | Planning worktree | Wave 1 | Added typed Menhood env configuration, ignored local enablement, and direct PostgreSQL/parser dependencies | 5 config tests passed; typecheck passed | Wave 2 query validator |
| 2026-08-03 | Planning worktree | Wave 2 | Added the bounded four-table AST query contract, safe parameter fingerprinting, and write/server escape rejection | 10 query tests plus 5 config tests passed; typecheck passed | Wave 3 PostgreSQL adapter |
| 2026-08-03 | Planning worktree | Wave 3 | Added the lazy two-connection PostgreSQL adapter, explicit read-only transaction/timeouts, bounded normalization, and shutdown hook | 22 focused tests passed; typecheck passed; live count and transaction-read-only probes passed | Wave 4 governed capability |
| 2026-08-03 | Planning worktree | Wave 4 | Registered `menhoodData`, copied final Airtable read decisions, added backend-managed catalogue/skill provisioning, and wired one gateway tool with redacted audit metadata | 134 focused Wave 0–4 tests and 71 gateway tests passed; typecheck passed | 40% cold-review gate |
| 2026-08-03 | Planning worktree | 40% gate | Independent reviewer found one P2 in failure audit metadata; fixed it, added a regression, and passed same-reviewer recheck | 6 focused tests passed; typecheck and diff check passed; final verdict `ship` | Wave 5 routing/cookbook |
| 2026-08-03 | Planning worktree | Wave 5 | Completed Airtable-first routing and the verified Menhood schema/quality cookbook with named recipes and single-offer guidance | 14 focused skill/router tests passed; typecheck and diff check passed | Wave 6 governed export replay |
| 2026-08-03 | Planning worktree | Wave 6 | Added the opaque `menhood_query` offer, nested verified preview offer, repeatable-read cursor replay, source registration, and inherited confirmation/worker rechecks | 156 focused query/offer/export/gateway tests plus 37 runtime and 6 card tests passed; typecheck and diff check passed | Wave 7 format-aware limits |
| 2026-08-03 | Planning worktree | Wave 7 | Centralized destination limits, lifted Sheet/CSV/auto beyond 5,000, added exact cursor-boundary truthfulness, and enforced a Menhood-only decimal 200 MB spool ceiling | 79 focused format/export/tool tests plus a 160,713-row generated streaming proof passed; typecheck and diff check passed | 80% cold-review gate |
| 2026-08-03 | Planning worktree | 80% gate | Fresh read-only Terra review found no verified findings and approved the frozen Waves 0–7 worktree | Cumulative 343 tests passed; typecheck and diff check passed; reviewer verdict `ship` | Wave 8 local and Development validation |
| 2026-08-03 | Planning worktree | Wave 8 | Proved the actual TLS/read-only adapter, four-table schema, aggregate/join/write guard, and full 160,713-row cursor replay; moved real Development Lark/Google artifact creation to the post-gate deployment wave to remove a circular prerequisite | Live probes passed without logging row values or credentials; 343 cumulative tests and typecheck passed | 100% cold-review gate |
| 2026-08-03 | Planning worktree | 100% gate | Final reviewer found one P1 in unauthenticated TLS; required a pinned CA and certificate identity, removed insecure mode, proved the real authenticated connection, and passed same-reviewer recheck | 17 focused tests and final 343-test cumulative run passed; typecheck and diff check passed; final verdict `ship` | Obtain explicit authorization for Wave 9 deployment |
| 2026-08-03 | This commit | Commit handoff | Recorded the approved Menhood release candidate locally without staging unrelated concurrent Lark/Pi interruption work or ignored deployment credentials | Final 343-test suite, typecheck, diff check, authenticated live probe, and all three review gates passed | Wave 9 deployment authorization |

## Mandatory cold-review and fixing loops

The milestone percentages measure implementation scope, not the raw fraction of checklist boxes. A gate is blocking: later work may start only after the gate verdict is **ship**, every verified P0/P1/P2 finding is fixed, and the recorded tests were re-run after the final fix.

Milestone mapping:

- **40%:** Waves 0–4 complete — typed configuration, query validator, read-only PostgreSQL adapter, permission alias, and governed tool form the first vertical slice.
- **80%:** Waves 5–7 complete — routing/cookbook, governed export replay, and format-aware large-result behavior are complete.
- **100%:** Wave 8 complete — the full implementation has passed local and Development validation; this gate blocks Wave 9 Main deployment.

Every gate must use this exact protocol. The gate-specific checklists below track each execution independently:

1. Synchronize plan status and freeze the exact baseline.
2. Run and record post-edit validation.
3. Spawn exactly one fresh read-only `gpt-5.6-terra` reviewer at medium reasoning with no forked implementation conversation.
4. Give it only the repository path, exact diff, acceptance criteria, relevant AGENTS rules, and validation evidence.
5. Require at most five verified, cited findings and a `block`, `ship after fixes`, or `ship` verdict.
6. Independently verify each finding, make only the smallest authorized fixes, and run narrow regressions.
7. Send fixes and fresh evidence back to the same reviewer; repeat until no verified P0/P1/P2 remains and the verdict is `ship`.
8. Change reviewers only when the fixes materially expand scope. After two failed attempts at the same error, stop and record the exact evidence.

### 40% gate — after Wave 4

- [x] Confirm every required Wave 0–4 task and exit criterion is checked with evidence.
- [x] Review typed env fail-closed behavior, company binding, SQL validation, transaction read-only enforcement, JSON normalization, permission inheritance, audit boundaries, and gateway exposure.
- [x] Update plan status and freeze the base/head commits, changed files, and Wave 0–4 acceptance criteria.
- [x] Run and record the focused Wave 0–4 validation after the latest edit.
- [x] Spawn the one fresh read-only Terra reviewer with the frozen scope and evidence.
- [x] Record its cited findings and initial verdict.
- [x] Independently verify and disposition every finding against the code.
- [x] Fix every verified P0/P1/P2 with the smallest scoped change.
- [x] Run and record narrow regressions after the last fix.
- [x] Send the fix diff and fresh evidence to the same reviewer.
- [x] Repeat the fix/recheck loop until the reviewer reports `ship` with no verified P0/P1/P2.
- [x] Record the final reviewer verdict and corrected head commit.
- [x] Mark `40% gate: passed` only after the final verdict is `ship`.
- [x] Do not begin Wave 5 while this gate is open.

#### 40% gate evidence

- Baseline/head: branch `main`, baseline `69db37b3e`, uncommitted Wave 0–4 worktree diff; no implementation commit created.
- Frozen acceptance: disabled/wrong-company fail closed; exactly four queryable tables; AST-governed single read query; explicit read-only transaction/timeouts; 25-row JSON-safe preview; exact final Airtable record-read inheritance; backend-only credentials/connection; one existing gateway tool; redacted audit metadata; no export offer until the real source exists.
- Validation: `node --import tsx --test` over 11 Wave 0–4 suites: 134 passed, 0 failed; `tests/application/gateway.test.ts`: 71 passed, 0 failed; `pnpm typecheck`: passed.
- Reviewer/initial verdict: fresh `/root/menhood_40_cold_review`, `gpt-5.6-terra` at medium reasoning, reported one P2 and `ship after fixes`.
- Finding/fix: valid query service failures omitted safe query identity from audit metadata. Verified; the tool now retains the validated fingerprint/table set and records them with `returnedRows: 0` on failure without SQL/parameters. Added a timeout regression.
- Post-fix validation: `node --import tsx --test tests/tools/menhood-data.tool.test.ts`: 6 passed, 0 failed; `pnpm typecheck`: passed; `git diff --check`: passed.
- Reviewer/final verdict: same reviewer confirmed the P2 resolved, no new issue introduced, final verdict `ship`; corrected state remains an uncommitted worktree on baseline `69db37b3e`.
- 40% gate: passed.

### 80% gate — after Wave 7

- [x] Confirm every required Wave 0–7 task and exit criterion is checked with evidence.
- [x] Review routing ownership, cookbook accuracy, export-offer secrecy, confirmation-time RBAC re-check, query replay validation, snapshot consistency, cursor backpressure, spool cleanup, destination limits, truncation, retries, and idempotency.
- [x] Verify large-result tests cover Sheet, CSV, XLSX, `auto`, timeout, cancellation, and cleanup boundaries.
- [x] Update plan status and freeze the base/head commits, changed files, and cumulative Wave 0–7 acceptance criteria.
- [x] Run and record the focused Wave 5–7 plus cumulative regression validation after the latest edit.
- [x] Spawn the one fresh read-only Terra reviewer with the frozen scope and evidence.
- [x] Record its cited findings and initial verdict.
- [x] Independently verify and disposition every finding against the code.
- [x] Fix every verified P0/P1/P2 with the smallest scoped change.
- [x] Run and record narrow regressions after the last fix.
- [x] Send the fix diff and fresh evidence to the same reviewer.
- [x] Repeat the fix/recheck loop until the reviewer reports `ship` with no verified P0/P1/P2.
- [x] Record the final reviewer verdict and corrected head commit.
- [x] Mark `80% gate: passed` only after the final verdict is `ship`.
- [x] Do not begin Wave 8 live validation while this gate is open.

#### 80% gate evidence

- Baseline/head: Menhood baseline `69db37b3e`; current branch head `6b174f30c` includes a pre-existing unrelated Lark runtime commit. Frozen review scope is the complete 46-file uncommitted worktree diff (35 tracked modifications plus 11 untracked files), with no Menhood implementation commit created.
- Frozen acceptance: Airtable owns user-facing routing and its CRUD/schema behavior remains unchanged; Menhood supplies a concise four-table analytics cookbook and one backend-only read adapter; opaque offers contain the normalized query and bound parameters but no preview rows; confirmation and worker execution re-check inherited `airtableRecords:read`; export replay revalidates the fingerprint and streams a repeatable-read cursor; the existing receipt/card/queue/sink path remains the sole export path; XLSX, Sheet, CSV, and `auto` obey destination-aware limits; Menhood spooling stops cleanly at decimal 200 MB with truthful truncation and cleanup.
- Validation: focused Wave 5 router/skill suites 14 passed; focused Wave 6 cumulative suites 156 passed plus Lark runtime 37 and card filtering 6; focused Wave 7 suites 79 passed, including a generated 160,713-row streaming CSV proof; final cumulative 20-file run 343 passed, 0 failed; `pnpm typecheck` passed; `git diff --check` passed.
- Reviewer/final verdict: fresh `/root/menhood_80_cold_review`, `gpt-5.6-terra` at medium reasoning, independently inspected the complete uncommitted scope and returned `ship` with no verified P0/P1/P2. It additionally ran `git diff --check` successfully.
- Findings/fixes: none. No code fix or re-review iteration was required; the latest cumulative 343-test/typecheck/diff-check evidence is the post-edit regression baseline. Corrected head remains `6b174f30c` with the Menhood implementation uncommitted.
- 80% gate: passed.

### 100% gate — after Wave 8 and before Wave 9 deployment

- [x] Confirm every required Wave 0–8 task and exit criterion is checked with evidence.
- [x] Review the complete cumulative implementation for security, correctness, regressions, operational failure modes, stale comments, dead code, unexpected generated files, and credential/PII leakage.
- [x] Confirm the implementation preserves backend authority, uses no second export path, and changes neither Airtable OAuth behavior nor Divo database isolation.
- [x] Confirm live source and pre-deployment integration evidence was captured after the final implementation fix; real Development Lark/Google artifacts remain in Wave 9 after deployment.
- [x] Update plan status and freeze the full implementation base/head commits, changed files, and cumulative acceptance criteria.
- [x] Run and record the final focused and cumulative validation after the latest edit.
- [x] Spawn the one fresh read-only Terra reviewer with the full implementation scope and evidence.
- [x] Record its cited findings and initial verdict.
- [x] Independently verify and disposition every finding against the code.
- [x] Fix every verified P0/P1/P2 with the smallest scoped change.
- [x] Run and record narrow regressions after the last fix.
- [x] Send the fix diff and fresh evidence to the same reviewer.
- [x] Repeat the fix/recheck loop until the reviewer reports `ship` with no verified P0/P1/P2.
- [x] Re-run the final focused suite after the last accepted fix.
- [x] Record the final reviewer verdict and corrected release-candidate commit.
- [x] Mark `100% gate: passed` only after the final verdict is `ship`.
- [x] Do not configure or deploy Development or Main while this gate is open.

#### 100% gate evidence

- Baseline/head: historical Menhood baseline `69db37b3e`; current branch head `6b174f30c`; frozen release-candidate scope is the complete current uncommitted worktree diff (33 tracked modifications plus 11 untracked files, including this plan). No implementation commit exists. Already-committed Lark/runtime changes between the historical baseline and current head are outside the review diff.
- Frozen acceptance: all Waves 0–8 decisions and exit criteria, including strict four-table read-only access, exact final Airtable permission inheritance, backend-only credential ownership, bounded previews/redacted audits, operational cookbook/routing, opaque governed offers, repeatable-read cursor replay, existing Lark/export authority, destination-aware limits, decimal 200 MB Menhood truncation, retries/idempotency/cleanup, live TLS/read-only/aggregate/join/write-guard proof, and full 160,713-row live replay. No deployment, Divo schema migration, or real Google artifact is part of this pre-deployment diff.
- Validation: final cumulative 20-file run 343 passed, 0 failed; `pnpm typecheck` passed; `git diff --check` passed. Live Wave 8 evidence is recorded in its evidence block; host/database/password literals are absent from the diff and the local stack remains stopped.
- Reviewer/initial verdict: fresh `/root/menhood_100_cold_review`, `gpt-5.6-terra` at medium reasoning, reported one P1 and `ship after fixes`; no other verified P0/P1/P2 was found.
- Finding/fix: verified that `rejectUnauthorized: false` encrypted traffic without authenticating the public database endpoint, risking credential interception. Insecure TLS mode is now invalid; enabled configuration requires a pinned base64 PEM certificate and expected certificate DNS identity; the pool uses `rejectUnauthorized: true` with both CA and `servername`. The ignored local env pins the endpoint's current self-signed certificate and identity.
- Post-fix validation: 17 focused config/service tests passed, 0 failed; final cumulative 20-file run 343 passed, 0 failed; `pnpm typecheck` and `git diff --check` passed. A live real adapter count succeeded with authenticated TLS. Controls failed without the pinned CA (`DEPTH_ZERO_SELF_SIGNED_CERT`) and without the matching identity (`ERR_TLS_CERT_ALTNAME_INVALID`).
- Reviewer/final verdict: the same reviewer verified the P1 resolved, found no remaining verified P0/P1/P2, and returned `ship`. The approved release-candidate state is recorded by the local commit containing this ledger; no deployment was performed.
- 100% gate: passed.

## Wave execution plan

### Wave 0 — Baseline and contract freeze

Goal: freeze the smallest implementation contract before adding dependencies or runtime code.

#### 0.1 Confirm the target behavior

- [x] Confirm Menhood remains an extension of the Airtable user experience.
- [x] Confirm Airtable MCP continues unchanged for record, schema, and automation operations.
- [x] Confirm Menhood is one deployment-configured company connection with no picker or OAuth UI.
- [x] Confirm the first release is read-only and has no HITL/write path.
- [x] Confirm chat returns only a bounded preview and aggregate answers.
- [x] Confirm bulk rows use only the existing governed export-offer path.

#### 0.2 Freeze names and contracts

- [x] Choose the canonical internal tool ID: `menhoodData`.
- [x] Choose the internal `menhood` family with `backend_managed` readiness while keeping Airtable as the user-facing router; this is catalogue metadata, not a second connection implementation.
- [x] Choose the export source discriminator: `menhood_query`.
- [x] Choose the backend-managed connection sentinel: `backend_managed`.
- [x] Define the preview row limit: 25 rows.
- [x] Keep timeout values as adapter constants rather than deployment infrastructure: 30-second preview statement, 2-second lock, 30-second idle transaction, and 5-minute export statement.
- [x] Define the export fetch-page size: 1,000 rows.
- [x] Define the exact four-table V1 allowlist: orders, customers, products, and city/pincode lookup; exclude advertisement costs.

#### 0.3 Capture the baseline

- [x] Record the current branch and clean/dirty worktree state.
- [x] Run the narrow existing Airtable skill/router tests.
- [x] Run the narrow existing permission tests covering Airtable reads.
- [x] Run the narrow existing export-offer, worker, and card tests.
- [x] Record every command and pass/fail count in this wave's evidence block.

#### Wave 0 exit criteria

- [x] Names, limits, and access inheritance are unambiguous.
- [x] Baseline tests pass or pre-existing failures are recorded precisely.
- [x] No production code has been changed before this contract is frozen.

#### Wave 0 evidence

- Baseline: branch `main`, HEAD `69db37b3e`; only `plans/menhood-read-only-adapter.md` is untracked.
- Command: `node --import tsx --test tests/application/system-skill-routes.test.ts tests/tools/airtable-mcp.tool.test.ts tests/application/permission.service.test.ts`
- Result: 82 passed, 0 failed.
- Command: `node --import tsx --test tests/application/data-export-offer.test.ts tests/application/data-export.test.ts tests/application/lark-pi-runtime.service.test.ts`
- Result: 92 passed, 0 failed.
- Command: `node --import tsx --test --test-name-pattern='export|Sheet|CSV|Excel' tests/infrastructure/lark/lark.webhook.routes.test.ts`
- Result: 6 passed, 0 failed.
- Company lookup: a read-only Development tunnel query found exactly one Company row, RelicWave (`9f9360aa-28d1-49df-919f-3b121b7403df`); the tunnel was stopped immediately afterward and is not listening.
- Completed commit: this local release-candidate commit.

### Wave 1 — Environment and dependencies

Goal: make the company connection available to typed backend code without exposing it outside the backend.

#### 1.1 Add direct dependencies

- [x] Add `pg` as a direct backend dependency (`8.22.0`).
- [x] Add the matching TypeScript types (`@types/pg` `8.20.3`).
- [x] Add `pgsql-ast-parser` (`12.0.2`) for AST validation.
- [x] Defer a cursor dependency until Wave 6; preview execution does not need it.
- [x] Update `pnpm-lock.yaml` through pnpm rather than manual editing.
- [x] Confirm lockfile movement is limited to the three direct additions and their dependency graph.

#### 1.2 Validate environment configuration

- [x] Add `MENHOOD_ENABLED` with a disabled-by-default value.
- [x] Add `MENHOOD_DB_HOST` to typed environment validation.
- [x] Add `MENHOOD_DB_PORT` as an integer from 1–65,535.
- [x] Add `MENHOOD_DB_NAME`.
- [x] Add `MENHOOD_DB_USER`.
- [x] Add `MENHOOD_DB_PASSWORD` without logging or error echoing.
- [x] Add `MENHOOD_COMPANY_ID` to bind the deployment-global database to RelicWave.
- [x] Keep query/lock/idle timeout values as Wave 3 adapter constants, not environment knobs.
- [x] Keep preview and page-size limits as adapter/export constants, not environment knobs.
- [x] Add simple TLS modes: `require` by default and `disable` only when explicitly configured.
- [x] Add non-secret placeholders and comments to `.env.example`.
- [x] Add enablement, RelicWave binding, and TLS mode to the existing ignored local values.

#### 1.3 Prove configuration behavior

- [x] Test valid Menhood configuration parsing.
- [x] Test invalid port rejection.
- [x] Test empty credential rejection when the integration is enabled.
- [x] Test missing `MENHOOD_COMPANY_ID` fails closed when Menhood is enabled.
- [x] Test disabled/unconfigured Menhood does not break unrelated backend startup.
- [x] Confirm validation errors never include the database password.

#### Wave 1 exit criteria

- [x] Backend typecheck recognizes every Menhood config field.
- [x] Dependency and lockfile diff contains only intended packages.
- [x] Configuration tests pass.
- [x] No secret is committed.

#### Wave 1 evidence

- Command: `node --import tsx --test tests/config/menhood-env.test.ts`
- Result: first run exposed an incomplete global env fixture (2 passed, 3 failed); after adding the five existing required non-secret test fields, 5 passed and 0 failed.
- Command: `pnpm typecheck`
- Result: passed with no TypeScript errors.
- Command: `pnpm why pg @types/pg pgsql-ast-parser`
- Result: one direct version each: `pg@8.22.0`, `@types/pg@8.20.3`, `pgsql-ast-parser@12.0.2`.
- Local ignored `.env`: Menhood enabled, bound to RelicWave, TLS required; no database credential was added to tracked files.
- Completed commit: not created.

### Wave 2 — Query contract and read-only validation

Goal: accept useful analytical SQL while rejecting every non-read shape before database execution.

#### 2.1 Define request and result types

- [x] Define a strict query request schema.
- [x] Require one non-empty SQL string within a 32,000-byte limit.
- [x] Define positional bound parameters with JSON-safe supported types.
- [x] Define an optional human-readable export title.
- [x] Define structured columns, rows, coverage, elapsed time, and truncation fields.
- [x] Define stable error codes for invalid query, forbidden table, timeout, unavailable connection, and provider failure.

#### 2.2 Implement AST validation

- [x] Parse the SQL into an AST; do not use regex as the authority.
- [x] Require exactly one statement.
- [x] Allow `SELECT`.
- [x] Allow read-only `WITH` queries.
- [x] Reject `INSERT`, `UPDATE`, `DELETE`, `MERGE`, and `TRUNCATE`.
- [x] Reject data-modifying CTEs.
- [x] Reject `COPY`.
- [x] Reject `SELECT INTO`.
- [x] Reject DDL, transaction control, `SET`, `CALL`, and `DO`.
- [x] Reject table references outside `public`.
- [x] Reject tables outside the four-table V1 allowlist.
- [x] Reject relation-valued functions, recursive CTEs, locking clauses, and catalog access.
- [x] Block the small explicit set of server/file/large-object functions that can escape ordinary analytics.
- [x] Preserve ordinary PostgreSQL scalar, aggregate, date, JSON, and window functions needed for analysis.
- [x] Preserve bound parameters without interpolating model text.
- [x] Bound parameter count, individual value size, and total serialized bytes.
- [x] Produce one normalized/fingerprinted query representation for audit and export offers.

#### 2.3 Cover validation regressions

- [x] Test a simple filtered select.
- [x] Test joins across orders, customers, and products.
- [x] Test grouping and aggregation.
- [x] Test a read-only CTE.
- [x] Test multiple statements are rejected.
- [x] Test each write/DDL family is rejected.
- [x] Test blocked server/file/catalog functions are rejected even when wrapped in `SELECT`.
- [x] Test relation-valued functions, recursive CTEs, and locking clauses are rejected.
- [x] Test the parameter count and byte ceilings.
- [x] Test a modifying CTE is rejected.
- [x] Test an unapproved schema is rejected.
- [x] Test an unapproved table is rejected.
- [x] Test malicious content in a bound parameter remains data, not SQL.

#### Wave 2 exit criteria

- [x] Every accepted AST is read-only and references only approved tables.
- [x] Every known write escape is covered by a focused test.
- [x] Query fingerprinting stores no raw parameter values.

#### Wave 2 evidence

- Command: `node --import tsx --test tests/application/menhood-query.test.ts`
- Result: first run found PostgreSQL parameter names include the `$` prefix and strict optional typing needed omission (8 passed, 2 failed; typecheck failed with 3 errors); after correction and nested-expression coverage, 10 passed and 0 failed.
- Command: `node --import tsx --test tests/application/menhood-query.test.ts tests/config/menhood-env.test.ts`
- Result: 15 passed, 0 failed.
- Command: `pnpm typecheck`
- Result: passed with no TypeScript errors after the latest edit.
- Completed commit: not created.

### Wave 3 — PostgreSQL read adapter

Goal: execute approved queries through a bounded, abortable, read-only backend connection.

#### 3.1 Build the client lifecycle

- [x] Build the connection configuration from validated fields without constructing a logged plaintext URL.
- [x] Require TLS according to configuration.
- [x] Create one bounded connection pool.
- [x] Set a conservative pool size of two connections.
- [x] Expose pool shutdown through `close()` for Wave 4 composition shutdown.
- [x] Log pool errors generically without credentials, provider details, or raw result rows.

#### 3.2 Enforce read-only execution

- [x] Acquire one client per query.
- [x] Start an explicit `BEGIN READ ONLY` transaction.
- [x] Make the transaction read-only before the query.
- [x] Apply a 30-second statement timeout with `SET LOCAL`.
- [x] Apply a 2-second lock timeout with `SET LOCAL`.
- [x] Apply a 30-second idle-in-transaction timeout with `SET LOCAL`.
- [x] Execute only the validator-approved SQL and bound parameters.
- [x] Commit after a successful read.
- [x] Roll back on validation/execution failure.
- [x] Release the client in `finally`.
- [x] Keep V1 cancellation simple: the gateway rejects an already-aborted run and the database statement timeout bounds an in-flight preview to 30 seconds; cursor cancellation belongs to Wave 6 export streaming.

#### 3.3 Normalize data safely

- [x] Convert date values to stable ISO strings.
- [x] Convert bigint/numeric values without unsafe precision loss.
- [x] Preserve `null` distinctly from an empty string.
- [x] Normalize non-JSON-safe driver values.
- [x] Bound preview rows by reading one extra row to detect truncation.
- [x] Return collision-safe column order from PostgreSQL field metadata.
- [x] Never log row bodies, customer PII, SQL parameters, or credentials.

#### 3.4 Verify the adapter

- [x] Unit-test begin/read-only/timeout/query/commit ordering.
- [x] Unit-test rollback and release on failure.
- [x] Unit-test timeout mapping and bounded V1 cancellation behavior.
- [x] Unit-test row normalization.
- [x] Run an opt-in live service probe from the ignored Menhood environment.
- [x] In the live probe, assert `transaction_read_only=on`.
- [x] In the live probe, run one bounded aggregate without printing PII.

#### Wave 3 exit criteria

- [x] The adapter cannot execute an unvalidated query.
- [x] Every database call runs inside an explicit read-only transaction.
- [x] Timeout, rollback, bounded V1 cancellation, and pool cleanup are proven.

#### Wave 3 evidence

- Command: `node --import tsx --test tests/application/menhood-query.service.test.ts tests/application/menhood-query.test.ts tests/config/menhood-env.test.ts`
- Result: 22 passed, 0 failed.
- Command: `pnpm typecheck`
- Result: passed with no TypeScript errors.
- Live service probe: `SELECT count(*)::bigint AS row_count FROM menhood_orders`
- Result: one structured row, `row_count=160713`, not truncated; no row bodies or PII printed.
- Live transaction probe: `BEGIN READ ONLY; SHOW transaction_read_only; ROLLBACK;`
- Result: `transaction_read_only=on`.
- Completed commit: not created.

### Wave 4 — Governed Airtable extension capability

Goal: expose Menhood analytics through the existing Divo gateway while inheriting Airtable read authority.

#### 4.1 Register the capability

- [x] Add the internal Menhood tool/family definition selected in Wave 0.
- [x] Mark the connection mode backend-managed.
- [x] Support only the `read` action.
- [x] Add a catalogue name, description, category, and guardrails.
- [x] Add the registered-tool seed.
- [x] Ensure capability reconciliation creates the missing catalogue row without overwriting manual metadata.
- [x] Keep the company connection out of member-selectable connection providers.

#### 4.2 Inherit Airtable read access

- [x] Define one authoritative mapping from Airtable record-read permission to Menhood read permission.
- [x] Ensure company-level Airtable read denial also denies Menhood.
- [x] Ensure department Airtable read denial also denies Menhood.
- [x] Ensure user overrides behave identically to Airtable record reads.
- [x] Avoid a second Menhood permission switch or independent grant source.
- [x] Bind execution to `MENHOOD_COMPANY_ID` before querying.

#### 4.3 Implement the tool

- [x] Add strict tool arguments using the Wave 2 query schema.
- [x] Add a strict structured result schema.
- [x] Implement the inherited read permission check.
- [x] Implement preflight for configuration, company binding, and query validation.
- [x] Execute through the Wave 3 adapter only.
- [x] Create a 25-row bounded preview.
- [x] Report coverage honestly when more rows exist.
- [x] Record query fingerprint, table set, latency, row count, and outcome in audit metadata.
- [x] Do not audit SQL parameter values or returned rows.
- [x] Convert connection/timeout/query failures into stable tool errors.

#### 4.4 Wire composition

- [x] Construct the Menhood pool/client once; the pool itself remains lazy until first use.
- [x] Construct the query validator/service once.
- [x] Keep export offers absent until the real `menhood_query` source lands in Wave 6; no dead placeholder offer is exposed.
- [x] Register the capability in the existing `ToolRegistry`.
- [x] Add shutdown cleanup.
- [x] Do not add a new HTTP or Pi route.

#### 4.5 Verify gateway behavior

- [x] Test missing/disabled configuration.
- [x] Test wrong company denial.
- [x] Test inherited Airtable permission denial.
- [x] Test inherited Airtable permission allowance.
- [x] Test invalid arguments.
- [x] Test unknown/unapproved query shapes.
- [x] Test successful bounded invocation.
- [x] Test structured result validation.
- [x] Test effective Menhood discovery follows the inherited permission and exposes no permission controls.

#### Wave 4 exit criteria

- [x] Desktop and Lark use the same existing gateway execution path.
- [x] No credential or connection selector reaches Pi/Desktop.
- [x] There is one permission authority: inherited Airtable record-read access.

#### Wave 4 evidence

- Command: `node --import tsx --test tests/tools/menhood-data.tool.test.ts tests/application/menhood-query.service.test.ts tests/application/menhood-query.test.ts tests/config/menhood-env.test.ts tests/application/permission.service.test.ts tests/application/desktop-tool-access.service.test.ts tests/application/tool-capability-taxonomy.test.ts tests/application/menhood-data-system-skill.test.ts tests/application/system-skill-routes.test.ts tests/application/capability-finalization.test.ts tests/http/admin-auth.routes.test.ts`
- Result: 134 passed, 0 failed.
- Command: `node --import tsx --test tests/application/gateway.test.ts`
- Result: 71 passed, 0 failed.
- Command: `pnpm typecheck`
- Result: passed with no TypeScript errors after composition/shutdown registration.
- Completed commit: not created.

### Wave 5 — Airtable routing and Menhood cookbook

Goal: teach Divo when and how to use Menhood without changing ordinary Airtable behavior.

#### 5.1 Route intent correctly

- [x] Add the Menhood specialist to the existing Airtable router.
- [x] Place Menhood analytics before generic Airtable record analysis for matching intents.
- [x] Add aliases for Menhood, company Airtable sync, orders, customers, products, sales analysis, RTO, COD, campaign, and pincode analysis.
- [x] Route joins, aggregates, cohorts, broad filters, and bulk analysis to Menhood.
- [x] Keep CRUD, schema, interface, form, and automation requests on Airtable MCP.
- [x] State that Menhood requires no Airtable `connectionId`.
- [x] Prevent routing to local Python for a result already carrying an export offer.

#### 5.2 Encode the data cookbook

- [x] Document the four V1 tables and their grain; state that advertisement costs are intentionally unavailable.
- [x] Document `orders.customer_id -> customers.id`.
- [x] Document `orders.product_id -> products.id`.
- [x] Document pincode normalization before the city lookup join.
- [x] Document order-line count versus distinct-order count.
- [x] Document the Delivered, Cancelled, and RTO Delivered values.
- [x] Document COD versus PREPAID values and null handling.
- [x] Instruct the agent to select the value field from the user's wording and disclose a material interpretation.
- [x] Document product ID coverage, SKU mismatch risk, and duplicate product SKUs.
- [x] Document UTM source/medium/campaign completeness.
- [x] Explicitly prohibit queries and claims based on `menhood_advertisement_costs` in V1.
- [x] Document the invalid pre-2000 customer date.
- [x] Document preview/truncation language.
- [x] Match existing Airtable bounded-preview and private governed-export behavior.

#### 5.3 Add named recipes

- [x] Daily/monthly distinct orders and delivered value.
- [x] Product/SKU performance.
- [x] Repeat-customer and cohort analysis.
- [x] COD versus prepaid delivery/RTO comparison.
- [x] Shipping-partner delivery/RTO comparison.
- [x] Coupon performance.
- [x] UTM/campaign attribution.
- [x] City/state/pincode demand.
- [x] Data-quality diagnostics.

#### 5.4 Verify skill behavior

- [x] Test the Airtable router targets the Menhood specialist.
- [x] Test a sales-analysis query chooses Menhood.
- [x] Test Airtable record updates remain on Airtable MCP.
- [x] Test schema/automation requests remain on their existing specialists.
- [x] Test the skill never asks for a Menhood connection ID.
- [x] Test the skill preserves the single verified export-offer choice.

#### Wave 5 exit criteria

- [x] Menhood feels like an Airtable extension to the user.
- [x] The backend connection remains technically separate and invisible.
- [x] Cookbook rules prevent obvious double-counting and exclude advertisement-cost claims.

#### Wave 5 evidence

- Command: `node --import tsx --test tests/application/menhood-data-system-skill.test.ts tests/application/system-skill-routes.test.ts`
- Result: 14 passed, 0 failed.
- Command: `pnpm typecheck`
- Result: passed with no TypeScript errors.
- Command: `git diff --check`
- Result: passed with no whitespace errors.
- Completed commit: not created.

### Wave 6 — Reuse the governed export-offer pipeline

Goal: export the exact approved Menhood query through the existing Sheet/CSV/XLSX buttons.

#### 6.1 Add the source contract

- [x] Add `menhood_query` to the dataset source discriminated union.
- [x] Require `connectionId: "backend_managed"`.
- [x] Store normalized validated SQL, bound parameters, and a query fingerprint.
- [x] Store a bounded human-readable export title.
- [x] Extend offer parsing without changing existing source payloads.
- [x] Map the source to the inherited Airtable read authority for confirmation and worker re-checks.
- [x] Include the source in deterministic export hashing/idempotency.

#### 6.2 Create offers from previews

- [x] Create an offer only after permission and SQL validation succeed.
- [x] Bind the offer to company, user, department, chat, run, and request identity.
- [x] Use the same normalized query spec as the preview.
- [x] Store no preview rows in the offer.
- [x] Add the opaque offer ID only to `preview.exportOfferId`.
- [x] Preserve existing 24-hour expiry and one-offer-per-request behavior.
- [x] Fail closed if the verified Lark run receipt cannot be recorded.

#### 6.3 Stream the source

- [x] Add `MenhoodQueryDataExportSource`.
- [x] Revalidate the stored query before execution.
- [x] Re-check `MENHOOD_COMPANY_ID`.
- [x] Open a fresh repeatable-read, read-only transaction.
- [x] Stream rows in bounded pages using the selected cursor approach.
- [x] Yield `DataExportPage` objects without accumulating the full result.
- [x] Forward cancellation from the worker.
- [x] Close the cursor, roll back/commit appropriately, and release the connection on every path.
- [x] Preserve the existing worker-owned truncation marker when the active pipeline limit stops the stream.
- [x] Register the source in the existing registry.

#### 6.4 Preserve existing button behavior

- [x] Verify `preview.exportOfferId` becomes the existing verified Lark run effect.
- [x] Verify the final result card shows Google Sheet, CSV in Drive, and Excel buttons.
- [x] Verify confirmation remains in the same chat/card.
- [x] Verify multiple Google accounts still produce the existing destination-choice card.
- [x] Verify missing Google access still uses the existing connect-and-resume flow.
- [x] Verify source read permission is checked at confirmation.
- [x] Verify source read permission is checked again in the worker.
- [x] Verify the final artifact remains invoker-only and integrity-checked.

#### 6.5 Test export replay

- [x] Test preview and offer contain the same query fingerprint.
- [x] Test the worker re-runs the stored query rather than exporting preview rows.
- [x] Test tampered/unparseable stored SQL fails closed.
- [x] Test a revoked Airtable-derived Menhood read permission blocks confirmation.
- [x] Test a permission revoked after confirmation blocks worker execution.
- [x] Test 5,001 rows mark the current artifact truncated.
- [x] Test sparse columns discovered on later pages are preserved.
- [x] Test formula-like strings are neutralized by the existing sink.
- [x] Test queue retry does not create a duplicate completed artifact.

#### Wave 6 exit criteria

- [x] No Menhood-specific card, queue, sink, sharing, or delivery path exists.
- [x] The exact validated query is replayable from the opaque offer.
- [x] Sheet, CSV, and XLSX work at the current 5,000-row ceiling.

#### Wave 6 evidence

- Command: `node --import tsx --test tests/tools/menhood-data.tool.test.ts tests/application/menhood-query.service.test.ts tests/application/menhood-query.test.ts tests/application/data-export-offer.test.ts tests/application/data-export.test.ts tests/application/gateway.test.ts`
- Result: 156 passed, 0 failed.
- Command: `node --import tsx --test tests/application/lark-pi-runtime.service.test.ts`
- Result: 37 passed, 0 failed.
- Command: `node --import tsx --test --test-name-pattern='export|Sheet|CSV|Excel' tests/infrastructure/lark/lark.webhook.routes.test.ts`
- Result: 6 passed, 0 failed.
- Command: `pnpm typecheck && git diff --check`
- Result: both passed.
- Completed commit: not created.

### Wave 7 — Unlock huge-record exports safely

Goal: replace the global 5,000-row bottleneck with the capacities the existing sinks already enforce.

#### 7.1 Split limits by destination

- [x] Keep XLSX at 5,000 rows.
- [x] Keep XLSX at 100,000 cells.
- [x] Allow Google Sheets up to 50,000 rows.
- [x] Keep Google Sheets at 2,000,000 cells.
- [x] Allow CSV/auto fallback to stream up to the existing row ceiling while enforcing a 200 MB Menhood byte cap.
- [x] Stop and mark the artifact truncated before the Menhood spool exceeds 200 MB.
- [x] Centralize limit selection so the tool, worker, sink, cards, and skill report the same numbers.

#### 7.2 Make `auto` truthful

- [x] Allow `auto` to read beyond 5,000 rows.
- [x] Select Google Sheet only when final rows/cells are eligible.
- [x] Fall back to CSV when Sheet limits are exceeded.
- [x] Never silently fall back from an explicitly requested XLSX or Sheet.
- [x] Return a clear format-limit error with the allowed alternative.

#### 7.3 Prove large streaming behavior

- [x] Test 5,001 rows can continue for Sheet/CSV but not XLSX.
- [x] Test 50,001 rows select/fall back to CSV under `auto`.
- [x] Test the Sheet cell ceiling independently of row count.
- [x] Test the XLSX cell ceiling independently of row count.
- [x] Test the Menhood CSV path stops and reports truncation at the 200 MB boundary.
- [x] Test a generated large source without holding all rows in test memory.
- [x] Test progress updates continue during long reads and writes.
- [x] Test the inactivity watchdog resets on source and sink progress.
- [x] Test cancellation cleans temporary spool files and partial artifacts.
- [x] Test retry/recovery remains idempotent for a large completed artifact.
- [x] Test final cards state exact row count and truncation honestly.

#### Wave 7 exit criteria

- [x] A complete 160,000-row order-line export can use CSV if it stays within the chosen safety ceiling.
- [x] Sheet and XLSX stop at their explicit format limits without data-loss claims.
- [x] Memory remains bounded by pages/spool rather than total result size.

#### Wave 7 evidence

- Command: `node --import tsx --test tests/application/data-export.test.ts tests/application/xlsx-export-file.test.ts tests/application/google-workspace-export-sheet.test.ts tests/application/google-workspace-export-xlsx.test.ts tests/tools/data-export.tool.test.ts tests/tools/zoho-books.tool.test.ts tests/application/system-skill-routes.test.ts`
- Result: 79 passed, 0 failed.
- Generated proof: a 160,713-row paged source completed under CSV without truncation or whole-result allocation.
- Command: `pnpm typecheck && git diff --check`
- Result: both passed after converting the Menhood limit to an exact decimal 200,000,000-byte ceiling.
- Completed commit: not created.

### Wave 8 — Local and live source validation

Goal: prove the vertical slice against real Menhood data and the complete pre-deployment Lark/export integration. Real Development Lark/Google artifact creation remains in Wave 9 after deployment; requiring it here would make the 100% pre-deployment gate circular.

#### 8.1 Local focused verification

- [x] Run Menhood validator tests.
- [x] Run Menhood client/service tests.
- [x] Run Menhood tool and permission tests.
- [x] Run Airtable/Menhood routing and skill tests.
- [x] Run Menhood export-source tests.
- [x] Run affected export-offer/worker/card tests.
- [x] Run backend typecheck.
- [x] Record exact test counts and output summaries.

#### 8.2 Live read-only verification

- [x] Verify TLS connection from the backend runtime.
- [x] Verify the configured database and server identity.
- [x] Verify `transaction_read_only=on` inside adapter execution.
- [x] Run a bounded distinct-order aggregate.
- [x] Run an orders/customers/products join.
- [x] Run a rejected write query and confirm no mutation occurred.
- [x] Confirm logs contain neither credential nor returned PII.

#### 8.3 Pre-deployment export-path verification

- [x] Verify a Menhood result uses the established bounded preview and opaque `preview.exportOfferId` contract.
- [x] Verify the existing Lark final-card filter recognizes the Menhood offer and renders all three existing export actions.
- [x] Verify offer confirmation and worker execution re-check inherited source permission.
- [x] Verify Sheet, CSV, and XLSX sink behavior with the existing provider test doubles and no Menhood-only delivery path.
- [x] Verify artifact ownership/sharing is resolved from the verified invoker by the existing guarded sink path.
- [x] Verify a large `auto` export chooses the intended format after Wave 7.
- [x] Verify the progress card becomes the terminal result card without losing the original answer.
- [x] Stream a real 160,713-row Menhood query through the replay source without retaining the whole result.

#### Wave 8 exit criteria

- [x] Focused automated checks pass.
- [x] Real Menhood preview and full source replay pass; real Development Google artifacts remain a post-deployment Wave 9 smoke check.
- [x] Read-only, privacy, and permission assertions are observed rather than assumed.

#### Wave 8 evidence

- Commands: cumulative 20-file `node --import tsx --test ...`; `pnpm typecheck`; `git diff --check`; actual `MenhoodQueryService.execute(...)` metadata/identity/aggregate/join/write-rejection probes; direct backend-driver TLS/read-only probe; actual `MenhoodQueryService.streamExportPages(...)` full replay; sensitive-literal scan; listener check for ports 8000, 15432, 6380, and 6381.
- Result: 343 tests passed, 0 failed; typecheck and diff check passed. The real backend connection used TLS and `transaction_read_only=on`; configured database identity matched, while the server correctly reported its internal/NAT interface instead of the public configured endpoint. The aggregate returned 134,418 distinct orders; the three-table join returned the requested bounded columns; an `UPDATE` was rejected as `invalid_query`; the orders count remained 160,713. Full replay streamed 160,713 rows in 161 pages, max 1,000 rows/page, with no false final continuation. Host/database/password literals were absent from the worktree diff, successful probes emitted no credentials or row values, and all local stack listeners remained stopped.
- Completed commit: not created.

### Wave 9 — Deployment and production proof

Goal: deploy the tested adapter without changing or cloning either Divo application database.

#### 9.1 Prepare Development configuration

- [ ] Add Menhood secrets and company binding to the Development deployment environment.
- [ ] Verify Development backend/container egress to the Menhood host and port.
- [ ] Verify TLS from inside the deployed backend container.
- [ ] Deploy Development.
- [ ] Verify health checks and Menhood preflight.
- [ ] Run one non-PII aggregate smoke query.
- [ ] Run one Development Lark export smoke test.

#### 9.2 Prepare Main configuration

- [ ] Add Menhood secrets and company binding to the Main deployment environment.
- [ ] Verify Main backend/container egress independently.
- [ ] Confirm no Development-to-Main database clone is requested.
- [ ] Confirm no Prisma schema migration is required for the env-only connection.
- [ ] Run the existing reconciliation/seed path that writes the registered-tool and skill/router catalogue rows.
- [ ] Record the exact catalogue rows created or updated; do not describe these application-data writes as a schema migration.
- [ ] Deploy Main through the existing release workflow.
- [ ] Verify the running image matches the release SHA.
- [ ] Verify backend and Pi controller health.
- [ ] Run one non-PII aggregate smoke query.
- [ ] Run one production Lark preview/export smoke test with an authorized account.

#### 9.3 Observe the rollout

- [ ] Monitor query latency and timeout audit events.
- [ ] Monitor export queue failures and retries.
- [ ] Confirm no credential/SQL-parameter/PII logging.
- [ ] Confirm ordinary Airtable operations remain healthy.
- [ ] Record any rollback trigger and rollback result.

#### Wave 9 exit criteria

- [ ] Development and Main both pass live read-only and export smoke checks.
- [ ] Divo Development/Main database isolation remains unchanged.
- [ ] Existing Airtable MCP behavior has no regression.

#### Wave 9 evidence

- Commands/workflows: not run.
- Result: not run.
- Release SHA: not created.

### Wave 10 — Closeout and continuing maintenance

Goal: leave an accurate operational record and keep schema/cookbook assumptions synchronized with the upstream sync.

#### 10.1 Close implementation accurately

- [ ] Check every completed task against its recorded evidence.
- [ ] Leave every deferred task unchecked.
- [ ] Record final commits and deployed release SHA.
- [ ] Record final focused/full test counts.
- [ ] Record current format limits.
- [ ] Record known data-quality caveats.
- [ ] Move only genuinely optional follow-ups into the backlog.
- [ ] Set overall status to complete only when every required wave exit criterion passes.

#### 10.2 Keep the cookbook synchronized with Menhood

- [ ] Re-run a lightweight schema/freshness probe when the upstream sync or schema changes.
- [ ] Check the latest order/customer dates and the four-table allowlist; ignore advertisement costs.
- [ ] Re-run row-grain and duplicate checks when upstream behavior changes.
- [ ] Update cookbook definitions in the same change as any schema/semantic correction.
- [ ] Re-run routing/query/export tests after cookbook changes.
- [ ] Record each schema/cookbook synchronization in the sync log above.

#### 10.3 Maintain the implementation plan

- [ ] Review this document at the start of every Menhood maintenance task.
- [ ] Update `Last synchronized` whenever implementation or upstream schema assumptions change.
- [ ] Append a sync-log row for each relevant commit or incident.
- [ ] Do not claim automated monitoring exists; V1 maintenance checks are explicit and lightweight.
- [ ] Keep current limits and deployment behavior aligned with code.

#### Wave 10 exit criteria

- [ ] The checklist matches the deployed code byte-for-byte in behavior.
- [ ] The lightweight schema/freshness maintenance procedure is documented and has one recorded run.
- [ ] The next maintainer can identify the current state and next task from this file alone.

#### Wave 10 evidence

- Commands/workflows: not run.
- Result: not run.
- Completed commit/release: not created.

## Backlog — intentionally outside the initial adapter

- [ ] Add a database-native limited reader credential when infrastructure is ready.
- [ ] Add a persisted multi-company Menhood connection model only if a second company database is required.
- [ ] Add non-Lark export delivery only when another verified artifact channel exists.
- [ ] Add write operations only as a separately approved architecture with independent safety review.

## Verification required

- A write statement and a data-modifying CTE are rejected before reaching PostgreSQL.
- The database session reports `transaction_read_only=on`.
- Calls outside `MENHOOD_COMPANY_ID` are denied.
- A member without inherited Airtable read access cannot preview or confirm an export.
- Filtered joins return the expected structured preview without customer rows leaking into logs.
- The 5,001st row is marked truncated until Slice 3 changes the applicable limit.
- Sheet, CSV, and XLSX buttons queue the same existing pipeline and produce invoker-only verified artifacts.
- Local, Development, and Main keep separate Divo databases; Menhood configuration is deployment secret state and requires no Prisma migration.

## Relevant existing implementation

- `advance-backend/src/application/skills/airtable.skill.ts`
- `advance-backend/src/application/skills/system-skill-routes.ts`
- `advance-backend/src/application/data-export/data-export.types.ts`
- `advance-backend/src/application/data-export/data-export.sources.ts`
- `advance-backend/src/application/data-export/data-export-offer.service.ts`
- `advance-backend/src/application/data-export/data-export.worker.ts`
- `advance-backend/src/application/data-export/google-workspace-export.sink.ts`
- `advance-backend/src/application/runtime/lark-pi-runtime.service.ts`
- `advance-backend/src/infrastructure/channels/lark/lark-data-export-card.handler.ts`

Recent precedents: `b20d9d3ca` (re-readable provider export source), `48c3082bc` (preserve the result card after export), and `f3eff6c1f` (connect/resume Google from the final card).

## Scope guard

- No Airtable MCP replacement.
- No new Divo connection-management UI or Prisma connection model.
- No second export pipeline.
- No database credential in Pi, Desktop, Lark cards, offers, logs, or model-visible results.
- No write operation, approval flow, or HITL path for Menhood.
