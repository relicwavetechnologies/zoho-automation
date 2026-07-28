# Secure Data Export Pipeline

## Goal

Divo exports bounded tabular datasets without placing bulk rows in model context, exposing source credentials, or creating provider-specific export paths.

## User experience

- An administrator selects one connected company Google Workspace account for exports.
- The UI derives and displays the selected account email and company domain; neither is hardcoded.
- The acknowledgement is intentionally simple: only the verified invoking user receives reader access.
- A user asks naturally for all Airtable or Zoho Books rows, a CSV, or a Google Sheet.
- Divo resolves the source and calls one governed `dataExport` capability.
- Divo creates one Lark tracker, updates it with page/row progress, then turns that same card into the verified Google link.
- The current phase exports at most 5,000 rows. Divo states this clearly whenever a user requests more or every row, and the final card marks capped results as truncated.

## Agent contract

- One deterministic system skill, **Secure Data Export**, owns the detailed recipe.
- One system invariant says large tabular results must use the governed export capability and must not enter model context.
- `dataExport` accepts a source, an optional row transform, and a destination.
- `destination.format="auto"` selects Google Sheets for manageable datasets and a CSV stored in Google Drive for larger datasets.
- Source tools may retain `exportAll=true` only as a compatibility trigger that delegates to `dataExport`; they do not fetch or upload the bounded artifact themselves.

## Trust boundaries

```text
source adapter (network + source credential)
  -> paged rows
  -> isolated transform child (empty environment, OS-blocked network, permission-blocked filesystem)
  -> NDJSON spool (bounded memory)
  -> Google sink (network + selected Google credential)
  -> exact invoking user reader permission
  -> integrity and permission verification
  -> Lark completion delivery
```

- Backend remains the authority for identity, connection resolution, RBAC, artifact access, credentials, queueing, auditing, and delivery.
- Source and sink nodes alone have network access.
- Generated transform code receives only `row`, `index`, and JSON-safe `args`.
- The transform runs in a separate disposable Node process. macOS uses `sandbox-exec`; Linux uses Bubblewrap or an unprivileged network namespace. Node permissions deny filesystem, child-process, worker, and native-addon access. If no supported isolation boundary is available, transformed exports fail closed.
- The invoking user must be able to read the exact source connection.
- Export artifacts are private by default: only the verified invoker receives reader access.
- Export access changes are unsupported and must be refused.
- Personalized Zoho access cannot create complete exports because rows outside the invoker's source scope cannot be read.
- The selected Google connection must remain active and retain Drive and Sheets write scopes.

## Central ownership

- One BullMQ queue and worker own all governed data exports.
- Source adapters own provider pagination only.
- The Google sink owns artifact creation, fixed sharing, cleanup, and verification.
- Provider tools own bounded previews and compatibility delegation only.
- No Airtable- or Zoho Books-specific Cloudinary/temporary-link export path remains.

## Current sources

- Airtable records: list and search, with exact connection and governed read scopes.
- Zoho Books modules: page-by-page reads with filters, organization, and deduplication.

Adding a provider requires a source schema, one registered paged adapter, permission mapping, and focused adapter tests. It must not add another queue, worker, sharing policy, or upload implementation.

## Safety and limits

- Transform source and arguments are size-limited.
- Transform runtime, page output, and row expansion are bounded.
- Source cursors/pages have hard loop guards.
- Rows are spooled server-side and never accumulated in model context.
- One central 5,000-row ceiling applies to both source rows and transformed output rows.
- Sparse fields discovered on later pages are preserved in the final column union.
- Spreadsheet-formula-like strings are neutralized.
- Partial Google artifacts are deleted on failure.
- A reset-on-progress worker watchdog aborts only after ten minutes of inactivity, not ten minutes of total work.
- Google artifacts carry the deterministic BullMQ job key and completion metadata so a retry recovers the same verified file instead of creating a duplicate.
- Completion is persisted before the single Lark tracker is changed to its terminal state.
