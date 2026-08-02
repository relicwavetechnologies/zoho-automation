# Unified Data Movement and Spreadsheet Workflows

**Status:** implementation active; Phases 0–4 are complete, and isolated-runtime validation is in progress
**Date:** 2026-08-02
**Scope:** tabular previews, proactive exports, cross-tool data movement, pasted spreadsheet URLs, and the boundary between deterministic backend exports and agent-authored container workflows
**Related foundation:** `plans/secure-data-export-pipeline.md`

---

## Delivery tracker

| Phase | Status | Current result |
|---|---|---|
| 0 — contracts and characterization | ✅ Done | Central limits, offer/resource/destination contracts, and regression coverage established |
| 1 — exporter modularization | ✅ Done | Source registry, destination sink, queue, verification, and worker boundaries centralized |
| 2 — preview and durable offers | ✅ Done | Bounded previews, opaque 24-hour offers, fresh authorization, and idempotent confirmation implemented |
| 3 — Lark export interaction | ✅ Done | Signed format/account cards, same-card progress, OAuth resume, and personal destination preference implemented |
| 4 — editable destinations and formats | ✅ Done | Personal owner/company reader semantics and usable Sheet/CSV/XLSX outputs are implemented; the personal-owner XLSX path is verified end to end |
| 5 — Semrush and OMS convergence | 🟡 Partial | OMS is integrated; Semrush is implemented and cold-reviewed in isolated commit `8eb621a4a`, pending safe integration and live parity evidence |
| 6 — pasted Sheet/Drive URLs | ⬜ Not started | Typed URL resolver and existing-Sheet bulk write remain |
| 7 — routers and provider skills | 🟡 Partial | Central export skill knows Excel; provider-wide routing/skill convergence remains |
| 8 — load and limit tuning | ⬜ Not started | Production measurements and tuned queue/resource ceilings remain |
| 9 — realistic isolated-runtime validation | 🟡 In progress | Dev Lark received a real Zoho preview and a fresh opaque export offer; Sheet/CSV confirmation and no-account OAuth resume remain |

**Immediate completion count:** 5 phases done.

**Latest validation evidence (2026-08-02):**

- The isolated cloud-Pi harness delivered a normal Emiac Zoho Books expense
  request to the Dev Divo DM in 39.155 seconds through the production
  status/final-card path.
- The low-hint request “Show me all expenses from the Emiac Zoho Books
  account” delivered a bounded 10-row preview in 27.503 seconds and persisted
  pending opaque offer `2158efa5-2776-4289-986e-c00d9e71d1f3`; no bulk rows
  were stored in the offer.
- Cloud controller retry classification now covers Pi's transient provider
  transport failures, including `terminated` and `Connection error`. Retries
  remain bounded, and any issued direct gateway action prevents a blind
  continuation retry even when its result was lost.
- Lark-facing runtime failures no longer expose Pi/controller names, internal
  codes, provider text, or tokens. Exact diagnostics remain on the internal
  error/trace path.
- Retry/error-boundary verification: controller 28/28 passed; Lark runtime and
  webhook 150/150 passed.
- OMS snapshot convergence is integrated in `130fbd3cb` (implemented first in
  isolated commit `6bec8626`) with
  14/14 OMS and 46/46 combined OMS/export checks plus TypeScript and diff
  validation. Independent cold review verdict: `ship`; live parity remains.
- Semrush central convergence is complete in isolated commit `8eb621a4a`:
  model-facing previews are capped at 25 rows, exports use opaque central
  offers, partial coverage stays explicit, production no longer creates a
  Cloudinary artifact, and confirmation transparently reruns the same governed
  query. Optional offer-persistence failures now leave both Semrush and OMS
  previews usable instead of failing the agent turn. Focused validation passed
  47/47 checks plus TypeScript and diff validation; two cold-review passes found
  no P0–P3 issue. Integration waits only for the shared `composition.ts` edit
  owned by the other active agent to land cleanly.

- Rebuilt `divo-pi-local:phase0` after detecting that the local image predated
  several committed runtime/extension changes. The controller will replace the
  stopped stale container by immutable image ID on its next activation.
- A fresh, low-hint isolated request now passes signed runtime admission and
  reaches governed Zoho Books account selection. It correctly asks the user to
  choose between the two accessible Books organizations instead of guessing.
- Dev Divo delivery is verified in chat
  `oc_0454e4b0ffbecd8d63d7fc66c372a5c4`. The earlier failure used a DM belonging
  to another Divo application; the development credentials were valid.
- A low-hint isolated run created and repeatedly updated one status card, then
  finalized it with `DIVO DEV DELIVERY LIVE` in 15.1 seconds.
- A low-hint Zoho expense request now stops after one bounded preview, creates
  an immutable 24-hour offer, and renders governed Sheet/CSV/XLSX actions.
- The card confirmation stays bound to the signed Lark chat even when Pi uses a
  synthetic internal thread ID. A user-owned Google account was selected and
  the same card progressed to `Data export ready`.
- The real XLSX job completed with 60 rows, no source truncation, owner access
  for `abhishek@emiactech.com`, and Drive completion metadata. Independent
  readback opened the 61-row by 48-column workbook, found one table, and found
  no formula-error cells.
- XLSX output now derives bounded readable column widths while streaming,
  preserves long string IDs as text, and filters the complete data range.
  Focused tests, TypeScript, raw workbook XML, and LibreOffice rendering pass;
  the independent cold review returned `ship` with no findings.
- A truncated provider page is now described as a preview; an unknown full
  count is no longer exposed as `totalCount`.

---

## 1. Outcome

Divo should treat tabular data as a dataset, not as chat text.

The user experience should be:

1. Small results are useful in chat: show at most 25 representative records plus the total/coverage when known.
2. If more useful data exists, Divo proactively offers an export without repeatedly asking vague questions.
3. The user chooses a destination only when it is genuinely ambiguous.
4. Bulk rows move directly between governed backend components or through a credential-free container script. They do not pass through Pi/model context.
5. A pasted Google Sheet URL becomes a first-class resource: Divo parses it, resolves the user's connection, verifies access, and works on that exact sheet.
6. Every write is verified, auditable, resumable where practical, and delivered back into the originating Lark conversation.

The target data plane is:

```text
source connection
  -> paged SourceAdapter
  -> optional deterministic transform
  -> bounded server-side stream / temporary spool
  -> DestinationSink in batches
  -> read-back / artifact verification
  -> progress and result in Lark
```

The model is the control plane. It sees intent, schemas, a small preview, counts, progress, errors, and opaque IDs. It does not carry the complete dataset.

---

## 2. Direct answer: is source-to-Sheets piping brute force?

No. Fetching from one system and writing to another is the normal ETL/integration pattern used by automation products.

The unsafe version would be:

```text
Semrush returns 5,000 rows to the model
  -> model rewrites them into another tool call
  -> Sheets receives the model-generated payload
```

That would be slow, expensive, lossy, token-limited, difficult to resume, and vulnerable to hallucinated or omitted rows.

The correct version is:

```text
Semrush pages are read by backend/container code
  -> rows are streamed or written to JSONL/Parquet
  -> deterministic code transforms them
  -> Sheets is written in bounded batches
  -> the model receives only counts and the final URL
```

The current central export implementation already follows the correct approach for Airtable and Zoho Books:

- source adapters expose paged async streams;
- the worker rechecks identity, source access, and RBAC;
- rows are transformed and spooled server-side;
- the Google sink writes Sheets in batches of 500 or uploads CSV;
- temporary files are deleted;
- bulk rows never enter model context.

The existing `divo-local` Python workflow also keeps bulk data outside model context. It is a real credential-free runtime bridge: scripts can page governed source calls, write JSONL/Parquet in the user's container, transform with Python/DuckDB, and invoke a governed destination.

Therefore, the architectural problem is not the act of piping data. The problem is fragmented provider behavior and unclear ownership of when to use each execution mode.

---

## 3. Decisions recorded

### D1. One dataset-delivery contract, two execution modes

We will centralize shared contracts, policies, destination resolution, resource references, and audit semantics. We will retain two execution modes with an explicit boundary:

#### Mode A — deterministic backend pipeline

Use for repeatable, productized bulk flows where a source adapter exists:

- export Semrush rows;
- export Zoho Books invoices;
- export Airtable records;
- export an OMS response snapshot;
- write a known dataset into a new or existing Sheet/CSV/XLSX destination.

Canonical flow:

```text
ExportOffer
  -> queued DataMovementJob
  -> SourceAdapter
  -> deterministic transform
  -> DestinationSink
  -> verification
```

This is the default for one-source exports because it is deterministic, testable, resumable, observable, and independent of agent-generated code.

#### Mode B — governed container workflow

Use for bespoke multi-product work whose transformation is different per request:

- join CRM leads with Semrush metrics;
- reconcile invoices with a user-provided workbook;
- fetch from multiple apps, clean data with Python, and write related updates;
- perform non-trivial custom calculations before publishing results.

Canonical flow:

```text
Pi plans the workflow
  -> credential-free divo-local calls governed backend tools
  -> rows remain in JSONL/Parquet/DuckDB inside the isolated user workspace
  -> destination writes still go through governed backend capabilities
  -> script checkpoints IDs, counts, and progress
```

Mode B must not become a second authority for credentials, RBAC, approvals, or sharing. Those stay in `advance-backend`.

### D2. The 25-row rule is a central preview policy

- At most 25 tabular records are presented inline by default.
- Providers do not invent their own 50/200-row model limits.
- A preview reports whether it is complete, truncated, sampled, or provider-limited.
- An export offer is attached when more useful rows are available or the user explicitly asks for a file/destination.
- “25 rows” is a user-interface policy, not an export limit.

### D3. The server owns export offers

The model must not reconstruct a large source query or raw export payload after the user confirms.

An `ExportOffer` is an immutable, opaque server-side record containing:

- company and requesting user;
- source type, exact connection, and normalized query;
- known coverage/row estimate and provider caveats;
- allowed destination formats;
- originating Lark reply address;
- expiry, status, idempotency key, and audit metadata;
- no raw result rows.

The Lark card or natural-language confirmation carries only the opaque `offerId` plus the user's destination choices. On confirmation, the backend rechecks the actor, source access, destination access, RBAC, and connection health.

Export offers will be persisted in Postgres with a 24-hour expiry. The schema
change must use this repository's existing Prisma `db push` workflow; do not
create Prisma migration files.

### D4. User-editable output is the product requirement

The current central export creates an artifact under one company Google account and grants the invoking user reader access. That is insufficient when the expected behavior is “I need to work on this later.”

Confirmed destination order:

1. a connected user-owned Google account, producing a user-owned/editable Sheet;
2. only when no eligible personal account exists, the Divo/company destination
   governed by admin policy, where the requester receives read-only access;
3. a downloadable CSV/XLSX artifact when a Sheet is unsuitable.

The Divo/company fallback remains read-only for the requester in V1. We must
not silently grant editor or broad-link access to company-owned artifacts.

### D5. Destination selection should not become repetitive

- An explicitly named eligible personal account wins after access validation.
- The company destination remains fallback-only and cannot bypass an eligible
  personal account.
- Otherwise, prefer the requesting user's eligible personal connection.
- Multiple eligible personal accounts: use a stored explicit preference; if none exists, ask once and remember the scoped preference.
- No eligible personal connection: use the governed Divo/company account only when company policy allows the operation.
- No eligible personal or governed fallback account: show the existing connection flow and resume the request afterward.
- Explicit user destination or pasted Sheet URL: honor it after access validation and select the account that can access that exact resource.
- No explicit format: choose Google Sheet for editable, manageable data; CSV for very large flat data; XLSX only when an actual workbook is requested.

Account selection must be a backend resolver policy, not model guesswork or a
hardcoded connection ID. The model may understand phrases such as “my work
Google account,” but the backend maps that intent to an exact eligible
connection and returns a safe choice state when ambiguous.

### D6. A pasted resource URL is parsed, not browsed

We will add a strict allowlisted resource-reference parser. It will never fetch an arbitrary URL just because it looks like a document.

Initial supported behavior:

- Google Sheets URL -> parse spreadsheet ID and optional `gid`, resolve connection, probe metadata/access, then use governed Sheets operations.
- Google Drive-hosted XLSX URL -> resolve Drive file; conversion/import to Google Sheets requires explicit approval.
- Attached/local XLSX -> process in the isolated container with the existing spreadsheet skill, then publish through a governed destination when required.
- OneDrive/SharePoint/Excel Online URL -> explicitly unsupported until a Microsoft connector exists.
- Lark Base/Sheet URL -> later phase after canonical URL parsing, table/schema discovery, and pagination exist.

### D7. Existing Sheet writes require verification

For a pasted or selected existing Sheet:

1. retrieve spreadsheet metadata;
2. resolve the tab/range safely;
3. read only the bounded data needed for the task;
4. perform the governed write;
5. read back the affected range;
6. return the canonical URL and exact change summary.

Bulk source-to-existing-Sheet jobs use the streaming destination sink. They do not ask the model to emit thousands of cells.

Potentially destructive changes—overwrite, clear, delete, or major structural
replacement—must create a Lark HITL approval for the relevant connected
account/resource owner before execution. Append-only or additive changes may
proceed under normal RBAC when policy allows. Approval routing is backend-owned;
the model cannot approve on the owner's behalf.

For V1, references such as “this Sheet” remain in normal agent conversation
context rather than a new separately persisted resource-memory subsystem. The
backend still reparses/revalidates the resource and access before each
important operation.

### D8. OMS exports are snapshots, not “all data”

The current OMS provider is capped and does not offer full pagination. Until the provider supports it, Divo may export the returned response but must label coverage truthfully, for example: “100 rows returned by OMS; this may not be the full dataset.”

### D9. No big-bang rewrite

The current `application/data-export/` worker is a sound foundation. Centralization should evolve it in behavior-preserving slices before considering a rename to `data-movement` or `dataset-delivery`.

An implementation that renames/moves more than eight files, adds another
database schema change beyond the confirmed ExportOffer table, or changes
permission semantics must be confirmed separately before execution.

---

## 4. Current state and fragmentation

### Working foundation

- One BullMQ export queue/worker exists.
- Airtable and Zoho Books have paginated source adapters.
- Identity, RBAC, connection, and source permission are rechecked in the worker.
- Rows stream through a bounded transform and server-side spool.
- Google Sheets and Drive CSV destinations are implemented and verified.
- Progress is delivered by editing one Lark tracker.
- A 96 KB model-facing result limit provides a final guardrail.
- Container Python instructions already require bulk rows to stay in JSONL/Parquet rather than model context.

### Fragmented behavior to converge

| Provider/path | Inline behavior | Bulk behavior | Problem |
|---|---:|---|---|
| Zoho list handlers | 25-row threshold | suggests export | Closest to desired UX, but the skill also contains stale “never export” wording |
| Airtable / Zoho Books central export | governed | queued Sheet/CSV | Sound foundation, but the model constructs too much source detail |
| Semrush | up to 200 rows | temporary Cloudinary CSV, up to 1,000 fetched | Separate policy, separate upload path, excessive model exposure |
| OMS | up to 50 rows | temporary Cloudinary CSV | Separate policy and incomplete-provider coverage is easy to misrepresent |
| Container Python | model sees summaries only | JSONL/Parquet + governed calls | Correct for bespoke workflows, but its boundary with central export is undocumented |
| Google Sheets tools | bounded governed read/write | direct operations when IDs are known | No canonical pasted-URL resolver |

### Missing capabilities

- persisted opaque export offers;
- a single 25-row preview envelope across providers;
- editable/user-owned destination resolution;
- true XLSX sink;
- source adapters for Semrush and OMS;
- pasted URL -> validated resource reference;
- bulk writes into a user-selected existing Sheet;
- thread-scoped memory for “this Sheet” / “that workbook”;
- one central Lark export-choice interaction;
- consistent telemetry across deterministic and container workflows.

---

## 5. Target module ownership

The first implementation phase should keep `application/data-export/` and introduce small submodules inside it. A later rename can happen only after behavior is stable.

Proposed target shape:

```text
advance-backend/src/application/data-export/
  contracts/
    dataset-preview.ts
    export-offer.ts
    data-movement-job.ts
    source-adapter.ts
    destination-sink.ts
    resource-reference.ts

  preview/
    tabular-preview.policy.ts
    export-offer.service.ts

  offers/
    export-offer.repository.ts
    confirm-export-offer.service.ts

  sources/
    source-registry.ts
    airtable.source.ts
    zoho-books.source.ts
    semrush.source.ts
    oms-snapshot.source.ts

  destinations/
    destination-resolver.ts
    google-sheet.sink.ts
    google-drive-csv.sink.ts
    google-drive-xlsx.sink.ts

  resources/
    resource-url.parser.ts
    resource-access-resolver.ts
    google-sheet-resource.resolver.ts

  interactions/
    lark-export-card.ts
    lark-export-action.handler.ts

  data-export.queue.ts
  data-export.worker.ts
```

This is a responsibility map, not authorization for a large folder move. Implementation should extract one seam at a time while keeping existing imports stable when possible.

### Shared contract sketches

```ts
type DatasetCoverage =
  | { kind: 'complete'; totalRows: number }
  | { kind: 'truncated'; returnedRows: number; knownTotal?: number; reason: string }
  | { kind: 'provider_limited'; returnedRows: number; reason: string }
  | { kind: 'unknown'; returnedRows: number };

interface DatasetPreview {
  columns: string[];
  rows: Array<Record<string, unknown>>; // maximum 25
  coverage: DatasetCoverage;
  exportOfferId?: string;
}

interface ResourceReference {
  provider: 'google' | 'lark' | 'microsoft';
  kind: 'spreadsheet' | 'drive_file' | 'base';
  resourceId: string;
  subresourceId?: string; // gid/table id/etc.
  canonicalUrl: string;
}
```

The exact TypeScript shapes should be derived from existing local patterns during implementation. The important contract decisions are the 25-row maximum, explicit coverage semantics, opaque offer IDs, and typed resource references.

---

## 6. Pasted Sheet URL workflow

### Example

User pastes:

```text
https://docs.google.com/spreadsheets/d/<spreadsheet-id>/edit#gid=123
```

Then asks:

```text
Add the latest Semrush keyword data to this sheet and remove duplicates.
```

### Required flow

1. **Admission and parsing**
   - Detect only allowlisted resource URL patterns.
   - Parse provider, resource ID, and optional tab/gid.
   - Reject malformed or lookalike hosts without making a network request.

2. **Connection resolution**
   - Find eligible Google Workspace connections for the requesting user/company.
   - If exactly one can access the Sheet, select it.
   - If several can access it, ask which account and remember the scoped preference.
   - If none are connected, show Connect Google and resume after OAuth.

3. **Access probe**
   - Call governed spreadsheet metadata using the parsed ID.
   - Distinguish missing connection, missing scope, inaccessible file, deleted file, and read-only access.

4. **Thread-scoped resource handle**
   - Store a small validated handle for the current conversation/thread so follow-ups such as “add another tab” can resolve “this Sheet.”
   - Store IDs and selected connection reference, never OAuth credentials.
   - Revalidate access before each important operation.

5. **Execution choice**
   - Small bounded edit: direct governed Google Sheets call.
   - Large one-source import: deterministic queued export with the existing Sheet as destination.
   - Bespoke multi-source transformation: governed container workflow, with source data in local files and destination writes via `divo-local`.

6. **Verification and delivery**
   - Read back the affected range or verify destination metadata/counts.
   - Update the same Lark tracker with what changed and the canonical Sheet URL.

### Non-goals for V1

- arbitrary web URL fetching;
- Microsoft Excel Online editing without a Microsoft connector;
- silently converting an XLSX file into Google Sheets;
- loading an entire workbook into model context;
- remembering a resource globally across unrelated users or conversations.

---

## 7. Proactive export UX

### Small complete result

Show the result inline. If the data is naturally reusable, include a quiet “Export” action, but do not force another question.

### More than 25 rows or an explicitly large request

Show:

- the first/representative 25 rows;
- exact coverage wording;
- a compact export offer;
- destination/format choices only when needed.

Good wording:

```text
Found 1,284 matching rows. I’ve shown 25 here.
Export the complete result to:
[ Google Sheet ] [ CSV ] [ Excel ]
```

For OMS:

```text
OMS returned 100 rows. This provider may have more data.
Export these returned rows?
```

Avoid:

- repeatedly asking “Do you want export?” after every list call;
- implying a provider-limited response is complete;
- showing a temporary third-party link when a governed connected destination exists;
- asking for an account when only one valid choice exists;
- asking the model to reconstruct filters after the user clicks Export.

### Confirmation channels

Both paths must invoke the same backend confirmation service:

- Lark Card 2.0 form/action;
- natural-language reply such as “yes, put it in my work Google account as a Sheet.”

Card callbacks must authenticate the clicking actor and must not trust company/user/source IDs from the card payload.

---

## 8. Phased implementation

### Implementation progress — 2026-08-02

- Added characterization coverage for source-registry dispatch, retry after a
  persisted completion, and rejection of recovered artifacts with broad access.
- Extracted the destination write contract into
  `data-export.destination.ts`; the worker now depends on the port while the
  existing Google sink remains the unchanged runtime implementation.
- Removed the worker's duplicate source-to-tool mapping and reused the canonical
  `datasetSourceToolId` used by tool authorization.
- Focused result: `data-export.test.ts` — 23 passed, 0 failed.
- `pnpm typecheck` and `git diff --check` passed.
- Fresh GPT-5.6 Terra medium cold review verdict: `ship`, no verified findings,
  no cleanup/deletion proposed, and no generated or temporary artifacts found.
- Added a Postgres-backed immutable `DataExportOffer` recipe with tenant/actor
  isolation, deterministic idempotency, and a 24-hour expiry. Raw rows and
  provider credentials are not stored in the offer.
- Routed the existing governed `dataExport` tool through the offer service so
  the new repository/service are live code; the gateway permission check and
  worker-side permission recheck remain in place.
- Applied the schema to the `divo_dev` database with Prisma `db push`; no
  migration file was created. Regenerated the ignored Prisma client.
- Expired recipes—including already-confirmed recipes—are deleted before their
  prior queue job can be reused. A later identical request creates or converges
  on a fresh opaque offer.
- Phase 2A focused result: 29 passed, 0 failed; `pnpm typecheck` and
  `git diff --check` passed. Fresh cold review initially found the confirmed
  recipe retention gap; after the fix and follow-up review, verdict: `ship`.
- Added the provider-neutral `DatasetPreview` contract with a hard 25-row
  model-facing cap and explicit `complete`, `truncated`, `provider_limited`,
  and `unknown` coverage. Provider-observed row counts remain distinct from
  the smaller model preview.
- Migrated ordinary Zoho Books list responses to the preview contract without
  duplicating the same rows under legacy `data`. Display formatting remains
  intact, and legacy `truncated` now truthfully reflects overflow.
- A default Zoho list overflow now persists one opaque offer only when the
  requester has `dataExport:create`, full Zoho read scope, an exact connection,
  a Lark chat, and the offer service is available. It does not claim, confirm,
  enqueue, or persist rows. Explicit `exportAll=true` remains unchanged until
  the shared confirmation path replaces it.
- Phase 2B focused result: 54 passed, 0 failed; `pnpm typecheck` and
  `git diff --check` passed. Fresh cold review and follow-up verdict: `ship`.
- Added natural-language offer confirmation through the existing governed
  `dataExport` tool. Its confirmation branch accepts only a strict opaque
  `{ offerId }`; source, destination, connection, company, user, and chat
  cannot be reconstructed or overridden by the model.
- Confirmation reloads the tenant-, actor-, and chat-scoped immutable recipe,
  then freshly resolves active identity, `dataExport:create`, stored-source
  read access, and full-company Zoho scope before any claim or queue call. The
  worker retains the final execution-time identity, RBAC, connection, and
  destination checks.
- Duplicate confirmation is exclusive: one caller holds a 60-second database
  lease, concurrent callers receive a truthful `in_progress` result without
  entering the queue path, and a stale lease can be atomically reclaimed after
  an interrupted attempt. Already-confirmed offers reuse their recorded job.
- Updated the backend-provisioned export skill so Divo asks once when a preview
  exposes more rows and, after explicit confirmation, submits only the opaque
  offer ID.
- Phase 2C focused result: 67 passed, 0 failed; `pnpm typecheck` and
  `git diff --check` passed. Fresh GPT-5.6 Terra medium cold review found and
  verified the concurrency/truthful-status fixes; final verdict: `ship`.
- Persisted the backend-derived Lark reply address (`replyToMessageId` and
  `replyInThread`) inside each immutable offer/job recipe. Both direct exports
  and Zoho overflow offers copy it only from trusted run context; model/tool
  arguments cannot set or relocate it.
- The worker now creates its single progress tracker at that stored address, so
  a group-thread export stays in the originating thread while DM/no-reply jobs
  retain their existing behavior. All later progress, completion, and error
  states continue editing the same tracker message.
- Reply addressing participates in the immutable export specification hash, so
  a retry cannot silently redirect an existing request to another location.
- Reply-address focused result: 63 passed, 0 failed; `pnpm typecheck` and
  `git diff --check` passed. Fresh GPT-5.6 Terra medium cold review verdict:
  `ship`, with no verified findings or cleanup proposed.
- Added a backend-owned Google destination resolver. One eligible user-owned
  writable account is selected automatically; multiple accounts produce a
  signed Lark choice card; an exact selected connection is carried into the
  immutable queue job; and the configured company destination is used only
  when no eligible personal account exists.
- The worker revalidates the exact selected connection before execution.
  Personal-account exports are created and verified under that account as the
  sole owner. Company fallback exports retain the V1 requester-reader policy.
  Legacy queued jobs without a target remain compatible with the configured
  company fallback.
- Removed the remaining direct `zohoBooks exportAll` queue bypass. Explicit
  Zoho exports now use the same destination-resolving offer service as every
  other governed export before a job can be queued. If personal ownership is
  ambiguous, Zoho keeps its source connection separate and accepts only the
  exact backend-returned Google `destinationConnectionId` on retry.
- Destination ownership focused result: resolver/offer 28 passed, export 38
  passed, Zoho Books 23 passed, Lark runtime 30 passed, Lark webhook 134
  passed; gateway/finalization 90 passed, TypeScript and `git diff --check`
  passed.
- Added typed export OAuth continuation data to the existing durable Google
  authorization intent and applied the nullable JSON column to `divo_dev` with
  Prisma `db push`; no migration file or row rewrite was created.
- When export confirmation has no eligible destination, the signed Lark action
  replaces the same card with Connect Google. OAuth completion revalidates the
  current Lark identity and newly connected personal account, then invokes the
  existing offer confirmation service directly with the opaque offer, selected
  format, and original card ID. It does not reconstruct a prompt or start Pi;
  ordinary Google OAuth continuations retain their existing isolated-Pi path.
- If the direct resume cannot start after Google connects, the continuation is
  marked failed and the same export card is edited with a visible retry message
  rather than remaining stuck on the Connect Google state.
- OAuth-resume focused result: offer/export 60 passed, Lark webhook 135 passed,
  Google OAuth flow/repository 29 passed, gateway/Zoho Books 94 passed;
  TypeScript and `git diff --check` passed.

### Phase 0 — freeze contracts and characterize current behavior

**Goal:** make the next refactor mechanical and safe.

- Add focused characterization tests for current Airtable/Zoho Books paging, streaming, retry/idempotency, progress editing, and destination verification.
- Record exact Semrush/OMS behavior, provider caps, and Cloudinary paths in tests.
- Define the preview, coverage, offer, resource-reference, and destination-selection contracts.
- Define the Postgres export-offer schema and 24-hour expiry using the existing
  Prisma `db push` workflow; do not add migration files.

**Exit criteria**

- Existing central export behavior is protected by focused tests.
- No contract permits more than 25 model-facing rows.
- `ExportOffer` contains no raw rows.
- Execution-mode selection is documented and testable.

### Phase 1 — modularize the existing exporter without changing behavior

**Goal:** centralize code ownership before adding more providers or UX.

- Extract source adapter and destination sink interfaces from the current files.
- Isolate source registry, destination resolution, progress delivery, and verification behind existing service boundaries.
- Move constants that are truly shared into one policy module.
- Preserve the current queue name, job identity, tool surface, and tests.
- Do not move/rename the whole directory in this phase.

**Exit criteria**

- Airtable and Zoho Books exports behave byte-for-byte equivalently at the public contract.
- The worker depends on interfaces/registries rather than provider branches.
- No provider-specific uploader exists inside the central worker.
- Narrow export tests and typecheck pass.

### Phase 2 — central preview and persisted export offers

**Goal:** separate user intent/confirmation from bulk execution.

- Implement the 25-row `DatasetPreview` policy.
- Persist immutable export offers with expiry and idempotency.
- Make source tools return structured preview/coverage/offer metadata.
- Add a single offer confirmation service with fresh permission/connection checks.
- Ensure duplicate clicks or repeated confirmations create only one job.

**Exit criteria**

- Results of 25 rows or fewer do not create unwanted files.
- Larger results expose at most 25 rows and one opaque offer ID.
- Revoked source access fails before job execution.
- Expired/tampered offers fail safely.
- Duplicate confirmation is idempotent.

### Phase 3 — Lark export interaction

**Goal:** make export choices clear without a conversation loop.

**Phase 3A completed:**

- A successful governed source result can create a backend-owned, run-scoped export-offer receipt.
- The Lark runtime converts only that verified receipt into Card 2.0 Sheet and
  CSV choices.
- Each button contains the opaque `offerId` and one allowed format; actor,
  company, and chat come from the signed Lark callback.
- The callback routes directly to `DataExportOfferService.confirmForActor`, so button and natural-language confirmation share the same persisted recipe, fresh RBAC checks, and idempotent queue claim.
- The signed callback card ID is attached only to the winning queue job; the worker edits that same card through progress and terminal delivery without posting a second tracker.
- Callback responses use toasts only, so a delayed callback response cannot overwrite a fast worker's progress or completed card.
- The original reply/thread address remains persisted in the recipe and controls worker progress/final delivery.

**Phase 3B completed:** the verified offer card now presents explicit Google
Sheet and Drive CSV choices. The signed callback may alter only that output
format before the immutable recipe is queued; destination ownership is resolved
separately, and the same card remains the progress tracker.

**Phase 3C completed:** personal Google account ambiguity is resolved through
the signed Lark card. The card carries only the opaque offer, allowed format,
and exact eligible connection ID; backend identity, RBAC, chat, and connection
eligibility remain authoritative.

**Phase 3D completed:** destination OAuth resumes the exact backend-owned offer
after connection and retains the original card as the progress/final tracker.

**Phase 3E completed:** when a user explicitly selects one of several personal
Google accounts on the signed Lark card, that eligible choice is remembered at
the user/company scope after the export wins the queue claim. Future exports
reuse it only while it remains writable and correctly owned; stale preferences
are ignored, and OAuth continuation or automatic/company choices do not mutate
the preference.

**Exit criteria**

- The callback actor is reauthenticated.
- Confirmation edits the same Lark message through queued/running/final states.
- Group-thread and DM delivery behave correctly.
- A user never needs to resend the original query after connecting an account.

### Phase 4 — editable destinations and format completion

**Goal:** make exported data genuinely usable afterward.

- Add user-owned Google destination resolution.
- Add admin-controlled company destination fallback.
- Remember an explicit destination preference at the correct user/company scope.
- Add a real XLSX sink; do not rename CSV bytes to `.xlsx`.
- Keep Sheet/CSV/XLSX format selection deterministic and size-aware.

**Completed in Phase 4:** user-owned Google resolution, signed account choice,
execution-time connection revalidation, owner-only artifact verification, and
the governed company-reader fallback. Explicit personal preference persistence
is applied to the tunneled shared dev/prod database. True XLSX is generated
server-side from the existing row spool, structurally reopened before upload,
then verified by Drive size, MIME type, and access. Since the installed SheetJS
writer retains workbook cells in memory, explicit Excel output is bounded to
5,000 rows and 100,000 cells; larger or wider exports must use CSV. `auto`
continues to choose only Google Sheet or CSV and never silently selects XLSX.
Generated workbooks also keep long string IDs as text, size columns from the
actual normalized data within a fixed readability cap, and apply a filter to
the full exported range.

**Exit criteria**

- A user-owned Sheet is editable by the user.
- Divo/company-owned output gives the requester read-only access in V1.
- Multiple-account selection is requested only when genuinely ambiguous.
- CSV, XLSX, and Google Sheet outputs are structurally verified.

### Phase 5 — Semrush and OMS convergence

**Goal:** remove provider-specific temporary export paths.

- Add Semrush as a paged source adapter with provider cost/row guardrails.
- Add OMS as a snapshot source adapter with explicit incomplete-coverage semantics.
- Route both through central preview/offers/destinations.
- Remove Cloudinary CSV generation only after parity tests pass.
- Keep a per-source feature flag during rollout; never run two exports for the same request.

**Exit criteria**

- Semrush exposes at most 25 model-facing rows.
- OMS never claims its response is exhaustive.
- Neither provider creates temporary Cloudinary export links.
- All exports use the central queue, destination policy, audit, and progress flow.

### Phase 6 — pasted Google Sheet/Drive URL resolver

**Goal:** let the user paste a Sheet and immediately work on it safely.

- Start with a strict parser for
  `https://docs.google.com/spreadsheets/d/<spreadsheetId>` plus optional numeric
  `gid`; reject lookalike hosts, malformed IDs, and generic Drive URLs before
  any provider call.
- Resolve an exact personal Google connection and validate metadata plus write
  access server-side. Company/Divo connections remain read-only for user-owned
  Sheet work and are never selected merely because they can view the file.
- Store a thread-scoped opaque Sheet reference in the existing
  `RuntimeConversation.refsJson`; store no OAuth material and revalidate access
  before every consequential read or write. No Prisma migration is required.
- Keep small direct reads/edits in the governed Google tool. For large imports,
  add an internal `existing_google_sheet` destination to the central queue and
  sink; V1 writes a new named tab or appends in bounded batches, then verifies
  the header, final row, and count. It does not clear or overwrite an existing
  tab.
- Add Drive XLSX metadata resolution and explicit conversion approval.
- Return clear unsupported behavior for OneDrive/Excel Online and Lark Base until their connectors are ready.

**Exit criteria**

- Valid Google Sheet URLs resolve without the model guessing IDs.
- Lookalike/unsupported URLs are never fetched.
- Missing connection, wrong account, insufficient scopes, no write access, and inaccessible resource are distinct states.
- Multiple writable personal accounts require one explicit choice; no account
  uses the existing OAuth-and-resume path.
- Large writes stream through the destination sink.
- Important writes are read-back verified.
- Destructive Sheet operations remain a separate HITL path; URL resolution
  itself grants no authority.

### Phase 7 — tune routers and provider skills

**Goal:** teach the agent the centralized behavior after the backend makes it true.

- Update the Data Work Router with the deterministic-vs-container decision boundary.
- Update Semrush, OMS, Zoho, Airtable, Google Sheets, file/document, and local Python skills.
- Remove stale/conflicting instructions such as Zoho's unconditional “never export.”
- Teach resource-URL routing before generic web browsing.
- Teach the agent to carry `offerId`/`resourceRef`/job IDs, never raw rows.
- Add examples for preview, export choice, multiple accounts, pasted Sheet, existing-Sheet bulk write, provider-limited data, and OAuth continuation.

**Exit criteria**

- Skill tests prove the intended route for representative prompts.
- No skill asks the model to copy a large record set between tool calls.
- No provider skill invents separate row/export limits.
- User-facing wording says Divo, not Pi or internal implementation terms.

### Phase 8 — load, cost, and limit tuning

**Goal:** raise limits based on measured behavior rather than guesses.

- Load-test queue concurrency, container disk use, temp-spool cleanup, Google batch writes, retries, and provider throttling.
- Measure time-to-preview, offer acceptance, rows/sec, bytes/job, destination-write failures, and cost.
- Tune per-provider page size, batch size, maximum rows/bytes, and queue concurrency.
- Keep the current 5,000-row cap until tests justify a controlled increase.

### Phase 9 — realistic local-container validation and iteration

**Goal:** prove the complete user experience through the same isolated cloud-Pi
path used in development, with results delivered to the real Divo Lark DM.

This is the final release gate, not an informal smoke test. Unit/integration
tests prove contracts; this phase proves that routing, skills, the controller,
the Docker lifecycle, connections, data movement, Lark cards, and final
delivery work together.

#### 9.1 Validate the test tooling first

- Inventory the scripts used by the flow, especially:
  - `advance-backend/scripts/db-tunnel.sh` / `pnpm dev:e2e`;
  - the normal local backend start command;
  - `advance-backend/scripts/run-engine-harness.ts`;
  - the private Pi controller and Docker runtime entrypoints.
- Check every script against the current controller/runtime contracts before
  relying on it. Remove or update stale instructions and duplicate scripts only
  after references, callers, package commands, CI usage, and runtime entrypoints
  prove what is obsolete.
- Require all test-specific values through CLI arguments or environment:
  backend URL, user identity, model, Lark chat ID, connection preference, and
  fresh-context behavior. Do not add source-code defaults for this test phase.
- Confirm scripts fail clearly when the DB tunnel, Redis, Docker, controller,
  backend, credentials, or required environment is unavailable.

#### 9.2 Start from a VM-like local state

- Start the database tunnel and local backend using the documented development
  commands.
- Ensure no user agent container is already running unless the test explicitly
  covers warm reuse.
- Invoke the isolated runtime through the controller; do not run a special
  in-process shortcut.
- Verify the first request creates/starts the correct per-user container, its
  workspace remains isolated, and subsequent requests follow the configured
  warm-container behavior.
- Capture container lifecycle, controller lease, queue, gateway, export job,
  and Lark delivery evidence without exposing credentials or raw datasets.

#### 9.3 Deliver every scenario to the real Divo DM

Use Abhishek's real member identity resolved from the development database as
the primary tester persona. Reuse the already connected personal Google and
governed Divo/company connections through normal backend resolution. Do not
extract OAuth tokens, inject credentials into the container, bypass RBAC, or
call providers through a privileged test-only path. The test is valid only when
the same member session, gateway, connection resolver, permission checks, and
tool execution path used by a real Lark request all participate.

Use the harness with the Lark chat ID supplied explicitly:

```bash
cd advance-backend
pnpm tsx scripts/run-engine-harness.ts \
  --backend-url http://127.0.0.1:8000 \
  --chat-id oc_4da3c8e6a6a2b9eb29a2aea24fd17e50 \
  "<normal user prompt>"
```

`oc_4da3c8e6a6a2b9eb29a2aea24fd17e50` is the current manual test target, not a
production default and not a value to embed in runtime code. The test must
verify acknowledgement/status updates and the final answer/artifact in that DM,
not only harness stdout.

#### 9.4 Test account resolution deliberately

The current test user has a personal Google connection and a governed
Divo/company connection. The resolver must demonstrate:

1. explicit account/destination in the prompt -> use that eligible account;
2. no account stated + eligible personal connection -> prefer the user's
   personal account;
3. no eligible personal connection -> use the governed Divo/company fallback
   only when policy allows it;
4. multiple eligible personal accounts without a stored preference -> ask once;
5. pasted existing Sheet -> select only a connection that can access that
   resource, regardless of generic preference;
6. no valid connection or fallback -> connect, then resume the original request.

Selection must be proven from resolver/audit evidence. A plausible final link
alone does not prove the correct account was used.

#### 9.5 Use low-hint, realistic prompts

Test as a normal user who knows what outcome they want but does not know Divo's
tool names, routers, row limits, connection IDs, or internal architecture.

Prompt families should include:

- “Show me the best keywords for our site.”
- “Put the complete result in a Sheet so I can work on it.”
- paste a Google Sheet URL alone and verify Divo reads metadata only before
  asking what to do; then request: “Add the latest keyword data here and remove duplicates.”
- “Get the invoices from last month and make an Excel file.”
- “Compare this workbook with our CRM leads and add a summary tab.”
- “Use my work Google account for this.”
- an ambiguous multi-account request that should ask exactly one useful question;
- an OMS request whose result must be labelled provider-limited;
- a follow-up such as “now add a chart to that Sheet” without repeating the URL;
- a request from a user with no personal Google connection to validate the
  governed fallback and, when forbidden, the connect/resume path.

Do not tell Divo which internal tool, skill, adapter, sink, or execution mode to
use. The system/router/skills must generalize from ordinary language.

#### 9.6 Evidence-driven fix and retest loop

For each failed or confusing behavior:

1. preserve the prompt, Lark message IDs, trace/run/job IDs, relevant logs, and
   observed result;
2. trace the failure to the owning layer: contract, resolver, policy, adapter,
   destination, router, skill, controller, or Lark delivery;
3. fix the smallest correct owner rather than adding prompt-specific text or
   user/account/provider hardcoding;
4. add the narrowest regression test that fails before the correction;
5. run the focused test and required typecheck/build evidence;
6. run `$cold-review` on the exact slice using one fresh GPT-5.6 Terra medium
   reviewer, then verify and fix confirmed findings;
7. rerun the original low-hint prompt and at least one adjacent paraphrase;
8. inspect the actual Lark DM output and destination contents before marking the
   scenario passed.

Use Terra-medium read-only subagents for bounded exploration at each major
slice—contracts/modularization, resolver/account selection, source adapters,
destination sinks, skills/routing, and final E2E diagnosis. They may inspect and
challenge the implementation; the primary agent owns edits and validation.

#### 9.7 Final code-quality gate

- One clear owner exists for preview policy, account resolution, export offers,
  source registration, destination selection, and resource URL resolution.
- Provider/user/test-specific behavior is not hardcoded where a contract,
  registry, policy, or configuration belongs.
- Legacy Semrush/OMS/Cloudinary paths are removed only after parity, reference,
  registration, feature-flag, and runtime reachability checks prove orphanness.
- Stale imports, exports, routes, feature flags, comments, tests, scripts, and
  documentation are removed with the proven orphan in the same scoped slice.
- `git diff`, staged diff, and untracked/generated artifacts contain only the
  intended work; unrelated user/agent work is preserved.
- E2E artifacts use a unique test prefix and cleanup deletes only files created
  and recorded by that exact test run.
- The cold review reports repository-hygiene and deletion evidence explicitly.

**Exit criteria**

- The full scenario matrix completes through a locally started isolated Docker
  runtime and delivers observable results to the configured Divo Lark DM.
- Personal-account preference, explicit selection, governed fallback,
  ambiguity, and connect/resume behavior all pass without hardcoded identities
  or connection IDs.
- At least one large export, one pasted-Sheet edit, one XLSX flow, one bespoke
  multi-source container workflow, and one provider-limited result are verified
  at their real destinations.
- Original prompts and adjacent paraphrases behave consistently.
- Focused tests, final typecheck/build evidence, final cold review, and repository
  hygiene checks are green.
- Remaining limitations are explicitly documented; no failed behavior is
  hidden by a legacy or model-mediated fallback.

---

## 9. Test matrix

### Preview and offer

- 0, 1, 25, and 26 rows;
- known total vs unknown total vs provider-limited;
- explicit “show in chat” vs “export all”;
- offer expiry and tampering;
- duplicate clicks/retries;
- source permission or connection revoked between preview and confirmation.

### Destination

- one eligible user Google account;
- several eligible accounts;
- company fallback allowed/denied;
- read-only destination selected for a write;
- Google Sheet, CSV, and real XLSX;
- partial artifact cleanup;
- idempotent retry finds/reuses the completed artifact.

### Resource URL

- valid Google Sheet URL with query/fragment/gid;
- malformed ID and Google-lookalike host;
- Drive-hosted XLSX;
- inaccessible/deleted resource;
- connected account lacks required scope;
- two accounts, only one can access;
- two accounts can access, requiring selection;
- OneDrive/SharePoint/Lark URL receives an explicit supported/unsupported result;
- resource handle survives a queued job and remains scoped to the correct user/thread.

### Data integrity and security

- sparse columns discovered on later pages;
- formula-injection strings;
- transformations that fail/expand rows/timeout;
- source pagination loops;
- provider rate limits and retries;
- no credentials in Pi/container/script/logs;
- no raw dataset in audit or model-facing output;
- user A cannot confirm user B's offer or use user B's resource handle.

### Lark behavior

- DM and group-thread addressing;
- acknowledgement -> queued -> running -> complete in the same card;
- cancellation and error state;
- OAuth continuation edits/resumes the original request;
- natural-language confirmation and card confirmation invoke identical backend behavior.

### Final realistic behavior

- low-hint prompts select the correct route without naming internal tools;
- explicit account selection beats preference;
- personal account beats governed fallback when both are eligible;
- governed fallback works only under policy when the user has no eligible account;
- pasted Sheet URL resolves to the exact accessible resource;
- original prompt and adjacent paraphrase produce equivalent execution choices;
- actual Lark DM card/final delivery and destination contents match the trace;
- the primary persona is resolved from the real development DB and uses only
  governed connection/tool paths;
- no test chat ID, user ID, connection ID, provider branch, or sample prompt is
  hardcoded into production behavior.

---

## 10. Observability

Every flow should correlate:

- `requestId` / agent run ID;
- `offerId`;
- job ID and idempotency key;
- source type and hashed connection identifier;
- page count, returned rows, output rows, bytes, and coverage kind;
- execution mode: deterministic backend or governed container workflow;
- destination type and hashed resource identifier;
- queue wait, source time, transform time, sink time, and verification time;
- final state: completed, truncated, cancelled, expired, denied, or failed.

Never log:

- OAuth tokens or SaaS credentials;
- raw row contents;
- signed temporary URLs;
- complete pasted URLs when their query parameters may contain secrets.

---

## 11. Failure behavior

- **No source connection:** connect and resume; do not discard the offer.
- **Several source connections:** ask which one; never guess across accounts.
- **Destination unavailable:** retain the valid offer until expiry and let the user choose/connect another destination.
- **Provider caps results:** export only observed rows and label coverage accurately.
- **Worker overload:** keep the job queued and edit the acknowledgement with position/waiting copy; no “try again.”
- **Partial write:** delete a newly created partial artifact where safe; for an existing Sheet, record the exact completed checkpoint and report the affected range.
- **Verification failure:** do not claim success merely because the provider returned 2xx.
- **Container recycled:** bespoke workflows resume only from explicit checkpoints; durable export jobs remain backend-owned.

---

## 12. Rollout and rollback

- Feature flag by company and source provider.
- Do not run both old and new exports for comparison; compare telemetry/fixtures, not user-visible duplicate writes.
- Retain a provider's legacy export path only until its central adapter passes parity and production verification.
- Once cut over, remove the legacy provider-specific uploader rather than keeping a silent fallback.
- A failed central export must remain visible; do not hide it behind a Cloudinary or model-mediated fallback.
- If a rollout fails, disable new offer creation for that provider while preserving direct bounded reads.

---

## 13. Immediate next actions

1. Confirm the live pending Zoho offer as Google Sheet, verify content/owner,
   repeat as CSV, and clean up only the exact test artifacts.
2. Run the no-eligible-account OAuth-resume case with a designated test
   identity that has neither a personal Google destination nor company fallback.
3. Obtain live OMS parity evidence before deleting the retained rollback-only
   Cloudinary path.
4. Integrate isolated Semrush commit `8eb621a4a`, then obtain live Semrush
   preview/offer/export evidence before removing its rollback-only Cloudinary path.
5. Add the pasted Google Sheet resolver and existing-Sheet streaming destination.
6. Tune skills and routers once each instruction describes backend behavior
   that exists and is covered by contract tests.
7. Execute Phase 9 through the isolated Docker runtime, deliver every
    scenario to the configured Divo Lark DM, and iterate until the final quality
    gate passes.

---

## 14. Confirmed product decisions

1. **Destination ownership and access**
   Prefer the user's eligible personal Google account, where the user can edit.
   Use the governed Divo/company account only as fallback, with read-only access
   for the requester in V1.

2. **Destructive Sheet operations**
   Overwrite, clear, delete, or major structural replacement requires a Lark
   HITL approval card routed to the relevant account/resource owner.

3. **Conversational resource context**
   Let the agent retain “this Sheet” through normal conversation context in V1;
   do not add a separate persisted resource-memory subsystem. Backend access is
   still revalidated at execution time.

4. **URL-only behavior**
   When a user pastes a Sheet URL without an instruction, inspect metadata only
   and ask what they want. Do not automatically read large/private contents.

5. **E2E test artifacts**
   Tests may create real Google files. They must use a unique test prefix,
   record created resource IDs, and remove only artifacts created by that exact
   test run.

6. **Export-offer persistence**
   Persist opaque export offers in Postgres for 24 hours. Apply the Prisma
   schema through the repository's `db push` workflow; do not create migration
   files. The produced Google artifact follows normal Drive retention rather
   than offer expiry.

7. **Excel URLs in V1**
   Support attached XLSX and Google Drive-hosted XLSX with explicit conversion;
   exclude OneDrive/SharePoint URLs until a Microsoft connector exists.

8. **Initial bulk cap**
   Keep the central 5,000-row cap, add byte/provider-cost caps, and raise it
   only after Phase 8 load measurements.

---

## 15. Architecture confidence and principal risks

**Confidence: 94%.** The core recommendation is backed by the existing working export worker, sink, provider tools, runtime bridge, and focused tests. It also matches the standard source-stream-transform-sink architecture for integration products.

Principal risks:

1. destination ownership and sharing semantics are product/security decisions, not merely code changes;
2. the confirmed Prisma `db push` schema change must be applied and verified
   against the correct development database without destructive drift;
3. existing-Sheet partial writes require careful checkpoint and idempotency design;
4. Semrush cost/pagination and OMS provider caps require source-specific truthfulness;
5. skill changes made before backend contracts exist would recreate fragmentation in prompt form;
6. a large folder rename/refactor could destabilize a working worker, hence the incremental modularization requirement.

---

## 16. Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-08-02 | Bulk rows never transit model context | Prevents token, fidelity, cost, privacy, and retry problems |
| 2026-08-02 | Keep deterministic backend export and governed container workflow as separate execution modes | They solve repeatable and bespoke work respectively |
| 2026-08-02 | Centralize provider preview at 25 rows | Consistent Lark UX and bounded model exposure |
| 2026-08-02 | Use opaque server-owned export offers | Confirmation must not reconstruct source queries or trust card payload identity |
| 2026-08-02 | Evolve the existing exporter incrementally | Its streaming/queue/sink architecture is already sound |
| 2026-08-02 | Treat pasted URLs as typed resource references | Safe routing and governed account/access resolution |
| 2026-08-02 | Prefer editable/user-owned destinations | Users expect to continue working with exported data |
| 2026-08-02 | Keep OMS coverage explicitly provider-limited | Current provider response cannot prove completeness |
| 2026-08-02 | Tune skills only after backend centralization | Prompts must describe one real source of behavior |
| 2026-08-02 | Resolve accounts by explicit intent, then personal preference, then governed fallback | Prevents account confusion without repeatedly questioning the user |
| 2026-08-02 | Close with real local-container-to-Lark testing and adjacent-prompt iteration | Contract tests alone cannot prove controller, skill, connection, card, and destination behavior together |
| 2026-08-02 | Reject prompt-specific and identity-specific hardcoding during fixes | Behavior must generalize through contracts, policies, routers, and skills |
| 2026-08-02 | Personal Google exports are editable; Divo/company fallback exports are requester-read-only | Preserve usability without granting company-owned write access in V1 |
| 2026-08-02 | Destructive Sheet changes require owner-routed Lark HITL | Protect the actual resource owner from silent destructive writes |
| 2026-08-02 | Use normal agent context for “this Sheet” in V1 | Avoid a separate resource-memory subsystem while retaining backend revalidation |
| 2026-08-02 | Persist 24-hour export offers in Postgres through Prisma db push | Survive callbacks/restarts and prevent duplicate exports without migration files |
| 2026-08-02 | E2E cleanup may delete only artifacts recorded as created by that test run | Permit real testing without risking unrelated user data |
| 2026-08-02 | Persist the original Lark reply address in each export recipe | Deferred workers must not move group-thread results into the group root or let callbacks relocate delivery |
| 2026-08-02 | Render export buttons only from exact backend run-effect receipts | Model text and tool arguments cannot mint a trusted Lark action |
| 2026-08-02 | Keep export card payloads opaque and reauthenticate callback actor/chat | Prevent card tampering or forwarded clicks from choosing identity, tenant, source, destination, or delivery target |
| 2026-08-02 | Bind the signed Card 2.0 `open_message_id` to the winning queue job | Let the worker edit the original offer card without adding mutable card identity to the stored export recipe |
| 2026-08-02 | Use toast-only callback responses once the worker owns the card | Avoid a callback/worker race that could replace a completed export with stale queued copy |
| 2026-08-02 | Persist only an explicit signed-card personal destination after the export wins its queue claim | Avoid repeated account questions without letting model input, stale OAuth state, fallback policy, or a losing concurrent click rewrite preference |
| 2026-08-02 | Treat `127.0.0.1:15432` as a tunnel to the shared dev/prod database | Prevent local-database assumptions when applying or reporting Prisma schema changes |
| 2026-08-02 | Offer XLSX only as an explicit bounded format; keep `auto` on Sheet/CSV | SheetJS 0.18.5 has no streaming XLSX writer, so a 5,000-row/100,000-cell ceiling prevents container memory spikes while CSV remains the scalable fallback |
