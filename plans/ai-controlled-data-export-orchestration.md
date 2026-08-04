# AI-controlled data export orchestration

Status: implementation note, 2026-08-04.

Related foundation:

- `plans/secure-data-export-pipeline.md`
- `plans/unified-data-movement-and-spreadsheet-workflows.md`
- `plans/data-export-identity-and-coverage-design.md`

## Decision under review

Give the model a narrow export orchestration tool so it can turn natural
language into an export plan, while the backend remains the only authority for
source access, destinations, limits, confirmation, and full-scale execution.

## Verdict

Proceed, but only as a backend-owned candidate-and-plan workflow.

Do not give the model a raw `export(sql, rows, recipient)` or direct
source-to-destination pipe. The model may choose among backend-returned opaque
data candidates, formats, titles, columns, tabs, and whether to ask a follow-up
question. The backend must validate and execute everything.

Confidence: 85%.

## Implementation status, 2026-08-04

The candidate-and-plan path is now wired for the current exportable providers:
Menhood DB, Semrush, OMS site data, Zoho CRM, and Zoho Books. Provider tools no
longer mint user-visible `preview.exportOfferId` handles for new results; they
return a backend-minted `exportCandidate` when the bounded preview can be safely
replayed by governed export. The model must call `dataExport op=plan` only when
the member asks for a file.

The legacy `dataExport op=confirm` and old offer service remain intentionally
available for in-flight Lark cards, old natural-language offer confirmations,
and already-supported direct recipes that do not yet emit candidates. They are
compatibility paths, not the preferred provider flow. Airtable MCP is the
important exception: preview/discovery through MCP is allowed, but full export
must not replay through MCP by default because large Airtable MCP reads are too
expensive and fragile for bulk export. Airtable full export should use a
bounded REST/connector replay path, or ask/refuse clearly when only MCP replay
is available.

Current implemented scope:

- `dataExport op=plan` validates candidates, RBAC, source read permission,
  personalized Zoho restrictions, destination account availability, CSV
  single-dataset rules, and shape compatibility.
- `dataExport op=sample` queues a 100-row governed sample artifact using the
  same worker pipeline with `exportKind="sample"` and `rowLimitOverride=100`.
- The worker marks the plan `sample_ready` only after the sample artifact has
  completed and the sample-ready card has been delivered.
- `dataExport op=confirm_sample` revalidates the same stored plan and queues
  the full export idempotently only from `sample_ready`, never from merely
  `sample_queued`.
- Google account choice is centralized in `dataExport`; provider tools no
  longer accept destination account knobs for export planning.
- Multi-shape/multi-tab workbook execution is not enabled yet. The backend
  safely returns `ambiguous` instead of blending incompatible datasets or
  inventing tabs.

## Live E2E issues observed, 2026-08-04

These came from local cloud-Pi/Lark harness tests delivered to the owner DM.
They block treating the flow as robust.

1. **Semrush preview can succeed while export replay fails on API units.**
   `semrush organic_positions` returned 52 rows for `emiactech.com`, then the
   model correctly called `dataExport op=plan` and queued a Google Sheet. The
   worker re-ran Semrush for the full artifact and failed with
   `Semrush reports insufficient API units.` This is not a Google or Lark
   problem; it is a metered-source replay problem. Fix: classify Semrush
   insufficient-units as a source quota/permanent failure, stop retrying it,
   and surface a clear user message.
2. **Export worker hides the actionable provider reason.** BullMQ retained only
   `Data export processing failed`; the user card said only
   `Data export could not finish`. Fix: carry a safe failure code/message from
   source adapters through worker failure delivery, logs, and final card copy.
3. **Non-retryable export failures retry.** Semrush insufficient units retried
   three times, burning time and possibly more units. Fix: mark quota/auth/bad
   args/schema errors unrecoverable; retry only transient network/5xx/lease
   failures.
4. **Chat answer and async export truth diverge.** The model said “Done” after
   queueing an async export, while the worker failed moments later. Fix: when
   an export is queued, the model says “I started the export; Divo will deliver
   the file here when ready,” and only the worker completion card says the file
   is done.
5. **Menhood first query failed because the model guessed join columns.** The
   model queried `c.name` and `p.name`; actual columns are
   `menhood_customers.customer_name` and `menhood_products.product_name`.
   Because the tool returned only generic `Menhood query failed`, the model
   kept retrying variants instead of repairing precisely. Fix: expose safe
   schema metadata to the model and map PostgreSQL `42703`/missing-column
   errors to a safe message naming the missing column/table relation.
6. **Menhood can loop on repeated tool errors.** The harness made repeated
   `menhoodData` calls after the same upstream failure and did not terminate
   promptly. Fix: add tool-error stop discipline in the skill/runtime: after
   one schema/probing repair or repeated same-class failure, stop and explain
   what is needed.
7. **Airtable MCP must not be a bulk-export source.** Airtable MCP is suitable
   for base/table discovery and bounded preview only. Full export must use a
   backend-owned REST/connector replay path, or Divo should ask/block clearly
   when only MCP replay is available. Menhood DB exists specifically to handle
   analytical/aggregate/filter questions that Airtable MCP cannot answer
   safely.

## Existing evidence

- `dataExport` already queues governed exports and rechecks source read access,
  destination eligibility, Google ownership/access, and artifact integrity.
- `dataExport op=confirm` already lets natural language confirm a pending
  provider offer in the current authenticated Lark chat.
- Provider tools such as Menhood currently auto-contribute export offers when a
  read succeeds. That means a normal answer can create an export offer even
  when the member said "do not export", and a multi-query answer can withdraw
  the offer as `shape_mismatch`.
- The current Secure Data Export skill says the Lark card owns the initial
  format/account choice, and direct recipes are limited to exact supported
  source identifiers.
- Current destination limits are: XLSX 5,000 rows / 100,000 cells, Google
  Sheets 50,000 rows / 2,000,000 cells, CSV 1,000,000 rows, and Menhood spool
  200 MB.

## Target flow

```txt
member intent
  -> source tool returns preview + opaque export candidate metadata
  -> model builds an ExportPlan
  -> backend preflights plan, caps, permissions, destination accounts, and review policy
  -> missing format/account/meaning: model asks one concise question
  -> small/explicit export: queue full run
  -> huge/high-risk export: queue sample artifact first
  -> member confirms sample
  -> backend revalidates same plan hash and queues full run
  -> worker replays recipe at full scale and delivers private verified artifact
```

This is not just source-to-destination mapping. The real object is an
`ExportPlan` over one or more backend-owned candidates.

## Export candidate

A source tool may publish an opaque candidate after a successful read. The
candidate contains no raw credentials and no bulk rows in model context.

"Source tool" means the normal provider-specific Divo tool the model already
uses to answer the user: `menhoodData`, `semrush`, `airtableRecords`,
`zohoBooks`, `zohoCrm`, `omsSiteData`, and future read tools. Their input
schemas stay provider-specific. Menhood uses SQL; Semrush uses an operation and
domain/keyword args; Airtable uses base/table/native-tool input; Zoho uses
module and filters. The common contract is that any exportable read may also
return one backend-minted `exportCandidate`.

The candidate is not there to teach the model the provider structure. It is a
safe receipt for the exact dataset the backend knows how to replay later. The
model references that receipt when it asks for Sheet/Excel/CSV, instead of
trying to rebuild provider args, credentials, cursors, pagination, or SQL.

Minimum shape:

```ts
type ExportCandidate = {
  candidateId: string;
  companyId: string;
  userId: string;
  chatId: string;
  conversationKey?: string;
  sourceKind: string;
  sourceRecipeHash: string;
  schema: readonly { name: string; type?: string }[];
  previewRowCount: number;
  estimatedRows?: number;
  coverage: DataExportCoverage;
  expiresAt: string;
};
```

The candidate must be bound to the exact company, user, Lark chat, thread/run
scope, permission snapshot, and source recipe. The model only sees
`candidateId`, human-safe schema/count metadata, and preview rows it already
needed for the answer.

## Export plan

The model calls one backend tool with a plan, not rows:

```ts
type ExportPlan = {
  datasets: readonly {
    candidateId: string;
    title?: string;
    columns?: readonly string[];
    tabName?: string;
  }[];
  destination: {
    format: 'google_sheet' | 'xlsx' | 'csv';
    title: string;
    connectionId?: string;
  };
  userIntent: 'explicit_export' | 'sample_then_confirm';
};
```

Rules:

- One CSV export can contain exactly one dataset.
- Google Sheets and XLSX may contain multiple datasets only as named tabs.
- No arbitrary union of mismatched shapes. If the user asks for summary plus
  raw orders, that is a workbook with two tabs, not one blended table.
- User-visible titles, tab names, and column choices are allowed; source
  credentials, SQL, provider IDs, recipients, and Google file IDs are not.
- Any transform must be backend-validated and bounded exactly like the current
  governed export transform path.

## Conversation decision flow

The model should make the conversation feel natural, but the backend should
decide what is allowed.

Plain-language flow:

1. If the user asks only to see data, the model calls the source tool and
   answers from the bounded preview. No export is created.
2. If the user asks for a file but not a format, the model asks: "Which format
   do you want: Google Sheet, Excel, or CSV?"
3. If the user asks for a format but more than one writable Google account is
   available, the backend returns account choices and the model asks which
   account should own the export.
4. If the user asks for a clear small export and one Google account is known,
   the backend queues the full export directly.
5. If the export is huge, unknown, multi-tab, or transformed, Divo creates a
   clearly labelled sample first and asks the user to confirm it before full
   scale.
6. If the user changes columns, filters, account, format, or destination after
   seeing the sample, the backend treats it as a new plan and preflights again.

The model may say what it is about to export in human terms: source, filters,
format, destination account label, estimated rows, and sample/full status. It
must not expose candidate IDs, offer IDs, connection IDs, SQL, spreadsheet IDs,
provider tokens, or internal plan hashes.

Recommended model copy before queueing a clear full export:

```txt
I will export the delivered orders from the last 7 days to Excel in your
abhishek@emiactech.com Google account. Divo will deliver the private file here.
```

Recommended model copy before sample-first review:

```txt
This looks large, so I will first prepare a 100-row sample with the same
filters and columns. Please confirm if it looks right, then I will run the full
export.
```

## Sample-first policy for huge data

The sample export idea is good and should be first-class. It prevents a member
from waiting for a huge file only to discover that the wrong columns, filters,
date range, account, or tab layout were chosen.

Recommended default policy:

- Queue full export directly only when the user explicitly asked for an export
  and the preflight estimate is at or below 5,000 rows and within the selected
  format's cell limit.
- Require sample confirmation when estimated rows exceed 5,000, when the user
  asks for "everything" and the count is unknown, when multiple datasets/tabs
  are involved, or when a transform materially changes columns.
- Block or ask for a different format/window when the plan exceeds the chosen
  destination cap: XLSX over 5,000 rows or 100,000 cells, Google Sheets over
  50,000 rows or 2,000,000 cells, CSV over 1,000,000 rows, or Menhood over the
  spool limit.
- Default sample artifact: first 100 rows after the exact same filters,
  column selection, transforms, and tab layout. The sample must be clearly
  titled as a sample and must not be treated as the final export.

The model copy should be simple:

```txt
I prepared a 100-row sample with the exact filters and columns I will use for
the full export. Please confirm if this looks right, and I will run the full
export.
```

Full-scale execution requires a backend-held `sampleRunId` or confirmation
token bound to the exact `ExportPlan` hash. If the user changes filters,
columns, format, account, or destination after seeing the sample, Divo must
create a new sample or re-preflight the changed plan.

## Tool surface

Add a small orchestration layer to `dataExport` instead of creating another
authority.

Candidate operations:

- `dataExport op=plan`: accepts an `ExportPlan`, validates candidates, returns
  `direct_queue`, `sample_required`, `choose_destination`, `ambiguous`, or
  `blocked`.
- `dataExport op=sample`: queues a private sample artifact for a plan that
  requires review.
- `dataExport op=confirm_sample`: queues the full export only after the member
  confirms the matching sample/plan hash.
- Keep existing `op=confirm` for legacy/current provider offers during
  migration.

The model can control timing and UX, but not authority. It cannot invent a
candidate, broaden scope, change recipient access, bypass caps, or queue full
scale when review policy says sample first.

Every `dataExport` orchestration call returns a structured result to the model.
The backend never silently asks a question or starts a sample out-of-band. If it
needs a format, account, dataset choice, or sample approval, the tool result
says that explicitly and includes only safe display labels. The model then
turns that result into the next user message. Async worker progress and final
artifact delivery can still be sent directly through the existing Lark
progress/final-card path, but the initiating tool call always tells the model
what happened next.

## Expected tool calls

These are the intended shapes, not final TypeScript.

Read data without export:

```json
{
  "tool": "menhoodData",
  "args": {
    "sql": "SELECT ... LIMIT 25",
    "parameters": []
  }
}
```

The source result returns preview rows plus `exportCandidate`, not an active
offer:

```json
{
  "preview": {
    "rows": [],
    "columns": ["Order ID", "Delivered At", "Amount"]
  },
  "exportCandidate": {
    "candidateId": "opaque_candidate_id",
    "sourceKind": "menhood_query",
    "previewRowCount": 25,
    "estimatedRows": 4230,
    "expiresAt": "2026-08-05T00:00:00.000Z"
  }
}
```

Other provider reads keep their own args. Examples:

```json
{
  "tool": "semrush",
  "args": {
    "operation": "organic_positions",
    "domain": "emiactech.com",
    "limit": 25
  }
}
```

```json
{
  "tool": "airtableRecords",
  "args": {
    "nativeTool": "list_records_for_table",
    "input": {
      "baseId": "app_...",
      "tableId": "tbl_...",
      "maxRecords": 25
    }
  }
}
```

```json
{
  "tool": "zohoBooks",
  "args": {
    "module": "invoices",
    "organizationId": "org_...",
    "filters": {
      "status": "sent"
    }
  }
}
```

Each can return the same kind of `exportCandidate`, even though their read args
are different.

Plan an explicit export:

```json
{
  "tool": "dataExport",
  "args": {
    "op": "plan",
    "datasets": [
      {
        "candidateId": "opaque_candidate_id",
        "title": "Delivered orders - last 7 days",
        "tabName": "Delivered Orders"
      }
    ],
    "destination": {
      "format": "xlsx",
      "title": "Delivered orders - last 7 days"
    },
    "userIntent": "explicit_export"
  }
}
```

If exactly one eligible Google account exists, backend can answer:

```json
{
  "status": "direct_queue",
  "exportJobId": "dtx_...",
  "message": "Excel export queued."
}
```

If several eligible Google accounts exist, backend answers:

```json
{
  "status": "choose_destination",
  "connections": [
    { "connectionId": "opaque_connection_id_1", "label": "abhishek@emiactech.com" },
    { "connectionId": "opaque_connection_id_2", "label": "divo@emiactech.com" }
  ]
}
```

Then the model asks which account, and calls the same plan again with the exact
backend-returned `connectionId`.

If the plan is large, backend answers:

```json
{
  "status": "sample_required",
  "sampleRows": 100,
  "reason": "estimated_rows_above_threshold"
}
```

Then the model queues a sample:

```json
{
  "tool": "dataExport",
  "args": {
    "op": "sample",
    "planId": "opaque_plan_id"
  }
}
```

After the user confirms the sample:

```json
{
  "tool": "dataExport",
  "args": {
    "op": "confirm_sample",
    "sampleRunId": "opaque_sample_run_id"
  }
}
```

## Skill contract

Create one Export Orchestration system skill that teaches:

- If the member did not ask for a file, do not create or mention an export.
- If the member explicitly asks for Sheet, Excel, CSV, XL, XLSX, or "download",
  build a plan from the current eligible candidate.
- If several candidates are possible, ask one concise question.
- If data is huge or uncertain, create a sample first and ask for confirmation
  before full scale.
- Do not fetch bulk pages through chat, Python, Google Drive, or provider MCPs.
- Do not run full Airtable exports through Airtable MCP. Use MCP only for
  connection/base/table discovery and bounded preview. Full export needs a
  backend-owned REST/connector source that enforces limits, pagination, retry,
  and coverage; otherwise ask for a smaller preview/export path instead.
- Never expose candidate IDs, offer IDs, source SQL, provider credentials,
  spreadsheet IDs, or connection IDs to the member.

This skill should replace provider-by-provider folklore. Source-specific skills
can describe what their data means, but export control should be consistent.

## Migration approach

Implemented migration:

1. Introduced candidate metadata and plan preflight behind the existing
   `dataExport` tool.
2. Converted Menhood first, removing the multi-query export-offer collision
   class by publishing independent candidates instead of a shared active offer.
3. Converted Semrush, OMS site data, Zoho CRM, and Zoho Books to candidate
   publishing.
4. Retired Zoho Books direct export queueing from provider calls. `exportAll`
   now means "publish a complete-data candidate", then the model plans format,
   account, sample/full, and delivery through `dataExport`.
5. Updated provider and routing skills so export behavior lives in the central
   data-export skill instead of provider-by-provider folklore.

Still intentionally compatible:

- Old provider offer confirmation remains for already-created offer cards and
  old Lark button/natural-language paths.
- Direct recipe export remains only for supported non-candidate sources with a
  robust backend replay path. Airtable MCP-only replay is excluded; Airtable
  should emit candidates only when the candidate can be replayed through a
  safe REST/connector export source.
- The old provider-offer append helper is no longer used by the converted
  runtime providers. It should be removed in a focused compatibility cleanup
  once in-flight old cards and legacy tests are intentionally retired.

## Acceptance tests

- "Show me delivered orders, do not export" returns a chat answer and creates
  no user-visible offer/card.
- "Give this in XLSX" after a single eligible preview calls `dataExport`
  with the candidate plan and queues the right format.
- A query over 5,000 estimated rows creates a sample first and does not queue
  full scale until the user confirms.
- Confirming a sample with an unchanged plan queues full scale; confirming
  after changing columns/filter/format forces a new preflight or sample.
- XLSX over 5,000 rows is blocked or asks for CSV/Sheet; it is never silently
  truncated as "complete".
- Multiple compatible datasets become named tabs in Sheet/XLSX. Not enabled in
  this slice; current behavior is to block mixed shapes with `ambiguous`.
- Multiple incompatible datasets are rejected for CSV and never blended into
  one table.
- RBAC or OAuth revoked after sample but before full confirmation stops the run
  before reading source rows.
- Source row counts changing between sample and full export are disclosed in
  the final card using the actual full-run coverage.
- Late/duplicate confirmations are idempotent and cannot queue duplicate full
  exports.
- Airtable MCP discovery/preview never escalates into MCP-backed bulk export.
  If no REST/connector replay path exists for the chosen base/table, Divo asks
  for a bounded preview or blocks the full export with a clear explanation.

## Airtable MCP export correction, 2026-08-04

Airtable MCP is now treated as a model-facing discovery and bounded-preview
surface, not an export or broad analytics transport.

- MCP record reads are capped before reaching Airtable and compacted before
  entering model context.
- The model-facing preview keeps an honest `hasMore` flag but deliberately
  drops `nextCursor`/`offset`. This prevents an agent from turning a preview
  into an accidental page loop.
- Synced Menhood analysis must route to `menhood-data`, where SQL can do joins,
  filters, aggregates, and governed export candidates safely.
- Full Airtable exports are allowed only through an exact backend-replayable
  source. The existing safe replay path uses the backend-owned Airtable REST
  pagination hook (`listRecordsPage`) for compatible table reads; it is not MCP
  pagination controlled by the model.
- If a non-Menhood Airtable request cannot be replayed by the backend source,
  Divo should ask for a bounded preview or clearly block the full export.

## Menhood query-loop correction, 2026-08-04

The Menhood database tool is safe/read-only, but the agent can still loop if it
has to guess schema and receives only a generic provider failure.

- The Menhood system skill now spoon-feeds the exact four-table schema map from
  the backend reporting DB, including the odd legacy `"discount _remove"`
  column and PII fields the agent should avoid unless explicitly requested.
- Menhood analytics should normally reuse that schema map directly rather than
  running discovery for common orders/customers/products/city questions.
- Schema probes remain allowed for unfamiliar or newly needed fields, but the
  model should do at most one probe and one corrected retry.
- Sanitized PostgreSQL schema failures such as undefined/ambiguous columns now
  flow up as correction hints: use the schema map and make at most one corrected
  retry. Generic provider errors still stay generic to avoid leaking row values
  or parameter contents.

## Cross-skill export follow-up, 2026-08-04

Provider skills should make export feel conversational without inventing unsafe
paths.

- If a read-only source result contains an `exportCandidate` and the member
  explicitly asked for Sheet, Excel/XLSX, CSV, all rows, or a full export, call
  `dataExport op=plan` immediately and then say the export has started/queued;
  the completion/failure card remains the source of truth.
- If the member did not ask for a file but the result is a useful table,
  ranking, report, cohort, comparison, shortlist, or diagnostic, ask one soft
  follow-up: whether to export it to Google Sheets, Excel, or CSV.
- Do not offer a full export when the only available source is Airtable MCP
  pagination or another non-replayable preview. In those cases ask for a
  bounded preview or block the full export clearly.
- Do not ask the follow-up for empty results, errors, one-number answers, or
  obviously conversational answers where a file would be noise.

## Semrush integration correction, 2026-08-04

Live audit showed Divo had treated Semrush as "official API only", while the
team's working Semrush recipes include private `www.semrush.com` routes backed
by a browser session cookie plus an API key.

- Current official `api.semrush.com` `domain_organic` can still answer small
  probes with the configured static key, but larger export-shaped requests
  failed with `ERROR 132 :: API UNITS BALANCE IS ZERO`.
- The webhook-selected key returned exhausted units for the same official
  report.
- Private `www.semrush.com/dpa/rpc` `ranks.Ranks` / `organic.overview` worked
  with the configured static key and valid browser-session cookie, but it is an
  overview metrics report, not the top-keyword row table.
- Private `www.semrush.com/backlinks/webapi2/` `backlinks_comparison` worked
  with the configured static key and valid browser-session cookie.
- Private `organic.KeywordPositionTrend` / `organic.positions` is a keyword
  position/trend route for one domain+keyword+date; it is not equivalent to
  Divo's existing monthly `domain_rank_history` operation.

Implementation rule: Semrush web routes are backend-owned API wrappers, not
model-callable curl/browser recipes. Credentials live in env for this slice
(`SEMRUSH_WEB_ENABLED`, `SEMRUSH_WEB_API_KEY`, `SEMRUSH_WEB_COOKIE`), are never
logged or exposed to the model, and failures must name whether the official API
units are exhausted or the private web session/key was rejected. Only verified
private routes should be enabled; do not silently substitute overview/trend
reports for a keyword-row export.

## Resolved owner decisions

Confirmed 2026-08-04.

1. **Sample artifact location:** the sample file itself lives in the selected
   Google Drive account, exactly like the final artifact. The database stores
   only the control receipt: candidate ID, sample run ID, plan hash, source
   recipe hash, user/chat binding, destination account, status, expiry, and
   cleanup state. Google Drive is the file store; Divo DB is the authoritative
   ledger that prevents duplicate confirmations, stale plan reuse, and unsafe
   cross-chat/account replay.
2. **Google account UX:** if Divo has only the company/default export account,
   tell the user upfront that the export will be created there and they will
   receive read-only access. Offer a Google OAuth button if they want the file
   owned by their own account instead. If one writable personal export account
   is already available, use it. If several writable accounts are available,
   ask which account should own the export. A remembered last-used account may
   be shown as context, but it must not silently bypass the chooser while two
   or more writable personal accounts remain eligible.
3. **Small explicit export:** if the user clearly says "give this in Excel",
   "make a Sheet", or "export CSV" and the plan is small/safe, queue directly.
   Do not ask a second "are you sure?" question.
4. **Huge or uncertain export:** require sample-first review above 5,000
   estimated rows, for unknown "everything", for multi-tab workbooks, or for
   material transforms.
5. **Sample size and cleanup:** create a 100-row private sample in the selected
   destination account and format. After full export succeeds, mark the sample
   superseded and auto-trash it after 72 hours. If full export fails, retain the
   sample for 7 days for debugging and user continuity.
6. **Multi-dataset exports:** allow Google Sheets/XLSX workbooks with named
   tabs only when the user asked for the combined workbook or the model can
   explain the tabs clearly. CSV stays single-dataset only.
7. **Confirmation surface:** support both natural-language confirmation and a
   signed Lark button for sample approval. They resolve to the same backend
   `confirm_sample` action and same plan hash.

## Skill cleanup

Export behavior should live in one orchestration skill. Existing provider
skills and export skills should be simplified so they do not each carry their
own export folklore.

Required skill rules:

- Provider skills explain how to ask/read their source data; they do not teach
  provider-specific export workflows except to preserve the returned candidate.
- The export orchestration skill owns format choice, Google account choice,
  sample-first policy, confirmation wording, caps, and refusal cases.
- Copy must be consistent: if using the company/default Google account, say the
  file will be created in that account and the requester will get read-only
  access; if the requester wants ownership/editing, ask them to connect their
  Google account through OAuth.
- Remove duplicate or conflicting instructions around `preview.exportOfferId`,
  direct Google Drive/Sheets writes, provider pagination, Cloudinary-style
  fallbacks, and natural-language confirmation.
