# Semrush capability matrix

This is the release gate for Divo's `semrush` tool. A row can be placed in the
backend implementation only after its official API, entitlement, response
fixture, and UI-parity probe are recorded. Never substitute a browser-session
or private web endpoint for a missing row.

| Divo operation | Team workflow | API/version | Probe / UI variance | Runtime status |
| --- | --- | --- | --- | --- |
| `domain_overview` | Domain Overview / Organic snapshot | Standard API v3 `domain_ranks` | Compare 2–3 approved domains and database semantics | Implemented; backend environment key |
| `organic_positions` | Organic Research rankings | Standard API v3 `domain_organic` | Compare rows, offsets, and database coverage | Implemented; backend environment key |
| `backlinks_comparison` | Bulk Backlink Analysis | Official API contract still required | Compare 2–10 approved root domains | Explicitly unavailable |
| `organic_position_trend` | Position Tracking trend | Official Projects API contract required | Validate campaign ownership and historical output | Explicitly unavailable |
| `domain_comparison` | Domain comparison | Official endpoint/response fixture required | Validate team workflow | Explicitly unavailable |
| `keyword_gap` | Keyword Gap | Official endpoint/response fixture required | Validate team workflow | Explicitly unavailable |
| `keyword_research` | Keyword Overview / Magic | Official endpoint/response fixture required | Validate team workflow | Explicitly unavailable |
| AI Visibility / Prompt Research / Topic Opportunity / citations | UI-only AI workflows | Official API/SKU not confirmed | Obtain written Semrush API contract first | Not registered as a callable operation |

## Completion record for each row

Record the date, account/key version, exact official documentation link, request
shape with credentials removed, test domains, UI comparison screenshots/values,
empty/partial behavior, and reviewer. The backend then enables only those
fixed operations. Normal Divo RBAC controls discovery and invocation; keys are
kept exclusively in the backend environment.
