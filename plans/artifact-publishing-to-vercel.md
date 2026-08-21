# Publishing an artifact as a link, on every surface

> Status: **Active handover**
>
> Created: **2026-08-21**
>
> Executor: **Sonnet 5, tier B**
>
> Scope: **The artifact seam — authorship in the container, storage in the backend, delivery per surface. Adds one capability: turning a stored artifact into a hosted URL.**
>
> Parked: **The web chat renderer, the mention composer, the Lark card builder's layout, and anything under `admin/src/components/admin/` — another agent is editing those.**

## 1. Outcome

Divo can hand someone a link to a document it wrote. The document is deployed to Vercel as an unprotected standalone page, and the URL comes back to the model as a tool result.

The same capability exists on Lark and on the web, because it is one tool on one path. What differs is only how the reader meets it: the web already has a panel, so the document opens there and publishing is an extra thing you can ask for or click; Lark has no panel, so a document reaches a Lark reader as a link or not at all.

When this is finished, `divo_artifact` is no longer a web-only tool. Both surfaces author documents identically. A change to how a document is written lands once and both channels get it, which is the property this whole job exists to preserve.

## 2. Scope boundary

### Included

- A `PublishedDocumentPort` and a Vercel adapter behind it, in the backend.
- A `divo_publish` tool, available on web and direct-message Lark, that takes an artifact this member already owns and returns a URL.
- A standalone variant of the document wrapper, so a published page carries the same design as the panel.
- `divo_artifact` extended to Lark, and Lark's `artifacts` descriptor moved from `'none'` to `'link'`.
- A publish control in the web artifact panel.
- Four new columns on `Artifact`.

### Parked, do not spend time here

- **Custom domains, and anything under `divo.outreachdeal.com`.** Published pages live on `*.vercel.app`. Pointing a real domain at them touches DNS and the origin split that `project_divo_prod_origin_split` is mid-way through; it is a separate decision.
- **Unpublishing, expiry, and a published-documents list.** Real, and not this job. A published page stays up until someone deletes it in Vercel.
- **Markdown artifacts.** `text/markdown` artifacts stay panel-only. HTML is what a browser can serve as a page; a markdown file would need a renderer at publish time, which is a second wrapper and a second thing to keep in step.
- **The Vercel CLI, and per-container login.** Locked out by D3 below. If you find yourself installing anything into a container image, you have left this plan.
- **Sanitising artifact bodies.** `domain/artifact/artifact.ts` explains at length why the store does not rewrite what it holds. Publishing does not change that argument; it changes where the document runs, which is handled in D6.

## 3. Locked decisions

**D1 — Publishing is a separate tool from authorship. `divo_publish` takes an `artifactId` that already exists; it never accepts a body.** Reason: one authorship path is what makes the two channels one agent. A publish tool that also accepted content would be a second way to make a document, and the two would drift within a month.

**D2 — Lark gets `divo_artifact`.** Reason: today Lark cannot author a document at all, so the model behind Lark and the model behind the web are running different toolsets and thinking about deliverables differently. That is the divergence the user is worried about, and it already exists. Fixing it is the point of this job, not a side effect.

**D3 — Deploy from the backend over the Vercel REST API using `fetch`. No CLI, no `@vercel/sdk`.** Reasons, both independently sufficient: containers are disposable and multi-tenant, so a logged-in CLI in each one is credential sprawl plus cold-start cost for a call the backend can make in one request; and `@vercel/sdk` is published ESM-only while `advance-backend` compiles to CommonJS (`advance-backend/tsconfig.json:4`), so it would need `await import()` at every call site.

**D4 — The Vercel token lives in backend env and never reaches a container.** Reason: the container runs model-authored code. Every other credential in this system is held the same way, and `divo_publish` goes over the existing gateway like every other `divo_` tool, so nothing new is needed to keep it there.

~~**D5 — The gate is client-side, injected into the page we generate, and is described honestly as a latch rather than a lock.** Reason: the user chose this over a paid Vercel plan, knowing that anyone who reads the page source can get past it. Do not present it in UI copy or in the skill as security. The words to use are that it keeps a link from being readable by whoever it gets forwarded to.~~ **Superseded by D8, 2026-08-21.**

**D6 — A published page ships its own CSP in a `<meta http-equiv>`, and the wrapper takes a `mode` parameter rather than being forked.** Reason: the panel's security model is a sandboxed iframe with no `allow-same-origin` (`admin/src/pages/workspace/artifacts/document.ts:50`), and a published page has neither an iframe nor an opaque origin. The same body now runs on a real origin, so the network denial that the frame gave for free has to be written into the page. One function with a mode keeps the design identical between the two; two functions would not stay identical.

~~**D7 — The password is stored as a SHA-256 hash, never in plaintext, and is returned to the caller exactly once at publish time.** Reason: the backend has no reason to be able to read it back, and a plaintext column is a plaintext column.~~ **Superseded by D8, 2026-08-21.** The gate module and wrapper branch remain for a future decision; the active publish path passes no gate hash.

**D8 — Published links are unprotected for now. The publish path mints no password and passes no `gateHash`.** Reason: getting a working link on both surfaces is the thing being proven, and the gate was blocking that. Accepted consequence: anyone who receives the URL can read the document, and Lark links get forwarded. Revisit before this reaches a customer.

**D9 — Lark gets `divo_artifact` and `divo_publish` in direct messages only, and `artifacts: 'link'` resolves per audience.** Reason: group-chat ownership is unsettled and `get` is keyed `[companyId, userId, artifactId]`, so a second member in the room cannot act on the document. Deferring costs nothing on Lark, where the descriptor is `'link'` and the room reads the published page rather than the panel. The descriptor takes the audience alongside the channel, so a shared turn is told it can return neither a document nor a link while the tools are absent.

## 4. Open questions

~~**Q1 — Whose artifact is a document authored in a shared Lark group chat?**~~ **Resolved 2026-08-21 as D9.** Shared Lark group turns do not receive `divo_artifact` or `divo_publish`; private Lark messages use the sender-owned artifact key and receive link delivery. The shared descriptor remains `artifacts: 'none'`.

~~**Q2 — Does the `divo@emiactech.com` Vercel account exist yet, and is it a personal account or a team?**~~ **Resolved 2026-08-21.** The account exists and is personal, not a team. `advance-backend/.env` has `VERCEL_TOKEN` set, `VERCEL_PROJECT_NAME=divo-artifacts`, and an empty `VERCEL_TEAM_ID`; the adapter trims the value and omits the `teamId` query parameter entirely when it is empty.

## 5. Current state

Everything below was read on **2026-08-21**.

**Authorship.** `divo_artifact` files a document the model wrote under `artifacts/`. It is available on web and direct-message Lark, and withheld from shared/unknown runs by the container manifest at `divo-pi/divo/runtime.mjs:146-147`:

```js
const CHANNEL_ONLY_MODULES = { "divo-artifact": ["web", "lark"] };
const CHANNEL_ONLY_TOOLS = { divo_artifact: ["web", "lark"], divo_publish: ["web", "lark"] };
```

`scopedManifest(isRunScoped, channel)` at `divo-pi/divo/runtime.mjs:171` filters three lists with this — the extension that registers the tool, the skill that teaches it, and the allowlist that admits it. The skill is `divo-pi/divo/skills/divo-artifact/SKILL.md`; its design spec is `DESIGN.md` beside it.

**The model is told the same thing in words.** `advance-backend/src/domain/channel/surface-capabilities.ts:32` declares `artifacts: 'none' | 'link' | 'inline'` and now carries an audience alongside the channel. Private Lark is `'link'`, shared Lark is `'none'`, and web is `'inline'`. This is the seam this whole job hangs on, and it was built for exactly this.

**Storage.** `POST /api/artifacts` and `GET /api/artifacts/:artifactId` in `advance-backend/src/http/member/artifacts.routes.ts`, behind `ArtifactRepoPort` (`advance-backend/src/infrastructure/persistence/artifact.repository.ts:28`) with `save`, `get`, `list`. The Prisma model is `schema.prisma:3138`, unique on `[companyId, userId, artifactId]`, body capped at 400,000 chars (`domain/artifact/artifact.ts`).

**What is stored is body markup only** — no doctype, no head, no palette. The skill tells the model this explicitly. The wrapper is added at read time by `buildDocument(body, theme)` at `admin/src/pages/workspace/artifacts/document.ts:432`, which supplies the CSP, both palettes, and the chart runtime from `admin/src/lib/chart-geometry.ts`. It has exactly one caller: `admin/src/pages/workspace/artifacts/formats.tsx:15`.

**Both palettes ship in every document.** Verified by reading `document.test.ts:155-156`, which asserts each hue appears in both the light and the dark build. The `theme` argument only sets a `data-theme` attribute (`document.test.ts:99`). This matters: a published page can carry both palettes and switch without a round trip.

**There is no shared package between `admin/` and `advance-backend/`.** No `pnpm-workspace.yaml`, no `workspace:` dependency in either `package.json`. Checked 2026-08-21. So a wrapper the backend can use has to live in the backend.

**Tool shape.** `advance-backend/src/application/tools/families/web-search.tool.ts` is the smallest complete example: 45 lines, `argsSchema`/`resultSchema`/`permissionCheck`/`execute`, registered at `advance-backend/src/composition.ts:2114`. Capabilities are declared in `TOOL_CAPABILITY_DEFINITIONS` at `advance-backend/src/domain/tools/tool-id.ts:130`.

**The Vercel API.** `POST /v13/deployments`, bearer token, optional `teamId` or `slug` query parameter. Small files may be inlined in the request body as `files: [{ file, data }]` rather than uploaded by SHA first. `projectSettings` is required on a project's first deployment and is remembered after. Omitting `target` produces a preview deployment; `"production"` assigns the project's aliases. Read from the reference on 2026-08-20's revision, at `https://vercel.com/docs/rest-api/deployments/create-a-new-deployment`. **Re-read it before you write the adapter** — this is the one external contract in the plan and it is the one thing here that can change without anybody telling us.

## 6. The shape

The wrapper, port, Vercel adapter, and shared publish application service are the
backend modules; the route and panel are callers of that one publish seam. Only the
adapter knows about Vercel.

**`domain/artifact/document.ts` (new)** — the wrapper, moved into the backend so both a panel and a page can be built from one place. Pure: markup in, markup out, no I/O.

```ts
export type DocumentTheme = 'light' | 'dark';
/** Where the finished page will run. Not a style — a security posture. */
export type DocumentMode = 'panel' | 'standalone';

export interface StandaloneOptions {
  /** Shown in the tab and above the document. */
  readonly title: string;
  /** SHA-256 hex of the optional gate password. Absent means no gate. */
  readonly gateHash?: string;
}

export function buildDocument(
  body: string,
  theme?: DocumentTheme,
  mode?: DocumentMode,
  standalone?: StandaloneOptions,
): string;
```

`'panel'` must return byte-for-byte what the admin copy returns today. That is Phase 1's gate. `'standalone'` adds the doctype-level things a top-level page needs: a `<title>`, the CSP as a `<meta http-equiv>`, and the gate.

**`application/publishing/published-document.port.ts` (new)** — the interface the tool talks to. Names a document and a page, never a vendor.

```ts
export interface PublishRequest {
  readonly slug: string;      // url-safe, derived from the artifact
  readonly title: string;
  readonly html: string;      // already wrapped and gated
}

export interface PublishedDocument {
  readonly url: string;           // https, no scheme-less forms
  readonly deploymentId: string;
}

export interface PublishedDocumentPort {
  publish(request: PublishRequest): Promise<Result<PublishedDocument, InfraError>>;
}
```

**`application/publishing/artifact-publishing.service.ts` (new)** — the ownership-scoped publish operation shared by `divo_publish` and the member panel route.

**`infrastructure/publishing/vercel-publisher.ts` (new)** — the only file in the repo that knows the string `vercel`. One `fetch` to `POST /v13/deployments`, the token from env, `files: [{ file: 'index.html', data: html }]`. It maps a non-2xx into `InfraError` with the upstream reason preserved — read `advance-backend/src/application/runtime/runtime-failure.ts` before you write the error path, because it is the house rule for this and the rule is that a failure reports its *cause*, not its shape.

**Where publishing is decided.** Nowhere, is the answer, and that is deliberate. `divo_publish` is on both channels with no gating. The web's `artifacts: 'inline'` and Lark's new `artifacts: 'link'` already tell the model everything it needs: on Lark a document only arrives as a URL, so it publishes; on the web the panel is there, so it publishes when asked. No branch anywhere reads the channel to decide whether to publish. If you find yourself writing `if (channel === 'lark')`, stop — the descriptor is the mechanism.

## 7. Phases

### Phase 1 — Move the wrapper into the backend ✅ *2026-08-21*

**Goal.** The backend can turn a stored body into a complete page, producing exactly what the panel produces today.

**Files.**

- `advance-backend/src/domain/artifact/document.ts` (new) — the wrapper, ported
- `advance-backend/src/domain/artifact/chart-geometry.ts` (new) — ported from `admin/src/lib/chart-geometry.ts`
- `advance-backend/tests/domain/artifact-document.test.ts` (new) — the admin suite, ported
- `advance-backend/tests/domain/artifact-document-parity.test.ts` (new) — the anti-drift gate

**Steps.**

- [x] Copy `admin/src/pages/workspace/artifacts/document.ts` and `admin/src/lib/chart-geometry.ts` into the backend, changing only the import path between them
- [x] Port `admin/src/pages/workspace/artifacts/document.test.ts` alongside it
- [x] Add `mode` and `standalone` to the signature per section 6, with `'panel'` as the default and the standalone branch left as `throw new Error('not implemented')` for now
- [x] Write the parity test: read the admin source files, and assert the backend's `buildDocument(body, theme)` output is identical to the admin one's for the bodies in the existing test fixtures, in both themes

**Do not.** Do not touch `admin/src/pages/workspace/artifacts/formats.tsx` or delete the admin copy. Two copies exist on purpose until Phase 6, and the parity test is what makes that safe. Do not "improve" the wrapper while porting it — a single changed byte fails the gate and you will not know whether it was the port or the improvement.

**Gate.** `cd advance-backend && node --import tsx --test 'tests/domain/artifact-*.test.ts'` passes, including a parity test that fails if you change one character of either copy. Prove it fails: add a space to the backend copy, run it, see red, take the space out.

### Phase 2 — Publish a page to Vercel ✅ *2026-08-21*

**Goal.** A hard-coded string of HTML becomes a live URL.

**Files.**

- `advance-backend/src/application/publishing/published-document.port.ts` (new)
- `advance-backend/src/infrastructure/publishing/vercel-publisher.ts` (new)
- `advance-backend/src/config/env.ts` — add `VERCEL_TOKEN`, `VERCEL_PROJECT_NAME`, `VERCEL_TEAM_ID`
- `advance-backend/tests/infrastructure/vercel-publisher.test.ts` (new)

**Steps.**

- [x] Re-read the Vercel reference linked in section 5 and confirm the request shape has not moved
- [x] Add the three env vars as `z.string().optional()`, following `SERPER_API_KEY` at `env.ts:175`
- [x] Write the port, then the adapter: one `fetch`, `files: [{ file: 'index.html', data: html }]`, `projectSettings: { framework: null }`, `target: 'production'`
- [x] Map failures through the cause-not-shape rule: a missing token is `not_configured` and names the env var, a 4xx from Vercel carries Vercel's own message, a 5xx is retryable
- [x] Unit-test the adapter against a stubbed `fetch` — request shape, and each failure mapping

**Do not.** Do not add a retry loop. The gateway already has one, and a deploy that half-succeeded twice is worse than one that failed once. Do not log the token, and do not put it in an error message; `not_configured` names the *variable*, never the value.

**Gate.** With a real token in `.env`, a one-off script publishes `<h1>hello</h1>` and prints a URL that returns 200 with that markup in the body. Paste the URL and the status line into the build log. If Q2 is unanswered, this gate is where you stop and ask.

### Phase 3 — The standalone wrapper and its gate ✅ *2026-08-21*

**Goal.** A stored artifact becomes a complete, gated page.

**Files.**

- `advance-backend/src/domain/artifact/document.ts` — implement the `'standalone'` branch
- `advance-backend/src/domain/artifact/gate.ts` (new) — password generation and hashing
- `advance-backend/tests/domain/artifact-gate.test.ts` (new)

**Steps.**

- [x] `gate.ts`: generate a password from an unambiguous alphabet (no `0`/`O`, no `1`/`l`), and hash with `crypto.createHash('sha256')`. Export `newPassword()`, `hashOf(password)`
- [x] Implement `'standalone'`: `<!doctype html>`, `<title>`, the CSP from `document.ts` as a `<meta http-equiv="Content-Security-Policy">`, both palettes, the chart runtime
- [x] Add the gate: the body ships base64-encoded, and a small script decodes and injects it only after `crypto.subtle.digest` of what was typed matches `gateHash`
- [x] Test: a gated page's HTML does not contain the body as readable text; an ungated one does; the palettes and chart runtime are present in both modes

**Do not.** Do not delete the gate module or the absent-hash branch while D8 stands. The gate is a retained, tested option for a future decision; the active publish path is unprotected. Do not add a server-side check to "make it real"; that is a different plan and it needs a runtime, which a static deployment does not have.

**Gate.** Publish a real stored artifact end to end with a throwaway script. Open the URL in a browser: the document loads directly with charts drawn and the theme intact. The gate-specific browser proof remains in the build log as a retained option, not as the active publish contract.

### Phase 4 — The tool, on both channels ✅ *2026-08-21*

**Goal.** The model can publish, on Lark and on the web, and Lark can author documents at all.

**Files.**

- `advance-backend/prisma/schema.prisma` — four columns on `Artifact`
- `advance-backend/src/domain/tools/tool-id.ts` — the capability
- `advance-backend/src/application/tools/families/artifact-publishing.tool.ts` (new)
- `advance-backend/src/composition.ts` — wire and register
- `advance-backend/src/domain/channel/surface-capabilities.ts:63` — Lark to `'link'`
- `divo-pi/divo/runtime.mjs:146-147` — add `"lark"` to both tables
- `divo-pi/divo/skills/divo-artifact/SKILL.md` — the surface sentence, and how to publish

**Steps.**

- [x] Add `publishedUrl String?`, `publishedAt DateTime?`, `publishGateHash String?`, `publishDeploymentId String?` to `model Artifact`, then `pnpm prisma db push` — **this project has no `_prisma_migrations` table; never run `prisma migrate`**
- [x] Add `artifactPublish: defineCapability('context', ['create'])` to `TOOL_CAPABILITY_DEFINITIONS`
- [x] Write the tool on the `web-search.tool.ts` shape: args `{ artifactId }`, result `{ url }`. It loads the artifact through `ArtifactRepoPort.get` scoped to the caller, refuses a `text/markdown` artifact with a plain reason, wraps without a gate hash, publishes, persists the four columns
- [x] Register it in `composition.ts` beside the other tool registrations
- [x] Flip Lark's private descriptor to `artifacts: 'link'`, resolve shared Lark to `artifacts: 'none'` from the audience, and update the descriptor comment
- [x] Add `"lark"` to both `CHANNEL_ONLY_MODULES` and `CHANNEL_ONLY_TOOLS`, with direct-message-only filtering for both artifact tools; update `scopedManifest`'s tests in `divo-pi/divo/test/runtime.test.mjs`
- [x] Rewrite the skill's "This skill exists on the web surface only" line, and add a short section: on a surface whose descriptor says `link`, publish and speak the URL; state that the link is currently unprotected; on `inline`, the panel is enough unless asked

**Do not.** Do not branch on channel anywhere in the tool or in the runtime beyond the two manifest tables. Do not build a second artifact-fetch path — `ArtifactRepoPort.get` exists and is already ownership-scoped. Do not let the tool accept a body, a title, or HTML; if a caller wants to change the document they call `divo_artifact` again, which already versions in place.

**Gate.** Two runs, both recorded in the build log. On the web, ask Divo to write a short report and publish it: the panel fills and the reply carries a working URL. On Lark, ask the same thing in a direct message: the card carries a working URL, and no panel is implied anywhere in the wording. Then confirm the negative: `divo-pi` tests still pass, and a shared/unknown run still has no artifact tools.

### Phase 5 — The publish control in the panel

**Goal.** Someone reading a document in the panel can publish it without asking.

**Files.**

- `advance-backend/src/http/member/artifacts.routes.ts` — `POST /:artifactId/publish`
- `advance-backend/src/application/publishing/artifact-publishing.service.ts` — shared publish seam
- `admin/src/pages/workspace/artifacts/publish.ts` (new) — the pure part
- `admin/src/pages/workspace/artifacts/panel.tsx` — the control

**Steps.**

- [x] Add the route, calling the same application service the tool calls. **Both callers share one path**; the route is a second door, not a second implementation
- [x] `publish.ts`: the states this control moves through (idle, publishing, published, failed) and what each shows, as a plain function with a colocated test
- [x] Add the control to `ArtifactPanel`'s header, next to the existing copy and source controls. Published state shows only the URL with a copy button; it must not mention a password while D8 stands
- [x] Read `AGENTS.md:140` first — colours come from the token files, never a one-off

**Do not.** Do not build a modal, a settings drawer, or a password field. D8 publishes an unprotected URL; the control has one action. Do not touch `ArtifactWorkspace` or `Surface` — `panel.tsx`'s header comment sets out the three layers and this belongs to exactly one of them.

**Gate.** Click it in a browser against a real backend. A URL appears, the URL opens directly, and the artifact row in Postgres has the URL, timestamp, null gate hash, and deployment id filled. Confirm the panel still renders an unpublished document exactly as before.

### Phase 6 — Retire the duplicate wrapper

**Goal.** One wrapper in the repo, not two.

**Files.**

- `advance-backend/src/http/member/artifacts.routes.ts` — `GET /:artifactId/document`
- `admin/src/pages/workspace/artifacts/formats.tsx` — fetch instead of build
- `admin/src/pages/workspace/artifacts/document.ts`, `admin/src/lib/chart-geometry.ts` — delete
- `advance-backend/tests/domain/artifact-document-parity.test.ts` — delete

**Steps.**

- [ ] Add the route returning `mode: 'panel'` output for an artifact the caller owns
- [ ] Change `HtmlDocument` to fetch it once per artifact version and hold it, keeping `DOCUMENT_SANDBOX` on the frame
- [ ] Handle theme without a refetch: both palettes are already in the document, so flip `data-theme` on the frame's root element
- [ ] Delete the admin copies, the parity test, and `DOCUMENT_SANDBOX`'s import path if it moved
- [ ] Run the full admin suite and confirm nothing else imported them

**Do not.** Do not start this phase before Phase 5 has landed and been used. It is the cleanup that makes the design honest, and it is also the only phase that can break the working web panel, so it goes last and alone. Do not refetch on theme change.

**Gate.** The string `buildDocument` appears in exactly one source file in the repo. `grep -rn "buildDocument" admin/src advance-backend/src` returns only the backend module and its callers. The panel renders a document, switches theme without a network request, and the full admin suite passes.

## 8. Primary files

**The wrapper**
- `admin/src/pages/workspace/artifacts/document.ts:432` — `buildDocument`, today's only copy
- `admin/src/lib/chart-geometry.ts` — `CHART_GEOMETRY_SOURCE`
- `admin/src/pages/workspace/artifacts/formats.tsx:15` — its only caller
- `advance-backend/src/domain/artifact/document.ts` (new) — where it goes

**The artifact**
- `advance-backend/src/domain/artifact/artifact.ts` — the type, the limits, and why nothing is sanitised
- `advance-backend/src/infrastructure/persistence/artifact.repository.ts:28` — `ArtifactRepoPort`
- `advance-backend/src/http/member/artifacts.routes.ts` — save and read
- `advance-backend/prisma/schema.prisma:3138` — `model Artifact`

**The channel seam**
- `advance-backend/src/domain/channel/surface-capabilities.ts:32` — the descriptor, `'link'` already present and unused
- `divo-pi/divo/runtime.mjs:146` — `CHANNEL_ONLY_MODULES` and `CHANNEL_ONLY_TOOLS`
- `divo-pi/divo/runtime.mjs:171` — `scopedManifest`
- `divo-pi/divo/skills/divo-artifact/SKILL.md` and `DESIGN.md`

**The tool**
- `advance-backend/src/application/tools/families/web-search.tool.ts` — the shape to copy
- `advance-backend/src/domain/tools/tool-id.ts:130` — `TOOL_CAPABILITY_DEFINITIONS`
- `advance-backend/src/composition.ts:2114` — where registration goes
- `advance-backend/src/application/runtime/runtime-failure.ts` — the error-reporting rule

**Publishing** — all new, under `advance-backend/src/application/publishing/` and `advance-backend/src/infrastructure/publishing/`.

## 9. Verification commands

```bash
# The wrapper is one thing in two places and they have not drifted. Phase 1's gate.
cd advance-backend && node --import tsx --test 'tests/domain/artifact-*.test.ts'
```

```bash
# The container still withholds what it should. Run after any runtime.mjs edit.
cd divo-pi && npm run divo:test
```

```bash
# The admin suite. 442 passing, 0 failing as of 2026-08-21.
cd admin && npm run test:unit
```

```bash
# Proves only that a page was created and is reachable — not that the gate
# works, and not that charts drew. Those need a browser; see Phase 3's gate.
curl -s -o /dev/null -w '%{http_code}\n' "<the published url>"
```

A note on what none of these prove: every gate that matters in this plan is a real run on a real surface. The tests catch drift and regressions, and there is no unit test that can tell you a Lark card read well.

## 10. How to work this plan

You are building this plan. Read it end to end before you touch code, then work
from `## Next action`.

**Before each phase**

1. Open the files the phase names and the tests around them. The plan's
   `Current state` was true on the date next to it, not necessarily today. Where
   it disagrees with the code, the code wins, and you fix the plan.
2. Re-read `Locked decisions`. Those are settled. If one of them turns out to be
   wrong, that is a finding: stop, say so, and do not quietly design around it.
3. Check `Parked`. Do not open those areas, even to fix something obvious there.

**While building**

4. Say which responsibility you are moving or which behaviour you are changing
   before you change it.
5. Preserve unrelated and concurrent work. Other agents may be editing this repo.
   Commit with an explicit pathspec rather than staging everything.
6. Run the narrow tests for what you touched, then the broader gate for the seam
   you crossed.

**Closing a phase**

7. A phase is complete when its **Gate** passed, not when the code compiles and
   not when the diff looks right. Run the gate. Record what it returned.
8. Tick every checkbox in the phase. Tick them when the step is done and proven,
   not when it is written.
9. Mark the phase heading complete with the date: `### Phase N — goal ✅ *YYYY-MM-DD*`.
10. Append to `## Build log`: what you built, where it differed from the plan and
    why, what you found that nobody knew about, and the gate result. The
    deviations and the surprises are the most valuable thing in this file. A log
    entry that only says "done as planned" is worth writing only when that is
    literally true.
11. Rewrite `## Next action`.
12. **Commit the plan update in the same commit as the code.** Not afterwards. A
    plan updated later is a plan updated never.

**When you are blocked**

13. Follow the escalation rule for your tier, stated in the header. In short:
    high tier decides and records the decision with its reason; mid and low tier
    stop and ask one clear question. Either way it goes in the build log.
14. Never delete a phase because it turned out to be wrong. Strike it through and
    write why. Someone will otherwise propose it again.

**What not to do**

15. Do not report a phase complete because tests pass that do not exercise the
    change. Say plainly which parts are unverified.
16. Do not widen the scope. If you find real work outside `Included`, write it at
    the bottom of the build log under `Found, out of scope` and leave it.
17. Do not rewrite this section.

## 11. Build log

### 2026-08-21 — Phase 1

- Ported the wrapper and chart geometry into `advance-backend/src/domain/artifact/`, using the required local chart import. Ported the admin wrapper tests and added source-plus-rendered-output parity coverage. The backend signature now has the planned `mode`/`standalone` parameters with the standalone branch intentionally unimplemented.
- The implementation stayed byte-for-byte for the existing panel path; only the required import and signature/placeholder additions differ. No parked files were opened or changed.
- Gate: `node --import tsx --test 'tests/domain/artifact-*.test.ts'` passed with 24 tests. The required one-space mutation made the parity gate fail (exit 1), then restoring it returned the gate to 24 passing tests (exit 0).

### 2026-08-21 — Phase 2

- Added `PublishedDocumentPort`, `VercelPublisher`, and the three optional `VERCEL_*` env fields. The adapter sends one `POST /v13/deployments` with an inline `index.html`, `projectSettings: { framework: null }`, `target: 'production'`, the artifact slug as `name`, and the configured project as `project`; `teamId` is present only when configured. The response is normalized to an HTTPS URL and deployment id.
- Re-read the specified [Vercel REST deployment reference](https://vercel.com/docs/rest-api/reference/endpoints/deployments/create-a-new-deployment) on 2026-08-21. The request shape matches: `files: [{ file, data }]`, `projectSettings: { framework: null }`, and `target: 'production'`; the empty personal-account `teamId` is omitted. A temporary `public` field was rejected by Vercel as an additional property and was removed, leaving the documented body unchanged.
- The first deployment used `projectSettings` and did not return a `missing_project_settings` error. Vercel returned `target: production`, `readyState: READY`, `readySubstate: PROMOTED`, `public: false`, and the generated deployment URL. The dedicated project had Vercel Authentication enabled, so that URL initially returned 302 to SSO; the project was updated through the documented project API with `ssoProtection: null`, after which the same deployment URL was publicly reachable.
- Gate: URL `https://divo-artifacts-mrjdmhoak-divo-2600s-projects.vercel.app/`; `CURL_STATUS=200`; `<h1>hello</h1>` was present. Focused adapter gate `node --import tsx --test 'tests/infrastructure/vercel-publisher.test.ts'` passed with 9 tests, including the explicit empty-team query case. `pnpm typecheck` remains red only at the byte-identical Phase 1 chart copy's unchecked indexed accesses (`chart-geometry.ts:118-119,144`) under backend strictness; changing that port would violate the Phase 1 byte gate.

### 2026-08-21 — Phase 3

- Added `gate.ts` with a 12-character unambiguous password alphabet and SHA-256 hashing. Standalone output carries a title, both palettes, the CSP, and the chart runtime. Gated output stores only base64 body data and a hash in the page source. The browser decodes and injects the body after a matching `crypto.subtle.digest` result, then starts the chart runtime.
- Unit gate: `node --import tsx --test 'tests/domain/artifact-*.test.ts'` passed with 29 tests. The parity test still passes because it strips only the marked standalone additions and the mode branch, not the panel copy.
- Browser gate: published a real dark-themed chart artifact at `https://divo-artifacts-1ubtsdsxh-divo-2600s-projects.vercel.app/`. The page asked for a password, refused a wrong password, and revealed the report with one rendered chart SVG after the correct password. The title and dark theme remained intact. View-source still exposes the base64 body and script, as D5 requires.
- The gated publish shipped and was genuinely browser-proven above; D8 now switches that behavior off in the publisher while retaining `gate.ts`, the gate branch, and its tests for a future decision. The switching commit is `34f0a4047` (`Supersede artifact link gate with unprotected publishing`).

### 2026-08-21 — Phase 4 in progress; Q1 resolved; D8 unprotected publish

- Added the four publication columns, kept `publishGateHash` inside the repository write path, and cleared all publication state when an artifact is revised. `prisma db push` synced Development `divo_dev` successfully and regenerated Prisma Client. No migration command was run.
- Added the `artifactPublish` capability, human label, channel-neutral tool, Vercel wiring, and focused tests. The tool accepts only an owned `artifactId`, refuses Markdown, wraps HTML without a gate hash under D8, publishes, persists the four publication values with a null gate hash, and returns only the URL. It contains no channel branch.
- Focused gates: `node --import tsx --test 'tests/tools/artifact-publishing.tool.test.ts'` passed with 5 tests; `node --import tsx --test 'tests/domain/artifact-*.test.ts'` passed with 29 tests. `pnpm typecheck` reports only the known Phase 1 chart indexed-access errors.
- D9 resolves Q1. The surface descriptor now carries `audience`: private Lark is `artifacts: 'link'`, shared Lark is `artifacts: 'none'`; the signed lease audience flows through `/runtime-context`. `divo_artifact` and `divo_publish` are admitted only to web and direct Lark runs; shared Lark is withheld by the direct-message manifest lists. The artifact extension reads the descriptor instead of branching on channel and does not imply a panel in link-mode wording. The skill now explains link delivery and its current unprotected consequence.
- Added the canonical `divo_publish` Pi name, regenerated the native catalogue, and added the manifest allowlist entry. Focused backend and Pi tests pass, including direct-Lark filing, shared-audience descriptor resolution, generated catalogue parity, and the negative unknown/shared-surface manifest cases. The real two-surface run gate remains open.
- Typecheck remains red only at the known Phase 1 byte-port chart indexed accesses (`chart-geometry.ts:118-119,144`); no Phase 4 type errors were introduced.
- Classified `artifactPublish` as an ownership-scoped company-inherited capability and bumped the existing permission-policy epoch so live Redis snapshots cannot retain the pre-capability decision. The permission service and department-template tests pass.
- The first direct-Lark Cloud-Pi run reached `write` and `divo_artifact` successfully, then exposed the stale permission snapshot. D8 now removes that blocked password mint; the next run must confirm a working unprotected URL in the Lark card. No group-chat run is authorized by D9.
- The first unprotected live runs eventually succeeded but showed the model guessing the artifact id after `divo_artifact`. The extension now includes the ownership-scoped `artifactId` in its result text as well as structured details, so `divo_publish` has an exact value to use instead of retrying guessed ids. The result-text fix is `7b757ea99`.

### 2026-08-21 — Phase 4 gate and Phase 5 backend seam

- Phase 4 direct-Lark gate: the clean run used `write → divo_artifact → divo_publish` in five steps and delivered URL-only final text to the configured DM. URL `https://divo-artifacts-b46e9jfxx-divo-2600s-projects.vercel.app/` returned `CURL_STATUS=200`; the body contained the report heading and no gate markers. The shared/unknown negative remains covered by the runtime manifest tests; no group run was fired because D9 keeps Q1 direct-message-only.
- Phase 4 web gate: the clean `/api/web-chat/runs` run completed `WEB_CLEAN_STATUS=200` with `write → divo_artifact → divo_publish`. URL `https://divo-artifacts-puwy2fat3-divo-2600s-projects.vercel.app/` returned `CURL_STATUS=200`; the body contained the report heading and no gate markers. The controller returned to `activeRuns: 0` after both runs.
- Phase 5 backend/UI implementation: added `ArtifactPublishingService` as the shared seam, `POST /api/artifacts/:artifactId/publish` with ownership and RBAC checks, URL-only admin data/state, and a panel header control with open/copy link actions. The live member route returned `PUBLISH_ROUTE_STATUS=200` and URL `https://divo-artifacts-hqy5xiro9-divo-2600s-projects.vercel.app/`; no password field or response value exists under D8.
- Focused verification: backend publish/tool/permission/catalogue tests passed; admin publish-state and artifact-store tests passed; admin `tsc --noEmit` passed. Backend typecheck remains red only at the known Phase 1 chart indexed accesses (`chart-geometry.ts:118-119,144`). The panel browser click gate is the remaining Phase 5 proof.

## 12. Next action

Complete the Phase 5 browser gate against the signed-in admin panel: click Publish on an unpublished artifact, confirm URL-only published state and direct readability, then verify the Postgres publication row before moving to Phase 6.
