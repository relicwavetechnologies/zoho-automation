# Autonomous export E2E validation

## Scope and rules

Command-driven tests of isolated cloud Pi only. Lark presentation and browser
automation are out of scope. Semrush truth comes exclusively from Divo's
configured backend Semrush API integration.

## Matrix

| Date | Prompt / action | Expected invariant | Actual trace / artifact result | Verdict | Root cause / fix | Rerun |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-03 | Cloud-Pi prompt: “top 50 organic keywords for emiactech.com in India… CSV… only top 50” | Preview, offer recipe, and confirmed artifact each have 50 rows | First attempt failed pre-tool with intermittent Prisma DB reachability. Retry completed cloud Pi with `deepseek-v4-pro`; trace shows only governed Semrush preflight/invoke. Persisted offer `9cb9373d-fdff-4b0e-a747-fb85a958fb7e` is pending with `args.limit=50`, `format=auto`; Semrush coverage also reports `limit=50`. No callback/artifact yet. | Offer path passes; artifact path pending | Fixed adapter limit loss: explicit `limit` is preserved page-by-page, and completing that requested limit is neither paginated nor reported truncated. Persisted raw gateway event was 29.7KB and truncates in trace storage, so this is a context-efficiency finding to assess separately. | Confirm CSV/XLSX/Sheet pending |
| 2026-08-03 | 1, 24, 25, 26, 49, 50, 51, 100, 1000 | Exact source / preview / artifact count; no duplicate or expanded rows | Pending | Pending | — | Pending |
| 2026-08-03 | Explicit all / everything | Cap and truncation are truthful | Pending | Pending | — | Pending |
| 2026-08-03 | Vague, typo, Hinglish, conflicting wording | Clarifies ambiguity or creates governed export | Pending | Pending | — | Pending |
| 2026-08-03 | CSV, XLSX, Sheet; duplicate/retry/concurrent callbacks | Equivalent rows/headers/types; idempotent artifacts | Pending | Pending | — | Pending |
| 2026-08-03 | Invalid and stale/expired/revoked cases when safely injectable | Safe error and no unwanted queued artifact | Pending | Pending | — | Pending |
| 2026-08-03 | Follow-up edit of delivered resource | Existing resource identity is reused | Pending | Pending | — | Pending |

## Artifact confirmation log

- 2026-08-03: Direct trusted handler confirmation for Google Sheet returned the
  success toast. BullMQ job `dtx_83a288bf2f8d814eea81dedbc74eacc5` completed
  in one page with `rowsRead=50`, `rowsExported=50`; persisted completion says
  `artifactType=google_sheet`, `rowCount=50`, `sourceTruncated=false`, and
  `verified=true`. Its submitted recipe retained Semrush `limit=50`.
- 2026-08-03: The immediate CSV confirmation failed before claim/queue at
  Prisma `dataExportOffer.findFirst`: cannot reach `127.0.0.1:15432`. This is
  the second independently observed intermittent tunnel failure. No CSV/XLSX
  job or artifact was created, so cross-format artifact equivalence and repeat
  callback checks remain blocked.

## Trace judgment criteria

- Trace explicitly reports cloud Pi; no legacy AI SDK path.
- Only governed `semrush` and export-capability calls occur, with no bulk data
  copied into the agent response/context.
- Provider pagination has no redundant pages or retries; artifacts preserve the
  requested query, limit, columns, values, and source order.

## Live run log

- 2026-08-03: Both controller and backend health checks initially passed. One
  local-only fresh-context prompt was issued. It produced no external delivery,
  callback, offer, artifact, or persisted trace because Prisma failed to reach
  the DB before Pi tool execution.
- 2026-08-03: Added the focused `SemrushSnapshotDataExportSource` regression:
  a 50-row offer makes exactly one `limit: 50, offset: 0` source call, writes
  50 rows, and has neither `hasMore` nor `sourceTruncated`. Verified with
  `node --import tsx --test tests/tools/semrush.tool.test.ts` (11 passing) and
  `pnpm typecheck` (passed).
