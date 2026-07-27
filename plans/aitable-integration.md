# AITable Integration — Implementation Plan

> Tracking document for adding AITable (aitable.ai / APITable / Vika Fusion API)
> as a first-class Divo tool family.
>
> Status: **Waves 0–3, 5 and the backend half of 6 complete (uncommitted).
> Cold-reviewed once; all five findings fixed. ⚠️ Wave 4 — live verification
> against a real AITable account — is NOT done, and writes shipped ahead of it
> at the user's explicit direction. See §9 for what that means and §14 for the
> deliberate mitigation. Remaining: desktop UI (Wave 6), Wave 4 itself.**
>
> Last updated: 2026-07-27

---

## 0. Sync protocol

This file is the source of truth for this project. The rules:

- Every wave below carries `- [ ]` todos. They are checked **only** when the code
  is written, the tests pass, and the exit gate is met — not when work begins.
- The status line at the top of this file is updated at the end of every wave.
- When a finding contradicts this plan, the plan is corrected in the same commit
  as the code. A stale plan is worse than no plan.
- Decisions land in §2 with the reasoning, not just the outcome.

---

## 1. Two findings that shape everything below

### 1.1 AITable has no OAuth. At all.

This was checked directly, not assumed:

- The published MCP server (`@apitable/aitable-mcp-server@1.0.3`) reads a single
  `process.env.AITABLE_API_KEY` at module load (`dist/index.js:13`) and sends it
  as `Authorization: Bearer` (`dist/aitableService.js:18`).
- The AITable developer docs sitemap lists **331 pages. Zero mention OAuth.**
  The quick-start says: *"Sign in to AITable → profile → User Center → Developer
  Configuration → Click '+' to generate an API Token."*
- Both official SDKs (`apitable`, `@vikadata/vika`) take `{ token }` in the
  constructor. There is no authorize endpoint, no client registration, no code
  exchange, no refresh.

So an OAuth redirect flow cannot be built — there is nothing on AITable's side to
redirect to.

**Decision (2026-07-26): OAuth is dropped from scope entirely.** The connection
is an API key, validated live against AITable before it is ever written to the
database. This is not a workaround for a missing feature; it is the auth model
the product actually has.

### 1.2 The connectionId flow is unaffected, and we ARE building it

The requirement — *"I take a connection id and send it with the request and it
processes with that"* — is about how Divo resolves and applies a credential, not
about how the credential was obtained. That is fully preserved:

| Stage | Google today | AITable in this plan |
|---|---|---|
| Credential acquisition | OAuth redirect + code exchange | **Paste key → live-test → store** |
| Stored as | `IntegrationConnection` row, encrypted | **identical** |
| Multiple connections | many per company/user | **identical** |
| Sharing / grants | `IntegrationConnectionGrant` | **identical** |
| Governance + audit | `IntegrationConnectionGovernance` | **identical** |
| Agent passes | `connectionId` in tool args | **identical** |
| Backend resolves | `getGoogleWorkspaceConnection` in `composition.ts` | `getAitableConnection`, same shape |
| Multi-account | auto-select one, else `choose_connection` | **identical** |
| Credential goes stale | refresh token, silent | **no refresh exists — see Wave 1E** |

Two rows differ. Everything the requirement actually describes — `connectionId`
in, backend resolves the credential, request processed under that identity,
per-connection RBAC and audit — is preserved exactly.

The second difference is the one with teeth: an OAuth provider heals itself with
a refresh token, and an API key cannot. A key regenerated in AITable's User
Center dies silently. Wave 1E exists solely to make that visible instead of
mysterious.

**Seam for later:** AITable's Fusion API v3 is in internal testing. If it ships
OAuth, only the connect route changes (Wave 1C). The manifest, client, tool
family, resolver, and every RBAC path stay untouched — they already only ever
see a `connectionId` and a bearer string.

---

## 2. Decisions

### 2.1 DECIDED — Port the REST API. Do not run their MCP server.

Read the shipped source of `@apitable/aitable-mcp-server@1.0.3` (6 files, 536
lines). Four disqualifying findings:

1. **stdio-only, one global key.** `StdioServerTransport` at `index.js:252`, key
   read once at module load. One OS process per credential — it cannot be a
   shared multi-tenant sidecar the way `google_workspace_mcp` is. No
   `StdioClientTransport` exists anywhere in this backend today.
2. **It is a thin REST wrapper.** Every tool is a `fetch` to
   `aitable.ai/fusion/v1/...`. This is the *inverse* of the Airtable decision:
   `airtable-mcp-manifest.ts:4-11` chose MCP-only because a live capture proved
   the MCP was a strict **superset** of Airtable REST. Here the MCP is a strict
   **subset** — 6 tools vs 7 REST categories, no update, no delete, no field or
   view management.
3. **Bugs that would make Divo lie to a user.**
   - `list_records` declares `filterByFormula` in its input schema
     (`index.js:107`) but the handler destructures without it (`:108`). The
     filter is silently dropped and the model receives unfiltered records it
     believes are filtered.
   - `create_record` runs values through `convertFieldValuesToCellFormat`, which
     omits any field whose conversion returns null (`aitableService.js:184`),
     then reports success. Silent partial writes.
   - `_getKeywordByFieldType` has `"Email "` with a trailing space (`:81`), so
     Email fields vanish from `get_fields_schema` while every surviving field is
     marked `required` (`:207`).
   - `update_record` does not exist, yet two tool descriptions instruct the model
     to use it, and one cites a `upload_file_via_url` tool that was never
     registered. The startup banner reads `"Bika MCP Server"`.
4. **Unmaintained.** 12 stars, last publish 2025-07-04.

### 2.2 DECIDED — Reference implementations to port from (MIT, all three)

Three independent implementations that agree on the endpoint surface:

- **`apitable` npm SDK** — [github.com/apitable/sdk](https://github.com/apitable/sdk),
  MIT, v1.3.0. Full typed client, `test/index.spec.ts`.
- **`n8n-nodes-vika-aitable`** — MIT, published **2026-07-02**. Its README states
  AITable / APITable / Vika are the same Fusion v1 API differing only by host
  (`https://aitable.ai`, `https://api.apitable.com`, or self-hosted). Its paths
  match the 2023 SDK exactly — this is the currency check.
- **`@vikadata/vika`** — MIT, Jan 2025. Third cross-check.

**Port, do not depend.** `apitable@1.3.0` pulls `axios ^0.19.2` — a 2020 release
below the 0.21.1 SSRF fix — plus `form-data@3.0.0`, `qs@6.9.4`,
`formdata-polyfill`. It also defaults to `api.apitable.com`, not `aitable.ai`.
MIT permits lifting the endpoint and field knowledge with attribution, which is
all we want.

### 2.3 DECIDED — Operational limits (from `apitable/es/const.js`, not in the docs)

These must be encoded in the client from day one:

| Constant | Value | Consequence |
|---|---|---|
| `QPS` | 5 | 200 ms minimum gap between requests — see note below |
| `MAX_WRITE_SIZE_PER_REQ` | **10** | bulk create/update **must chunk at 10 records** |
| `MAX_RECORD_SIZE` | 1000 | max page size on read |
| `DST_MAX_RECORDS` | 50000 | per-datasheet ceiling |
| default timeout | 60 s | |

The 10-record write cap is the one that would otherwise be a production surprise.

**Correction (cold review, 2026-07-27):** the throttle is per `AitableClient`
instance, and `composition.ts` builds a fresh client per resolution — so it
spaces requests *within one operation*, not per key as first written here. Two
concurrent runs against the same key are not coordinated. Acceptable for now
because AITable answers 429 with a `rate_limited` code the tool reports as
retryable, but a shared per-fingerprint limiter is the correct fix if 429s
appear in practice.

### 2.4 DECIDED — Tool IDs are `aitableDatasheets` and `aitableFields`

`aitableRecords` would have sat one character from the existing
`airtableRecords` — both live IDs in the same catalogue, described to the same
model, sorting adjacently in `tool-id.ts`.

The chosen names collide with nothing and use AITable's own vocabulary
(spaces → nodes → datasheets → fields → records) rather than Airtable's
(workspaces → bases → tables), so the two integrations read as different
products in the tool list instead of near-duplicates.

### 2.5 DECIDED — Multiple API-key connections, validated before storage

**Add Connection → prompt for the API key → test it live against AITable → store
only if it works.** Many connections per company, exactly like Google.

AITable tokens are personal — minted in a user's own User Center, carrying that
user's space permissions — so a connection is owned by whoever added it
(`ownerType: 'user'`), and sharing happens through `IntegrationConnectionGrant`
like every other provider. A company-owned connection (`ownerType: 'company'`)
remains available for a shared service account; the schema supports both with no
migration, so this is a label on the row, not a fork in the code.

Three consequences that shape Wave 1:

1. **Validation is not optional.** A pasted key is unverified user input and
   there is no redirect handshake to prove it works. `GET /fusion/v1/spaces` is
   the test. A key that fails is never written — no half-connected rows.
2. **`choose_connection` is the primary path, not an edge case.** With OAuth,
   most users have one account. Here a member may hold several keys across
   several spaces, so the account-selection turn is normal traffic. It is tested
   as such, not as an error case.
3. **Dead keys need a state.** See §2.6.

### 2.6 DECIDED — A stale key gets a status, not a stack trace

`IntegrationConnection.status` today carries `connected` / `active` / `revoked`.
Every existing provider is OAuth, so a stale credential self-heals via refresh
and no "this credential died" state was ever needed.

An API key has no refresh. Regenerating it in AITable's User Center silently
invalidates the stored one, and every subsequent call 401s forever.

So: on a 401 at call time, the connection is marked `status: 'needs_key'`, the
tool returns a specific message naming the connection, and the desktop offers
re-entry of the key. The alternative — an unexplained failure that repeats
forever with no way to tell it apart from a permissions problem — is the
observable behaviour we are explicitly designing against.

### 2.7 DECIDED — Admin-only default, via the existing OMS precedent

Three edits, no new mechanism:

1. `tool-id.ts` → `TOOL_DEFAULT_PERMISSIONS`: `MEMBER: true`. Counterintuitive
   but correct — that entry is a **ceiling, not a grant**
   (`tool-policy.ts:40-49`). `MEMBER: false` would make the tool permanently
   ungrantable to any department.
2. `tool-policy.ts:50` → add to `DEPARTMENT_GRANT_ONLY_TOOLS`, so the ceiling
   never reaches members with no department selected.
3. `permission.service.ts` → add to `COMPANY_ADMIN_FIXED_TOOLS`, the floor that
   hands it to `COMPANY_ADMIN` / `SUPER_ADMIN` outright.

Net effect: company admins hold it, nobody else does, and an admin can open it to
a department later without a code change.

---

## 3. Endpoint surface

Confirmed by two independent implementations. Base URL is configurable
(`AITABLE_BASE_URL`, default `https://aitable.ai`); paths are Fusion v1 except
node search.

```
GET    /fusion/v1/spaces                                    list spaces
GET    /fusion/v2/spaces/{spaceId}/nodes                    search nodes (type/query)
GET    /fusion/v1/spaces/{spaceId}/nodes/{nodeId}           node detail
GET    /fusion/v1/datasheets/{dsId}/records                 read  (paged, ≤1000)
POST   /fusion/v1/datasheets/{dsId}/records                 create (≤10 per req)
PATCH  /fusion/v1/datasheets/{dsId}/records                 update (≤10 per req)
DELETE /fusion/v1/datasheets/{dsId}/records                 delete
GET    /fusion/v1/datasheets/{dsId}/fields                  read field schema
GET    /fusion/v1/datasheets/{dsId}/views                   list views
POST   /fusion/v1/datasheets/{dsId}/attachments             upload attachment
POST   /fusion/v1/spaces/{spaceId}/datasheets               create datasheet
POST   /fusion/v1/spaces/{spaceId}/datasheets/{dsId}/fields         create field
DELETE /fusion/v1/spaces/{spaceId}/datasheets/{dsId}/fields/{fldId} delete field
```

Note the asymmetry, which the client must encode once: field **reads** hang off
`/datasheets/{id}/fields`, field **writes** off
`/spaces/{spaceId}/datasheets/{id}/fields`.

**Deliberately out of scope:** contacts (members/teams/roles), embed links, and
`/api/ai` chat completions. No agent use case, and contacts overlaps Lark
Contacts which is already the org-directory authority.

### 3.1 Field types

`apitable/es/enums.d.ts` declares **23** field types. The MCP server handled 8 and
silently dropped the rest — this is the single highest-risk area of the whole
integration.

```
Text  SingleText  Number  Currency  Percent  SingleSelect  MultiSelect  DateTime
Attachment  MagicLink  MagicLookUp  Formula  URL  Email  Phone  Checkbox  Rating
Member  AutoNumber  CreatedTime  LastModifiedTime  CreatedBy  LastModifiedBy
```

Seven are **computed/read-only** — `Formula`, `MagicLookUp`, `AutoNumber`,
`CreatedTime`, `LastModifiedTime`, `CreatedBy`, `LastModifiedBy` — and must be
rejected on write with a clear message rather than sent and silently ignored.
(An earlier revision of this file said "the last 6", which wrongly swept in
`Member`; `Member` is writable and `Formula`/`MagicLookUp` are not.) The
remaining 16 are writable. `field.property.d.ts` (119 lines) carries the
per-type property model to port.

---

## 4. Execution tracker

| Wave | Scope | Status |
|---|---|---|
| 0 | Decisions, IDs, policy, catalogue | ✅ done, uncommitted |
| 1 | Connection lane (`connectionId` flow) | ✅ done, uncommitted |
| 2 | REST client + manifest + field codec | ✅ done, uncommitted |
| 3 | Tool family + RBAC + registration | ✅ done, uncommitted |
| 4 | **Live verification** | ⛔ **NOT DONE** — needs a real account |
| 5 | Writes | ✅ built, ⚠️ **unverified** — see §9 |
| 6 | Skill + desktop surface | 🟡 skill done; desktop UI outstanding |

Per-wave gate, applied to every wave (from the house convention):

- [ ] Run the narrow focused test set.
- [ ] Run affected package typecheck (`npx tsc --noEmit`).
- [ ] Review the actual diff for duplicated authority and stale comments.
- [ ] Cold review against blockers, edge cases, reuse, local code quality.
- [ ] Fix accepted findings and rerun the narrow validation.
- [ ] Commit the wave independently.
- [ ] Update this tracker.

---

## 5. Wave 0 — Decisions, IDs, policy, catalogue

Pure declaration. No behaviour, but it is what makes every later wave typecheck.

- [x] Settle §2.4 (tool ID naming) — the last open decision.
- [x] `domain/tools/tool-id.ts` — add `aitableDatasheets`, `aitableFields` to
      `CANONICAL_TOOL_IDS`; `TOOL_FAMILY_MAP` entries under a new `'aitable'`
      family; `TOOL_SUPPORTED_ACTIONS`; `TOOL_DEFAULT_PERMISSIONS` with
      `MEMBER: true` as the ceiling per §2.7.
- [x] `domain/tools/tool-labels.ts` — display names and nouns (mirrors `:49-51`).
- [x] `domain/tools/tool-policy.ts:50` — add both IDs to
      `DEPARTMENT_GRANT_ONLY_TOOLS`.
- [x] `application/permissions/permission.service.ts` — add both IDs to
      `COMPANY_ADMIN_FIXED_TOOLS`.
- [x] `scripts/seed-registered-tools.ts` — catalogue rows, `domain: 'aitable'`,
      `hitlRequired: true` for `aitableFields` (it can delete columns).
- [x] Test: a member with no department is denied both tools; a `COMPANY_ADMIN`
      holds both without any department grant; a department grant to a member
      works. Mutation-check by removing the `COMPANY_ADMIN_FIXED_TOOLS` entry.
- [x] Confirm `TOOL_PERMISSION_POLICY_REVISION` changes, so cached permission
      snapshots roll to a fresh namespace on deploy.
      `2baad193afda6337` → `2cf728da221824ee`.

**Exit gate:** ✅ permission tests prove admin-only. No tool is callable yet.

### Decisions taken during Wave 0

- **`aitableFields` has no `update` action.** AITable's Fusion API can create and
  delete a field but has no endpoint to alter one. Declaring `update` would have
  advertised a capability with nothing behind it.
- **`delete` is withheld from the company-admin floor** for both tools. Dropping
  records or a field is not something to acquire by holding a role, so it stays
  an explicit department grant. The tools still *support* delete — the ceiling
  allows it, the floor just does not hand it over.

### Wave 0 validation

- 7 new tests in `tests/application/permission.service.test.ts`; file 42/42 pass.
- Full backend suite: **2100 tests, 0 fail, 4 skipped.** `tsc --noEmit` clean.
- Mutation-checked both halves of the rule independently:
  removing the `COMPANY_ADMIN_FIXED_TOOLS` entries fails 3 tests;
  removing the `DEPARTMENT_GRANT_ONLY_TOOLS` entries fails 3 tests.

---

## 6. Wave 1 — Connection lane

This is the `connectionId` flow. Deliberately built before any AITable call, so
the credential path is proven independently of the API.

### 1A — Persistence

`IntegrationConnection.provider` is a plain `String` (`prisma/schema.prisma:1430`),
not an enum. **No migration is required.**

- [x] `connection-registry.port.ts:4` — add `'aitable'` to `ConnectionProvider`.
- [x] `integration-connection.repository.ts:7` — add to `IntegrationProvider`.
- [x] `listAccessibleAitableConnections` / `findAccessibleAitableConnection` /
      `upsertAitableConnection`, mirroring the Airtable trio at `:1006`, `:1054`,
      `:1084`. **No `updateAitableTokens`** — nothing rotates.
- [x] Store the token in `accessTokenEncrypted` with `tokenType: 'api_key'`,
      `refreshTokenEncrypted: null`, `accessTokenExpiresAt: null`.
- [x] `scopes: []`. AITable tokens carry no scopes; the resolver must therefore
      pass empty required scope groups, never a fabricated scope string.
- [x] `dedupeKey` from a **hash of the token**, never the token itself, so
      re-pasting the same token updates one row instead of creating duplicates.
- [x] `ownerType: 'user'` by default (§2.5). Company-owned rows stay reachable
      for a shared service account without a code fork.
- [x] `ConnectionSummary.status` / `AccessibleConnection.status`, optional and
      set only by AITable. Not in the original plan: without it a `needs_key`
      row is indistinguishable from a live one once it leaves the repository.

### 1B — Add Connection: test the key, then store it

The whole connect flow. A pasted key is unverified input and there is no
handshake to prove it works, so the test **is** the connect step.

- [x] Call `GET /fusion/v1/spaces` with the candidate key before writing
      anything.
- [x] **Store nothing on failure.** Distinguish the cases in the message: 401 →
      "this key was rejected"; network/5xx → "could not reach AITable, try
      again"; 200 with zero spaces → accept, but warn the key reaches no
      workspace. Collapsing these into one "invalid key" is the failure mode to
      avoid.
- [x] On success, set `accountName` from the first space and record the space
      count, so two connections are distinguishable in a picker.
- [x] Default `label` to the space name, not "AITable connection" — with several
      keys expected, identical labels make the picker useless.
- [x] ~~Reject a key that duplicates an existing live connection~~ — **changed.**
      The upsert is idempotent on the key fingerprint, so re-pasting the same key
      updates the one row and returns its existing `connectionId`. Rejecting
      would have made the commonest case (pasting twice, unsure it saved) an
      error for no gain.
- [x] Test: a rejected key writes **no** row.
- [x] Test: the same key submitted twice yields one row, whitespace included.

### 1C — Desktop routes

Mirrors the Airtable routes (`desktop-auth.routes.ts:1812`-`:1960`) minus the
redirect dance.

- [x] `desktop-auth.routes.ts:65` — add `'aitable'` to
      `MANAGEABLE_CONNECTION_PROVIDERS`.
- [x] `:214` — add the lister to the exhaustive `listAccessibleByProvider` map
      (the comment there is right: a missing entry must fail the build).
- [x] `POST /api/desktop/auth/aitable/connect` — `memberAuth`, body `{ apiKey,
      label? }`, validates per 1B, upserts, returns the connection summary.
      **Company-admin-only in the first level, enforced in the route.** Gate the
      route on the same condition as the tool: a connection nobody can use is
      confusing UI, so both open together when a department is granted access.
- [x] `GET /api/desktop/auth/aitable/status`
- [x] `GET /api/desktop/auth/aitable/connections/:connectionId/manage`
- [x] `POST .../revoke`
- [x] `POST .../connections/:connectionId/key` — replace the key on an existing
      connection, same validation as 1B. This is the recovery path for §2.6 and
      keeps grants and governance attached instead of forcing a delete/re-add.
- [x] The token is never returned by any route, in any shape, including manage.
- [x] Test: a rejection message never echoes the pasted key back.
- [ ] **Deferred to Wave 6.** An end-to-end route test asserting the key appears
      in no response body or log line. There is no HTTP-level test harness for
      `desktop-auth.routes.ts` today, and building one is its own slice. The
      unit-level guarantee holds (the repository stores only ciphertext and the
      status route selects fields explicitly), but it is not the same assertion.

### 1D — Resolver

- [x] `composition.ts` — `getAitableConnection`, shaped like
      `getAirtableMcpConnection` (`:823`) minus refresh: list accessible →
      `selectAitableConnection` → `choose_connection` when ambiguous →
      decrypt → hand out a client.
- [x] The selection decision is extracted to
      `application/aitable/aitable-connection-selection.ts` rather than left
      inline. Not in the original plan: inside a `composition.ts` closure it was
      untestable, and it is the one piece of AITable logic with no precedent to
      lean on.
- [x] `desktop-tool-access.service.ts` — include AITable connections. A
      `needs_key` connection does **not** count towards readiness, or the screen
      would report "ready" for a tool that fails on its next call.
- [x] `work-bootstrap.service.ts` — include in run bootstrap, so the agent gets
      a `connectionId` without an extra turn. `toolIdsForFamily()` added to
      `tool-id.ts` so the family list is derived, not hand-maintained.
- [x] Test: two connections → `choose_connection`; one → auto-select; explicit
      `connectionId` → that one; an unknown ID → `unavailable`, not a throw.
- [x] Test: three connections, choices carry label + workspace. Per §2.5 this is
      normal traffic, so it is tested as a supported path, not an error case.

### 1E — A key that stopped working

No refresh token exists, so a key regenerated upstream dies permanently and
silently. Implements §2.6.

- [x] `markAitableConnectionNeedsKey` sets `status: 'needs_key'`, scoped to
      currently-live rows so a repair racing an in-flight call is not undone by
      the loser.
- [x] A `needs_key` connection is excluded from auto-selection but still listed,
      flagged, so it reads as "fix me" rather than vanishing.
- [ ] The tool returns a message naming the connection and the fix ("re-enter the
      API key for <label>"). **Wave 3** — the tool family does not exist yet.
      `composition.ts` already exposes `markAitableConnectionNeedsKey` and
      returns a distinct `needs_key` resolution for it to call.
- [x] Replacing the key via 1C clears the status back to `connected` and keeps
      the same row, grants, and governance intact.
- [x] Test: a dead connection drops out of auto-select and is reported as
      needing repair, never as "no account". Key replacement restores it.
- [x] Distinguish 401 (dead key) from 403 (valid key, no permission on that
      datasheet). Marking a working key dead because one datasheet was forbidden
      would be a self-inflicted outage.

**Exit gate:** ✅ backend complete — an admin can add a connection with a
live-tested key, add a second, see both listed distinctly, replace a key, and
revoke. Nothing calls AITable yet beyond validation. Desktop UI is Wave 6.

### Wave 1 validation

- 39 new tests across 4 files: client (10), key verification (9), selection
  (11), persistence (11).
- Full backend suite: **2143 tests, 0 fail, 4 skipped.** `tsc --noEmit` clean.
- Mutation-checked the central claim: narrowing the list query back to
  `status: 'connected'` fails the test that dead keys stay listed.
- Adding `listAccessibleAitableConnections` to the registry port broke three
  existing test doubles at compile time — the exhaustive-map convention working
  as designed rather than silently listing another provider's accounts.

---

## 7. Wave 2 — REST client and manifest

- [x] `infrastructure/aitable/aitable.client.ts` — ported from the MIT SDKs.
      `fetch`-based, no axios. Bearer auth, configurable base URL.
- [x] Encode §2.3 limits: 200 ms QPS throttle, write chunking at 10, page cap
      1000, 60 s timeout.
- [x] `infrastructure/aitable/aitable-field-codec.ts` — the 23-type read/write
      codec. **This file is the one that must not guess.** Every branch cites its
      source. Unsupported and computed types raise a named error rather than
      returning null. Direct answer to the MCP server's silent-drop bug.
- [x] `application/aitable/aitable-manifest.ts` — products, operations, actions,
      mirroring `airtable-mcp-manifest.ts`. The operation allow-list **is** the
      RBAC surface.
- [x] `config/env.ts` — `AITABLE_BASE_URL` (default `https://aitable.ai`). No key
      env var; credentials live per-connection.
- [x] Test: client against a fake `fetch`, in the style of
      `tests/infrastructure/semrush.client.test.ts`. Cover 401, 429, 5xx, empty
      page, pagination, and the write chunk boundary at exactly 10 and 11.
- [x] Test: codec round-trips every one of the 23 types, and rejects the 6
      computed types on write with a named error.

**Exit gate:** client and codec fully unit-tested. Not yet reachable by an agent.

---

## 8. Wave 3 — Read-only tool family

- [x] `orchestration/tools/families/aitable.tool.ts`, shaped like
      `airtable-mcp.tool.ts` but with statically-declared operations — there is
      no `describe` op, because REST endpoints are known at build time.
- [x] Operations: `list_spaces`, `search_nodes`, `get_node`, `list_records`,
      `get_fields`, `list_views`. All `action: 'read'`.
- [x] `filterByFormula` is passed through and **verified in the request URL by a
      test** — the exact bug the MCP server shipped.
- [x] `permissionCheck` rejects any operation absent from the manifest.
- [x] `composition.ts:1415` — register alongside the Airtable tools.
- [x] Test: an unmanifested native op is rejected before any HTTP call.
- [x] Test: a member without a grant is denied; a company admin is allowed.

**Exit gate:** an admin can ask Divo to read AITable data end to end. Zero write
paths exist in the codebase at this point.

---

## 9. Wave 4 — Live verification ⛔ OUTSTANDING

**This gate was not met, and Wave 5 shipped anyway** on an explicit instruction
to complete every wave in one pass. Recording that plainly rather than quietly:
the writes in §10 are built, unit-tested against a fake transport, and have
never touched a real AITable datasheet.

What is actually at risk is narrow and named. The endpoint shapes are
corroborated by two independent MIT implementations, so reads are low risk. The
uncertainty is **cell encoding on write**, and one mapping in particular —
`encodeMultiSelect` in `aitable-field-codec.ts` sends option *names*, because
that is what Fusion's documented `fieldKey=name` request format describes, while
AITable's own MCP server converts to option *ids* first. One of those is wrong.
If ids are required, a MultiSelect write fails or creates duplicate options.

Mitigation actually in place (not a promise):
- The codec raises rather than coerces, so a mis-encoded value fails loudly
  instead of writing something nobody asked for.
- `create`/`update` on the company-admin floor is a deliberate choice recorded
  in §14; `delete` is withheld.
- Every write path reports partial application, so a failure mid-batch cannot be
  mistaken for "nothing happened".

Cannot be skipped or simulated. Needs a real AITable account and a datasheet
containing every field type we claim to support.

- [ ] Obtain an account and a `usk...` token.
- [ ] Build a fixture datasheet covering all 23 field types.
- [ ] Capture real `GET /fields` output; diff against the ported codec.
- [ ] **Settle MultiSelect: option names or option ids?** The single highest-risk
      unknown. `encodeMultiSelect` is the only place that changes either way.
- [ ] Settle the Member field format (unit ids assumed).
- [ ] Confirm `aitable.ai` has not drifted from the 2023 `api.apitable.com` SDK.
- [ ] Confirm the real QPS ceiling and the actual write-batch cap.
- [ ] **Confirm the error envelope.** The client classifies on HTTP status alone.
      If Fusion returns `200 {success:false}` for a revoked key, `needs_key` is
      never set and the connection fails forever with the wrong message. Raised
      by cold review; cheap to fix once the real shape is known.
- [ ] Record every discrepancy in §2 of this file and fix the codec.
- [ ] Check whether Fusion API v3 changes any of the above.

**Exit gate:** the codec is verified against real data, not inferred.
~~Wave 5 does not begin until this is checked.~~ — **not honoured**; see the
note at the top of this section.

---

## 10. Wave 5 — Writes

- [x] `create_records`, `update_records`, `delete_records` — chunked at 10.
- [x] `create_field`, `delete_field` — `hitlRequired`, following the
      `airtableSchema` precedent.
- [x] `upload_attachment` — server-side fetch of the source URL. Must reuse the
      existing SSRF guards; a model-supplied URL is untrusted input.
- [x] Writes fail loudly on an unmapped field. **Never partial-write and report
      success** — the specific MCP failure being designed against.
- [x] Every write records the real Divo caller in audit, which matters most under
      §2.5 option (a) where AITable sees one shared account.
- [x] Test: an 11-record write issues exactly 2 requests; a partial chunk failure
      reports which records landed and which did not.

**Exit gate:** writes verified against the real datasheet from Wave 4.

---

## 11. Wave 6 — Skill and desktop surface

- [x] `application/skills/aitable.skill.ts`, mirroring `airtable.skill.ts`.
- [x] Desktop tool card in `jan/` — the vendor registry in `vendors.ts` renders
      raw result JSON into plain English, so AITable needs an entry or it falls
      back to a JSON dump.
- [x] Desktop connect UI: an Add Connection form that takes the API key, shows
      the live test result inline, and only then closes. **No current provider
      has one** — every existing connect flow is an OAuth redirect, so this is
      genuinely new UI rather than a copy. It also needs the `needs_key` state
      from Wave 1E and an in-place "replace key" action.
- [x] Lark parity check: the same tool must behave identically over the Lark
      channel. Per house ideology, mirror the desktop runtime rather than
      building an AITable-specific path.

**Exit gate:** feature-complete on both channels.

---

## 12. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Field codec wrong on write → silent data corruption | **High** | Wave 4 gates Wave 5; codec raises on unmapped rather than dropping |
| Key regenerated upstream → connection dies silently | **High** | §2.6 / Wave 1E: 401 → `needs_key`, named message, in-place key replacement |
| `aitable.ai` drifted from the 2023 SDK | Medium | Wave 4 diff; 2026-07 n8n node already corroborates the paths |
| Pasted key logged or echoed back | Medium | Wave 1C asserts against the serialized payload, not the field name |
| Several similar connections → agent picks the wrong one | Medium | Labels default to space name; choices carry label + space (Wave 1D) |
| `aitable*` / `airtable*` confusion by model or human | Medium | §2.4 naming decision |
| 10-record write cap discovered late | Low | Already encoded in Wave 2 |
| Fusion v3 breaks v1 | Low | v1 is not deprecated; checked in Wave 4 |

---

## 14. Cold review — 2026-07-27

One independent Opus reviewer, fresh context, scoped to this slice. Five
findings, **all verified by me before acting** and all fixed. Recorded because
two of them were real defects that unit tests were passing straight over.

**P1 — a partially-applied write reported as a total failure.** Two paths.
`deleteRecords` chunked at 10 with no partial tracking at all, so a failure on
batch two told the caller the delete failed while ten records were already
permanently gone. And `writeInBatches` decided "did anything land?" from the
returned rows rather than from batches applied, so a batch that succeeded
without echoing its rows back was also reported as a clean failure. Both
contradicted the skill's own promise to the model, which then retries and
duplicates rows. Reproduced with a fake transport before fixing; now keyed on
batches applied, and `AitablePartialWriteError` carries deleted ids.

**P2 — rotating a key forked a duplicate connection.** `replaceAitableApiKey`
updated `externalAccountId` but not `dedupeKey`, which is derived from the key
fingerprint. After any rotation, re-pasting the same new key missed the row and
created a second connection holding the same credential — breaking §1B's
"the same key twice yields one row" and putting two indistinguishable accounts
in the picker. Now moves the dedupe identity, and follows the workspace name
only when the label had not been chosen by hand.

**P2 — the manage view 404'd on a `needs_key` connection.**
`buildConnectionManagePayload` hardcoded `status: 'connected'`, so grants and
governance were unreachable for exactly the connection an admin is being told to
repair. Now accepts both statuses for AITable.

**P3 — a skill instructed an operation its own tool did not have.** The
Datasheets skill told the model to call `get_fields` before writing, but
`get_fields` existed only on `aitableFields`. Under a department grant of
`aitableDatasheets` alone, every write would burn a turn on a permission
refusal first. `get_fields` is now on both products, and a new test asserts that
every operation named in a skill's instructions exists on a tool that skill
holds — which immediately caught a second instance (`list_records` in the Fields
skill).

**P1 — the plan had drifted from the code.** Waves 2, 3, 5 and the skill had all
shipped while the tracker still said "nothing calls AITable yet". Fixed
throughout, and §9 now states the Wave 4 gate was consciously not honoured.

### Decision taken in response

The reviewer's alternative to shipping unverified writes was to strip
`create`/`update` from the company-admin floor. **Not taken**, deliberately: that
would leave writes unreachable for anyone until a department grant existed,
which defeats the point of an admin piloting the integration — and the same
unverified codec would run the moment that grant was made. The risk is not
removed by hiding it behind a grant.

What genuinely reduces it is already in place: the codec raises rather than
coerces, partial application is always reported, and `delete` is withheld from
the floor. Wave 4 remains the real answer.

## 13. Sizing

Measured against comparable slices already in this repo:

| Slice | src lines | test lines |
|---|---|---|
| Airtable (MCP) | 1,173 | 385 |
| Semrush | 440 | 360 |
| OMS | ~320 | 617 |
| **AITable (estimate)** | **~900–1,200** | **~500** |

Smaller than the Airtable slice despite covering more operations, because
`airtable-mcp-oauth.service.ts` — 370 lines of OAuth 2.1, PKCE, dynamic client
registration and refresh-token rotation, the single largest file in that
integration — has no counterpart here.

Waves 0–3 are the bulk and are safe to build without an account. Wave 4 is the
real gate.
