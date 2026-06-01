# AirNote ⇄ Divo integration — build spec (AirNote side)

> Hand this whole doc to the AirNote agent. It is self-contained: you do **not** need the Divo
> codebase. Divo already has the server side built and tested. Your job is the **AirNote side**:
> capture the instruction, send it to Divo, stream the progress into the HUD, and render the answer.

---

## 0. What you're building (context)

AirNote is a macOS voice-dictation app. We're adding a **"Send to Divo"** channel. **Divo** is Emiac's
agentic ops assistant (it lives in Lark and can run Zoho / Google / Lark / web tools, with RBAC and
approvals). The feature:

1. User holds a configurable **hotkey (default: Ctrl on macOS), speaks an instruction, releases.**
2. AirNote transcribes it with its **existing** STT + polish pipeline → plain text.
3. AirNote sends that text to Divo over HTTP and **streams Divo's progress** back via **SSE**.
4. The **HUD** shows live status while Divo works (with a **hide** control — hiding does not stop it).
5. When Divo finishes, the HUD shows a **"Divo (1)"** notification; clicking it opens a **panel**
   (larger than a normal HUD panel) that renders Divo's answer as **markdown**, with a
   **spoken follow-up** option.

**Divo only ever receives text and sends back events + a final markdown answer.** There is no audio,
no STT, and no TTS on the Divo side — all of that stays in AirNote.

---

## 1. Server base URL

**For now, point AirNote at the local Divo dev server:**

```
DIVO_BASE_URL = http://localhost:8000
```

| Env | Base URL | Notes |
|---|---|---|
| **Local dev (use this now)** | `http://localhost:8000` | Divo runs locally via its dev script (`pnpm dev` / `scripts/dev.sh`, tsx watch). The full endpoint is `http://localhost:8000/api/airnote/chat`. |
| Production (later) | `https://divo.outreachdeal.com` | Not deployed yet — switch the base URL once the AirNote channel ships to prod. |

Make the base URL a **single config value** (env var / setting) so flipping local → prod is one change.
All paths below are relative to it.

**CORS / where to make the call:** make the request from **AirNote's Rust side** (e.g. `reqwest`) — Rust
HTTP clients are not subject to browser CORS, so localhost works with no extra setup. If you instead
call from the Tauri **webview** (JS `fetch`/`EventSource`), the browser will enforce CORS and the local
`http://localhost:8000` origin would need allow-listing on the Divo server — so prefer the Rust path
(it's also what §8 recommends for SSE streaming).

---

## 2. Authentication — use AirNote's own Lark login

AirNote and Divo authenticate against the **same Lark app / org**, so the Lark `open_id` is a shared
identity key. **You do not create or store any Divo-specific token.**

On **every** request to Divo, send the signed-in user's **Lark `user_access_token`** (the same one
AirNote already obtains from its Lark OAuth) as a Bearer token:

```
Authorization: Bearer <lark_user_access_token>
```

Divo verifies that token against Lark, derives the trusted `open_id`, and resolves the Divo user.

**Error handling:**
- `401 {"error": "..."}` → the Lark token is missing/expired/invalid → run your normal Lark OAuth
  refresh and retry once.
- `403 {"error": "This Lark user is not connected to Divo yet. Open Divo in Lark once to link your account."}`
  → the user has never used Divo → surface this message; they must open Divo in Lark one time, then retry.

---

## 3. Send an instruction — `POST /api/airnote/chat`

**Request**

```
POST /api/airnote/chat
Authorization: Bearer <lark_user_access_token>
Content-Type: application/json
Accept: text/event-stream
```

```jsonc
{
  "requestId": "f1e2-...-uuid",   // REQUIRED. Unique per turn (generate a UUID each send).
  "message":   "What were our top 3 expenses last month?",  // REQUIRED. The transcribed+polished text.
  "threadId":  "abc-...-uuid",    // OPTIONAL. OMIT on a fresh hotkey press. SEND the same id for a follow-up.
  "mode":      "high"             // OPTIONAL. "high" (default) or "fast" (snappier/cheaper).
}
```

- Missing `requestId` or empty `message` → `400 {"error":"requestId and message are required"}`.

**Response: Server-Sent Events** (`Content-Type: text/event-stream`). The connection stays open for the
whole run and closes after a terminal event. Each frame is:

```
event: <name>
data: <single-line JSON>

```

Heartbeat comment lines (`: ping`) arrive ~every 15s — **ignore** them.

### Event vocabulary (exact shapes)

| `event:` | `data:` JSON | Meaning / what to do |
|---|---|---|
| `meta` | `{ "threadId": "...", "requestId": "..." }` | **First frame.** Store `threadId` — you'll send it back for follow-ups. |
| `status` | `{ "phase"?: string, "liveLabel"?: string, "progressPct"?: number, "plan"?: [{ "status": "pending\|running\|done\|failed\|skipped", "title": string, "subtitle"?: string, "toolFamily"?: string }] }` | Rolling progress. `liveLabel` is the best single line for the HUD (e.g. "Searching Zoho Books…"). Fields are optional/partial — merge into your current state. |
| `thinking` | `{ "text": string }` | Model narration sentence. |
| `tool.start` | `{ "callId": string, "name": string, "family": string, "args": object, "verb"?: string }` | A tool began (e.g. `name:"zohoBooks"`, `verb:"Searching invoices"`). |
| `tool.end` | `{ "callId": string, "name": string, "ok": boolean, "durationMs": number, "past"?: string }` | That tool finished (`past` = past-tense label, e.g. "Searched invoices"). No raw output is sent. |
| `text` | `{ "delta": string }` | Streamed partial answer text. Optional to render live; you may ignore and just use `done`. |
| `done` | `{ "message": { "id": string, "threadId": string, "role": "assistant", "content": string, "createdAt": ISO8601 }, "format": "markdown" }` | **Terminal.** `content` is the final answer in **GitHub-flavored markdown** — render this in the panel. |
| `error` | `{ "message": string }` | **Terminal.** The run failed; show the message. |

After `done` or `error` the server ends the stream.

### Approvals (important)

Some Divo actions require a manager's approval. When that happens, you'll receive a `status` with
`phase: "awaiting_approval"` (and a `liveLabel` like "Sent to <manager> for approval in Lark"), and then
the stream ends **without** a `done`. The approval is handled **inside Lark** (the manager approves in
their Lark DM). For v1, show "Pending approval in Lark"; the user gets the result in Lark, and you can
re-fetch the thread later (see §5) to pick up the answer once it lands.

---

## 4. Conversation model — fresh task per press, follow-up continues

- **Each new hotkey press = a fresh task.** Send `POST /chat` **without** `threadId`. Divo creates a new
  thread and returns its id in the `meta` frame.
- **The spoken follow-up (from the panel) continues that task.** Send `POST /chat` **with** the
  `threadId` you got from `meta`. Divo loads that thread's history so the follow-up has full context.
- Do not reuse a `threadId` across unrelated hotkey presses.

---

## 5. Recovery & "Divo (1)" after disconnect — `GET /api/airnote/threads/:threadId`

Hiding the HUD does **not** close the SSE connection — keep consuming; just stop rendering. But if the
socket actually drops (app closed, network), **Divo still finishes the run and persists the answer.**
To recover the answer (also used for the post-approval result):

```
GET /api/airnote/threads/<threadId>?page=1&pageSize=50
Authorization: Bearer <lark_user_access_token>
```

```jsonc
// 200
{
  "success": true,
  "data": {
    "id": "abc-...", "channel": "airnote", "title": "...",
    "createdAt": "...", "updatedAt": "...", "lastMessageAt": "...",
    "messages": [
      { "id": "...", "threadId": "...", "role": "user|assistant", "content": "...", "metadata": {...}|null, "createdAt": "..." }
    ],
    "pagination": { "page": 1, "pageSize": 50, "totalMessages": 4, "totalPages": 1 }
  }
}
// 404 {"success":false,"message":"Thread not found"}  // if not yours / doesn't exist
```

The latest `role:"assistant"` message's `content` is the markdown answer. Use this to drive the
"Divo (1)" badge when an answer arrives while the HUD was hidden or after an approval.

---

## 6. What is NOT available on this channel

- **No terminal / shell execution.** Divo's `runCommand` tool is disabled for AirNote. You will never
  receive a terminal exec request and don't need to handle one.
- **No file attachments** in v1 (text only).

---

## 7. Product behaviors AirNote must build

1. **Hotkey** — configurable, **default Ctrl on macOS**. Hold-to-talk; on release, run your existing
   STT + polish, then `POST /chat` (omit `threadId`).
2. **HUD live view** — render the rolling `status`/`thinking`/`tool.*` stream (e.g. show `liveLabel` and
   optionally the `plan` checklist). Include a **hide** control. Hiding must keep the SSE connection
   alive and the run going.
3. **"Divo (1)" badge** — when `done` arrives (or an answer is found via §5 after the HUD was hidden),
   show a notification badge.
4. **Response panel** — clicking the badge opens a panel **larger than a normal HUD panel** that renders
   `done.message.content` as **markdown** (GFM: headings, lists, tables, code).
5. **Spoken follow-up** — a button in the panel that records a follow-up, transcribes it, and
   `POST /chat` **with the same `threadId`**, streaming into the same panel.

---

## 8. Rust / Tauri implementation notes

- Use `reqwest` with a streaming response (`.bytes_stream()`), or an SSE client crate
  (e.g. `reqwest-eventsource`), to read frames as they arrive. **Do not** buffer the whole response.
- Parse SSE: split on blank lines; for each block read the `event:` line and the `data:` line; `data`
  is single-line JSON. Lines starting with `:` are heartbeat comments — skip.
- Keep the read loop alive for the whole run; treat `done` and `error` as terminal and then close.
- Generate `requestId` as a UUID per send. Persist the active `threadId` in memory for the panel's
  follow-up; clear it when a new hotkey press starts a fresh task.
- On `401`, refresh the Lark token and retry the request once; on `403`, surface the "open Divo in
  Lark once" message.

---

## 9. End-to-end example

**Send (fresh press):**
```
POST /api/airnote/chat
Authorization: Bearer u-xxxxxxxx
Content-Type: application/json

{ "requestId": "11111111-1111-1111-1111-111111111111",
  "message": "Summarize this month's overdue invoices in Zoho Books." }
```

**Stream (illustrative):**
```
event: meta
data: {"threadId":"a1b2c3","requestId":"1111...."}

event: status
data: {"liveLabel":"Thinking…","progressPct":8}

event: tool.start
data: {"callId":"t1","name":"zohoBooks","family":"zoho","verb":"Searching overdue invoices","args":{...}}

event: tool.end
data: {"callId":"t1","name":"zohoBooks","ok":true,"durationMs":1430,"past":"Searched overdue invoices"}

event: status
data: {"liveLabel":"Writing the answer"}

event: done
data: {"message":{"id":"m9","threadId":"a1b2c3","role":"assistant","content":"### Overdue invoices\n\n| Client | Amount |\n|---|---|\n| Acme | ₹1,20,000 |\n...","createdAt":"2026-06-01T..."},"format":"markdown"}
```

**Follow-up (same panel):**
```
POST /api/airnote/chat
{ "requestId":"2222....", "threadId":"a1b2c3", "message":"And the month before?" }
```

---

## 10. Acceptance checklist (AirNote side)

- [ ] Hotkey (default Ctrl) hold-to-talk → transcribe → `POST /chat` with no `threadId`.
- [ ] SSE parsed incrementally; `meta.threadId` stored; heartbeats ignored.
- [ ] HUD shows live `status`/`thinking`/`tool.*`; **hide** keeps the stream + run alive.
- [ ] `done` → "Divo (1)" badge → panel renders markdown (incl. tables/code).
- [ ] Follow-up sends the same `threadId` and streams into the same panel.
- [ ] `401` → refresh Lark token + retry; `403` → "open Divo in Lark once" message.
- [ ] If the stream drops, `GET /threads/:id` recovers the latest assistant answer.
- [ ] No handling needed for terminal/tool execution (not sent on this channel).
```
