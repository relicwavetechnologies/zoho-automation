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

Divo can hand someone a link to a document it wrote. The document is deployed to Vercel as a standalone page, gated behind a short password Divo speaks in the conversation, and the URL comes back to the model as a tool result.

The same capability exists on Lark and on the web, because it is one tool on one path. What differs is only how the reader meets it: the web already has a panel, so the document opens there and publishing is an extra thing you can ask for or click; Lark has no panel, so a document reaches a Lark reader as a link or not at all.

When this is finished, `divo_artifact` is no longer a web-only tool. Both surfaces author documents identically. A change to how a document is written lands once and both channels get it, which is the property this whole job exists to preserve.

## 2. Scope boundary

### Included

- A `PublishedDocumentPort` and a Vercel adapter behind it, in the backend.
- A `divo_publish` tool, available on every channel, that takes an artifact this member already owns and returns a URL plus a password.
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

**D5 — The gate is client-side, injected into the page we generate, and is described honestly as a latch rather than a lock.** Reason: the user chose this over a paid Vercel plan, knowing that anyone who reads the page source can get past it. Do not present it in UI copy or in the skill as security. The words to use are that it keeps a link from being readable by whoever it gets forwarded to.

**D6 — A published page ships its own CSP in a `<meta http-equiv>`, and the wrapper takes a `mode` parameter rather than being forked.** Reason: the panel's security model is a sandboxed iframe with no `allow-same-origin` (`admin/src/pages/workspace/artifacts/document.ts:50`), and a published page has neither an iframe nor an opaque origin. The same body now runs on a real origin, so the network denial that the frame gave for free has to be written into the page. One function with a mode keeps the design identical between the two; two functions would not stay identical.

**D7 — The password is stored as a SHA-256 hash, never in plaintext, and is returned to the caller exactly once at publish time.** Reason: the backend has no reason to be able to read it back, and a plaintext column is a plaintext column.

## 4. Open questions

**Q1 — Whose artifact is a document authored in a shared Lark group chat?** Answer needed from: Abhishek. Blocks: the second half of Phase 4 only. `divo-pi/divo/runtime.mjs:123` shows shared Lark turns are run-scoped and lose the recall tools; artifacts are keyed `[companyId, userId, artifactId]` (`advance-backend/prisma/schema.prisma:3154`), so a group-chat artifact would be filed against whoever sent the message. That is probably right, but it means a document made in a group chat appears in the asker's private web panel. Land Phase 4 for direct messages first and ask before widening it.

**Q2 — Does the `divo@emiactech.com` Vercel account exist yet, and is it a personal account or a team?** Answer needed from: Abhishek. Blocks: Phase 2's gate, which needs a real token. The API takes an optional `teamId` query parameter, and whether it is required changes one line in the adapter.

## 5. Current state

Everything below was read on **2026-08-21**.

**Authorship.** `divo_artifact` badges a file the model wrote under `artifacts/`. It is web-only, enforced in the container at `divo-pi/divo/runtime.mjs:146-147`:

```js
const CHANNEL_ONLY_MODULES = { "divo-artifact": ["web"] };
const CHANNEL_ONLY_TOOLS = { divo_artifact: ["web"] };
```

`scopedManifest(isRunScoped, channel)` at `divo-pi/divo/runtime.mjs:171` filters three lists with this — the extension that registers the tool, the skill that teaches it, and the allowlist that admits it. The skill is `divo-pi/divo/skills/divo-artifact/SKILL.md`; its design spec is `DESIGN.md` beside it.

**The model is told the same thing in words.** `advance-backend/src/domain/channel/surface-capabilities.ts:32` already declares `artifacts: 'none' | 'link' | 'inline'`. Lark is `'none'` (line 63), web is `'inline'`. **`'link'` is already in the type and is not used by any surface.** This is the seam this whole job hangs on, and it was built for exactly this.

**Storage.** `POST /api/artifacts` and `GET /api/artifacts/:artifactId` in `advance-backend/src/http/member/artifacts.routes.ts`, behind `ArtifactRepoPort` (`advance-backend/src/infrastructure/persistence/artifact.repository.ts:28`) with `save`, `get`, `list`. The Prisma model is `schema.prisma:3138`, unique on `[companyId, userId, artifactId]`, body capped at 400,000 chars (`domain/artifact/artifact.ts`).

**What is stored is body markup only** — no doctype, no head, no palette. The skill tells the model this explicitly. The wrapper is added at read time by `buildDocument(body, theme)` at `admin/src/pages/workspace/artifacts/document.ts:432`, which supplies the CSP, both palettes, and the chart runtime from `admin/src/lib/chart-geometry.ts`. It has exactly one caller: `admin/src/pages/workspace/artifacts/formats.tsx:15`.

**Both palettes ship in every document.** Verified by reading `document.test.ts:155-156`, which asserts each hue appears in both the light and the dark build. The `theme` argument only sets a `data-theme` attribute (`document.test.ts:99`). This matters: a published page can carry both palettes and switch without a round trip.

**There is no shared package between `admin/` and `advance-backend/`.** No `pnpm-workspace.yaml`, no `workspace:` dependency in either `package.json`. Checked 2026-08-21. So a wrapper the backend can use has to live in the backend.

**Tool shape.** `advance-backend/src/application/tools/families/web-search.tool.ts` is the smallest complete example: 45 lines, `argsSchema`/`resultSchema`/`permissionCheck`/`execute`, registered at `advance-backend/src/composition.ts:2114`. Capabilities are declared in `TOOL_CAPABILITY_DEFINITIONS` at `advance-backend/src/domain/tools/tool-id.ts:130`.

**The Vercel API.** `POST /v13/deployments`, bearer token, optional `teamId` or `slug` query parameter. Small files may be inlined in the request body as `files: [{ file, data }]` rather than uploaded by SHA first. `projectSettings` is required on a project's first deployment and is remembered after. Omitting `target` produces a preview deployment; `"production"` assigns the project's aliases. Read from the reference on 2026-08-20's revision, at `https://vercel.com/docs/rest-api/deployments/create-a-new-deployment`. **Re-read it before you write the adapter** — this is the one external contract in the plan and it is the one thing here that can change without anybody telling us.

## 6. The shape

Three modules, and the point of the split is that only the middle one knows about Vercel.

**`domain/artifact/document.ts` (new)** — the wrapper, moved into the backend so both a panel and a page can be built from one place. Pure: markup in, markup out, no I/O.

```ts
export type DocumentTheme = 'light' | 'dark';
/** Where the finished page will run. Not a style — a security posture. */
export type DocumentMode = 'panel' | 'standalone';

export interface StandaloneOptions {
  /** Shown in the tab and above the document. */
  readonly title: string;
  /** SHA-256 hex of the gate password. Absent means no gate. */
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

### Phase 2 — Publish a page to Vercel

**Goal.** A hard-coded string of HTML becomes a live URL.

**Files.**

- `advance-backend/src/application/publishing/published-document.port.ts` (new)
- `advance-backend/src/infrastructure/publishing/vercel-publisher.ts` (new)
- `advance-backend/src/config/env.ts` — add `VERCEL_TOKEN`, `VERCEL_PROJECT_NAME`, `VERCEL_TEAM_ID`
- `advance-backend/tests/infrastructure/vercel-publisher.test.ts` (new)

**Steps.**

- [ ] Re-read the Vercel reference linked in section 5 and confirm the request shape has not moved
- [ ] Add the three env vars as `z.string().optional()`, following `SERPER_API_KEY` at `env.ts:175`
- [ ] Write the port, then the adapter: one `fetch`, `files: [{ file: 'index.html', data: html }]`, `projectSettings: { framework: null }`, `target: 'production'`
- [ ] Map failures through the cause-not-shape rule: a missing token is `not_configured` and names the env var, a 4xx from Vercel carries Vercel's own message, a 5xx is retryable
- [ ] Unit-test the adapter against a stubbed `fetch` — request shape, and each failure mapping

**Do not.** Do not add a retry loop. The gateway already has one, and a deploy that half-succeeded twice is worse than one that failed once. Do not log the token, and do not put it in an error message; `not_configured` names the *variable*, never the value.

**Gate.** With a real token in `.env`, a one-off script publishes `<h1>hello</h1>` and prints a URL that returns 200 with that markup in the body. Paste the URL and the status line into the build log. If Q2 is unanswered, this gate is where you stop and ask.

### Phase 3 — The standalone wrapper and its gate

**Goal.** A stored artifact becomes a complete, gated page.

**Files.**

- `advance-backend/src/domain/artifact/document.ts` — implement the `'standalone'` branch
- `advance-backend/src/domain/artifact/gate.ts` (new) — password generation and hashing
- `advance-backend/tests/domain/artifact-gate.test.ts` (new)

**Steps.**

- [ ] `gate.ts`: generate a password from an unambiguous alphabet (no `0`/`O`, no `1`/`l`), and hash with `crypto.createHash('sha256')`. Export `newPassword()`, `hashOf(password)`
- [ ] Implement `'standalone'`: `<!doctype html>`, `<title>`, the CSP from `document.ts` as a `<meta http-equiv="Content-Security-Policy">`, both palettes, the chart runtime
- [ ] Add the gate: the body ships base64-encoded, and a small script decodes and injects it only after `crypto.subtle.digest` of what was typed matches `gateHash`
- [ ] Test: a gated page's HTML does not contain the body as readable text; an ungated one does; the palettes and chart runtime are present in both modes

**Do not.** Do not describe the gate as encryption anywhere — not in a comment, not in UI copy, not in the skill. It is base64 plus a hash check, and someone reading the source gets the document. That is D5 and it is the user's call, but it has to be written down honestly or the next person will trust it. Do not add a server-side check to "make it real"; that is a different plan and it needs a runtime, which a static deployment does not have.

**Gate.** Publish a real stored artifact end to end with a throwaway script. Open the URL in a browser: it asks for a password, the right one shows the document with charts drawn and the theme intact, a wrong one does not. Note in the build log that view-source defeats it, so the record shows this was known.

### Phase 4 — The tool, on both channels

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

- [ ] Add `publishedUrl String?`, `publishedAt DateTime?`, `publishGateHash String?`, `publishDeploymentId String?` to `model Artifact`, then `pnpm prisma db push` — **this project has no `_prisma_migrations` table; never run `prisma migrate`**
- [ ] Add `artifactPublish: defineCapability('context', ['create'])` to `TOOL_CAPABILITY_DEFINITIONS`
- [ ] Write the tool on the `web-search.tool.ts` shape: args `{ artifactId }`, result `{ url, password }`. It loads the artifact through `ArtifactRepoPort.get` scoped to the caller, refuses a `text/markdown` artifact with a plain reason, wraps, publishes, persists the four columns
- [ ] Register it in `composition.ts` beside the other tool registrations
- [ ] Flip Lark's descriptor to `artifacts: 'link'` and update the comment above it, which currently explains why it is `'none'`
- [ ] Add `"lark"` to both `CHANNEL_ONLY_MODULES` and `CHANNEL_ONLY_TOOLS`, and update `scopedManifest`'s tests in `divo-pi/divo/test/runtime.test.mjs`
- [ ] Rewrite the skill's "This skill exists on the web surface only" line, and add a short section: on a surface whose descriptor says `link`, publish and speak the URL and the password; on `inline`, the panel is enough unless asked

**Do not.** Do not branch on channel anywhere in the tool or in the runtime beyond the two manifest tables. Do not build a second artifact-fetch path — `ArtifactRepoPort.get` exists and is already ownership-scoped. Do not let the tool accept a body, a title, or HTML; if a caller wants to change the document they call `divo_artifact` again, which already versions in place.

**Gate.** Two runs, both recorded in the build log. On the web, ask Divo to write a short report and publish it: the panel fills and the reply carries a working URL and password. On Lark, ask the same thing in a direct message: the card carries a working URL and password, and no panel is implied anywhere in the wording. Then confirm the negative: `divo-pi` tests still pass, and a run on a channel that is neither still has no artifact tool.

### Phase 5 — The publish control in the panel

**Goal.** Someone reading a document in the panel can publish it without asking.

**Files.**

- `advance-backend/src/http/member/artifacts.routes.ts` — `POST /:artifactId/publish`
- `admin/src/pages/workspace/artifacts/publish.ts` (new) — the pure part
- `admin/src/pages/workspace/artifacts/panel.tsx` — the control

**Steps.**

- [ ] Add the route, calling the same application service the tool calls. **Both callers share one path**; the route is a second door, not a second implementation
- [ ] `publish.ts`: the states this control moves through (idle, publishing, published, failed) and what each shows, as a plain function with a colocated test
- [ ] Add the control to `ArtifactPanel`'s header, next to the existing copy and source controls. Published state shows the URL and the password with a copy button
- [ ] Read `AGENTS.md:140` first — colours come from the token files, never a one-off

**Do not.** Do not build a modal, a settings drawer, or a password field. The password is generated, not chosen; the control has one action. Do not touch `ArtifactWorkspace` or `Surface` — `panel.tsx`'s header comment sets out the three layers and this belongs to exactly one of them.

**Gate.** Click it in a browser against a real backend. A URL and a password appear, the URL opens the gated page, and the artifact row in Postgres has all four columns filled. Confirm the panel still renders an unpublished document exactly as before.

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

## 12. Next action

Start Phase 2. Re-read the Vercel deployment reference, then implement and unit-test the backend publishing port and adapter; the real-token gate stops for Q2 if the Vercel account details are still unanswered.
