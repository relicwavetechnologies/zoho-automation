# Semrush Integration Validation Notes

Last updated: 2026-07-20

## Purpose

This is the evidence log for the proposed Divo Semrush capability. It records
what was actually tested from the senior-provided Lark request recipes; it is
not a claim that all Semrush UI functionality is available through an API.

## Security boundary

- Do not commit, log, or return Semrush API keys, cookies, SSO tokens, or
  browser session headers. Credentials pasted in chat should be rotated.
- Divo's backend is the only place that may hold credentials and call Semrush.
  Pi/Desktop must use the existing Divo gateway rather than calling Semrush
  directly.
- The tested `www.semrush.com` routes are private web endpoints, not a stable
  public integration contract. Prefer a supported Semrush API entitlement for
  any production deployment.

## Observed private recipes

| Capability | Request shape | Evidence | Wrapper decision |
| --- | --- | --- | --- |
| Backlinks comparison | `POST /backlinks/webapi2/`, `type=backlinks_comparison` | Browser-session endpoint returned data | Accepted for backend-owned env-session wrapper |
| Organic overview | `POST /dpa/rpc`, `ranks.Ranks`, `organic.overview` | Browser-session endpoint returned target-dependent results | Accepted for backend-owned env-session wrapper |
| Organic keyword-position trend | `POST /dpa/rpc`, `organic.KeywordPositionTrend`, `organic.positions` | Browser-session endpoint returned rows for tested targets | Wired as `keyword_position_trend` |
| Legacy backlink export | `GET /analytics/backlinks/webapi2`, `action=export`, `type=backlinks` | Live probe returns `403 ERROR 130 API DISABLED` with active session | **Excluded** — API disabled on live session; do not implement |
| Organic growth/trend export | `POST /dpa/rpc`, `export.Get`, `organic.overviewtrendbatch` | Supplied payload is an n8n template with eight unresolved expressions, so it is not valid raw JSON | Exclude until the resolved API contract is supplied and tested |

2026-08-04 update: Divo Semrush is web-only via `SEMRUSH_WEB_API_KEY`,
`SEMRUSH_WEB_COOKIE`, and `SEMRUSH_TIMEOUT_MS` (default 15000). It never exposes
the cookie/key to Pi, Desktop, Lark, logs, or export artifacts. Only the
validated private routes in the matrix are wired.

## DPA request-ID rule

The Lark guidance says a ranking request needs a random request ID; changing
the final four characters is an accepted manual workaround. The supplied
working requests use 36-character UUIDs, and fresh UUIDs were validated.

**Implementation rule:** Divo may invoke private DPA routes only through the
backend-owned Semrush web wrapper, with a fresh request ID per call.

## Input behaviour observed

- Change the target website through `params.args.searchItem`.
- Data is target-dependent: a syntactically valid request may return an empty
  result set when Semrush has no applicable data for that target/configuration.
- Keyword-position requests also depend on database, date/date type, keyword,
  and position type. Validate and bound these fields server-side.

## Explicitly not API-validated

The Lark chat lists these as paid/UI workflows, but no callable, validated API
recipe has been supplied:

- AI Visibility Overview
- Prompt Research and Competitor Prompt Research
- Topic Opportunity and AI mention/citation reporting
- Compare Domains
- Keyword Gap
- Keyword Research

## Implemented safe gateway contract

Expose only these web-session operations through one backend-owned Semrush
capability:

- `domain_overview`
- `backlinks_comparison`
- `keyword_position_trend`

For each invocation:

1. Authenticate the Divo member and enforce capability RBAC in the backend.
2. Validate a whitelisted operation and a strict operation-specific payload.
3. Call validated `www.semrush.com` recipes with `SEMRUSH_WEB_API_KEY` and
   `SEMRUSH_WEB_COOKIE` held only in the backend.
4. Apply short timeouts and structured audit logging with secrets redacted.
5. Return structured JSON to the Divo gateway. Never return raw cookies or
   credential-bearing request details.

This document should be updated whenever another Semrush web recipe is
validated or invalidated.
