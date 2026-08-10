# Cloud-Pi skills rewrite, native wiring, and DB rollout

> Status: **Planned — handoff to a separate skills agent**
>
> Last updated: **2026-08-10**
>
> Scope: **Cloud Pi only; skill content, router graph, system-skill provisioning, DB reconciliation, and skill-behavior proof**
>
> Explicitly out of scope: **Pi runtime/controller changes, warm-process work, typed-tool implementation, gateway authorization, provider adapters, Jan/Desktop, and export-state-machine deletion**

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
- `dataExport` remains the governed backend boundary for replayable provider
  exports. A separate, currently uncommitted policy slice is changing new
  provider exports to the configured company Google owner with the verified
  invoker as reader. Do not treat that behavior as landed until the runtime
  plan's Phase 0 gate passes, and do not promise a terminal replacement where
  a provider does not yet expose one.
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

- [ ] Wait until the current company-export-policy slice is committed; the live
      worktree already modifies several skill source files.
- [ ] Enumerate every seeded system skill dynamically from the definitions.
- [ ] Record slug, human title, summary, aliases, tags, tool IDs, router edges,
      Markdown bytes, and current DB revision.
- [ ] Classify every paragraph as routing, domain semantics, workflow,
      completion proof, backend-owned policy, duplicated schema, historical
      explanation, or contradiction.
- [ ] Map every skill to at least one natural prompt and expected tool sequence.
- [ ] Map every tool-bearing skill to the actual current typed contract.
- [ ] Record capability gaps in the non-skills plan instead of writing imagined
      workarounds.
- [ ] Capture a baseline: prompt tokens, skill reads, tool calls, corrections,
      time, and final-answer truthfulness for the first two pairs.

Deliverable: an inventory table appended to this file or a linked evidence
file, with no skill body changed yet.

## 8. Rewrite waves — no more than two coupled skills at once

The exact second member of a pair may change after inventory, but a commit may
not rewrite more than two skill definitions.

### Wave 1 — central data decision

- [ ] `data-router`
- [ ] `secure-data-export`

Goal: one unambiguous distinction between bounded chat work, replayable
provider export, bespoke local transformation, and reading/editing an existing
file. Preserve the governed export compatibility boundary until source E2E
evidence permits removal.

### Wave 2 — local transformation and Sheet destination

- [ ] `divo-python-automation`
- [ ] `google-sheets`

Goal: one persistent script, governed calls, local source/checkpoint files,
chunked write, exact read-back, and source/written/verified reconciliation.
Do not embed Google argument schemas or promise turn-to-turn persistence that
the runtime does not provide.

### Wave 3 — research routing

- [ ] `research-router`
- [ ] `divo-semrush-seo-research`

Goal: choose Semrush versus web/OMS once; retain only Semrush facts needed for
truthful interpretation and the cheapest proven operation selection.

### Wave 4 — files and delivery

- [ ] `files-router`
- [ ] `read-understand-files`

Then:

- [ ] `create-edit-files`
- [ ] `divo-presentations`

Goal: local paths are intermediate; final delivery is a governed artifact or
connected destination. Keep export ownership in the export boundary.

### Wave 5 — Airtable and Menhood

- [ ] `airtable-router` + `airtable-core`
- [ ] `airtable-schema-ops` + `airtable-automation-ops`
- [ ] `menhood-data` + the router it actually depends on after inventory

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
- `advance-backend/src/application/skills/`
- `learnings/hermes-memory-persona-architecture.md`
