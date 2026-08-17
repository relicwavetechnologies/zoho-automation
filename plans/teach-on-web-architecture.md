# Self-updating skills, and native video understanding

Living document. What exists, and the decisions we settle as we grill the
design. Nothing here is built yet.

**Superseded on 2026-08-18.** This file previously planned a "Teach on the web"
feature — a `/teach` command, a teach session, a teach-specific write path. That
framing is dropped. See D1.

## The target

Two things, and neither is a named feature:

1. **A skill can update itself.** Like any coding agent, Divo should be able to
   decide a skill needs changing and change it — gated by approval, because a
   skill change alters how work gets done. Not a mode, not a command. An
   ordinary capability described in instructions.
2. **Video is understood natively.** Anyone uploads a video in any chat, Divo
   takes in its context, and answers from it. We do not keep the video — only
   what was understood from it.

The product reason: web Divo is a pitch surface. A client should see Divo learn
from a recording without being told to enter a special mode first.

---

## The one thing that cannot work, and why

**The agent must never write skills inside the container.** Two independent
reasons, and the second is already enforced:

1. The container is rebuilt from the database on every bootstrap, so a file
   written in-container is reverted on the next run — the change would appear to
   work and then silently vanish.
2. It is physically impossible anyway. The skills volume is mounted
   **`readonly`** and the container itself runs `--read-only`
   (`divo-pi/divo/runtime-docker.mjs:88`), and staged `SKILL.md` files are
   written `0444`.

So the write has to go to the **database**, and the container has to pick it up.
Both halves already exist — see below.

---

## What already exists (verified 2026-08-17/18)

### The skill write path — complete

`KnowledgeMutationService` is a full state machine, not a stub:

```
propose → confirmRequesterReview → attachRuntimeApproval
        → acceptRuntimeApproval → apply | reject | cancel
```

`applyApproved` (`knowledge-mutation.repository.ts:322`) runs in one transaction
with advisory locks on both the mutation and the target
(`company:kind:targetKey:logicalKey`), an optimistic `baseVersion` check, a live
re-check of the approver's authority, and a requirement that the bound approval
was **atomically claimed** for execution. It writes a `KnowledgeResource` plus a
`KnowledgeOutbox` event.

`knowledge-projection.service.ts` consumes the outbox and writes the `Skill`
row: `revision: { increment: 1 }`, with `scope` and `departmentId` writable, and
a per-scope slug collision check. **So a scope change is already an ordinary
update** — no copy-and-fork.

Direct writes elsewhere are already closed off: *"Direct skill writes are
disabled. Use the governed knowledge review flow"*
(`admin/departments.routes.ts:287`).

### The refresh path — complete, and self-triggering

1. Backend returns a bootstrap from
   `/api/desktop/auth/runtime-context?nativeSkills=1` — ≤100 visible skills,
   access-filtered, fail-closed, each with instructions + revision
2. The controller writes `<slug>/SKILL.md` into `/run/divo-skills/.next` inside
   a throwaway helper container (no network, read-only, all caps dropped), then
   `rename current → previous`, `next → current` — atomic
3. Pi launches with `--skill /run/divo-skills/current`

`nativeSkillBootstrapDigest` hashes the **whole bootstrap — every skill's
instructions and revision** — and is part of `piProcessBinding`. So an edited
skill changes the digest, which invalidates the warm binding and replaces the Pi
process on the next turn. Identical digests short-circuit to `"unchanged"` and
cost nothing.

Worth knowing: the trigger is the **content hash**, so the refresh does not
depend on `registryRevision` moving. It does move anyway —
`recordSkillRegistryMutation` writes the `SkillVersion` row and bumps
`SkillRegistryRevision` in the same transaction — but the hash is the robust
half.

### System skills are already unreachable, by construction

The projection resolves its target as
`skill.findUnique({ where: { knowledgeResourceId: resource.id } })`. The 19
code-provisioned system skills (`*-system-skills.ts`, `isSystem: true`) have no
`knowledgeResourceId`, so **no knowledge mutation can ever modify one**. A
member cannot talk Divo into rewriting the Zoho, mail-ops or gateway skill.

There is no explicit `isSystem` check anywhere in the knowledge flow — the
protection is structural. One consequence to fix: a proposal whose slug collides
with a system skill in the same scope fails the collision check *inside the
outbox worker*, i.e. **after a manager has already approved it**. That belongs at
propose time, with a readable message.

### The web already renders decisions

`DecisionCard` (`admin/src/pages/workspace/decisions/decision.view.tsx`) is live
on three surfaces: the Approvals page (`screens-you.tsx`), inside the chat
thread (`screens-chat.tsx`), and home's "up next" (`upnext.view.tsx`).

So anything asked *through the decision module* already has a web card, a
thread card and a home entry, with no new UI.

**Cost of a refresh:** one Pi *process* restart inside the already-warm
container. Not a container boot, not a rebuild. Same path a model switch takes.
Not measured yet.

**Consequence for UX:** the swap lands *between* turns. A skill changed
mid-conversation is live from the next message. Copy should read "Divo learnt
this — it'll use it from here on", never "applied".

### Video understanding — complete, and knows nothing about teaching

`ManagerTeachMediaProcessor`: scene-cut frame extraction (≤40 frames at 1600px,
threshold 0.12) → audio split → `gpt-4o-mini-transcribe` in 5-minute chunks →
per-frame OCR on `qwen/qwen3-vl-32b-instruct` (caption + screen text + UI
elements) → one `evidence-manifest.json`. Named progress steps
(`selecting_evidence`, `transcribing`, `reading_screens`,
`reconstructing_workflow`). Raw video self-deletes after 24h.

The module is video-generic. Only the session table and manager gate wrapped
around it are teach-specific — which is exactly what we are removing.

Ingestion is equally generic: `PUT /sessions/:id/video` streams MP4/MOV/WebM
capped at 2047 MB, rejecting a body whose size does not match the declared one.
Plus a BullMQ worker with a 5-minute lock, stall recovery, a reconcile sweep,
`cancel` and manual `resume`.

### The approval vocabulary — complete

`src/domain/decision/decision.ts` is one vocabulary for every human-in-the-loop
ask. A confirm is one question with two options; a form is several. It carries
`{ kind: 'run', toolId, action, argsHash }` — *"approval is a decision over one
validated set of arguments, never a licence to re-plan"*, with the hash proving
the arguments did not move while a person read them.

`decision.service.ts` takes `approver` and `requestedBy` separately, splits the
inbox into `awaitingMe` / `requestedByMe`, rejects an actor who is not the named
approver, and hashes the approver into the dedupe key. **A decision therefore
cannot be re-routed after it is asked** — a different audience means a second
decision. `approvalResolver.resolveManager(departmentId, companyId)` already
resolves a department's manager.

Known limit: the `tell` arm was deliberately removed — *"it needs the runtime
threaded through to this module to work"*. So `run` can apply a change, but Divo
cannot yet narrate the result back into the thread as a new turn.

### The two kinds of approval already have names

`DEFAULT_KNOWLEDGE_POLICIES` (`knowledge-provisioning.ts`) generates one row per
(kind × scope × action):

| scope | `requesterReviewRequired` | `requiredAuthority` | `distinctApprover` |
|---|---|---|---|
| personal | (memory only: false) | `none` | **false** |
| department | true | `department_manager` | **true** |
| company | true | `company_admin` | **true** |

- `requesterReviewRequired` — the invoker confirms. The "normal" kind.
- `distinctApprover` — a *different* person must approve. The "higher authority"
  kind.

These are **rows in a `KnowledgePolicy` table, not constants** — tenant
configurable without a code change.

---

## What is actually missing

Only two things. Everything above is built.

### M1 — The shared-skill approval has no web surface

`LarkKnowledgeReviewService` (1,048 lines) builds a **Lark card** and sends it to
a Lark chat. The pending review lives **only in Redis** —
`cache.set(knowledgeReviewKey(reviewId))` — it never touches the approvals table
and never calls `ApprovalGateService`. So it has no web surface, no durable row,
and it dies with its TTL.

This is one of the two askers the decision module's own comment complains about:
*"Two of them had given up on the approvals table entirely and kept their
pending question in a cache, because the table can only hold a verdict."*

The web approval card for skill updates cannot be built on this. There is
nothing to render.

### M2 — Video is refused everywhere except a teach session

`upload-intake.ts` has three outcomes — audio transcribed and folded into the
ask (bytes not staged), unopenable formats refused by name, everything else
staged as a path — and video sits in the refusal set. The browser mirrors it in
`admin/src/pages/workspace/chat/attach.ts`. The composer also caps files at
24 MB, while video needs the streaming PUT.

### Smaller, but real

- Cloud Pi has no `skill-view`/`skill-authorization` extensions (the desktop
  copy has both).
- No slash-command infrastructure anywhere — but under D1 we no longer need any.
- Recording in-browser: `getDisplayMedia` + `MediaRecorder` → WebM, which the
  backend already accepts. The desktop's macOS-only `screencapture` path
  (`jan/src-tauri/src/core/divo/teach.rs`) is not portable and not worth
  porting.

---

## Decisions

### D1 — There is no Teach feature

*Settled 2026-08-18. Supersedes the earlier `/teach` design.*

No `/teach` command, no teach mode, no teach session as a user-visible concept,
no teach-specific write path. Updating a skill is an **ordinary agent
capability**, described in instructions and skill text — "if this skill is wrong
or incomplete, propose the corrected version" — exactly as any coding agent
edits its own skills.

Why: a separate feature implies a separate machine to maintain, a separate
approval path, and a mode the member has to know to enter. The capability is
more valuable when it is always on. It also means we stop needing the two
gateway ops (`teach.context.get`, `teach.learning.apply`), the teach clarifier
port to cloud Pi, and the `PI_RUNTIME_BLOCKED_OPS` question entirely.

"Owner" is dropped as a word. The concerned party for a department skill is the
**manager**.

### D2 — Skills, not persona

Persona is a graph of rules only Divo reads: no title, no body, nothing a human
can look at and say yes to. A skill is a document with a name, a summary and
markdown. Since everything must be approval-gated, the approved object has to be
**readable** — that alone decides it.

### D3 — The approver is the department manager; a manager self-approves

*Settled 2026-08-17, re-confirmed under D1.*

| requester | personal scope | department scope |
|---|---|---|
| ordinary member | self-approve | goes to the department manager |
| department manager | self-approve | **self-approve** |

**Deliberate deviation from shipped policy:** `distinctApprover` is true for
department scope today, so a manager publishing to their own department needs a
*second* manager. We switch that to false when the requester already holds
`department_manager` authority over that department. A `KnowledgePolicy` row
change, not a code change — but it does remove a second pair of eyes on
department-wide behaviour. Recorded as a decision, not a drift.

### D4 — The run waits for video understanding; the wait is shown

*Settled 2026-08-17.*

Rejected the alternative (start the turn immediately, fetch evidence via a tool
call). A video being understood is shown as exactly that, with progress, and the
answer comes after.

Supported by what exists: the pipeline already reports named steps and the
desktop already renders them; and a web run **survives disconnection** — *"An
abort is the reader leaving… The run itself carries on server-side and will be
here when they come back"* (`admin/src/pages/workspace/chat/live.ts:372`). A
reload during a three-minute wait does not lose the recording.

Build-time consequence: `WebRunService.run` is an async generator feeding the
HTTP stream, so understanding progress must be emitted as run events — otherwise
a reader who returns mid-wait sees a blank thread.

### D5 — Video is understood natively, in any chat

*Settled 2026-08-17, re-confirmed under D1.*

Any member attaches a video in any chat and asks questions answered from its
context. Video stops being a refused extension.

Cost accepted knowingly: at most 40 calls to a small open-weights VL model plus
one transcription per five minutes of audio.

Follows from this: the 24 MB composer cap lifts for video on the *ordinary*
attachment path, so the streaming PUT becomes the normal route for video.

### D7 — Divo proposes only from an explicit correction

*Settled 2026-08-18.*

In a coding agent, editing a skill is free — nobody is interrupted. Here every
proposal spends a **manager's attention**, and the manager did not ask to be
involved. Unchecked, the same rough edge gets proposed by three different
members in a week, the manager gets nine near-duplicate cards, and starts
approving without reading. A rubber-stamped gate is worse than no gate.

Three brakes, in order of what they buy:

1. **Only from an explicit correction.** Divo may propose when a member tells it
   something was wrong or shows it a better way. It may **not** propose from its
   own reading of a skill. A correction has already passed a human filter; the
   agent's opinion has not.
2. **One open proposal per skill.** `KnowledgeMutation` already carries
   `targetKey` + `logicalKey` and takes an advisory lock on exactly that tuple.
   A second proposal against a skill with one pending merges into it rather than
   queueing behind it.
3. **`baseVersion` freshness** — already in the code. A proposal drafted against
   a stale skill fails at apply instead of silently overwriting.

Accepted cost: Divo will **not** spontaneously improve a skill it notices is
wrong. It waits to be told. That is a real narrowing of "if you feel you need to
update it, update it", taken deliberately because a manager's attention is the
scarce resource.

### D6 — We keep the understanding, not the video; both on the existing expiry

*Settled 2026-08-18.*

Two different things come out of an upload:

- **the recording** — hundreds of MB of someone's screen, face and voice
- **the understanding** — transcript, per-frame captions, screen text. A few
  pages, capped at 5 MB (`MANAGER_TEACH_EVIDENCE_MAX_MB`)

We are not a video store. The recording is deleted as soon as the understanding
exists — not 24 hours later, since nothing reads it again.

**Amended after building it.** There turned out to be two lifetimes, not one,
and the plan as written described neither:

- **The on-disk artefacts** — the extracted stills and the stored reading — age
  out on their own constant, `CONVERSATION_VIDEO_RETENTION_HOURS` (24h). Not the
  conversation-attachment TTL: the two are separate dials, because these files
  live in their own directory tree rather than in the attachment store.
- **What Divo remembers** lives as long as the thread. Because slice 4 was
  deferred, the excerpt is folded into the ask itself, and an ask is part of the
  conversation turn — it has to be, or the answer above it stops making sense on
  re-read.

So the earlier claim here — that a follow-up next week cannot be answered — is
wrong in both directions: the *reading* is gone, but the excerpt that was
actually used is still in the thread. Recorded plainly because a retention
review will read this section and act on it.

Three lifetimes already exist in an ordinary thread, and this simply joins the
third:

| What | How long | Where |
|---|---|---|
| Chat text | forever — no expiry, no prune | `DesktopThread` / `DesktopMessage` |
| Run trace | 7 days | `TRACE_RETENTION_DAYS` |
| Uploaded files | 24 hours | `CONVERSATION_ATTACHMENT_TTL_MS` |

**Consequence, recorded so it is a choice and not a surprise:** at 24 hours, a
follow-up question about last week's video cannot be answered — the
understanding is gone with the file, and `divo_watch_video` has nothing to read.
The window is one constant, so if that bites in practice it becomes 30 days
without any redesign.

### D9 — We are unlocking a capability, not building one

*Settled 2026-08-18.*

The self-updating-skill architecture **already exists and runs today**:

- the tool: `divo_knowledge_review`, in `runtime-manifest.json`'s allowlist and
  *not* channel-scoped, so the model is handed it on web and Lark alike
- the instruction, in the run prompt of every cloud Pi run
  (`run-prompt.ts:189`): *"When the user clearly finishes teaching a reusable
  procedure, prepare the corrected complete version and open the same review in
  the naturally implied scope"*
- the same again in `skills/divo-gateway/SKILL.md:77`, already carrying a brake:
  *"Do not save unfinished teaching, one-off task details, or unrelated
  conversation"* — which is D7 brake 1, already written

**And the backend refuses it anywhere but Lark.** `openVerifiedLarkKnowledgeReview`
guards on `member.channel !== 'lark' || !member.larkOpenId || !member.runtimeChatId
|| !member.runtimeRunId || !member.runtimeThreadId` and returns
`permissionDenied('Knowledge requester review requires an authenticated Lark Pi
runtime')`.

So today a member on the web finishes explaining a procedure, Divo does exactly
what it was instructed to do, and the call comes back denied — the "denial vs
absence" trap, where Divo then invents a confident wrong reason for not saving
what it was just taught.

The project is therefore two sentences:

1. Make `divo_knowledge_review` channel-agnostic by moving its pending state onto
   the decision module. The web card, thread card and approvals inbox then exist
   for free.
2. Make video an understood input in any chat, and keep only what was understood.

Everything else settled here (D3, D6, D7) is tightening what already runs.

### D10 — Understanding is eager; reading is a tool

*Settled 2026-08-18.*

The flow, end to end:

1. **Drop → upload.** The composer routes a video to the streaming PUT rather
   than the multipart path, and it uploads while the member is still typing.
2. **Understanding runs once, eagerly**, in the worker: ffmpeg scene-cut →
   frames, audio → chunked transcript, frames → OCR. This is the wait the member
   watches (`selecting_evidence → transcribing → reading_screens`). Output is one
   manifest, addressable by a handle.
3. **The turn starts** with the handle and a short précis — not the manifest.
4. **The agent calls `divo_watch_video(handle, question)`** to actually read it.

Step 4 cannot be replaced by inlining at step 3: the manifest is capped at 5 MB,
and pre-trimming at intake means choosing what to keep *before* knowing what was
asked. A tool call lets the model ask "what is on screen around 0:40?" and get a
budgeted slice with citations. The persona processor already solved this exact
budgeting problem for the same reason.

**The wait is for understanding; the tool is for reading.** Understanding happens
once and is expensive. Reading happens many times, is cheap, and still works on
the next turn.

Two modules, small interfaces, deep implementations:

- `understand(video) → Understanding` — ffmpeg, scene detection, chunked STT, OCR
  fan-out with partial-failure handling, behind two words. Runs in the worker.
- `read(handle, query) → excerpt` — budgeting, trimming, citation refs. This is
  the `divo_watch_video` tool.

Where the wait lives: `upload-intake` gains a fourth **classification** ("this is
a video, here is its handle") and stays fast; `WebRunService.run` awaits the
understanding before the first model turn. Intake cannot emit run events, so a
multi-minute path behind its interface would both lie about cost and be unable
to report progress — the run service can do both.

**Honest limit:** the route accepts **MP4, MOV and WebM only**. An `.avi` or
`.mkv` is rejected at the door even though ffmpeg downstream handles them fine.
That is a policy list, not a capability limit, so widening it is cheap — but
"any video" is not true today.

---

## The shape, in deep-module terms

Applying `/codebase-design` to what we settled:

**`LarkKnowledgeReviewService` fails the deletion test in the good direction.**
Its interface — what a caller must know to open a review — includes *"you must be
on Lark, with a `larkOpenId`, `runtimeChatId`, `runtimeRunId` and
`runtimeThreadId`"*, plus pending state in Redis that expires. That is transport
leaking into the interface of "ask a human to approve a change". Delete it and
complexity **vanishes** rather than reappearing at callers, because the decision
module already holds ask/answer/settle and already has a Lark courier. The seam
is real rather than hypothetical: two adapters exist across it (Lark courier, web
`DecisionCard`).

**`ManagerTeachMediaProcessor` is less deep than it looks.** The implementation
is genuinely deep. But its interface takes ten fields and seven of them
(`teachSessionId`, `companyId`, `departmentId`, `managerId`, `source`,
`originalFileName`, `evidenceDir`) are the caller's session bookkeeping, not the
video's. Understanding a video needs bytes. Shrinking the interface to
`understand(video) → Understanding` is leverage for the second caller we are
about to add, at no cost to the implementation.

**`upload-intake` keeps its shape.** It already documents three outcomes behind
one interface. Video becomes a fourth classification, and the interface does not
grow.

---

## Build log

### Slice 1 — the understanding module, extracted ✅ *2026-08-18*

Pure refactor, no behaviour change.

New module `src/application/video-understanding/`:

- `video-understanding.types.ts` — the value (`VideoUnderstanding`) and three
  ports (`VideoFrameExtractor`, `VideoTranscriber`, `FrameReader`)
- `video-understanding.service.ts` — `understand({ videoPath, workDir, assertActive?, onProgress? })`

**Interface: ten fields → two required, two optional.** The seven session fields
(`teachSessionId`, `companyId`, `departmentId`, `managerId`, `source`,
`originalFileName`, `evidenceDir`) are gone; none of them changed how a frame
was read.

Other changes in the same slice:

- **Progress is now the module's own 0–100.** It used to emit 35/55/70/95 —
  a slice of one Teach bar, which would have reported 35% for a fresh chat
  attachment before a frame was read. `manager-teach.service` maps it into
  30–95 via `INGESTION_READING_FLOOR`/`CEILING`.
- **The manifest write moved to Teach**, which owns the only part of it the
  reader could not produce — the `source` block. The reader no longer writes
  files it does not own.
- **`FrameReading` is declared in the application layer.** It used to be
  `VisionOcrResult`, imported from the OpenRouter adapter, which put the vision
  provider into the interface every caller had to learn. The adapter satisfies
  the shape now; it does not define it.
- `frame.reading` in the module, `frame.ocr` on disk — the manifest is a stored
  format the persona processor's schema already speaks, so the rename stops at
  that boundary rather than migrating files.

Renamed (none were ever teach-specific): `peepshow-manager-teach.extractor` →
`peepshow-video.extractor`, `openai-manager-teach.transcriber` →
`openai-video.transcriber`, `openrouter-manager-teach.ocr` →
`openrouter-frame.reader`. Deleted: `manager-teach-media.processor.ts`,
`manager-teach-media.types.ts`.

**Verified:** `tsc --noEmit` clean; **1,728 application tests pass, 0 fail**; new
`video-understanding.service.test.ts` covers frame ordering, one unreadable
frame surviving in place, silence reported rather than invented, every-frame
failure leaving no work directory behind, and a frame written outside the work
directory being refused.

### Slices 2 & 3 — video accepted, and the wait made visible ✅ *2026-08-18*

New module `src/application/conversation-video/` — a video attached to a
conversation, from arrival to answer.

- `PUT /api/web-chat/threads/:threadId/video` streams the body to disk
  (its own endpoint, because a recording does not fit the multipart ask and
  because starting early is what overlaps reading with typing)
- reading begins immediately, in the background, under a concurrency cap
- `POST /runs` carries `videoIds`; `WebRunService.run` awaits each reading
  before the first model turn, yielding a `watching` event as it goes
- a budgeted, question-relevant excerpt is folded into the model-facing text
- the recording is deleted as soon as the reading is written; readings are
  pruned on the retention sweep

Browser: video is an accepted kind with its own ceiling, uploaded ahead of the
ask, and the wait is shown as the live label.

### Slice 4 — `divo_watch_video` *(deferred, deliberately)*

Registering a typed tool needs backend tool-registry provisioning, which is not
in reach of this wave. Instead the excerpt is **inlined into the ask**, chosen
against the member's own question.

The honest cost: this answers the turn the video arrives on, and not a follow-up
three turns later. When the tool exists, `askNoticeFor` goes back to being a
summary and `excerptFor` — already written and tested — becomes the tool's body.

### The cold review, and what it caught

Five findings, all fixed, plus two more found while fixing:

1. **The ask named a tool that does not exist** while deliberately withholding
   the evidence "for" it — the model would have had a paragraph and no content.
2. **`watching` frames were dropped by the browser's parser allow-list**, so the
   wait would have shown nothing — the exact silence the event was added to end.
3. **Stop was inert during a reading.** No abort was threaded through, so the
   thread stayed busy and paid for OCR the member had cancelled.
4. **A single `videoIds` value failed the schema.** `/runs` is multipart, and
   `append-field` stores one occurrence as a *string* and only builds an array
   from the second — so attaching exactly one video, the ordinary case, would
   have 400'd the whole ask after the upload was already paid for.
5. **Reading was unqueued and uncapped**, where the Teach path it came from runs
   behind a worker with a concurrency limit.

Found while fixing:

6. **An unhandled rejection**: `void this.begin(...)` attaches no handler, so a
   reading that failed before anyone awaited it would take the process down.
7. **A prune that never swept.** `Date.now()` is whole milliseconds and
   `stat().mtimeMs` carries a fraction, so a directory written inside the
   current millisecond read as being in the future and was skipped by every
   window.

### Attachments, shown as themselves ✅ *2026-08-18*

One `FileCard` used by both the composer and the transcript. A pill with an icon
was the same drawing for a screenshot, a contract and a screen recording — three
things a reader tells apart instantly by looking. The card leads with a tile that
shows the thing itself where it can: the actual image, the recording's own first
frame via `preload="metadata"`.

The object URL is minted and revoked by the card that draws it, not at send
time — a URL made once outlives every card that ever showed it, and nothing at
that point knows when the last one goes away. A reload drops the bytes and the
card falls back to the typed tile, which is the ordinary case for anything not
sent in this tab.

### D8 — Replace the Lark-only skill review, with a staged cutover

*Settled 2026-08-18.*

The `knowledge` tool opens a `Decision` directly. `LarkKnowledgeReviewService`'s
bespoke card builder and Redis state machine are **deleted** — 1,048 lines gone,
not wrapped in an adapter.

Cheap rather than brave, because the decision module already has a Lark side:
`lark-decision.courier.ts`, `lark-decision-card.ts`,
`lark-decision-card.handler.ts`. Lark keeps its card, the web gains one, and the
Approvals page and home "up next" light up — all rendering from the same
`Decision`, which is the only reason they cannot drift apart. The two-step shape
(requester confirms, then the manager) is just two decisions, i.e. D3.

**Sequencing, because the risk is asymmetric.** Knowledge review works today on
Lark, in production. The web has nothing to lose; Lark does. So: build the
decision path → run it for web-originated proposals first → cut Lark over once
proven → delete the old service. Temporarily two paths, as a migration sequence
with a delete at the end — not as an architecture.
