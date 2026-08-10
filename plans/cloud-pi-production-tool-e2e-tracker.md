# Cloud Pi Production Tool E2E Tracker

Updated: 2026-08-10  
Owner: Abhishek / Divo engineering  
Environment: Main, one tool at a time  
Runtime: Cloud Pi only; Jan is out of scope

## Purpose

Prove each tool through the real Main lifecycle: native skill routing, typed Pi
registration, backend governance, provider execution, terminal/file handling,
final delivery, and persisted trace evidence. For data-producing tools, also
prove a complete export with exact source/written/read-back reconciliation.

This is the operational source of truth. A tool is not “done” because its unit
tests pass or because it returned a preview once.

## Status legend

- `[ ]` Not tested on Main
- `[~]` Partial evidence; acceptance is incomplete
- `[x]` Passed on Main with recorded evidence
- `[!]` Failed or has an open issue
- `[-]` Not applicable, with a written reason
- `[B]` Blocked by connection, permission, provider, or environment

## Safety rules

1. Test one governed tool at a time using a fresh Cloud Pi context.
2. Show and record the exact prompt before firing it.
3. Reads may use real Main data. Writes must target clearly named disposable
   test artifacts; never mutate or delete ordinary company data.
4. Do not clone Development into Main and do not expose provider credentials.
5. Keep `dataExport` available as rollback until each source passes its own
   terminal-first export proof.
6. A failure stays visible in this file until fixed and rerun.
7. Record IDs only in private test evidence. Do not commit tokens, chat IDs,
   connection IDs, raw protected rows, or personal data here.
8. Default to natural member prompts that state only the desired outcome. Do
   not coach Divo with tool names, paging rules, Python steps, destination
   mechanics, or verification logic; those behaviors must come from its own
   runtime and skills. Use explicit diagnostic prompts only for targeted retests.

## Required evidence for every governed tool

- [ ] Tool is visible only when authorized and its Pi schema is typed correctly.
- [ ] The intended native skill is loaded once and routes to the right tool.
- [ ] A normal request succeeds without speculative calls or avoidable reruns.
- [ ] Permission denial and missing/expired connection fail clearly.
- [ ] Trace records model call, tool sequence, timings, result, and final delivery.
- [ ] No credential or unbounded provider payload appears in Pi context or logs.

## Additional export acceptance

For every tool marked `Bulk`, prove:

- [ ] `1`, `10`, `100`, multi-page, empty, and provider-capped datasets.
- [ ] Terminal workflow persists provider pages to files outside model context.
- [ ] Python transforms the persisted files without copying bulk rows into chat.
- [ ] Destination artifact is created through a governed destination tool.
- [ ] `source == transformed == written == read-back verified` counts reconcile.
- [ ] Schema, dates, currency, booleans, IDs, nulls, and Unicode remain correct.
- [ ] Rate limits use structured retry timing; the model adds no manual sleeps.
- [ ] Ambiguous failure does not duplicate mutations; retry/resume is safe.

Export modes:

- `Bulk` — complete paged export and reconciliation are mandatory.
- `Artifact` — prove a faithful file/document artifact, not necessarily tabular.
- `Optional` — exporting the returned list is useful but is not the core contract.
- `N/A` — orchestration/mutation helper; record the reason instead.

## Main execution order

1. `divo_skill_resolve`, `divo_connections`, and trace baseline.
2. `zohoBooks` -> `googleSheets` complete export.
3. `zohoCrm` -> `googleSheets` complete export.
4. Airtable data surfaces -> `googleSheets`/file export.
5. Shopify Analytics, then conditional Orders and Customers.
6. Semrush, OMS, and Menhood sources.
7. Google Workspace tools.
8. Lark tools.
9. Web, knowledge, Canva, mail automation, commands, and schedules.
10. Runtime support tools and explicit fallback `dataExport` verification.

## Master governed-tool matrix

| Status | Tool ID | Family | Export mode | Main evidence |
| --- | --- | --- | --- | --- |
| [~] | `larkTask` | Lark | Optional | Main read/export/read-back passed; mutation lifecycle pending |
| [~] | `larkMessaging` | Lark | Optional | Main list/export/read-back passed; send lifecycle pending |
| [~] | `larkContacts` | Lark | Bulk | Main empty lookup/read-back passed; directory paging pending |
| [~] | `larkCalendar` | Lark | Bulk | Main one-page list/export/read-back passed; multi-page proof pending |
| [~] | `larkMeeting` | Lark | Bulk | Main capped search/export/read-back passed; complete paging pending |
| [~] | `larkDoc` | Lark | Artifact | Main empty-root list/read-back passed; document lifecycle pending |
| [B] | `larkBase` | Lark | Bulk | Blocked: no governed base/table discovery surface |
| [B] | `larkApproval` | Lark | Optional | Blocked: no governed approval-definition discovery surface |
| [~] | `googleGmail` | Google | Bulk | Main bounded read and Sheet evidence passed; multi-page export pending |
| [~] | `googleDrive` | Google | Artifact | Main folder creation and artifact moves passed; checksum proof pending |
| [~] | `googleCalendar` | Google | Bulk | Main empty-range read passed; multi-page/lifecycle proof pending |
| [x] | `googleDocs` | Google | Artifact | Main create/write/read-back/folder delivery passed after API enablement |
| [x] | `googleSheets` | Google | Bulk + destination | Main 2,457-row verified Google Sheet export passed |
| [~] | `googleSlides` | Google | Artifact | Main presentation creation passed; structural read-back pending |
| [B] | `googleForms` | Google | Bulk | Blocked: Forms API disabled in the shared GCP project |
| [B] | `googleTasks` | Google | Optional | Blocked: Tasks API disabled in the shared GCP project |
| [B] | `googleContacts` | Google | Bulk | Blocked: People API disabled in the shared GCP project |
| [B] | `googleChat` | Google | Bulk | Blocked: Chat API disabled in the shared GCP project |
| [B] | `googleAppsScript` | Google | Artifact | Blocked: Apps Script API disabled in the shared GCP project |
| [~] | `mailAutomations` | Mail | N/A | Main read-only inventory passed; mutation/HITL intentionally not exercised |
| [-] | `canvaDesign` | Canva | Artifact | Not available in this Main member's governed allowlist; non-Google writes excluded |
| [x] | `airtableBase` | Airtable | Bulk | Main discovery and complete 2,457-row export passed |
| [x] | `airtableRecords` | Airtable | Bulk | Main complete 2,457-row export reconciled |
| [B] | `airtableSchema` | Airtable | Artifact | Agent used a nonexistent base-native schema operation |
| [~] | `airtableAutomation` | Airtable | Optional | Main read-only inventory and Sheet reconciliation passed |
| [-] | `aitableDatasheets` | Aitable | Bulk | Intentionally skipped; integration is not ready |
| [-] | `aitableFields` | Aitable | Artifact | Intentionally skipped; integration is not ready |
| [B] | `zohoCrm` | Zoho | Bulk | No Main connection has CRM OAuth scopes |
| [~] | `zohoBooks` | Zoho | Bulk | 8,014 expenses + 6,190 invoices paged; final Sheet proof failed |
| [x] | `webSearch` | Context | Optional | Main parallel web evidence + Sheet delivery passed |
| [B] | `knowledge` | Knowledge | Artifact | Main reads are blocked by misconfigured approval routing |
| [x] | `dataExport` | Fallback | Bulk | Main 2,457-row Airtable-to-Google fallback export verified |
| [~] | `semrush` | Research | Bulk | Main comparison + parallel domain reads + Sheet passed; bulk paging pending |
| [~] | `omsSiteData` | Internal data | Bulk | Main site-profile evidence + Sheet passed; bulk paging pending |
| [~] | `menhoodData` | Internal data | Bulk | Main parallel analysis + Sheet delivery passed; raw bulk export pending |
| [-] | `shopifyAnalytics` | Shopify | Bulk | No direct Shopify connection is available on Main |
| [-] | `shopifyOrders` | Shopify, conditional | Bulk | No direct Shopify connection is available on Main |
| [-] | `shopifyCustomers` | Shopify, conditional | Bulk | No direct Shopify connection is available on Main |
| [-] | `runCommand` | Execution | N/A | Not available in this Main member's governed allowlist |
| [~] | `scheduledWorkflows` | Scheduling | N/A | Main read-only inventory passed; lifecycle mutations intentionally not exercised |

## Per-tool records and issue sections

Update each record with the exact prompt, trace/run reference, artifact link,
counts, duration, and issue IDs. Detailed sensitive evidence stays outside Git.

### Lark

#### `larkTask`
- Status: `[~]`; export: `Optional`
- Core proof: create disposable task -> read -> update -> complete; delete only the test task.
- Export proof: export a bounded task list when useful.
- Evidence: 2026-08-10 Main diagnostic rerun returned 48 tasks, wrote 49 Sheet rows including the header, and read back 49/49. The final response supplied the governed Sheet link without bulk rows or a local path.
- Issues: Mutation lifecycle remains untested. `LARKTASK-001` resolved by the diagnostic rerun; `EXPORT-DEST-001` remains open because the prompt explicitly specified Google Sheets and therefore did not prove default destination behavior.

#### `larkMessaging`
- Status: `[~]`; export: `Optional`
- Core proof: search/read plus send into the approved test chat only.
- Export proof: persist and export a bounded, non-sensitive search result.
- Evidence: 2026-08-10 Main diagnostic run listed 36 chats, wrote 37 Sheet rows including the header, and read back 37/37.
- Issues: Sending into the approved test chat remains untested.

#### `larkContacts`
- Status: `[~]`; export: `Bulk`
- Core proof: lookup and department listing with RBAC.
- Export proof: multi-page directory export with exact count reconciliation.
- Evidence: 2026-08-10 Main diagnostic run completed an empty lookup and verified its two-row status tab.
- Issues: The workflow invented a lookup term instead of discovering a meaningful target; department listing and multi-page directory export remain untested (`LARKCONTACT-001`).

#### `larkCalendar`
- Status: `[~]`; export: `Bulk`
- Core proof: list events; create/update/delete only a named test event.
- Export proof: multi-page date-range event export.
- Evidence: 2026-08-10 Main diagnostic run listed 23 August events, wrote 24 Sheet rows including the header, and read back 24/24.
- Issues: Multi-page export and disposable event lifecycle remain untested.

#### `larkMeeting`
- Status: `[~]`; export: `Bulk`
- Core proof: list/read an authorized meeting record.
- Export proof: paged meeting metadata export without protected transcript leakage.
- Evidence: 2026-08-10 Main diagnostic run returned the requested cap of 20 meetings, wrote 21 Sheet rows including the header, and read back 21/21.
- Issues: The result was truthfully labelled capped; complete paging remains untested.

#### `larkDoc`
- Status: `[~]`; export: `Artifact`
- Core proof: read and edit a disposable test document.
- Export proof: faithful document/file artifact and read-back.
- Evidence: 2026-08-10 Main diagnostic run completed an empty root listing and verified its two-row status tab.
- Issues: Read/edit and faithful artifact proof require a disposable document.

#### `larkBase`
- Status: `[-]`; export: `Bulk`
- Core proof: schema/read plus write only to a disposable test table.
- Export proof: multi-page records with field-type and count reconciliation.
- Evidence: 2026-08-10 Main diagnostic run stopped without guessing identifiers.
- Issues: `LARKDISC-001` — no governed operation discovers an accessible Base and table before schema/read calls.

#### `larkApproval`
- Status: `[B]`; export: `Optional`
- Core proof: read definitions/instances; submit only an approved test definition.
- Export proof: bounded approval-instance report if permitted.
- Evidence: 2026-08-10 Main diagnostic run stopped without guessing an approval code.
- Issues: `LARKDISC-001` — every exposed read requires an approval code, but no governed definition-discovery operation exists.

### Google Workspace

#### `googleGmail`
- Status: `[~]`; export: `Bulk`
- Core proof: search/read; mutation tested only with a disposable draft.
- Export proof: multi-page metadata export with message bodies excluded unless requested.
- Evidence: 2026-08-10 Main natural run retrieved 20 recent messages and wrote a bounded evidence tab that read back exactly.
- Issues: Full multi-page metadata export and disposable-draft lifecycle remain untested. The agent selected among multiple connected accounts without asking which account represented "my" activity (`GOOGLEACCOUNT-001`).

#### `googleDrive`
- Status: `[~]`; export: `Artifact`
- Core proof: search/read/upload into a disposable test folder.
- Export proof: upload/download checksum and file-ID read-back.
- Evidence: 2026-08-10 Main natural run created the requested test folder and moved the generated Sheet and Slides into it.
- Issues: Upload/download checksum and direct file-ID read-back remain untested. Argument/result-shape guessing caused avoidable retries (`GOOGLEARGS-001`).

#### `googleCalendar`
- Status: `[~]`; export: `Bulk`
- Core proof: list; create/update/delete only a named test event.
- Export proof: multi-page event export across a fixed date range.
- Evidence: 2026-08-10 Main natural run completed an empty fixed-range read and verified the evidence tab.
- Issues: Multi-page export and disposable event lifecycle remain untested.

#### `googleDocs`
- Status: `[x]`; export: `Artifact`
- Core proof: create/read/edit a disposable document.
- Export proof: faithful document artifact and exact read-back of inserted content.
- Evidence: 2026-08-10 Main retry after API enablement created the disposable activity brief, moved it into the governed test folder, inserted content, read it back successfully, and returned an accessible link. A natural visual-feedback follow-up rebuilt a second document with styled title, subtitle, section headings, status rows, and hyperlinks, then moved and verified it.
- Issues: The API blocker is resolved for Docs. The first insert required repair because `start_index` was omitted (`GOOGLEARGS-001`). The beautification follow-up completed but needed 29 steps, repeated run-file discovery, and several index/schema repairs; member visual acceptance of the rebuilt document remains pending (`GOOGLEDOCS-001`, `CONTEXT-001`).

#### `googleSheets`
- Status: `[x]`; export: `Bulk + destination`
- Core proof: create/read/write/format a disposable spreadsheet.
- Export proof: receive 2,000+ rows, verify types/counts, then read back exact values.
- Evidence: Development small-read proof exists. Main created and reconciled bounded evidence workbooks, then the fallback export pipeline delivered a verified 2,457-row Google Sheet with complete coverage and backend checkpoint/delivery evidence.
- Issues: The model-driven Zoho Sheet still failed exact verification (`VERIFY-001`); the backend-owned 2,457-row destination path passed.

#### `googleSlides`
- Status: `[~]`; export: `Artifact`
- Core proof: create/read/edit a disposable presentation.
- Export proof: generated presentation remains readable and structurally complete.
- Evidence: 2026-08-10 Main natural run created an executive-summary presentation and placed it in the requested test folder.
- Issues: Structural content read-back was not reported.

#### `googleForms`
- Status: `[B]`; export: `Bulk`
- Core proof: read/create only a disposable test form.
- Export proof: response export with exact row and question-field reconciliation.
- Evidence: 2026-08-10 Main natural run reached the provider and received a project-level disabled-service response.
- Issues: `GOOGLEAPI-001` — Forms API is disabled in the shared GCP project.

#### `googleTasks`
- Status: `[B]`; export: `Optional`
- Core proof: list plus create/update/complete a disposable task.
- Export proof: bounded task-list export when useful.
- Evidence: 2026-08-10 Main natural run reached the provider and received a project-level disabled-service response.
- Issues: `GOOGLEAPI-001` — Tasks API is disabled in the shared GCP project.

#### `googleContacts`
- Status: `[B]`; export: `Bulk`
- Core proof: search/list without mutation.
- Export proof: multi-page contact metadata export with protected fields handled safely.
- Evidence: 2026-08-10 Main natural run reached the provider and received a project-level disabled-service response.
- Issues: `GOOGLEAPI-001` — People API is disabled in the shared GCP project.

#### `googleChat`
- Status: `[B]`; export: `Bulk`
- Core proof: list/search/read; write only to an approved test space.
- Export proof: bounded message export with paging and count reconciliation.
- Evidence: 2026-08-10 Main natural run reached the provider and received a project-level disabled-service response.
- Issues: `GOOGLEAPI-001` — Chat API is disabled in the shared GCP project.

#### `googleAppsScript`
- Status: `[B]`; export: `Artifact`
- Core proof: inspect and run only an approved disposable script project.
- Export proof: source/project artifact remains complete and readable.
- Evidence: 2026-08-10 Main natural run reached the provider and received a project-level disabled-service response.
- Issues: `GOOGLEAPI-001` — Apps Script API is disabled in the shared GCP project.

### Airtable and Aitable

#### `airtableBase`
- Status: `[x]`; export: `Bulk`
- Core proof: list/read base metadata through the typed native contract.
- Export proof: multi-page base/table data export where supported.
- Evidence: 2026-08-10 Main natural runs listed 253 visible bases. A later raw-export run resolved MENHOOD Official / Orders, applied the July date window, and supplied a complete candidate with 2,457 source rows.
- Issues: The earlier broad inventory still exposed stale-run and helper problems (`CONTEXT-001`, `RUNFILES-001`); the bounded complete export path passed.

#### `airtableRecords`
- Status: `[x]`; export: `Bulk`
- Core proof: page records; mutations only in a disposable test table.
- Export proof: full cursor traversal with typed fields and exact counts.
- Evidence: Main exported all 2,457 July rows (288 fields) from the live Orders table through the fallback pipeline. Backend evidence records `coverageOutcome=complete`, `rowCount=2457`, a checkpointed artifact, and successful governed delivery on the first worker execution with checkpoint replay.
- Issues: The earlier terminal inventory still exposed skipped-skill and path-unsafe helper behavior (`SKILLLOAD-001`, `LOCALHELPER-001`); the complete fallback path passed.

#### `airtableSchema`
- Status: `[B]`; export: `Artifact`
- Core proof: read schema and resolve field/table identities.
- Export proof: schema artifact includes every visible table and field.
- Evidence: Main schema phase failed before producing a usable field map.
- Issues: The workflow guessed `get_table_schema` and `list_fields_for_table` on `airtableBase` instead of using the registered schema capability (`SKILLLOAD-001`).

#### `airtableAutomation`
- Status: `[~]`; export: `Optional`
- Core proof: read automation state; mutate only an explicit test automation.
- Export proof: bounded automation inventory if available.
- Evidence: Main loaded the exact automation skill, listed 88 automations across two production bases, wrote them to a Google Sheet, then paged read-back beyond the 50-row cap and reconciled every row.
- Issues: The first summary reported 87 rows and the wrong SCANNER split; explicit read-back corrected the Sheet to 88 total (63 deployed, 25 drafts) (`VERIFY-001`).

#### `aitableDatasheets`
- Status: `[-]`; export: `Bulk`
- Core proof: list/read and page datasheet records.
- Export proof: complete datasheet export with exact field/count reconciliation.
- Evidence: Main loaded the exact AITable skills, checked connections, and attempted `list_spaces`; the governed call reported no active AITable connection.
- Issues: Intentionally deferred by the owner because the integration is not ready. Current public ID uses `aitable`, not `airtable`; do not rename during E2E.

#### `aitableFields`
- Status: `[-]`; export: `Artifact`
- Core proof: list/read field definitions and allowed metadata.
- Export proof: complete field-schema artifact.
- Evidence: Field enumeration could not begin because no AITable connection exists on Main.
- Issues: Intentionally deferred by the owner because the integration is not ready. Current public ID uses `aitable`, not `airtable`; do not rename during E2E.

### Zoho

#### `zohoBooks`
- Status: `[~]`; export: `Bulk`
- Core proof: Development list/read and small export worked; Main remains unproven.
- Export proof: expenses plus a second paged module -> Google Sheet, 2,000-row target.
- Evidence: Development `3/3/3` and empty `0/0/0`. Main paged 8,014 expenses and 6,190 invoices at 100 rows per call through local files; a follow-up refetched 3,466 FY expenses and 1,293 FY invoices and wrote both tabs to a Google Sheet.
- Issues: The prior-turn source files were unavailable on follow-up, expense amounts mapped to zero, read-back returned only the first 50 rows, and the run ended with a temporary failure instead of verified delivery (`RUNFILES-001`, `ZOHOMAP-001`, `VERIFY-001`).

#### `zohoCrm`
- Status: `[B]`; export: `Bulk`
- Core proof: list/read records from one authorized module.
- Export proof: multi-page module -> Google Sheet with field/count reconciliation.
- Evidence: Main reached the governed CRM call, which was rejected because the selected connection has Books-only OAuth scopes; connection discovery found no CRM-enabled alternative.
- Issues: Reconnect an approved Zoho account with CRM scopes, then retest.

### Shopify

#### `shopifyAnalytics`
- Status: `[-]`; export: `Bulk`
- Core proof: one bounded analytics query.
- Export proof: multi-page/report export with provider-cap truthfulness.
- Evidence: 2026-08-10 Main connection discovery reported no direct Shopify connection; Divo transparently routed the business question to the Menhood reporting DB plus live Airtable.
- Issues: Intentionally unavailable until a governed Shopify connection is configured; the successful fallback does not count as Shopify tool proof.

#### `shopifyOrders`
- Status: `[-]`; export: `Bulk`; availability: conditional.
- Core proof: confirm the tool is registered and authorized on Main, then page orders.
- Export proof: provider-capped export with truthful partial/full coverage.
- Evidence: No direct Shopify connection was available on Main.
- Issues: Enable only with a governed connection, then verify the 25,000 deep-pagination boundary before large testing.

#### `shopifyCustomers`
- Status: `[-]`; export: `Bulk`; availability: conditional.
- Core proof: confirm the tool is registered and authorized on Main, then page customers.
- Export proof: provider-capped export with truthful partial/full coverage.
- Evidence: No direct Shopify connection was available on Main.
- Issues: Enable only with a governed connection, then retest protected customer paging.

### Research and internal data

#### `semrush`
- Status: `[~]`; export: `Bulk`
- Core proof: choose one correct operation without avoidable fan-out.
- Export proof: page/export a large supported report with exact coverage metadata.
- Evidence: Main ran one three-domain backlinks comparison, one initial overview, and two competitor overviews concurrently, then delivered and verified a formatted five-tab Google Sheet.
- Issues: Complete multi-page keyword/backlink export and provider-cap reconciliation remain pending.

#### `omsSiteData`
- Status: `[~]`; export: `Bulk`
- Core proof: query an authorized snapshot without preview truncation.
- Export proof: complete snapshot export with count reconciliation.
- Evidence: Main `get_site_profiles` completed alongside Semrush and web reads and its findings were included in the verified SEO Sheet.
- Issues: Snapshot paging and a standalone count-reconciled export remain pending.

#### `menhoodData`
- Status: `[~]`; export: `Bulk`
- Core proof: execute an authorized read-only query.
- Export proof: large export without attempting to resume a transaction-bound cursor.
- Evidence: Main ran four independent Menhood reads concurrently, then two more concurrently, combined them with live Airtable freshness checks, and delivered a formatted seven-tab Google Sheet with an explicit maturity warning.
- Issues: Raw multi-page export/count reconciliation remains pending. The run selected a Google account without asking and required ten failed Sheet writes/range repairs before success (`GOOGLEACCOUNT-001`, `GOOGLEARGS-001`). Current cursor is transaction-bound; record the chosen streaming boundary.

#### `webSearch`
- Status: `[x]`; export: `Optional`
- Core proof: one researched answer with source links and trace evidence.
- Export proof: persist a structured result set when the prompt requests a file.
- Evidence: Main executed two batches of three web searches concurrently, synthesized positioning evidence, and wrote the bounded findings into the verified SEO Sheet.
- Issues: none observed.

#### `knowledge`
- Status: `[B]`; export: `Artifact`
- Core proof: scoped search/read with correct company/department visibility.
- Export proof: create a cited artifact without leaking hidden knowledge content.
- Evidence: A fresh Main run selected the Knowledge and Google Docs tools. `documents.search` and three `resources.list` calls all failed before returning any source. Divo still created a Google Doc, but populated it from runtime bootstrap/persona text rather than retrieved company knowledge.
- Issues: Read operations were rejected as `Approval misconfigured. Invalid knowledge apply request` (`KNOWLEDGE-001`). The artifact is not accepted as knowledge proof because its claims were not grounded in retrieved sources.

### Automation, design, execution, and fallback

#### `mailAutomations`
- Status: `[~]`; export: `N/A`
- Core proof: inspect and exercise test-rule lifecycle with required review/HITL.
- Export proof: `[-]` configuration workflow, not a bulk data source.
- Evidence: Main loaded the exact Mail Ops skill and read all six rules (1 active, 3 paused, 2 archived) without mutating any rule; the inventory was written and read back from Google Sheets.
- Issues: Mutation/HITL lifecycle was intentionally not exercised under the read-only production test policy.

#### `canvaDesign`
- Status: `[-]`; export: `Artifact`
- Core proof: create/read one disposable design.
- Export proof: returned design/export artifact opens and matches requested content.
- Evidence: The Main permission bootstrap does not expose Canva for this member.
- Issues: Intentionally not exercised because the production test policy permits disposable writes only in the member's Google account.

#### `runCommand`
- Status: `[-]`; export: `N/A`
- Core proof: approved command, denial, timeout, bounded output, and trace.
- Export proof: `[-]` execution primitive; resulting files are tested through destinations.
- Evidence: The Main permission bootstrap does not expose this capability for the current member.
- Issues: No parity claim; unavailable under current RBAC.

#### `scheduledWorkflows`
- Status: `[~]`; export: `N/A`
- Core proof: create/read/update/disable a disposable schedule and verify one execution.
- Export proof: `[-]` scheduler; the scheduled source tool owns export correctness.
- Evidence: Main loaded the exact scheduling skill and read all four archived schedules; the inventory was written and read back from Google Sheets.
- Issues: Create/update/disable/execution lifecycle was intentionally not exercised under the read-only production test policy.

#### `dataExport`
- Status: `[x]`; export: `Bulk`; role: rollback only.
- Core proof: verify existing candidate/plan path still works while sources migrate.
- Export proof: one representative fallback export with exact reconciliation.
- Evidence: Main resolved a 2,457-row Airtable candidate for July 2026, ran preflight, created the async export, wrote a Google Sheet in 500-row progress batches, and delivered a governed link. Backend logs confirm `rowCount=2457`, `coverageOutcome=complete`, artifact checkpoint, and delivery completion.
- Issues: The run began the large export without first estimating and confirming its scale (`EXPORTCONFIRM-001`). Remove this fallback only after every migrated provider has passed and rollback is approved.

## Divo runtime-support tool matrix

These tools are tested for routing, context, safety, and lifecycle correctness.
Bulk export acceptance does not apply unless explicitly stated.

| Status | Runtime tool | Required Main proof | Issues |
| --- | --- | --- | --- |
| [ ] | `divo_skill_resolve` | Selects one relevant native DB skill without repeated loading | none logged |
| [ ] | `divo_connections` | Resolves an authorized account once; no token exposure | none logged |
| [ ] | `divo_image_read` | Reads an allowed workspace image under model policy | none logged |
| [ ] | `divo_preflight` | Validates Google/Airtable native mutation arguments | retire only after full typed parity |
| [ ] | `divo_memory` | Stores permitted personal memory in a private DM only | none logged |
| [x] | `divo_memory_recall` | Recalls scoped memory without group exposure | Main private-DM retrieval passed |
| [ ] | `divo_memory_review` | Review lifecycle is governed and traceable | none logged |
| [ ] | `divo_knowledge_review` | Knowledge review respects department scope | none logged |
| [~] | `divo_search_chats` | Searches private chat history with bounded results | Retrieval passed; end-to-end synthesis failed (`HISTORY-001`) |
| [~] | `divo_read_chat` | Reads only an authorized prior chat | Authorized reads passed; excessive paging exhausted the run (`HISTORY-001`) |
| [ ] | `divo_todos` | Tracks run work without replacing business task tools | none logged |
| [ ] | `divo_subagents` | Parallel read work preserves scope and result ownership | none logged |

## Central issue ledger

Every per-tool issue should also receive a row here for triage.

| ID | Tool | Severity | Environment | Symptom | Root cause | Fix/decision | Retest | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LARKTASK-001 | `larkTask` | High | Main | CSV rows were pasted into the final card; local container path was shown; no downloadable file arrived | Artifact registration/delivery was not completed after local file creation | Diagnostic rerun delivered a governed Sheet and kept bulk rows out of chat | Passed 2026-08-10 | Resolved |
| EXPORT-DEST-001 | Cross-tool export | High | Main | Divo treated a container-local file as the final export destination | No shared default destination rule was available to the model | Default tabular exports to Google Sheets; explicit files to Drive or Lark attachment; local paths are intermediate only | Pending | Open |
| PARALLEL-001 | Cross-tool terminal workflow | Medium | Main | Independent read-only Lark provider calls executed serially | Divo nested calls inside one Python loop using blocking `subprocess.run`, outside Pi's parallel tool scheduler | Shared terminal-workflow guidance should parallelize only independent read-only invokes; keep mutations serial | Pending | Open |
| LARKCONTACT-001 | `larkContacts` | Medium | Main | The diagnostic workflow invented a lookup term and returned an uninformative empty result | The combined prompt lacked a concrete contact target and the agent guessed instead of seeking clarity | Natural retest with a real member outcome; require clarity when a meaningful target cannot be inferred | Pending | Open |
| LARKDISC-001 | `larkBase`, `larkApproval` | High | Main | Read-only audits cannot begin without caller-supplied opaque identifiers | The governed surfaces expose resource reads but no authorized Base/table or approval-definition discovery operation | Add minimal read-only discovery operations, then retest with natural prompts | Pending | Open |
| GOOGLEAPI-001 | Google family | High | Main | Docs initially failed alongside Chat, Tasks, Contacts, Forms, and Apps Script | Docs, Chat, Tasks, and Contacts hit disabled provider APIs; the retry reclassified Forms and Apps Script as OAuth-scope blocks | Docs passed after API enablement; enable Chat/Tasks/People and separately repair Forms/Apps Script scopes | Docs passed 2026-08-10; others pending | Partial |
| GOOGLEACCOUNT-001 | Google family | High | Main | The agent chose one of several connected Google accounts without confirming the intended identity | The natural prompt said "my" activity while multiple accounts were available and no default-account rule resolved the ambiguity | Ask for clarity or use an explicitly configured default account; never infer from broader scopes | Pending | Open |
| GOOGLEARGS-001 | `googleDrive`, `googleDocs` | Medium | Main | Folder creation, ID extraction, add-parent, and Docs insertion arguments required script repairs | Skill/examples and generated terminal helper usage did not make the typed input/result contracts sufficiently self-describing at the scripting boundary | Expose or consume exact native contracts in the terminal helper and add fixture coverage for these operations | Pending | Open |
| GOOGLEDOCS-001 | `googleDocs` | Medium | Main | The document was functionally correct but the member rejected its visual presentation | The first pass optimized for content completion and read-back without a strong document-layout recipe or visual verification loop | Evaluate the active beautification follow-up and improve the Docs skill only if the natural retry still needs avoidable repair | Pending | Open |
| CONTEXT-001 | Cloud Pi thread runtime | High | Main | Later turns read roughly 100k-131k cached tokens and a simple Docs beautification took 29 steps | All family tests shared one long-lived Pi JSONL session; large prior tool results and run history remained in the active model context while scripts also searched UUID-named result files across run directories | Prove a fresh-thread baseline, then add bounded context compaction and stable current-run result references without weakening audit persistence | Pending | Open |
| SKILLLOAD-001 | Native skills / Airtable | High | Main | The failed Airtable run invoked tools and wrote four scripts without reading any Airtable or Python skill; a fresh Zoho chat immediately read all four required skills | Advisory skill loading can be skipped, and stale long-session context supplied obsolete paths and patterns | Keep execution advisory, but make the typed tool/local-workflow surface point to the exact native skill and emit a concise first-use reminder; never accept caller-supplied provenance | Pending | Open |
| LOCALHELPER-001 | `divo-local` Python workflow | High | Main | Generated Airtable helpers hid structured errors and created temp paths from labels containing `/` | The model rewrote the documented safe helper instead of reusing it; `--args-file` ergonomics make accidental filename construction easy | Provide one reusable runtime helper or fixture that owns safe filenames, full errors, and local-file parsing | Pending | Open |
| RUNFILES-001 | Cloud Pi run lifecycle | High | Main | 14,204 paged Zoho rows disappeared before the member's “proceed” follow-up, forcing a complete refetch | The skill calls `DIVO_RUN_DIR` persistent, but runtime cleanup makes it turn-scoped | Add an explicit governed thread-work directory for resumable checkpoints, or finish partial artifacts before asking a post-fetch question | Pending | Open |
| ZOHOMAP-001 | `zohoBooks` | High | Main | All exported expense amounts became zero despite valid provider totals | The script guessed top-level expense fields instead of mapping the actual preview columns/row shape | Add a Zoho expense fixture and require schema-derived column mapping before bulk write | Pending | Open |
| VERIFY-001 | `googleSheets` | High | Main | A 3,467/1,294-row write was “verified” with only 50 rows returned | Workspace MCP 1.22.0 fetched the full range but rendered only its first 50 rows; the workflow then treated that partial view as verification | Deploy the pinned 1.22.2 upgrade, then repeat the exact Main read/write reconciliation; Development already returned 120/120 with zero omissions | Development passed; Main pending | Open |
| QUEUE-001 | Lark ingress / Cloud Pi | Medium | Main | A card said a request would start automatically, but the backend completed it with `user_busy` and never retried | Status copy describes queueing while the runtime lane currently rejects the concurrent request | Either enqueue it durably or state that the member must retry; never promise automatic execution without a queued job | Pending | Open |
| KNOWLEDGE-001 | `knowledge` | High | Main | Every scoped read failed as `Approval misconfigured. Invalid knowledge apply request` | Read operations are entering an apply/approval path whose request shape is invalid | Correct read-vs-apply classification/approval wiring and add read-only route tests for `documents.search` and `resources.list` | Pending | Open |
| HISTORY-001 | Chat history runtime | High | Main | A Zoho-chat retrospective performed 15 tool steps, loaded roughly 106k tokens from 270 messages, then ended with a temporary failure and no Doc | Search ranked an older broad thread and the model paged almost its entire transcript into context instead of retrieving bounded relevant evidence | Add tighter date/thread ranking and a bounded evidence/summarization path; never stream whole long chats into the active model context | Pending | Open |
| EXPORTCONFIRM-001 | Cross-tool large export | Medium | Main | A request for a potentially large complete export begins execution without first confirming the expected scale and destination cost with the member | Export planning has no conversational size-estimate/confirmation gate before bulk retrieval | Estimate rows/bytes first; for materially large exports, state the estimate and ask one short confirmation before fetching pages or creating the destination | Pending | Open |
| EXPORTOBJECT-001 | Airtable / cross-tool export | High | Main | The verified 2,457-row Sheet preserved linked-record/select objects as raw JSON strings in user-facing cells | Source-specific value normalization was not applied before the backend export sink serialized rows | Put provider semantics in the Airtable source skill, a generic `name`/`label`/`value` plus array-flattening fallback in the shared Python/export skill, and an unresolved-object scan in the Sheets completion contract; keep field-shape logic out of the gateway/router | Active cleanup run | Open |

## Per-run evidence template

Copy this block beneath the relevant tool after each run:

```md
#### Run YYYY-MM-DD HH:MM IST
- Status: pass / fail / blocked
- Exact prompt: "..."
- Main SHA and model: ...
- Skill selected: ...
- Tool sequence: ...
- Source/destination: redacted labels only
- Dataset: 1 / 10 / 100 / multi-page / empty / capped
- Counts: source=... transformed=... written=... read-back=...
- Duration and retries: ...
- Trace reference: private evidence location
- Artifact: private evidence location
- Context/credential check: pass / fail
- Issue IDs: none / TOOL-NNN
- Notes: ...
```

## Completion gate

The program is complete only when:

- [ ] Every active Main governed tool is `[x]` or intentionally `[-]`.
- [ ] Conditional Shopify tools have an explicit availability decision.
- [ ] Every `Bulk` source has a reconciled multi-page export.
- [ ] Google Sheets and file/Drive destinations pass large-write read-back.
- [ ] Every open issue is fixed, accepted, or explicitly deferred with an owner.
- [ ] No test exposed credentials, leaked unbounded rows, or duplicated mutations.
- [ ] `dataExport` removal/cutover is decided from recorded evidence, not assumption.
