# Data export: identity, coverage, and recovery — final design

Status: **implemented (V1 + V2-lite)**, 2026-08-04. Baseline: `cd218170c`; full V2 durable source recovery remains deferred.

This design closes the class of defects behind the export pipeline's repeated
breakages. V1 is a correct, idempotent whole-run retry: after an interruption it
may re-fetch the recipe from page one. Part 6 records the Airbyte-inspired V2
durable-recovery path for when resume-from-checkpoint becomes necessary. It is
written against verified Divo and Airbyte production code rather than inferred
from intent. Divo borrows Airbyte's checkpoint protocol; it does not adopt the
Airbyte platform, credential model, or connector runtime.

---

## Part 1 — Constraints that were discovered, not chosen

These are properties of the system as built. Any design that violates one of
them is wrong regardless of how clean it looks.

### C1. The offer-key formula is frozen

`confirmForActor` recomputes `dataExportOfferKey(offer.payload)` from the
*persisted* payload and compares it against the *stored* `idempotencyKey`
column ([data-export-offer.service.ts:139-144](../advance-backend/src/application/data-export/data-export-offer.service.ts:139)):

```ts
this.assertSameRequest(
  offer,
  offer.payload,
  dataExportSpecHash(offer.payload),
  dataExportOfferKey(offer.payload),
);
```

Change the formula and every offer written before the deploy fails that
comparison. It throws `CONFLICT_MESSAGE` — *"Only one data export can be queued
per user request"* — which describes nothing that happened. The offer TTL is 24
hours, this repo deploys by `prisma db push` with no migration step, and no
migration could backfill the column anyway.

The Lark card is unaffected: it carries the row's uuid, not the key. The card
looks fine and dies at the last step.

**The only safe lever is the `requestId` *value*, not the formula.** `requestId`
travels inside the payload, so recomputation from a persisted payload always
agrees with what was stored.

### C2. The offer key must be invariant to everything the append path mutates

`replacePendingPayload` rewrites `payloadJson` and `specHash` and **never**
rewrites `idempotencyKey`
([data-export-offer.repository.ts:130-143](../advance-backend/src/infrastructure/persistence/data-export-offer.repository.ts:130)).
So a key that depended on `additionalParts`, `observedRowCount`, or
`destination.title` would diverge from its own column the moment a second part
landed — breaking the 22-domain merge the machinery exists for, on new rows, not
just legacy ones.

### C3. A run can bind exactly one offer

`recordDataExportOffer` throws when a second offerId appears under the same run
identity ([run-effect-receipt.store.ts:259](../advance-backend/src/application/runtime/run-effect-receipt.store.ts:259)),
and the gateway converts that throw into a hard tool failure
([gateway-dispatcher.ts:1234](../advance-backend/src/application/gateway/gateway-dispatcher.ts:1234)).
The card renderer likewise emits exactly three buttons bound to one `offerId`
([lark-pi-runtime.service.ts:1032-1056](../advance-backend/src/application/runtime/lark-pi-runtime.service.ts:1032)).

Consequence: **adding `datasetSourceShapeKey` to the offer key, on its own,
makes things worse.** A Zoho-plus-Semrush run goes from *zero export buttons* to
*the tool call fails and asks the member to retry*. Per-shape offers are a
feature spanning the receipt store, the renderer, and the card copy — not a
one-line identity tweak.

### C4. `limit` is not always a row count

`organic_position_trend` takes `limit` as **months** of history, bounded to 120
([semrush.types.ts:82](../advance-backend/src/application/semrush/semrush.types.ts:82),
[semrush.client.ts:21](../advance-backend/src/infrastructure/semrush/semrush.client.ts:21)).
The export adapter is safe today only by accident: its paging branch is gated on
`operation === 'organic_positions'`, so months never reach the row arithmetic.
Any generalisation of that branch to "operations with a limit" silently
reinterprets 24 months as 24 rows.

### C5. Optional fields split the key space silently

`sha256CanonicalJson` runs `JSON.stringify`, which drops `undefined` values
([hash.ts:12-18](../advance-backend/src/shared/hash.ts:12)). A new *optional*
key field yields the old hash when absent and a new one when present — one code
path, two key spaces, and a failure that looks intermittent.

### C6. The current spool is attempt-local, not recoverable

`GoogleWorkspaceExportSink` writes rows to `mkdtemp(...)/rows.ndjson` and
unconditionally removes that directory in `finally`
([google-workspace-export.sink.ts:51-58](../advance-backend/src/application/data-export/google-workspace-export.sink.ts:51),
[google-workspace-export.sink.ts:175-178](../advance-backend/src/application/data-export/google-workspace-export.sink.ts:175)).
The current job can recover an already-completed new Google artifact by
`exportKey`, and the existing-Sheet path uses a deterministic export tab, but a
worker crash during source reading loses the spool and restarts the recipe from
the beginning. A local temp file therefore cannot be a checkpoint.

This is an accepted V1/V2-lite tradeoff: a retry may re-fetch the recipe from
page one. The full V2 durable design in Part 6 adds a Divo-private staging store
and a persisted run manifest. In either version, provider credentials and source
rows never enter Pi or a job payload.

---

## Part 2 — What is actually broken

Four defects, one root cause: **there is no single place that owns "the rows the
member asked for" or "what this export failed to include."** Every adapter
re-invents both, and each gets a different half wrong.

| # | Where | Defect | Member sees |
|---|---|---|---|
| D1 | [data-export.sources.ts:291](../advance-backend/src/application/data-export/data-export.sources.ts:291) | Non-`organic_positions` Semrush flags `sourceTruncated` on any `partial`, and the client sets `partial` whenever `rows.length === limit` ([semrush.client.ts:165](../advance-backend/src/infrastructure/semrush/semrush.client.ts:165)) | A satisfied `keyword_gap` limit of 250 ships a ⚠️ warning **and** a permanent cover-sheet row reading `Partial — Divo export safety cap reached` |
| D2 | [data-export.sources.ts:78-80](../advance-backend/src/application/data-export/data-export.sources.ts:78) | Airtable deletes `maxRecords` before any routing decision, so the member's row window is erased | Asked for 50 records, receives the whole table up to the format cap — plus a truncation warning if the table exceeds it |
| D3 | [data-export.sources.ts:271](../advance-backend/src/application/data-export/data-export.sources.ts:271) | OMS discards `result.status`; the provider caps at 100 rows with no pagination | A provider-capped export is delivered as complete, while the *chat* path for the identical query does warn |
| D4 | four of five provider tools | `exportWithdrawn: true` is set structurally, but only Semrush explains it in `message` ([semrush.tool.ts:191](../advance-backend/src/application/tools/families/semrush.tool.ts:191)) | No button and no reason, unless the router happened to load `secure-data-export` |

D1 is the sharpest: the *same file*, thirty lines below, already proves the
correct rule. The paged branch computes `requestedLimitReached` and suppresses
the warning; the non-paged branch does not.

---

## Part 3 — The design

### Decision 1 — identity stays as shipped

Run-scoped `dataExportRunRequestId` for the five append paths, call-scoped
`dataExportCallRequestId` for the two submit paths. Shape does **not** enter the
offer key (C3). Shape mismatch continues to withdraw, which is the locked
ideology and the only honest option while a run can bind one offer.

If per-shape offers are ever wanted, the lever is the `requestId` value —
`${runId}#${shapeKey}` — which is formula-safe under C1 and C2. It must ship
*together with* a multi-offer receipt store and a per-dataset card group, or it
converts "no button" into "the run fails."

### Decision 2 — one place owns the row window

Introduce `datasetSourceSelection(source): { limit?, offset? } | undefined`,
resolved **per kind and per operation**, alongside the existing
`datasetSourceShapeKey` in `data-export.types.ts`. It returns `undefined` where
no window exists (Zoho) or where `limit` is not a row count
(`organic_position_trend` — C4 becomes explicit and typed instead of
accidentally safe).

The source registry then wraps every adapter's `read()` in a window decorator
that enforces the selection centrally: skip `offset` rows, stop at `limit`.
Adapters may still push the window down to the provider for efficiency — Semrush
already does, correctly — but **correctness no longer depends on each adapter
remembering to.** An adapter that forgets over-fetches; it cannot over-deliver.

This is the corrected form of the `ExportSpec` idea that was reverted last
round. That attempt was right about the diagnosis and wrong about the placement:
it hoisted the window to one offer-level `payload.selection`, but a run has many
parts and each carries its own window. The window belongs on the part.

Fixes D2. Makes D1's rule reusable rather than per-adapter folklore.

### Decision 3 — coverage is structured; a satisfied request is never truncation

The old boolean cannot honestly express both what the member asked for and what
stopped the export. Replace it with an additive `coverage` result:

```ts
type DataExportCoverage = {
  readonly requestedRows?: number;
  readonly inputRowsRead: number;
  readonly rowsWritten: number;
  readonly outcome: 'complete' | 'requested_window_satisfied' | 'partial';
  readonly cause?:
    | 'provider_limit'
    | 'export_row_cap'
    | 'destination_row_cap'
    | 'destination_cell_cap'
    | 'spool_cap';
  readonly knownOmittedRows?: number;
};
```

A `requested_window_satisfied` outcome means the member got the requested
window, even if the adapter knew that more upstream rows exist. It creates no
warning. `knownOmittedRows` is populated only when the source or limit proves
the number; Divo must not invent it.

Only an unwanted stop is `partial`:

1. **The adapter** reports `provider_limit` only when it can prove the provider
   stopped the read.
2. **The shared worker/sink** reports the exact Divo limit that stopped it. A
   row cap, destination cell cap, and spool cap remain distinguishable.

This resolves the internal contradiction in the earlier `sourceTruncated`
definition: upstream rows outside a satisfied request are intentionally out of
scope, not omitted. It also makes the 1,234-row truth table executable.

During the migration, `sourceTruncated` remains a derived compatibility field
for old completed jobs and Drive metadata. New presentation, final cards, and
cover sheets read `coverage`; they never claim "Divo export safety cap reached"
without that exact cause. This kills D1 and D3 and the Zoho status-boundary
false positive ([data-export.worker.ts:333](../advance-backend/src/application/data-export/data-export.worker.ts:333),
where `hasMore` means "another status query remains, possibly empty").

### Decision 4 — withdrawal is carried by the runtime, not by instructions

The system skill does explain withdrawal
([data-export-system-skill.ts:34-36](../advance-backend/src/application/skills/data-export-system-skill.ts:34)),
but `secure-data-export` is router-loaded via `data-router`, so a run that never
mentions exporting may never load it. Semrush is safe because it hard-codes the
sentence in `message`; the other four are safe only if the router cooperated.

All five tools state the withdrawal in `message`, as Semrush already does. The
skill sentence stays as backup. This follows the repeated lesson in this
codebase: an instruction-layer promise that the runtime does not carry is a
promise that gets dropped.

Fixes D4.

---

## Part 4 — What this deliberately does not do

- **No canonical `ExportSpec` type.** The window is per-part; a per-part
  selection resolver plus a shared decorator gets the same guarantee without a
  payload migration or a new offer-level field (C1, C2).
- **No change to the offer-key formula.** C1.
- **No per-shape offers.** C3 — decided below.
- **No Zoho row window.** Neither Zoho schema accepts `limit`/`offset`
  ([data-export.types.ts:29-42](../advance-backend/src/application/data-export/data-export.types.ts:29));
  filters are the only expressible bound. Adding one is a separate product
  decision, not a correctness fix.
- **No Airbyte platform or SDK in the serving path.** Divo's backend continues
  to own credentials, OAuth refresh, RBAC, approvals, audit, and destination
  access. Airbyte is a production-code reference for checkpoint semantics only.
- **No row-content deduplication.** Duplicate-looking rows can be legitimate
  business data. Resume avoids duplicate *page staging* by page receipt and
  checkpoint; it must never silently collapse rows by value or guessed ID.

---

## Part 5 — Behaviour changes to call out

**Airtable `maxRecords` starts being honoured.** This flips a currently-pinned
test ([data-export.test.ts:139-152](../advance-backend/tests/application/data-export.test.ts:139),
which asserts `maxRecords: 1` is absent from both provider calls and two rows
come back for a request that named one). The flip is intended: `pageSize` and
`cursor` stay deleted because they are preview transport — `pageSize` is clamped
to 10 for chat previews ([airtable-mcp.tool.ts:314-322](../advance-backend/src/application/tools/families/airtable-mcp.tool.ts:314)) —
whereas `maxRecords` is the member's own row count. "Show me 50" should export
50; "export everything" sends no `maxRecords` and still walks the table.

---

## Decision 5 — a mixed-shape run stays at zero buttons, and says so

Decided 2026-08-03. A run that mixes two dataset shapes continues to offer no
export, which is the locked ideology working as designed: a single file cannot
honestly hold Zoho invoices and Semrush domains, and half a dataset behind a
button that claims the whole answer is worse than no button at all.

Per-dataset button groups are coherent but are a feature, not a fix — they
require the receipt store to hold a list of offers per run (C3), the card to
render one group per dataset, and footer copy naming each group's dataset.
Deferred. Decision 4 is what makes today's behaviour honest, and that is the
part that is actually broken.

Revisit only if members ask for it in practice. The implementation lever is
recorded under Decision 1.

---

## Part 6 — V2-lite implementation and full V2 reference

The earlier decisions make a completed export truthful. **V1 deliberately does
not make source reading resumable:** a worker loss before publication re-runs
the confirmed recipe from page one. This is acceptable while exports are small
enough that the retry cost and source-change risk are tolerable.

V1 still keeps destination effects safe: the Google sink looks up Divo-created
files by `exportKey`, removes only incomplete Divo-created artifacts, recovers a
verified completed artifact, and uses a deterministic tab plus append-missing
behaviour for an existing member-owned Sheet. It never clears a member sheet.

### V2-lite — implemented 2026-08-03

V2-lite closes the cross-replica publishing gap without retaining raw source
rows. The deterministic BullMQ export job is the durable run record: it already
holds the immutable recipe, progress-card ID, and — before any conversation
write or final-card delivery — the verified Google artifact receipt. The worker
now takes the existing fenced database lease under
`data-export:<exportKey>` for the complete job lifetime.

- A second replica defers before it reads a source, creates a Google artifact,
  or edits the member's card. The deterministic BullMQ job is moved back to
  its delayed queue without spending a retry attempt.
- The holder checks that it still owns the lease before checkpointing a
  completion, saving the conversation resource, or delivering either terminal
  card. A completion-card transport failure defers the checkpointed job without
  spending the final BullMQ attempt.
  A lost lease never sends a terminal failure card; the current lease holder is
  allowed to complete the same idempotent job.
- The Google artifact receipt has two durable states: `verified` records the
  exact type, row count, coverage, and privacy check before `complete` is
  acknowledged. A retry re-verifies and promotes `verified` to `complete`; it
  never deletes a receipt it can prove was verified. Only an unverified,
  Divo-created artifact is eligible for cleanup. Existing member-owned Sheets
  are never cleared.
- A crash can still occur between provider-side verification and the first
  durable receipt. The remaining `writing` artifact is therefore ambiguous:
  recovery re-checks that it is private, preserves it, and asks the member to
  start a new export rather than deleting or blindly replaying it. The full V2
  manifest/staging path is required to make that state automatically resumable.
- The terminal Lark card has its own durable `ChannelDelivery` reservation,
  keyed to the export job. A stale export worker cannot overwrite a newer card;
  an active card publisher makes the retry defer without spending an attempt.
- Lifecycle logs carry only job/export identity, safe artifact and coverage
  fields, and bounded error class. Source rows, cursors, provider error text,
  and arbitrary transform errors do not escape into logs or BullMQ failure
  records. Cleanup failures are observable without replacing the export error.
- A proved privacy-policy failure (wrong owner, missing selected reader, or
  broader sharing) removes the Divo-created artifact before the member gets a
  terminal sharing-policy message. If Drive deletion fails, that remediation is
  manually delayed outside the normal export-attempt budget until it succeeds.
  Transient Google API failures remain retryable.

This deliberately does **not** claim source resume. A crash during source
reading has no durable page receipt, so its retry starts at page one and may see
changed upstream data. That is the explicit boundary until private durable
staging is provisioned. No new storage provider, schema migration, source
cursor contract, or raw-row retention was introduced for V2-lite.

The rest of this section is the deferred V2 path that closes source-recovery
gaps using the smallest useful subset of Airbyte's production protocol:

```txt
source page + proposed next state
  -> durable private staging of that page
  -> persist checkpoint with that durable page receipt
  -> only then advance the source
  -> publish or resume the same destination artifact
  -> verify the artifact
  -> deliver a receipt
```

Airbyte's destination consumer commits records before emitting a state message
([CommitOnStateAirbyteMessageConsumer.kt](https://github.com/airbytehq/airbyte/blob/ca6d630dd63be1d4364cef1748e78ead104e4674/airbyte-cdk/java/airbyte-cdk/core/src/main/kotlin/io/airbyte/cdk/integrations/base/CommitOnStateAirbyteMessageConsumer.kt)),
and its asynchronous state manager treats each state message as a watermark:
all preceding records must be flushed before acknowledgement
([GlobalAsyncStateManager.kt](https://github.com/airbytehq/airbyte/blob/ca6d630dd63be1d4364cef1748e78ead104e4674/airbyte-cdk/java/airbyte-cdk/core/src/main/kotlin/io/airbyte/cdk/integrations/destination/async/state/GlobalAsyncStateManager.kt)).
Divo has one serial export stream, not Airbyte's concurrent multi-stream
destination, so it adopts that invariant without porting their queues, counters,
containers, or platform.

### Decision 6 — one durable export run owns retries

Add an `ExportRun` persistence model, created atomically when the offer is
claimed. It belongs to one `exportKey` and snapshots the exact confirmed payload
(including the source parts and selected destination) for the lifetime of that
run. It does **not** change the offer-key formula.

Required state machine:

```txt
queued -> reading -> staged -> publishing -> verifying -> completed
                  \-> failed_retryable -------------------/
                  \-> failed_terminal | expired | cancelled
```

Required manifest data:

```txt
exportKey, offerId, payload fingerprint, destination format and target identity
lease owner / expiry / attempt number
current part index, encrypted opaque source resume state, staged page sequence
input rows, transformed rows, bytes staged, coverage
destination artifact ID + Google sheet/tab ID once created
artifact verification receipt, terminal error class, timestamps
```

The manifest stores IDs, counters, hashes, encrypted opaque resume state, and
staging URIs; it never stores provider access tokens or raw rows. Resume state
is never emitted in logs: provenance logs contain only its hash. Its payload
fingerprint guards against a retry accidentally running a changed recipe.

`exportKey` is already the idempotent artifact handle for newly created files.
The run uses that same key; a retry always finds the prior run before it reads a
source or creates a destination resource. Only one active lease may advance a
run. A stale lease is recoverable after its expiry, with an auditable attempt
transition.

### Decision 7 — source adapters expose opaque resume capability

Extend the source read contract so an adapter can consume and emit an opaque
resume state. The registry and worker own persistence; the adapter alone knows
whether a provider uses a cursor, offset, page number, or cannot resume within a
part.

```ts
type DataExportResume =
  | { readonly kind: 'cursor'; readonly value: string }
  | { readonly kind: 'offset'; readonly value: number }
  | { readonly kind: 'page'; readonly value: number }
  | { readonly kind: 'restart_part' };

type DataExportPage = {
  readonly rows: readonly Record<string, unknown>[];
  readonly hasMore?: boolean;
  readonly nextResume?: DataExportResume;
  readonly coverage?: { readonly cause: 'provider_limit' };
};
```

This is a Divo-shaped contract, not Airbyte's protocol. `nextResume` describes
where to start *after this page is durably staged*. The registry's selection
decorator sits above every adapter and applies offset/limit before a checkpoint
is committed.

Provider rules:

- Cursor-, offset-, and page-paginated reads resume from the page boundary.
- A one-page/non-resumable read checkpoints only after the whole part has been
  staged; after an interruption it restarts that part, never appends a guessed
  suffix.
- Adapters must never declare resumability that the upstream API cannot honour.
  If provider ordering is weak or the source changes during retries, Divo may
  re-read an already staged page. It does not deduplicate row values; the page
  receipt makes staging idempotent.

This follows Airbyte's resumable-full-refresh use of synthetic page cursors,
but avoids its warehouse-level merge/deduplication assumption. A Divo export is
an immutable, confirmed artifact, not a continually converging table.

### Decision 8 — staging is private, durable, and page-idempotent

Add a `DataExportStagingStore` port backed in production by encrypted,
Divo-private object storage. The current repository has no suitable durable
object-storage implementation; provisioning one is a deployment prerequisite,
not something an adapter may improvise with a local directory. The port keeps
the provider choice behind infrastructure:

```ts
appendPage(input: {
  exportKey: string;
  partIndex: number;
  pageSequence: number;
  rows: readonly Record<string, unknown>[];
}): Promise<{ uri: string; sha256: string; rowCount: number; byteCount: number }>;

openVerifiedPages(exportKey: string): AsyncIterable<readonly Record<string, unknown>[]>;
deleteRun(exportKey: string): Promise<void>;
```

Page identity is `(exportKey, partIndex, pageSequence)`. `appendPage` must be
idempotent: it either returns the existing matching receipt or fails on a hash
mismatch. The worker commits the manifest checkpoint only after that receipt is
durable. A process death after object write but before the database commit leaves
an orphan page that a retry can adopt after hash validation or that retention
can purge; it must never create duplicate output rows.

Raw staged data is encrypted at rest, access-restricted to the backend runtime,
named with opaque IDs, and never shared with the LLM or Lark. Delete it after a
verified completion. Failed/cancelled runs use a short, configurable retention
window (default 24 hours) to permit recovery, then a sweeper deletes their pages
and marks the manifest expired. Keep the metadata/audit receipt under the normal
application retention policy; do not keep the data merely for logs.

### Decision 9 — publication is a separate idempotent commit

Source reading produces staged pages only. No member-facing Google artifact is
called complete until all intended pages have reached `staged` and coverage has a
terminal outcome.

The publisher then:

1. looks up the destination by `exportKey` before any create call;
2. creates or resumes the same file/tab, never clears a user sheet;
3. writes from verified staging in deterministic order;
4. records the artifact ID/tab ID immediately after the provider accepts it;
5. verifies row count, access, artifact identity, and relevant metadata;
6. atomically marks the manifest `completed` with the verification receipt.

The existing Google sink already has the right seeds: it recovers completed
new-file artifacts by `exportKey` and chooses a deterministic tab title for an
existing Sheet. Preserve both mechanisms while making the manifest the source
of truth for in-progress work. A retry after file/tab creation resumes that
resource; it never clears and rebuilds, because that could destroy member edits.

### Decision 10 — retry, failure, and provenance are first-class

Classify failures before retrying:

| Class | Examples | Behaviour |
|---|---|---|
| Retryable | provider 429/5xx, Google 429/5xx, network reset, worker loss | bounded backoff; reuse run, staged pages, checkpoint, and artifact |
| Terminal | revoked OAuth, RBAC denial, deleted destination, invalid recipe/schema, provider rejects filters | stop; no blind retry; give the member an actionable reason |
| Partial but delivered | proved provider limit or Divo destination/spool cap | verify and deliver with exact coverage cause |
| Unknown interruption | process died without terminal receipt | reclaim lease, validate staging/artifact state, then resume safely |

Record provenance for every transition: run and attempt IDs, source part/page,
cursor hash (not sensitive cursor value in logs), staging receipt/hash/bytes,
coverage state, destination resource IDs, verification outcome, retry class, and
timestamps. This is Divo's version of Airbyte state acknowledgement and NiFi
provenance. It makes "what happened to my export?" answerable without exposing
the rows.

The completion card remains a receipt only: artifact URL, row count, precise
coverage, privacy/access, and verification. It never serializes export data into
Pi or the chat.

### Decision 11 — consistency is disclosed, never fabricated

An export recipe is re-fetched at confirmation time. Sources may change while a
long run is reading or retrying. Divo reports retrieval start and completion
time, and only claims a source snapshot when the provider actually supplies one.
For a weakly ordered provider, a synthetic cursor can produce at-least-once page
reads after recovery; page receipts prevent Divo from duplicating staged pages,
but Divo must not claim a globally immutable upstream snapshot it cannot prove.

---

## Part 7 — executable acceptance matrix

Write these tests before implementation. They are the export contract, not
after-the-fact regression tests.

### V1 — correctness and whole-run retry

| Scenario | Required outcome |
|---|---|
| Asked 1,234; 5,000 exist; wrote 1,234 | `requested_window_satisfied`; no warning |
| Asked 1,234; source exhausts at 800 | `complete`; no warning |
| Provider proves a 100-row ceiling | `partial/provider_limit`; no invented omitted count |
| Asked 6,000 XLSX rows; format stops at 5,000 | `partial/destination_row_cap` |
| 12,000 known upstream; export row cap stops at 5,000 | `partial/export_row_cap`, `knownOmittedRows: 7_000` |
| Cell or spool ceiling stops output | precise `destination_cell_cap` or `spool_cap` |
| Transform filters rows | fewer output rows, never partial by itself |
| Offset/limit, multi-part sources, zero-row pages | window is applied once per part; no false partial |
| Crash after Google file/tab creation | retry reuses the same artifact/tab |
| Crash after verification, before or during completion receipt | retry promotes the verified receipt; no duplicate artifact or source reread |
| Stale worker reaches the terminal card after lease loss | durable card reservation admits one publisher; the other defers or observes delivery |
| Source/provider error contains rows, cursor, or token-like text | logs and queue failure record contain only a safe error class/message |
| OAuth/RBAC revoked on retry | terminal failure, no stale credential use or partial publish |

A V1 worker loss while source reading simply re-fetches from page one. The
completion receipt reports the final retrieval time and must not claim the
result is an immutable upstream snapshot.

### V2 — durable resume and operations

| Scenario | Required outcome |
|---|---|
| Two replicas receive the same V2-lite job | Only the lease holder reads, publishes, or edits the card; the other defers and is requeued without spending an attempt |
| A V2-lite holder loses its lease | It aborts before publication, is requeued without spending an attempt, and never sends a terminal failure card |
| Crash after page staging, before checkpoint | retry validates/adopts page or safely restages it |
| Crash after checkpoint, before next read | retry starts exactly at committed resume state |
| Two workers claim the same run | lease permits only one publisher; the other exits/retries harmlessly |
| Stale staging data reaches retention | sweeper removes raw pages and marks the run expired |

Run the matrix with fake sources/sinks first, then at least one live Google
destination E2E test for create, existing-sheet tab, retry, and verification.

---

## Implementation order

V1 is independently shippable with no object-storage dependency or schema
migration. V2 is explicitly deferred until whole-run retry is no longer an
acceptable product tradeoff.

1. **Decision 4** — withdrawal stated in `message` by all five provider tools.
   Smallest, and it is the only defect currently reaching members with no
   explanation at all.
2. **Decision 3** — additive coverage result, derived compatibility boolean,
   exact cover-sheet/card copy, and D1/D3/Zoho boundary tests.
3. **Decision 2** — `datasetSourceSelection` and the registry window decorator.
   This flips the pinned Airtable test; rewrite the assertion explicitly rather
   than deleting it.

When V2 is approved:

4. **Infrastructure decision and V2 contract tests** — provision the
   Divo-private encrypted object store and agree its lifecycle
   permissions/retention before changing source or destination code.
5. **Decisions 6–8** — add the `ExportRun` migration, run repository, lease,
   staging-store port, local test store, page receipts, and checkpoint state.
   No provider adapter uses a resume cursor until the worker can durably accept
   it.
6. **Decision 7** — make source adapters resume-capable one at a time, starting
   with Semrush/Airtable pagination. Mark single-page sources `restart_part`
   rather than pretending they can seek.
7. **Decisions 9–10** — make Google publication read verified staging, persist
   the artifact checkpoint, classify retries, add the retention sweeper, and
   emit provenance.
8. **Decision 11** — run failure-injection tests and Google E2E checks for
   create, existing-sheet tab, mid-read retry, post-create retry, and revoked
   access. Instrument run age, retries, expired staging, and verification
   failures before enabling the path broadly.

V1 rollback is phase-safe: coverage remains additive with the legacy boolean,
and the retry path remains the existing full recipe re-fetch. V2 routes new runs
through the durable worker behind a feature flag; old jobs continue through the
V1 worker. If staging or publication regresses, stop new durable runs, retain
their private staged pages for the configured recovery window, and let V1
continue for unaffected exports. Never delete or clear a member-owned artifact
as a rollback mechanism.

Cold review each step before commit, per the repository's standing rule.
