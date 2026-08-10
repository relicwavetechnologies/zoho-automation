# Cloud-Pi skills rewrite, native wiring, and DB rollout

> Status: **Planned — handoff to a separate skills agent**
>
> Last updated: **2026-08-10**
>
> Scope: **Cloud Pi only; skill content, router graph, system-skill provisioning, DB reconciliation, and skill-behavior proof**
>
> Explicitly out of scope: **Pi runtime/controller changes, warm-process work, typed-tool implementation, gateway authorization, provider adapters, Jan/Desktop, and retired export-planner cleanup**

## 1. Executive handoff

This track rewrites Divo's DB-backed skills so Pi receives small, current,
useful procedures instead of long exception walls. It also proves that the
rewritten definitions are reconciled into Development and Main, exposed only
to authorized users, materialized as native `SKILL.md` files, and selected by
Pi in real work.

The runtime integration is already built. Do not redesign it in this track.
The skills agent owns the quality of the skill catalogue, not the authority of
the tools.

The recommendation is to work in **coupled pairs of at most two skills**, run a
behavioral test after each pair, and reconcile the pair into Development before
starting the next one. This keeps failures attributable and prevents a large
prompt rewrite from becoming another exception pile.

## 2. Rolling context: what is already achieved

The next agent should begin from these facts rather than rediscovering the old
architecture.

- Authorized DB skill rows are returned by the authenticated runtime bootstrap.
- Cloud Pi validates and materializes those rows as read-only
  `/run/divo-skills/current/<slug>/SKILL.md` files.
- Pi loads that directory through its native `--skill` resource path and shows
  the entries in its native available-skills index.
- The removed `divo_skill_view`/process-local skill ledger is not an authority
  path anymore. A skill read is guidance, not permission.
- Backend RBAC, OAuth ownership, credentials, approvals, schemas, provider
  limits, rate policy, and audit remain authoritative for every call.
- Backend contracts are registered as individual typed Pi tools; the
  `divo_gateway` mega-tool has been deleted.
- Prompt-relevant Google and Airtable nested operation schemas are bound before
  inference. A skill must not duplicate those schemas in prose.
- Read-only tool capabilities can run in parallel when every reachable action
  is read-only.
- `divo-local` lets a credential-free script call the same governed backend
  tools and persist large results outside model context.
- The legacy candidate/offer/sample export tool and `secure-data-export` skill
  are being hard-removed by the runtime track. Do not rewrite or provision
  either one. Route complete data movement through the source specialist,
  `divo-python-automation`, and the destination specialist only when the source
  contract exposes truthful continuation. Otherwise require an honest bounded
  answer; prose must not invent missing paging.
- Native-skill staging and warm Pi reuse already use an exact scope/catalogue
  digest. This track must not modify that machinery merely because Markdown
  changes alter the digest.
- `predev` and `prestart` run `pnpm capabilities:reconcile`; changed system
  definitions are therefore idempotently reconciled on backend boot and bump
  the skill registry revision.

Primary implementation history: `6bbaf1f36`, `d1b8f8bd9`, `d08c24013`,
`7ddb2426c`, `299cddf39`, `88c7ddde9`, `2b2db91d6`, and `7941b839e`.

## 3. Why this track exists

Pi now loads the skills correctly, but many skill bodies still reflect the old
architecture:

- tool schemas and argument inventories repeated as prose;
- OAuth, credential, RBAC, paging, retry, and rate-limit explanations that the
  model cannot enforce;
- several competing routes for the same export or file task;
- historical provider implementation notes and environment variable names;
- long defensive instructions created after individual failures;
- tests that assert exact sentences and thereby make bloat permanent;
- routers that explain execution instead of selecting one specialist;
- specialists that restate generic runtime rules instead of teaching the few
  provider semantics Pi genuinely needs.

Representative current sizes show the problem: `google-sheets` is about 14.9
KB, `mail-ops` 16.6 KB, `airtable-core` 13.0 KB, `shopify-commerce` 12.4 KB,
`menhood-data` 11.6 KB, `divo-python-automation` 9.1 KB, and
`divo-semrush-seo-research` 8.0 KB.

Shorter is not automatically better. The target is **higher decision density**:
every retained sentence must change routing, execution, honesty, or completion
verification.

## 4. Locked ideology

### 4.1 Skills guide; tools and backend enforce

A skill may tell Pi what outcome to pursue and which capability to choose. It
must not pretend to enforce authorization, ownership, approval, credential
handling, provider caps, or rate policy. Those are backend checks.

### 4.2 Tool contracts are the API reference

Do not copy full operation lists, JSON schemas, required fields, UUID formats,
or result envelopes into skills when the registered typed tool already exposes
them. If the contract is unclear or wrong, record a dependency in the runtime
plan rather than compensating with another page of prose.

### 4.3 One router decision, one specialist procedure

- Router: determine the task class and select exactly one specialist.
- Specialist: teach the shortest proven workflow plus domain facts the schema
  cannot express.
- Shared workflow skill: own genuinely cross-provider mechanics once.
- Backend/tool: own policy and mechanical validation.

### 4.4 Advisory loading stays advisory

Never reintroduce a hard “skill must be loaded” authorization gate. Make the
right skill easy to discover through its slug, description, aliases, router
edge, and the tool's concise first-use guidance. The backend still rejects an
unsafe call regardless of what was read.

### 4.5 Chase essential clarity

When a missing target, scope, identity, destination, or destructive intent
would materially change the result, ask one short question and stop. Do not
guess work the member will probably reject. Do not ask when the task is already
unambiguous or when a safe read can resolve the missing fact.

### 4.6 Prefer reusable task-class knowledge

Follow the useful Hermes pattern: improve an existing class-level skill before
creating a narrow new one; use a small support fixture/script when mechanics
need exact reuse; avoid turning a single failed run into a global paragraph.

## 5. Standard shape for every rewritten skill

Each skill should contain only the sections that add value:

1. **Use when** — concrete trigger and exclusions.
2. **Outcome** — what a successful result looks like.
3. **Workflow** — the shortest proven sequence, normally 3–7 steps.
4. **Invariants** — two to five rules that protect truth or user intent.
5. **Ask/stop conditions** — only material ambiguity or a real capability gap.
6. **Completion evidence** — the read-back, count, status, or artifact proof.

Optional provider facts belong only when they cannot be expressed by the typed
contract, such as source grain, semantic meaning of a field, or the difference
between “provider returned no row” and “measured zero.”

### Content that should normally be removed

- environment variables, cookies, tokens, endpoint paths, and ops-only setup;
- full tool operation/argument tables already present in the contract;
- generic “do not expose credentials” prose enforced by the runtime;
- repeated retry, rate-limit, or pagination mechanics owned by the client;
- historical failure narratives;
- duplicate export, Google connection, or file-delivery policies;
- instructions for removed tools and compatibility paths no active run sees;
- mandatory preflight/describe calls when the exact typed schema is already
  bound before inference.

## 6. Ownership boundary with the runtime plan

| Finding | Skills track action | Runtime track action |
| --- | --- | --- |
| Wrong router/specialist chosen | Rewrite metadata/edge/body | None unless bootstrap omitted it |
| Correct skill skipped | Improve discovery/first-use guidance and test | Inspect context/bootstrap only if still reproducible fresh |
| Tool schema missing or misleading | Record dependency; do not duplicate it | Fix typed contract/schema propagation |
| Missing provider pagination/discovery | State the honest limit | Implement provider/gateway capability |
| Context too large | Remove unnecessary skill text | Implement lifecycle/compaction changes |
| Run file disappears next turn | Do not call it persistent | Implement governed thread checkpoint storage |
| Authorization/ownership/rate behavior wrong | Do not patch with prose | Fix backend authority |
| Skill row not updated in DB | Fix provision/reconcile coverage | Runtime only verifies bootstrap observation |

## 7. Phase 0 — inventory before rewriting

- [x] Wait until the current company-export-policy slice is committed; the live
      worktree already modifies several skill source files.
      *Landed 2026-08-10 as `72e32448d` and `1042e01ec`.*
- [x] Enumerate every seeded system skill dynamically from the definitions.
- [x] Record slug, human title, summary, aliases, tags, tool IDs, router edges,
      and Markdown bytes. **Current DB revision is not recorded** — that needs
      the Development tunnel and belongs to the first reconciliation, not here.
- [ ] Classify every paragraph as routing, domain semantics, workflow,
      completion proof, backend-owned policy, duplicated schema, historical
      explanation, or contradiction. *Done per pair, recorded in §15; a
      catalogue-wide paragraph pass ahead of the rewrites was not attempted.*
- [ ] Map every skill to at least one natural prompt and expected tool sequence.
- [ ] Map every tool-bearing skill to the actual current typed contract.
      *Done for `dataExport` only, in Wave 1.*
- [ ] Record capability gaps in the non-skills plan instead of writing imagined
      workarounds. *None found yet.*
- [ ] Capture a baseline: prompt tokens, skill reads, tool calls, corrections,
      time, and final-answer truthfulness for the first two pairs.
      *Not captured — needs the local harness.*

### 7.1 Inventory, 2026-08-10

54 seeded system skills, 256,710 bytes of Markdown, roughly 64,000 tokens if
every body were read. Sizes are heavily skewed: the top twelve skills hold about
half the catalogue and the smallest twenty hold under 12,000 bytes together. The
catalogue is not the problem; a dozen files are.

Regenerate with the read-only script recorded in §16.

| slug | family | bytes | ~tok | tools | aliases | routed by |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| mail-ops | mail | 16627 | 4157 | 1 | 12 | google-workspace-router |
| google-sheets | google | 14871 | 3718 | 1 | 12 | google-workspace-router, data-router |
| airtable-core | provider | 12960 | 3240 | 1 | 3 | airtable-router |
| shopify-commerce | provider | 12432 | 3108 | 3 | 10 | shopify-router |
| menhood-data | data | 11595 | 2899 | 1 | 14 | airtable-router |
| google-gmail | google | 10135 | 2534 | 1 | 3 | google-workspace-router |
| divo-python-automation | productivity | 9110 | 2278 | 0 | 9 | data-router |
| schedule-divo-work | productivity | 8375 | 2094 | 0 | 15 | google-workspace-router, work-automation-router |
| divo-semrush-seo-research | research | 8020 | 2005 | 1 | 4 | research-router |
| google-drive | google | 7858 | 1965 | 1 | 5 | google-workspace-router, data-router |
| zoho-books-read-analysis | zoho | 7769 | 1942 | 1 | 17 | finance-zoho-router |
| zoho-books-invoice | zoho | 7385 | 1846 | 1 | 15 | finance-zoho-router |
| google-docs | google | 7073 | 1768 | 1 | 2 | google-workspace-router |
| zoho-books-bill | zoho | 6857 | 1714 | 2 | 7 | finance-zoho-router |
| secure-data-export | data | 6638 | 1660 | 1 | 6 | data-router |
| google-calendar | google | 6606 | 1652 | 1 | 3 | google-workspace-router |
| google-contacts | google | 6402 | 1601 | 1 | 2 | google-workspace-router |
| read-understand-files | files | 6146 | 1537 | 0 | 10 | data-router, files-router |
| google-appscript | google | 5319 | 1330 | 1 | 2 | google-workspace-router |
| google-slides | google | 5110 | 1278 | 1 | 2 | google-workspace-router |
| google-chat | google | 5060 | 1265 | 1 | 2 | google-workspace-router |
| google-forms | google | 5039 | 1260 | 1 | 2 | google-workspace-router |
| google-tasks | google | 5026 | 1257 | 1 | 2 | google-workspace-router |
| divo-oms-site-inventory | research | 4913 | 1228 | 1 | 7 | research-router |
| airtable-automation-ops | provider | 4552 | 1138 | 2 | 3 | airtable-router |
| airtable-schema-ops | provider | 4366 | 1092 | 2 | 3 | airtable-router |
| aitable-datasheets | provider | 3922 | 981 | 1 | 3 | aitable-router |
| data-router | routing | 3907 | 977 | 0 | 14 | (is a router) |
| zoho-books-money | zoho | 3855 | 964 | 1 | 12 | finance-zoho-router |
| create-edit-files | files | 3696 | 924 | 0 | 8 | files-router |
| share-memory | memory | 3601 | 900 | 0 | 0 | memory-router |
| lark-documents | lark | 3529 | 882 | 1 | 0 | lark-router |
| divo-presentations | productivity | 2648 | 662 | 0 | 7 | **UNROUTED** |
| zoho-bill-notify-accounts | zoho | 2570 | 643 | 3 | 3 | finance-zoho-router |
| zoho-crm-read-analysis | zoho | 2365 | 591 | 1 | 5 | finance-zoho-router |
| aitable-fields | provider | 2124 | 531 | 1 | 2 | aitable-router |
| airtable-router | routing | 1747 | 437 | 0 | 17 | (is a router) |
| lark-tasks | lark | 1708 | 427 | 1 | 0 | lark-router |
| lark-router | lark | 1648 | 412 | 0 | 4 | (is a router) |
| lark-calendar | lark | 1520 | 380 | 1 | 0 | lark-router |
| lark-messaging | lark | 1471 | 368 | 1 | 0 | lark-router |
| finance-zoho-router | zoho | 1387 | 347 | 0 | 38 | (is a router) |
| google-workspace-router | mail | 1379 | 345 | 0 | 8 | (is a router) |
| lark-base | lark | 1274 | 319 | 1 | 0 | lark-router |
| lark-meetings | lark | 1264 | 316 | 1 | 0 | lark-router |
| lark-contacts | lark | 917 | 229 | 1 | 5 | lark-router |
| research-router | routing | 859 | 215 | 0 | 6 | (is a router) |
| lark-approvals | lark | 842 | 211 | 1 | 0 | lark-router |
| files-router | routing | 565 | 141 | 0 | 7 | (is a router) |
| shopify-router | routing | 425 | 106 | 0 | 5 | (is a router) |
| memory-router | routing | 422 | 106 | 0 | 7 | (is a router) |
| aitable-router | routing | 310 | 78 | 0 | 4 | (is a router) |
| web-search | routing | 302 | 76 | 1 | 4 | research-router |
| work-automation-router | routing | 209 | 52 | 0 | 5 | (is a router) |

#### Findings that are not about size

1. **`divo-presentations` is unrouted, and the guard cannot see it.**
   `unroutedSeededSystemSkillSlugs()` returns `[]`, because
   `ROUTABLE_SEEDED_SYSTEM_SKILL_SLUGS` never lists the skill. It is
   provisioned for every company by `admin-auth.routes.ts`, appears in the
   registry, and no router points at it — precisely the failure that function's
   own doc comment describes for `divo-python-automation`. The guard is
   incomplete, not passing. Fix in Wave 4, with `divo-presentations`.
2. **Eight skills carry no aliases at all**, all in the Lark family
   (`lark-documents`, `lark-tasks`, `lark-calendar`, `lark-messaging`,
   `lark-base`, `lark-meetings`, `lark-approvals`). Router search scores an
   alias phrase far above a summary, so these are reachable only through
   `lark-router`. Confirm in Wave 9 that this is intended rather than inherited.
3. **Four skills sit under two routers** (`google-sheets`, `google-drive`,
   `read-understand-files`, `schedule-divo-work`). That is legitimate — the
   same specialist genuinely serves two task classes — but each pair of routers
   must give the same answer, or the choice depends on which router loaded.
4. **`finance-zoho-router` carries 38 aliases**, more than any other skill and
   roughly the whole Zoho vocabulary. Worth checking in Wave 7 that the
   specialists below it are still reachable on their own terms.

## 8. Rewrite waves — no more than two coupled skills at once

The exact second member of a pair may change after inventory, but a commit may
not rewrite more than two skill definitions.

### Wave 1 — central data decision

- [x] `data-router`
- [x] ~~`secure-data-export`~~ — **superseded, not shipped.**

Rewritten 2026-08-10 in `0dda5a26e`; see §15. The runtime track then removed the
whole export pipeline in `e90de44f2` and `4596fc00a`, deleting the
`secure-data-export` skill and the `dataExport` tool outright and rewriting
`data-router` to route complete data movement through the source specialist,
`divo-python-automation`, and the destination specialist. The compression of
that skill therefore never reached a runtime. What survived the retirement is
the method, not the text: the tool-owns-its-own-contract rule, the ask/stop
lesson in §15, and the test-fossilization fix.

Goal: one unambiguous distinction between bounded chat work, replayable
provider export, bespoke local transformation, and reading/editing an existing
file. Preserve the governed export compatibility boundary until source E2E
evidence permits removal.

### Wave 2 — local transformation and Sheet destination

- [x] `google-sheets`
- [x] `divo-python-automation` — **examined and deliberately left unchanged.**

Goal: one persistent script, governed calls, local source/checkpoint files,
chunked write, exact read-back, and source/written/verified reconciliation.
Do not embed Google argument schemas or promise turn-to-turn persistence that
the runtime does not provide.

### Wave 3 — research routing

- [x] `research-router`
- [x] `divo-semrush-seo-research`

Goal: choose Semrush versus web/OMS once; retain only Semrush facts needed for
truthful interpretation and the cheapest proven operation selection.

### Wave 4 — files and delivery

- [x] `files-router`
- [x] `read-understand-files`

Then:

- [x] `create-edit-files`
- [x] `divo-presentations`

Goal: local paths are intermediate; final delivery is a governed artifact or
connected destination. Keep export ownership in the export boundary.

### Wave 5 — Airtable and Menhood

- [x] `airtable-router` + `airtable-core`
- [x] `airtable-schema-ops` + `airtable-automation-ops`
- [x] `menhood-data` + the router it actually depends on after inventory

Goal: distinguish live Airtable record work from settled Menhood analytics;
never infer totals from bounded previews or serialize unresolved objects into a
user-facing artifact.

### Wave 6 — Shopify and AITable

- [ ] `shopify-router` + `shopify-commerce`
- [ ] `aitable-router` + `aitable-datasheets`
- [ ] `aitable-fields` + its nearest remaining coupled route/specialist

Goal: preserve read-only/protected-data truth and avoid inventing bulk routes
that the contracts do not expose.

### Wave 7 — Zoho finance

Work from router outward, two at a time:

- [ ] `finance-zoho-router` + `zoho-crm-read-analysis`
- [ ] `zoho-books-read-analysis` + `zoho-books-invoice`
- [ ] `zoho-books-money` + `zoho-books-bill`
- [ ] `zoho-bill-notify-accounts` + the relevant Lark messaging specialist

Goal: domain semantics and completion proof stay; copied schemas and generic
export/rate instructions leave.

### Wave 8 — Google Workspace family

After `google-sheets`, process generated skills in natural pairs:

- [ ] `google-gmail` + `google-workspace-router`
- [ ] `google-drive` + `google-docs`
- [ ] `google-slides` + `google-forms`
- [ ] `google-calendar` + `google-tasks`
- [ ] `google-contacts` + `google-chat`
- [ ] `google-appscript` + the remaining Google routing/automation dependency

Goal: typed native contracts carry arguments; skills carry task procedure,
product-specific semantics, ambiguity rules, and verification.

### Wave 9 — Lark family

- [ ] `lark-router` + `lark-documents`
- [ ] `lark-tasks` + `lark-calendar`
- [ ] `lark-meetings` + `lark-messaging`
- [ ] `lark-contacts` + `lark-base`
- [ ] `lark-approvals` + the remaining Lark umbrella/dependency

Goal: one family router, direct specialist selection, natural language, and no
invented opaque IDs when discovery is unavailable.

### Wave 10 — automation, mail, knowledge, and memory

Pair from the inventory rather than forcing unrelated edits:

- [ ] `work-automation-router` + Schedule Divo Work
- [ ] `mail-ops` + its Google Workspace router dependency
- [ ] `memory-router` + Knowledge Management
- [ ] remaining memory/review/presentation skills in coupled pairs

Goal: preserve real approval and scope boundaries without repeating them as
model-enforced rules.

### Wave 11 — final catalogue audit

- [ ] No seeded active skill is unrouteable unless intentionally direct.
- [ ] No router links to itself, a missing slug, or two specialists for the
      same exact intent without a stated disambiguator.
- [ ] No active skill refers to removed tools or contradictory export paths.
- [ ] No system skill exposes credentials, environment variables, internal
      endpoints, or caller-supplied authorization provenance.
- [ ] Catalogue size, priority ordering, and omission behavior remain inside
      the 100-skill/2 MB native bootstrap budget.
- [ ] Every retained long section has E2E evidence that removing it causes a
      material regression.

## 9. Acceptance gate for every pair

Do not mark a pair complete until all gates pass.

### Static/content gate

- [ ] Trigger description and aliases route representative prompts correctly.
- [ ] Router selects one specialist or asks one material clarification.
- [ ] Specialist names one shortest proven workflow.
- [ ] Typed schema/backend policy is not duplicated.
- [ ] No stale tool, endpoint, environment, or delivery claim remains.
- [ ] Markdown byte/token delta is recorded with a reason for any growth.

### Unit and graph gate

- [ ] Focused skill tests assert behavioral invariants, not exact paragraphs.
- [ ] Provisioning test proves create/update/existing/skip behavior.
- [ ] Changed content creates a new skill version and registry revision.
- [ ] Aliases, grants, tool IDs, and route edges remain correct.
- [ ] `unroutedSeededSystemSkillSlugs()` remains empty.

### Agent Seat gate

- [ ] Run at least one ordinary prompt and one ambiguity/capability-gap prompt.
- [ ] Record skill selection, tool sequence, correction count, and final answer.
- [ ] Pi is not involved here; this isolates content and tool-graph quality.

### Native Cloud-Pi gate

- [ ] Reconcile into Development.
- [ ] Start a fresh Cloud-Pi context through the documented local harness.
- [ ] Confirm the native skill appears and the intended `SKILL.md` is read when
      relevant without a custom loader loop.
- [ ] Confirm only governed typed tools are called.
- [ ] Confirm no credential or bulk rows enter model context.
- [ ] Confirm completion evidence matches the actual artifact/result.

## 10. DB reconciliation and deployment procedure

Skill Markdown is application data, not a Prisma schema migration.

### Development

1. Run the focused tests for the pair.
2. Start the Development DB tunnel and backend only after reading
   `AGENTS.local.md`.
3. Run `pnpm capabilities:reconcile` from `advance-backend/`, or start the
   backend normally (`predev` performs the same reconciliation).
4. Inspect the affected Development rows: slug, system ownership, revision,
   latest version body, aliases, grants, routes, and registry revision.
5. Fetch the authenticated native bootstrap and verify only the intended
   bodies changed.
6. Run Agent Seat, then one fresh local Cloud-Pi harness replay.

### Main

1. Merge through the normal release path after Development evidence is saved.
2. Backend `prestart` runs the same idempotent reconciliation on Main.
3. Verify reconciliation counts and backend health; do not add a second deploy
   provisioning path.
4. Inspect the Main skill revision/body read-only.
5. Run only the explicitly approved, safe, targeted production prompt.
6. Record the evidence in the appropriate tracker and this plan.

### Rollback

- Revert the definition commit and redeploy; reconciliation writes the prior
  system definition as a new version.
- Do not overwrite a non-system/custom skill with the same slug. Provisioning
  intentionally skips it; record the collision and ask for a decision.
- `DIVO_PI_NATIVE_DB_SKILLS=false` is an emergency runtime rollback, not a
  normal skills-content rollback.

## 11. Test map

Primary suites and sources:

- `advance-backend/tests/application/system-skill-routes.test.ts`
- `advance-backend/tests/application/google-workspace-system-skills.test.ts`
- `advance-backend/tests/application/lark-system-skills.test.ts`
- `advance-backend/tests/application/zoho-finance-system-skills.test.ts`
- provider-specific `*-system-skill.test.ts` files
- `advance-backend/tests/http/desktop-auth.routes.test.ts`
- `advance-backend/tests/application/skill-catalog-rbac.test.ts`
- `advance-backend/tests/application/skill-token-folding.test.ts`
- `divo-pi/divo/test/runtime.test.mjs`
- `divo-pi/divo/test/local-rpc-controller.test.mjs`
- `advance-backend/tests/application/agent-seat.service.test.ts`

Behavior evidence belongs in:

- `plans/cloud-pi-production-tool-e2e-tracker.md`
- this plan's rolling evidence section
- sanitized local harness artifacts referenced privately, never copied with
  tokens, connection IDs, chat IDs, or production row data

## 12. Coordination and commit rules

- This agent owns skill definition files, routing seeds, provisioning wiring,
  and their focused tests only.
- The runtime agent owns `divo-pi/`, gateway contracts, backend execution,
  provider adapters, container lifecycle, and non-skill issue fixes.
- Before every pair, inspect `git status` and the exact overlapping diff.
- Never use `git add -A`; commit only the pair and its tests with pathspecs.
- If a runtime dependency blocks a pair, record it in the other plan and move
  to an independent pair. Do not invent prose as a substitute.
- Use a read-only evidence sub-agent before each family and a cold reviewer
  after each pair; only one agent edits a given file at a time.

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| Short skill loses critical domain truth | Preserve only facts tied to a prompt/test; compare natural runs before/after |
| Test suite forces old prose back in | Replace sentence snapshots with routing, invariants, and behavior assertions |
| Definition changes but DB stays stale | Reconcile and inspect Development for every pair; verify Main after deploy |
| Custom skill shares a system slug | Provisioner skips it; record collision and ask, never overwrite |
| Rewrite promises unsupported capability | Cross-check typed contract and E2E evidence; block honestly |
| Advisory loading is skipped | Improve metadata/router/tool first-use cue; never hard-gate execution |
| Two agents overwrite shared files | Strict path ownership, clean baseline, two-skill commits, and diff review |
| Catalogue exceeds bootstrap budget | Measure byte/token changes and preserve priority/order tests |

## 14. Completion gate

This track is complete only when:

- [ ] every active DB-backed system skill has been inventoried;
- [ ] every oversized or contradictory skill is rewritten or explicitly
      retained with evidence;
- [ ] routers and specialists form one consistent graph;
- [ ] tests assert behavior instead of fossilized prose;
- [ ] every rewritten pair is reconciled and verified in Development;
- [ ] native Cloud-Pi discovery and real tool behavior pass for every family;
- [ ] Main contains the intended revisions after deployment;
- [ ] no skill claims authority that belongs to the backend;
- [ ] no open capability gap is hidden behind instructions;
- [ ] the rolling evidence below contains the final before/after metrics.

## 15. Rolling evidence

### Pair: data-router + secure-data-export — 2026-08-10

- Commit / environment: local worktree on `dev`, not yet reconciled to any DB.
- Before → after bytes: `secure-data-export` 6,638 → 4,376 (1,660 → 1,094 tok);
  `data-router` 3,907 → 2,349 (977 → 587 tok). Pair total −3,820 bytes,
  −956 tokens. Catalogue 256,710 → 252,890 bytes.
- What was removed and why: every fact the registered `dataExport` tool already
  states through its zod schema, description, or `parameterDocs` — the format
  row/cell caps, the `destination.format` enum meanings, `transform.script`
  receiving `row`/`index`/`args`, the legacy `op=confirm` path, "do not create a
  sample or ask for another confirmation", and the verbatim "the backend
  re-checks…" paragraph. The skill imported four limit constants purely to print
  numbers the tool already prints; only the Menhood spool cap, which the tool
  does not publish, is still imported.
- What was deliberately kept: candidate attribution to the table the member was
  actually shown, the single-offer rule and its skip list, "the file and the
  chat answer are different artifacts", queued-is-not-finished and the
  completion card as sole truth, permanent-source-failure handling, the Zoho
  Books `accountId` scoping rule, Airtable MCP not being a bulk-export source,
  and the cross-tool refusals (no personal OAuth, no Google permission tool, no
  reshare) that no single tool contract can express.
- Router/specialist boundary: `op=plan` mechanics and the missing-destination
  message moved out of `data-router` into `secure-data-export`, which owns the
  tool. The router keeps task-class selection, the opaque-handle ownership
  table, and four examples that each decide a boundary the bullets decide
  slowly; three examples that merely restated a bullet were dropped.
- Tests: exact-sentence assertions across three suites replaced with
  wrap-insensitive invariant tokens, plus a new guard,
  `leaves the dataExport contract to the dataExport tool`, that fails if any of
  the removed tool-owned facts is pasted back. Backend suite 3,597 pass /
  0 fail / 30 skipped; `tsc --noEmit` clean.
- Cold review: found the first cut too deep in two places, both restored before
  any commit. (a) **Both ask/stop conditions had been deleted** — ask which
  format when the member named none, and ask which table when a direct recipe
  needs one they never named. Neither is deducible from the contract:
  `exportPlanRequestSchema` has no `auto` format, so a silent choice is a silent
  choice of row cap, and `parameterDocs` never tells the model to stop and ask.
  This is the general lesson for later waves — a tool contract states what an
  argument *means* and never that Divo should decline to fill it in.
  (b) The permanent-failure stop rule had been narrowed to the completion card,
  but `op=plan` returns terminal `blocked` outcomes (revoked grant, stale replay
  candidate) that produce no card at all. (c) The legacy
  `preview.exportOfferId` handle row was restored to the router, since Wave 1
  requires preserving that boundary and `gateway-dispatcher.ts` still reads it.
  Each restored rule now has its own regression test. The review independently
  verified every "the tool already says this" claim against
  `data-export.tool.ts`; all held.
- Agent Seat result: not run.
- Cloud-Pi Development result: not run.
- DB revisions / registry revision: not reconciled.
- Cross-plan dependencies discovered: none.
- Pre-existing defect noticed, not fixed here: the skill says pass `accountId`
  for Zoho Books bank transactions, while the backend rule keys on the source
  filter `account_id` and its refusal message says "Add account_id"
  (`data-export.types.ts:105-113`). Same wording before the rewrite, so not a
  regression; worth settling in Wave 7.
- Decision: content complete; **gates §9.3 and §9.4 still open.**

### Pair: google-sheets + divo-python-automation — 2026-08-11

- Commit / environment: local worktree on `dev`, clean baseline after the export
  retirement landed. Not reconciled to any DB.
- Before → after bytes: `google-sheets` 13,350 → 10,314 (3,338 → 2,579 tok),
  −3,036 bytes. `divo-python-automation` unchanged at 8,791. Catalogue
  240,704 → 237,668 bytes.
- **`divo-python-automation` was examined and deliberately not compressed.**
  `divo-local` is a CLI, not a registered tool, so no typed contract exists to
  defer to and the dedup thesis finds nothing. Its bulk is the `divo_invoke`
  helper, whose exact error handling and `DIVO_RUN_DIR` containment check are
  the mechanics §4.6 says to keep as a support fixture, plus the
  checkpoint/reconcile rules. The only available cut was ~300 bytes of generic
  "the backend enforces RBAC" prose. §3 says shorter is not automatically
  better; this is the skill that proves it.
- Two defects fixed, not merely bloat: three JSON examples taught
  `{"toolId": "googleSheets", "args": {…}}`, the `divo_gateway` envelope deleted
  when contracts became typed tools — and which this skill's own preamble
  already says is rejected. And the entire "must not be an Office file"
  paragraph was a second copy of `OFFICE_FILE_RECOVERY`, which
  `withRecoveryHint` appends to Google's own refusal. The error-attached copy is
  strictly stronger: skill prose reaches the model only if the skill was read.
  Its test moved to `tests/tools/google-workspace-office-file.test.ts`, which
  already asserted every claim the skill made.
- Also removed: the `resolve_reference`/`call_resolved_sheet` mechanics, the
  `connectionId` reuse rules, and the format/resize argument shapes — all stated
  by the `googleSheets` `parameterDocs` or bound before inference through
  `bootstrap.nativeContracts`.
- Kept against first instinct, after review: `frozen_row_count`, the
  machine-readable `read_sheet_values` fields, the partial-task definition, both
  pasted-URL forms, and the `manage_sheet_data_validation` shape — the last
  because `suggestedProductOperations` has no branch that ever binds it and no
  keyword for "dropdown", while `dropdown` is a registered alias of this skill.
  The rule cuts both ways: the same reasoning that deletes a bound schema
  requires writing out an unbound one.
- Cold review: found my Lark/Desktop guard was decorative — with the `s` flag it
  passed on channel-inverted prose, and a Lark run never receives
  `data.resource` at all because the dispatcher replaces that response with
  `{status, destinationReferenceId}`. Replaced with a tempered pattern that
  cannot cross the sentence boundary, and proved it by mutating the body and
  confirming the assertion fails. The reviewer's own suggested regex had the
  same defect it was diagnosing.
- Tests: backend suite 3,370 pass / 0 fail / 30 skipped; `tsc --noEmit` clean.
  Verified the diff is a single hunk inside `case 'sheets'`; the other ten
  Google skills are byte-identical.
- Agent Seat result: not run.
- Cloud-Pi Development result: not run.
- DB revisions / registry revision: not reconciled.
- Cross-plan dependency discovered: the shared Google preamble — "Governed
  execution", "Canonical governed call shape", "Reliability and safety" — is
  4,795 bytes carried by all 11 Google skills, **52,745 bytes (~13,200 tokens),
  about 22% of the catalogue**, from one template. It is the largest remaining
  lever and one edit to `buildProductSkillMarkdown`. Left untouched here because
  it changes 11 skills inside a commit claiming two; it belongs to Wave 8.
- Decision: content complete; **gates §9.3 and §9.4 still open.**

### Pair: research-router + divo-semrush-seo-research — 2026-08-11

- Commit / environment: local worktree on `dev`. Not reconciled to any DB.
- Before → after bytes: `divo-semrush-seo-research` 6,180 → 4,031
  (1,545 → 1,008 tok), −35%. `research-router` 771 → 562, −27%. Catalogue
  237,668 → 235,310 bytes.
- **Two sections were policy violations, not merely bloat.**
  `## Backend environment (ops only — never expose to members)` named
  `SEMRUSH_WEB_API_KEY`, `SEMRUSH_WEB_COOKIE`, and `SEMRUSH_TIMEOUT_MS` under a
  heading declaring they must not be exposed, inside a document the model reads
  and can quote — against §5 and the §8 Wave 11 audit item. `## Senior curl
  mapping` was a provenance table pairing each operation with the senior's
  original curl calls, including an Excluded row for a probe that answered
  `403 ERROR 130 API DISABLED`: history, and §5 names historical provider notes
  and failure narratives for removal. The tool's `operation` enum decides
  callability and its `parameterDocs` already name the three operations.
- **A test was pinning the env-var section in place.** `documents web-only env
  vars without legacy api.semrush.com keys` asserted all three names appear in
  the skill body. Its intent — the wired path is the web session, not the
  retired `api.semrush.com` key — is real, so it moved to `EnvSchema`, which
  declares the variables, plus a guard that no `SEMRUSH_*` name returns to the
  markdown. Note `SEMRUSH_API_KEY_WEBHOOK_URL` exists and is separate, so the
  assertion matches exact keys rather than a prefix.
- **The flagship honesty rule was stated twice.** "A country Semrush did not
  return is unknown, not a measured zero" appeared at length in both the
  operation list and the cost/honesty rules, having already drifted in wording
  between the two. Now stated once, with a test asserting it appears exactly
  once — the duplication is what let them diverge.
- Router/specialist boundary: "prefer one main Semrush call and one main table"
  and the local-Python artifact condition were execution decisions living in the
  router. The router now selects and says the specialist owns call count and
  boundedness; the specialist states both. Guarded from both sides.
- Also removed as tool-owned: "never invent endpoint paths, report names,
  headers, cookies, credentials, export columns, or raw provider filters"
  (`parameterDocs` states Divo rejects exactly these), and the bare listing of
  the four result states (`resultSchema` types the enum) — the honesty
  consequence of each state was kept.
- Kept: the shy-answering call prior, one-row-per-country-database semantics,
  `keyword_position_trend` returning a dated series, `database` discovery from
  the `Database` column, the 1–10 targets in one web request cost prior,
  `coverage.missingTargets` meaning no provider data, counts-from-rows, and the
  25-row preview cap.
- Tests: backend suite 3,370 pass / 0 fail / 30 skipped; `tsc --noEmit` clean.
- Cold review: **not run before commit** — this pair was committed on an
  explicit request to move quickly. Run it before reconciling.
- Agent Seat result: not run.
- Cloud-Pi Development result: not run.
- DB revisions / registry revision: not reconciled.
- Decision: content complete; **gates §9.3 and §9.4 still open, and §12's cold
  review is owed.**

### Pair: files-router + divo-presentations — 2026-08-11

- Commit / environment: local worktree on `dev`. Not reconciled to any DB.
- **This pair fixed a defect rather than removing text; byte delta is +190.**
  `divo-presentations` provisioned for every company, appeared in the registry,
  and no router pointed at it, so it was reachable only by a member who already
  knew the slug. It is now a `files-router` target — a deck is a file Divo was
  asked to author — and the router names it.
- **The guard that should have caught this was blind, not passing.**
  `unroutedSeededSystemSkillSlugs()` returned `[]` because
  `ROUTABLE_SEEDED_SYSTEM_SKILL_SLUGS` never listed the skill, and a definition
  missing from that list is exempt from the only check that would notice. Both
  fixed, and proved: with the new route edge removed the function now reports
  `["divo-presentations"]`, where before it reported `[]` either way.
- **`read-understand-files` and `create-edit-files` were examined and left
  unchanged.** Their shared "Dependencies install on demand" block already comes
  from one `DEPENDENCY_TIERS` constant in `bundled-file-scripts.ts`, whose own
  comment explains the drift risk; both skills rendering it is correct, since
  each `SKILL.md` must stand alone. There is no typed tool behind these — the
  helpers are bundled scripts — so nothing defers to a contract. The remaining
  content is tier choice, `--render` versus `--images`, and the
  untrusted-extracted-content rule, all of which change what Divo does.
- Also corrected: the module comment still described the capability chain as
  `files-router` → `divo_skill_view` → markdown. That tool was removed with the
  process-local skill ledger.
- Tests: 3,371 pass / 0 fail / 30 skipped; `tsc --noEmit` clean.
- Cold review: deferred to a single review covering Waves 3-5.
- Decision: content complete; **gates §9.3 and §9.4 still open.**

### Wave 5, slice 1: the Airtable connection block — 2026-08-11

- Commit / environment: local worktree on `dev`. Not reconciled to any DB.
- `airtable-core` 13,080 → 12,544; `airtable-schema-ops` 4,366 → 3,830;
  `airtable-automation-ops` 4,552 → 4,016. −1,608 bytes from one shared helper,
  `airtableConnectionMethod`, which all three skills render.
- **All three were teaching a deleted tool.** The block described the
  `divo_gateway` mega-tool: reach Airtable through `divo_gateway` or `call_tool`
  depending on runtime, wrap the call in root `op: "tools.invoke"` with
  `payload: { toolId, args }`, and keep `connectionId` inside `payload.args`
  rather than beside `payload`. That mega-tool is gone (§2) and each family is a
  registered typed tool, so the envelope is not merely unnecessary — it is
  rejected. A run following this skill literally could not call Airtable.
- **The test asserted the envelope**, so the suite was holding the deleted call
  shape in place. Third instance of this pattern, after the `google-sheets`
  `{"toolId","args"}` blocks and the Semrush env-var section. It now guards that
  no gateway vocabulary returns, and asserts the surviving fact instead: which
  of the three Airtable tools owns a given job.
- **Systemic, not local.** `divo_gateway` is still taught by
  `shopify.skill.ts` (three places, including "call shopifyOrders only as a
  direct divo_gateway tool invocation") and `aitable.skill.ts`. Those belong to
  Wave 6 and were deliberately not touched here.
- **Wave 5 is not finished.** The bodies of `airtable-core` (12.5 KB, and still
  one wall of text with no headings), the two ops skills, and `menhood-data`
  are not yet rewritten. Notably `airtable-core` restates the `filters` tree,
  the date VALUE/RANGE objects, and `get_table_schema` input — and §2 says
  Airtable nested schemas are bound before inference, so those are candidates
  once verified against `airtable-contract-bootstrap.service.ts`.
- Tests: 3,371 pass / 0 fail / 30 skipped; `tsc --noEmit` clean.
- Cold review: pending, to cover Waves 3-5 together.

### Wave 5, slice 2: Airtable bodies + menhood-data — 2026-08-11

- `airtable-core` 12,544 → 11,435; `menhood-data` 11,132 → 10,764. Airtable
  family total 20,390 → 19,369. Catalogue now 232,374 bytes.
- **The filter tree and date objects had an owner already.**
  `AirtableContractBootstrapService` binds `list_records_for_table` before
  inference for every record run, and its own comment states why: the filter
  tree is a deeply nested union that no model reconstructs correctly from
  prose, and each failed guess costs a larger validation dump than the schema
  itself. The skill wrote out the tree, the leaf-condition shape, the full
  operator list, and the date VALUE/RANGE mode enumerations regardless — the
  losing copy of a contract the runtime was already binding. Same for
  `get_table_schema` input.
- **Kept, because no schema encodes it:** which operator suits which field
  type, why a `sel...` choice ID beats a choice name, and the one that changes
  an answer rather than a call — a named calendar month is not a rolling
  window, so filtering July with `pastMonth` returns a different number.
  `list_fields_for_table` guidance stays too: Divo synthesizes that operation,
  so no contract is ever bound for it.
- `menhood-data`: dropped the single-SELECT rule, bound-parameter rule, table
  allow-list, and the `ORDER BY o.order_date, o.order_number, o.id` example —
  all in `menhoodData`'s `parameterDocs`. Kept the reason stable ordering
  matters (a sample is only reviewable if the full replay matches it), the
  never-through-local-Python routing rule, the zero-row schema probe technique,
  and the spend-claim consequence of the unavailable ad-cost table. Its
  coverage and data-model sections were left intact — that is the domain
  semantics §5 exists to protect.
- **Four more fossilized assertions** removed across two suites, pinning the
  gateway envelope, the filter tree, the leaf-condition shape, and the ORDER BY
  column list. Running total for the session: every wave has found at least one
  test holding stale prose in place.
- Tests: 3,371 pass / 0 fail / 30 skipped; `tsc --noEmit` clean.

### Waves 6 and 8: the deleted call surface, and the shared Google preamble — 2026-08-11

- **Wave 6** removed the last `divo_gateway` references, from `shopify.skill.ts`
  (three) and `aitable.skill.ts` (one). The Shopify rules mattered beyond the
  name: "call `shopifyOrders` only as a direct tool invocation" exists to keep
  protected record results on the runtime path that deletes the session and
  suppresses learning, which a `divo-local` or Bash path does not do. That rule
  is kept with its reason spelled out. A catalogue-wide guard now fails if
  `divo_gateway`, `call_tool`, `tools.invoke`, or `payload.args` reappears in
  any skill body.
- **Wave 8 is the largest single change in this track.** The shared preamble in
  `buildProductSkillMarkdown` fell 3,398 → 1,848 bytes, and eleven skills carry
  it: catalogue **232,155 → 208,154 bytes**, −24,001 bytes, roughly −6,000
  tokens from one edit. Google family 76,861 → 49,824.
- What it was duplicating, all from the `googleWorkspace` tool's own
  `parameterDocs`: reuse the bootstrap `connectionId` and reuse it across
  describe and call; prefer the schema already in `bootstrap.nativeContracts`
  and describe once only when absent; `input` may be omitted for describe; the
  approved-operation list, which is the `nativeTool` enum verbatim; and the
  canonical argument object, which is the zod schema. Step 7 was
  `GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.agentGuidance` — **the same constant the
  tool already emits** in its `input` doc, so eleven copies shipped beside the
  original.
- Kept: the no-account OAuth protocol (describe once, wait for
  `google_workspace_authorization_pending`, end the run), never rotating
  accounts after an error, the Bash/CLI/curl/SDK refusal, the `divo-local`
  args-file transport and its no-envelope rule, and the whole reliability
  section — pending is not completed, never guess resource IDs, verify with a
  read, satisfy `level: "required"` advisories.
- Two over-cuts caught by the suite and restored: the `divo_connections`
  routing rule, which the Google tool cannot state because it governs when to
  call a *different* tool, and the availability criterion that every line
  mentioning `divo-local` must carry.
- Tests: 3,372 pass / 0 fail / 30 skipped; `tsc --noEmit` clean.

Append one block per pair:

```md
### Pair: <slug-a> + <slug-b> — YYYY-MM-DD
- Commit / environment:
- Before → after bytes/tokens:
- Natural prompts:
- Expected / actual skills read:
- Expected / actual tool sequence:
- Tool-call corrections before / after:
- Completion evidence:
- Agent Seat result:
- Cloud-Pi Development result:
- DB revisions / registry revision:
- Cross-plan dependencies discovered:
- Decision: complete / revise / blocked
```

## 16. References

- `plans/pi-native-skills-and-terminal-export-simplification.md`
- `plans/pi-typed-tool-surface.md`
- `plans/cloud-pi-production-tool-e2e-tracker.md`
- `advance-backend/docs/cloud-pi-testing/06-agent-seat.md`
- `advance-backend/docs/cloud-pi-testing/07-local-runtime-harness-framework.md`
- `advance-backend/scripts/reconcile-capabilities.ts`
- `advance-backend/scripts/skill-inventory.ts` (`pnpm skills:inventory`) — the
  read-only enumeration behind §7.1; rerun it after every pair to record the
  byte delta the acceptance gate asks for
- `advance-backend/src/application/skills/`
- `learnings/hermes-memory-persona-architecture.md`
