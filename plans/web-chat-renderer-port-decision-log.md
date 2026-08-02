# Web Chat Renderer Port — Decision Log

**Status:** recommendation recorded; implementation not started
**Date opened:** 2026-08-02
**Scope:** bring the useful Divo desktop chat experience into the browser app in `admin/`. The app name is incidental; the target is a normal web application.

This is the living record of the decisions, evidence, alternatives, and gates for the work. Update it when a decision changes. Do not silently rewrite an architectural decision in implementation code.

## 1. Decision in one sentence

Port Jan’s chat UX and behavior into a shared browser-safe renderer, while restyling it to the existing admin visual system and building a separate browser transport/runtime backed by server-side Pi and the backend-owned Divo gateway.

## 2. Current verdict

**Proceed with a renderer extraction spike. Do not directly port the desktop chat runtime.**

Confidence from repository inspection: **94%**.

The desktop renderer is reusable after decoupling. The desktop runtime is not browser-compatible as-is because it depends on Tauri commands, Tauri events, local Pi process ownership, desktop persistence, local files, and local approval flows. “Same UX” means the same user-visible capabilities, states, and interaction model; it does not mean copying Jan’s desktop CSS, shell, window chrome, or spacing tokens.

## 3. Evidence baseline

### Desktop chat path

```text
Thread route
  → AI SDK UIMessage state
  → MessageItem / Pi trace renderers
  → CustomChatTransport
  → Tauri pi_start / pi_prompt / pi_abort
  → local Pi process and pi-event stream
  → desktop persistence
```

Key source locations:

- Chat lifecycle and route ownership: `jan/web-app/src/routes/threads/$threadId.tsx`
- Main message renderer: `jan/web-app/src/containers/MessageItem.tsx`
- Markdown renderer: `jan/web-app/src/containers/RenderMarkdown.tsx`
- AI SDK transport: `jan/web-app/src/lib/custom-chat-transport.ts`
- Tauri Pi stream bridge: `jan/web-app/src/lib/pi-stream.ts`
- Pi event-to-UI mapping: `jan/web-app/src/lib/pi/pi-event-mapper.ts`
- Durable UI/message conversion: `jan/web-app/src/lib/messages.ts`
- Pi lifecycle commands: `jan/src-tauri/src/core/pi/mod.rs`
- Local thread/message persistence: `jan/src-tauri/src/core/threads/commands.rs`

### Browser app baseline

- Browser app entry point: `admin/src/main.tsx`
- Browser routes: `admin/src/app/App.tsx`
- Auth/session provider: `admin/src/auth/AdminAuthProvider.tsx`
- JSON-only API client: `admin/src/lib/api.ts`
- Existing run inspection: `admin/src/cursor/use-run-detail.ts`

The browser app currently has no interactive chat route, no conversation store, and no SSE/WebSocket/ReadableStream client. Existing AI Ops run views are inspection/replay surfaces, not a live chat transport.

## 4. Decisions

### D-001 — Target is web chat, not an “admin chat” product

**Decision:** Treat `admin/` as the current browser application only. The chat should be a normal Divo web surface and must not inherit unnecessary company-admin semantics.

**Reason:** The same member-authenticated web application may eventually serve members, managers, and company admins. Chat context and backend permissions remain separate concerns.

**Status:** Agreed for planning.

### D-002 — Do not copy the desktop route or runtime wholesale

**Decision:** Do not import the full Jan thread route, `CustomChatTransport`, `pi-stream.ts`, Tauri persistence, or Tauri approval state into the browser app.

**Reason:** These modules own desktop lifecycle and privileged capabilities. Direct reuse would produce hidden local-runtime assumptions and duplicate authority.

**Status:** Agreed.

### D-003 — Extract a browser-safe shared renderer

**Decision:** Create a shared presentation boundary, likely under `packages/divo-chat-renderer/`, consumed by both Jan and the browser app.

**Initial candidates:**

- `PiTraceTimeline`
- `CommandGroup`
- `ToolIcon`
- `SubagentRunCard`
- `ToolCard`
- `TerminalCard`
- trace splitting and tool-label helpers
- supporting collapsible/chain-of-thought primitives

**Reason:** These components can be driven by props and normalized message parts without owning auth, storage, Tauri, or backend execution.

**Status:** Recommended; validate with a spike before committing to the package shape.

### D-003A — Preserve desktop chat UX while adopting the browser visual system

**Decision:** The browser chat should feel like the same Divo chat experience: same conversation flow, message hierarchy, streaming behavior, reasoning/work trace, tool states, approvals, errors, attachments, citations, artifacts, and recovery affordances. Its visual treatment should use the existing browser app system in `admin/src/styles/cursor.css`, `admin/src/styles/workspace.css`, and the browser’s existing primitives.

**Keep consistent across desktop and browser:**

- composer behavior and send/stop states;
- user/assistant message hierarchy;
- live streaming and partial-response behavior;
- collapsed/expanded reasoning and Pi work trace;
- tool running/succeeded/failed/denied states;
- approval pending and decision feedback;
- attachment, citation, and artifact affordances;
- error, retry, regenerate, and recovery language;
- keyboard accessibility, focus behavior, and responsive layout intent.

**Adapt to the browser app:**

- colors, typography, borders, radii, spacing, and loading skeletons;
- navigation and page shell;
- dark/light theme tokens;
- browser-native dialogs, file selection, links, and downloads;
- admin/workspace scope context where the surrounding route needs it.

**Reason:** A browser user should not receive a visually alien Jan surface, but behavioral parity is more important than pixel-level desktop cloning. The renderer package should expose semantic states and slots; each host app supplies its visual tokens and shell.

**Status:** Agreed product direction.

### D-004 — `MessageItem` is an orchestration boundary, not the first shared component

**Decision:** Do not use the current `MessageItem` as the first cross-app package boundary.

**Reason:** It reaches into model settings, service hubs, message errors, approvals, grounding/RAG, artifact filesystem access, and desktop-specific actions. It can later be split into a browser-safe message shell plus injected renderers/actions.

**Status:** Agreed for the first phase.

### D-005 — Markdown is adaptable, not automatically safe for public web use

**Decision:** Reuse the desktop Markdown approach only after defining browser security policy.

**Required review:**

- URL scheme validation and link safety
- Mermaid and code rendering
- `dangerouslySetInnerHTML` usage in syntax highlighting
- HTML/SVG artifact iframe CSP and sandbox settings
- network access from generated artifacts
- long-stream rendering performance

**Status:** Open implementation gate.

### D-006 — Browser chat requires a backend-owned runtime

**Decision:** The browser must call a backend web-chat API that owns conversation admission, Pi lifecycle, run ownership, and event delivery.

**Target topology:**

```text
Browser
  → authenticated web chat API
  → durable conversation/run/event store
  → isolated server-side Pi runtime
  → advance-backend Divo gateway
  → RBAC, credentials, approvals, audit
```

**Reason:** A browser cannot invoke `pi_start`, `pi_prompt`, or `pi_abort`, cannot read desktop Pi JSONL, and must not receive SaaS credentials or policy authority.

**Status:** Recommended architectural direction; backend design still required.

### D-007 — Establish one canonical browser event contract

**Decision:** The browser protocol must be versioned and replayable instead of exposing raw Tauri events.

**Minimum event shape:**

```ts
{
  schemaVersion: 1,
  threadId: string,
  runId: string,
  sequence: number,
  type: string,
  timestamp: string,
  data: unknown,
}
```

**Minimum event types:**

```text
run.started
message.delta
tool.started
tool.input
approval.pending
tool.completed
message.completed
run.failed
run.completed
```

**Reason:** Refresh, reconnect, cancellation, multi-tab ownership, and idempotent finalization need server-authoritative sequencing.

**Status:** Required before live browser chat implementation.

### D-008 — Browser conversations become server-backed

**Decision:** Do not make browser chat history depend on Jan’s local JSONL/SQLite stores or browser-only local storage.

**Reason:** Desktop messages, Pi sessions, backend traces, and browser state are currently separate stores. A browser implementation needs one canonical conversation/run history and an explicit desktop migration policy.

**Status:** Required; schema and ownership are open.

### D-009 — Browser authentication must not copy the desktop token pattern blindly

**Decision:** Prefer same-origin HTTP-only session cookies or a BFF boundary for browser chat. If bearer tokens remain, use short-lived, scoped tokens and avoid durable browser storage where possible.

**Reason:** The current browser app stores the member token in `localStorage`, which increases exposure if the chat surface later renders untrusted or model-generated content.

**Status:** Open backend/security decision.

### D-010 — Backend remains the authority for tools and permissions

**Decision:** The browser displays tool availability and run state but never implements RBAC, SaaS credential handling, or provider execution.

**Reason:** This preserves the repository architecture: `advance-backend` owns identity, permission checks, HITL, credentials, execution, and audit; Pi remains the runtime layer.

**Status:** Agreed and non-negotiable.

### D-011 — Attachments use browser upload and opaque server IDs

**Decision:** Replace desktop local paths and Tauri file access with browser upload → server-side validation/storage → opaque attachment IDs.

**Reason:** Browser paths are not meaningful to the server and must never become trusted execution input. Files also need scanning, size limits, retention, and authorization.

**Status:** Required for attachment parity; detailed design open.

### D-012 — Approval/HITL is a browser/backend flow

**Decision:** Rebuild interactive approvals against backend approval state. Do not port local Pi extension approval commands or local “always allow” grants.

**Required states:** pending, approved, rejected, expired, execution-failed, completed.

**Reason:** Desktop has both local Pi UI approvals and backend Divo approvals. They are different authorities and cannot be merged casually.

**Status:** Required for write-capable chat.

### D-013 — First proof is a reversible renderer spike

**Decision:** First implement a small browser spike using a static fixture or existing run-detail data before building live chat.

**Spike scope:**

1. Render the extracted Pi timeline in the browser app.
2. Feed thought, narration, grouped tools, streaming, settled, and failed states.
3. Map one existing admin `RunTurnView.tools` object into the shared trace contract.
4. Keep the tool view read-only.
5. Verify light/dark styling and desktop regression tests.

**Reason:** This proves the visual reuse seam without committing to a browser runtime or mutating production data.

**Status:** Recommended next implementation step.

### D-014 — Web has a Lark-DM continuation thread and separate native threads

**Decision:** The web app exposes one reserved `Chat` conversation for the member’s Lark DM, plus separate web-native conversations. Opening the reserved conversation loads the Lark DM context and continues from the cloud agent state. Web-native conversations never become Lark conversations.

**Status:** Agreed product direction.

### D-015 — Cross-surface history flows one way after import

**Decision:** When the reserved web `Chat` is opened, it may import Lark turns that arrived since the last web read. Web-originated turns extend the web continuation thread only; they are not sent, mirrored, or delivered back into the Lark DM. The web renderer still consumes the same cloud-agent event shapes for both Lark-originated and web-originated runs.

**Reason:** This keeps the user’s continuity without creating a bidirectional channel-sync system or surprising Lark recipients with messages typed in the web app.

**Status:** Agreed product direction.

### D-016 — The mirror renders the full cloud-agent event history

**Decision:** The reserved web `Chat` renders the complete safe event history for Lark and web runs: user/assistant messages, streaming text, thinking/reasoning states, tool starts/progress/completions, approvals, artifacts, citations, errors, and terminal status. The renderer consumes one normalized cloud-agent event contract regardless of which surface initiated the run.

New Lark and web runs must persist enough normalized event data to replay that experience. Older Lark runs may be transcript-only when their detailed events were never durably captured; the UI must label that limitation rather than inventing a trace.

**Status:** Agreed product direction; event-retention policy remains open.

### D-017 — Detailed event history is retained for one week

**Decision:** Keep the full normalized cloud-agent event/trace detail for seven days. This includes the work timeline, tool progress, approval transitions, and other renderer-specific run events.

**Status:** Agreed retention direction; transcript and attachment retention are still separate decisions.

## 5. Deep issues pinned down

This section records issues found during the adversarial follow-up inspection. These are implementation constraints, not optional polish.

### I-001 — The desktop WebSocket adapter is not a live integration

`advance-backend/src/infrastructure/channels/desktop/desktop.adapter.ts` is present in source, but the tracked code has no import, instantiation, WebSocket upgrade handler, or route that mounts it. `composition.ts` creates a `ChannelAdapterRegistry` and registers only the Lark adapter. The remaining references are documentation and mock pages.

The adapter is also the wrong browser seam: it emits `terminal.exec.request` to a connected client and waits on a process-local `pendingExecs` map. That assumes the desktop client owns terminal execution and that the same backend process holds the pending request. A browser chat must use a new authenticated web-run API with server-owned execution, durable state, and no client terminal authority.

**Pinned resolution:** do not port or revive `DesktopChannelAdapter` for web chat. Keep it out of the new dependency graph unless a separate desktop migration explicitly makes it live.

### I-002 — The existing execution trace API is not a chat protocol

`GET /api/executions/:id/events` returns a bounded JSON snapshot, not a live stream. The execution query layer also redacts prompt, history, tool input, and other sensitive payloads for callers without raw execution-data access. Its event vocabulary is operational (`plan_created`, `step_executed`, `model_call`, and similar), not a lossless `UIMessage`/Pi trace stream.

**Pinned resolution:** use execution events for admin inspection only. Define a separate browser chat event contract; an adapter may correlate a chat run to an execution run, but it must not reconstruct the user-facing chat from redacted execution rows.

### I-003 — The existing Pi runtime is Lark-specific at the transport boundary

The current lease contract hard-codes `PI_RUNTIME_CHANNEL = 'lark'`, the runtime posts to `/v1/lark-runs`, pending attachments are keyed under `channel: 'lark'`, and progress is delivered through an in-request `onProgress` callback. The service returns final text after consuming the controller stream; it does not publish a durable event feed that a browser can subscribe to later.

**Pinned resolution:** either generalize the runtime boundary to an explicit channel-neutral web adapter or add a parallel web runtime adapter behind the same server-owned Pi/gateway authority. Do not label a browser run as Lark merely to fit the existing lease.

### I-004 — There are already multiple persistence families; a third one is prohibited

The desktop side has `DesktopWorkspace`, `DesktopThread`, and `DesktopMessage`. The cloud runtime side already has `RuntimeConversation`, `RuntimeConversationMessage`, `RuntimeRun`, `RuntimeApproval`, and `RuntimePendingAttachment`. `ConversationRepository` already reads and appends turns in `RuntimeConversation` using company/channel-scoped keys.

**Pinned resolution:** the first schema candidate is to reuse the runtime family with `channel = 'web'`, explicit user/scope metadata, and browser-safe message mapping. Do not create `WebConversation`, `WebMessage`, or browser-local history until a field-by-field gap analysis proves the runtime family cannot represent web semantics. Desktop history sharing is a separate migration decision, not an accidental side effect of using the same database.

### I-005 — Message history sequence and live event sequence must be separated

`RuntimeConversationMessage.sequence` is a history sequence. The existing append path claims the next sequence before attempting dedupe, so a retried delivery can create a sequence gap. That may be acceptable for history, but it cannot be left implicit if the browser reconnect protocol says “send every event after sequence N.”

**Pinned resolution:** define separate semantics for persisted message order and run-event order. Every browser event needs an idempotency key, a stable event ID, and an explicit rule for gaps, replay, and terminal events. Final message persistence and run completion must be idempotent under client retry, worker retry, and browser refresh.

### I-006 — Current progress delivery cannot support refresh or reconnect

The Lark runtime’s callback exists only while the inbound request is alive. Jan’s `CustomChatTransport.reconnectToStream()` is intentionally a no-op and `useChat` sets `resume: false`. That is fine for a local desktop process, but a web tab can refresh, sleep, change networks, open a second tab, or lose an SSE connection while Pi continues running.

**Pinned resolution:** a web run must outlive the request that started it. Provide a server-side run owner, durable event cursor, reconnect endpoint, idempotent cancel endpoint, and a terminal reconciliation path. The client must be able to recover from “stream lost” without starting a duplicate Pi run.

### I-007 — Authentication and streaming transport are coupled decisions

The browser app currently stores the member bearer token in `localStorage`; the backend member middleware accepts `Authorization: Bearer` and does not read cookies. Native `EventSource` cannot attach that Authorization header, while a cookie/BFF design changes CSRF and same-origin requirements.

**Pinned resolution:** decide the browser session boundary before choosing SSE. Preferred production shape is same-origin HTTP-only cookie or BFF. If the existing bearer model is retained for the first spike, use `fetch`-based streaming or an explicit short-lived stream token, never a URL query token, and record the migration plan.

### I-008 — Browser attachments are not a simple port of local files

Jan sends local file paths and Tauri-managed file parts. The existing backend knowledge-file endpoint stages one upload in memory, and its identity helper labels every non-Lark request as `desktop`. The pending attachment model and Lark runtime also key state to `channel: 'lark'`.

**Pinned resolution:** browser upload must produce an opaque server asset ID bound to company, user, conversation, and expiry. The run request may reference only validated IDs. Add MIME/content/size policy, scanning or quarantine, authorized download, retention cleanup, and a clear rule for whether an attachment is consumed by one run or remains in history.

### I-009 — Approval is durable backend state, not local Pi permission state

Jan has local Pi approval queues and “allow for this chat” behavior. The backend has `RuntimeApproval` and a member-authenticated desktop approval inbox. The approval repository can create conversation/run stubs while creating an approval, which is useful for Lark delivery but could create ghost browser runs if called without the browser run identity.

**Pinned resolution:** browser approvals must be attached to the exact web conversation/run and rendered from backend state. Approve, reject, expire, resume, and execution-failed transitions need authorization, idempotency, and event emission. Do not port local “always allow” grants into the web authority model.

### I-010 — Jan `UIMessage.parts` and backend runtime messages are different contracts

`MessageItem` renders text, reasoning, files, tool input/output states, Pi trace metadata, citations, artifacts, interruptions, version navigation, and retry/edit/delete actions. `RuntimeConversationMessage` has normalized role/kind/text/JSON/tool/attachment fields, but it is not a direct `UIMessage` serialization.

**Pinned resolution:** define a browser-safe normalized message/part DTO and explicit lossless adapters for the states the UX promises. The renderer must not infer live status from missing fields or re-open historical tool calls as pending. Streaming deltas, final message parts, and replayed history must use the same semantic model.

### I-011 — `MessageItem` itself is too coupled to share first

The current component reaches into model settings, interface settings, service hubs, RAG/grounding stores, message-error stores, local approvals, local artifact links, desktop actions, and filesystem-oriented helpers. Leaf renderers such as the Pi timeline and tool cards are better candidates for extraction.

**Pinned resolution:** share semantic leaf components and a renderer contract first. Inject markdown, tool-card, approval, artifact, link, and action behavior from the host app. Only share a message shell after the dependency graph is browser-safe.

### I-012 — React/Tailwind/dependency versions will affect the package boundary

Jan uses React 19 and Tailwind 4; `admin` uses React 18 and Tailwind 3. Jan also owns Streamdown, Mermaid, KaTeX, Shiki-related code, Tabler icons, and AI SDK dependencies that `admin` does not currently declare.

**Pinned resolution:** keep the first shared package dependency-light and React-compatible with both hosts. Prefer semantic props and host-supplied primitives/tokens over importing Jan’s app-wide providers or Tailwind-generated classes. A package-level CSS strategy must be chosen before broad extraction.

### I-013 — Markdown/artifact behavior needs a browser security policy

Jan currently sets Streamdown link safety to disabled and supports opt-in HTML/SVG artifact rendering. The admin artifact surface already treats agent-written HTML as a separate sandboxed surface and documents that it must not execute on the dashboard origin. A chat renderer that blindly copies Jan behavior could create a session or data-exfiltration boundary.

**Pinned resolution:** browser chat defaults to safe links and no executable HTML. Generated artifacts require opaque IDs, authorized downloads, a separately governed sandbox origin, restrictive CSP/sandbox flags, and explicit network policy. Mermaid, remote images, citations, code highlighting, and iframe behavior are all part of the security test matrix.

### I-014 — Scope selection must be part of the server identity, not only the shell

The browser shell exposes `You`, team, and company scopes, while gateway execution can depend on department membership and `departmentId`. A selected scope stored only in React state is not an authorization boundary and can become stale after membership changes.

**Pinned resolution:** include a validated scope/department context in the start request, re-resolve permissions server-side, bind it to the conversation/run, and show the effective context in the chat header. Never let a UI scope select credentials or bypass backend RBAC.

### I-015 — Artifacts have no browser-ready durable contract yet

The existing admin artifacts screen records that agent files currently die with the container workspace and lack versioned storage. Jan’s `ArtifactLinks` therefore cannot be copied as-is.

**Pinned resolution:** define artifact identity, storage ownership, versioning, preview/download authorization, expiry, and failure states before promising artifact parity in browser chat. Until then, render a truthful unavailable/desktop-only state instead of a broken local path.

### I-016 — Streaming performance must be designed, not inherited

Jan has specific mitigations for streamed rendering: deferred content, a plain-code path while streaming, throttled AI SDK updates, and bounded live trace scrolling. A web app adds background-tab throttling, mobile widths, multiple tabs, and potentially much longer server histories.

**Pinned resolution:** set event/delta coalescing limits, message-size limits, trace bounds, scroll-follow rules, and a virtualization or pagination strategy. Test a long stream and a large replay before calling the renderer production-ready.

### I-017 — Observability and user-visible detail need an explicit privacy split

The admin execution query intentionally redacts prompts, histories, and tool inputs for some viewers, while the desktop chat may show detailed tool traces to the person running the task. The browser’s “same UX” request does not automatically grant company-admin viewers access to private prompts or tool payloads.

**Pinned resolution:** define the chat viewer’s audience (`private`, team, or company), redact server-side before events leave the backend, and test cross-user, cross-department, and changed-membership access. The browser should receive only the minimum tool detail needed for its UX.

### I-018 — Rollback must be feature-flag and additive

The repository rules require schema changes to be committed and merged before Main deployment, and deployments do not clone conversation data. A live chat migration must therefore not depend on an irreversible desktop history rewrite.

**Pinned resolution:** keep the first renderer spike fixture-only; introduce web routes behind a flag; prefer additive fields or reuse of existing runtime tables; provide disable-route and worker-drain behavior; and defer history migration until replay and authorization tests pass. No destructive cleanup or desktop deletion is part of the first web release.

## 6. Pinned decisions after the follow-up pass

1. The web chat backend will be a new browser-facing API/adapter. The unmounted desktop WebSocket adapter is not the implementation base.
2. The browser event protocol will be versioned, durable, sequenced, replayable, and distinct from admin execution-trace snapshots.
3. `RuntimeConversation`/`RuntimeRun`/`RuntimeConversationMessage` remain the first persistence candidate with a `web` channel; a new parallel web schema requires an explicit gap analysis.
4. The renderer spike comes before Pi lifecycle wiring, attachments, or write-capable approvals.
5. “Same UX” is a behavioral parity target. Local shell, local filesystem, local MCP, local RAG, local model providers, and client-side terminal execution are not browser capabilities; they must be omitted or replaced with server-backed equivalents.
6. Admin visual tokens and shell primitives are the browser styling source. Jan CSS and Tailwind classes are not copied wholesale.
7. Browser chat will expose the effective conversation scope and will never treat the scope picker as permission authority.
8. The reserved web `Chat` is a one-way continuation surface for Lark DM context; web-native conversations are separate and never sync back to Lark.
9. Full safe cloud-agent event history is the parity target for both Lark-originated and web-originated runs.
10. Detailed cloud-agent event history has a seven-day retention window; transcript/context retention is not automatically limited to seven days.

## 7. Required implementation sequence and proof

### Phase 0 — Contract freeze

- Write the normalized message/part DTO and event envelope.
- Define run, conversation, scope, idempotency, cancellation, approval, attachment, and artifact identifiers.
- Decide stream transport and browser session boundary.
- Add contract fixtures for a minimal answer, streamed answer, tool call, approval, error, reconnect, and terminal replay.

**Proof:** schema validation rejects unknown/malformed events and accepts a full representative trace.

### Phase 1 — Renderer extraction spike

- Extract Pi trace/timeline/tool-card presentation only.
- Build an admin fixture page or route using existing admin tokens in light and dark mode.
- Run Jan renderer tests and browser component tests.
- Confirm no shared module imports Tauri, `window.core`, local filesystem, desktop stores, backend clients, or browser auth.

**Proof:** static browser rendering shows the promised states and can be removed without touching runtime or database code.

### Phase 2 — Mock web transport

- Add a browser client adapter with a fake sequenced event source.
- Exercise reconnect, duplicate events, missing events, stop, retry, and terminal reconciliation.
- Do not start real Pi or mutate production conversations.

**Proof:** client state converges to the same result after a dropped stream, duplicate delivery, or refresh.

### Phase 3 — Server protocol and persistence

- Add authenticated web conversation/run routes using the chosen runtime persistence candidate.
- Add server-side event persistence, replay, ownership checks, rate limits, and idempotency.
- Add a mocked Pi runner behind the same application service.

**Proof:** backend tests cover missing auth, wrong company/user, wrong scope, duplicate start, cancellation, replay cursor, event ordering, and terminal state.

### Phase 4 — Real server-side Pi and gateway

- Generalize or add the runtime adapter with a real web channel identity.
- Issue a web-bound Pi lease and route tools only through the backend Divo gateway.
- Persist progress and final messages without exposing credentials or raw internal prompts.

**Proof:** a real run can complete, fail, reconnect, and cancel while backend permission tests remain authoritative.

### Phase 5 — Attachments, approvals, and artifacts

- Add browser upload/quarantine/download flows.
- Attach approvals to exact web runs and resume them safely.
- Add durable artifact metadata and safe preview/download behavior.

**Proof:** each capability has cross-user authorization tests, expiry/retry tests, and browser UX states for pending/failed/unavailable.

### Phase 6 — Controlled rollout and rollback

- Enable for a small member cohort behind a feature flag.
- Monitor run completion, stream disconnects, replay recovery, approval latency, upload failures, and renderer errors.
- Disable new starts without deleting existing history; drain active runs or expose recovery; then remove only after data/rollback review.

**Proof:** rollback returns the app to the prior routes without destructive data operations.

## 8. Alternatives considered

### Alternative A — Shared presentation package

**Choice:** Recommended long-term approach.

**Pros:** real reuse, stable app-neutral contract, prevents renderer drift.
**Cons:** React 18/19 and Tailwind 3/4 compatibility work; dependency and CSS-token alignment required.

### Alternative B — Rebuild an admin-only renderer

**Choice:** Acceptable only as a temporary visual experiment.

**Pros:** fastest browser proof, minimal dependency conflicts, easy rollback.
**Cons:** proves UX but not reuse; desktop and browser will drift.

### Alternative C — Directly import Jan source into `admin/`

**Choice:** Rejected.

**Reason:** It crosses application boundaries, imports desktop stores/Tauri assumptions, depends on unavailable packages, and makes ownership unclear.

### Alternative D — Browser → localhost companion bridge → Jan/Tauri

**Choice:** Possible but not the primary architecture.

**Pros:** preserves local Pi, local files, and desktop-only tools.
**Cons:** pairing, origin validation, CSRF, localhost abuse, availability, version mismatch, and poor remote-web behavior. This is a companion mode, not true web chat.

## 9. Open decisions before live chat

- Server-side Pi topology: per-user container, pooled runtime, or another isolated runtime model.
- Web chat API transport: SSE versus WebSocket.
- Canonical conversation/message schema and desktop history migration policy.
- Server-side event retention and replay window.
- Browser session model and token/cookie boundary.
- Attachment storage, scanning, retention, and download authorization.
- Browser approval/resume semantics and reconnect behavior.
- Which desktop-only features are omitted from web: local shell, local filesystem, local MCP, local RAG, and local model providers.
- Artifact storage and safe preview policy.
- Whether the browser should use AI SDK `useChat` with a new transport or a smaller app-specific event adapter.

## 10. Acceptance gates

### Renderer spike gate

- Shared renderer builds in both applications.
- No shared renderer module imports Tauri, desktop stores, backend clients, or local filesystem helpers.
- Static fixture renders thought, narration, grouped tools, streaming, settled, and error states.
- One existing admin run record maps into the renderer contract.
- The fixture is visibly consistent with the existing admin UI in light and dark themes.
- The spike demonstrates the desktop interaction states using admin visual tokens rather than copied desktop CSS.
- The chat surface remains usable at browser widths and does not depend on desktop window chrome.
- Existing desktop renderer tests remain green.
- Removing the spike requires deleting only its package wiring, adapter, page, styles, and tests.

### Live browser chat gate

- Browser authentication is server-validated and appropriately scoped.
- Conversation history is durable and canonical.
- Pi runs are isolated and server-owned.
- Events are versioned, sequenced, replayable, and reconnectable.
- Cancellation is idempotent and ownership-checked.
- Tool execution remains backend-owned and RBAC-filtered.
- Approval pending/approve/reject/expire behavior is tested.
- Attachments use opaque server-side IDs.
- Markdown, links, artifacts, and iframes pass browser security tests.
- Desktop, browser, and backend event/message contract tests pass.

## 11. Out of scope for this decision log

- Replacing the existing admin/workspace information architecture.
- Moving RBAC, credentials, or provider execution into the browser.
- Modifying vendored Pi core.
- Deleting or rewriting the desktop chat implementation before parity exists.
- Implementing the spike or live chat in this documentation-only change.

## 12. Change history

| Date | Change |
|---|---|
| 2026-08-02 | Initial decision log created after desktop/browser architecture inspection and four independent Luna reviews. |
| 2026-08-02 | Clarified that browser chat must preserve desktop UX behavior while adopting the existing admin visual system; pixel-level desktop styling is not a goal. |
| 2026-08-02 | Follow-up inspection: confirmed the desktop WebSocket adapter was unmounted/unused, separated execution traces from chat events, pinned runtime/persistence/auth/attachment/approval/security issues, and added phased proof/rollback gates. |
| 2026-08-02 | Safely removed the unreferenced `DesktopChannelAdapter`; the separate terminal bridge remains untouched because `run-command` still imports that capability and removing it would be a broader behavior change. |
| 2026-08-02 | Product clarification: reserved web `Chat` continues the Lark DM context, imports later Lark turns one-way on open, and keeps web-originated continuation web-only; native web conversations remain separate. |
| 2026-08-02 | Product clarification: web `Chat` must render full historical cloud-agent events, with transcript-only fallback for older Lark runs whose detailed events were not stored. |
| 2026-08-02 | Product clarification: retain detailed cloud-agent event history for one week; keep transcript and attachment retention as separate decisions. |
