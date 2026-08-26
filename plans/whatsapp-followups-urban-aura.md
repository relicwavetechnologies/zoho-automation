# WhatsApp Follow-ups for Urban Aura — Integration Plan

Status: proposed. Nothing built yet.
Source being absorbed: `whatsapp-followup-agent` (gitignored local clone at repo root, 1,651 LOC, MIT).

---

## 1. What this is

Urban Aura's event-management team runs its client and vendor work through
roughly **ten WhatsApp numbers**. Nothing watches those threads. Promises made
in passing, questions nobody answered, and dates mentioned once are held in ten
people's heads.

This brings that under Divo: read those numbers' chats, work out what is still
outstanding, and post it **into one Lark group** on a schedule with a button
that opens a Divo web page for managing it.

It is deliberately **not** a WhatsApp chatbot. Divo does not answer anyone on
WhatsApp. It reads, tracks, and reports — with one exception the team asked for
explicitly, bulk sending, which is a human-initiated broadcast, not the agent
replying (§11).

## 2. Why this belongs in Divo rather than beside it

Divo already does this shape once, for mail. `application/mail-ops/` ingests
external comms as rows, matches rules, and a claimed, scheduled runner composes
one LLM brief and delivers it to Lark. `mail-brief.ts` says out loud what it
does not answer:

> "A third question, *what you are waiting on* — mail you sent that nobody
> answered — is deliberately unanswered... It is a wave of its own, not a
> paragraph of this one."

**Follow-ups is that wave.** WhatsApp is its first source. Every hard part —
claim tokens, window advancement, Lark delivery, approval gating, RBAC — is
already solved in this codebase and should be copied in shape, not reinvented.

The imported agent's real value is narrow and worth naming precisely, because
everything else in it is plumbing Divo already has better:

1. **The analysis contract.** Each pass is handed the items already tracked for
   that chat *with their ids*, and must return each one refreshed under the same
   id, list it as resolved with a reason, or stay silent. That is what stops the
   same follow-up being recreated every pass, and what lets "sent it just now"
   close an item with nobody touching it.
2. **The quiet-window discipline.** A chat is only analysed after it has been
   silent for a few minutes, and never more often than a cooldown. Reading a
   conversation mid-flow produces follow-ups the next three messages resolve.
3. **The prompt.** Ownership is binary and mandatory (`me` / `them`); confidence
   discipline is explicit; code-switched Hinglish is read as intent, not noise.

Those three port almost verbatim. The SQLite store, the Express dashboard, the
bespoke OpenRouter/Anthropic client, and the in-process `setInterval` loops do
not — Divo has Postgres, an admin web app, a model catalog, and BullMQ workers.

## 3. The traps, and the simplification

The first three do not exist in the original, because the original serves one
person with one phone and can afford to fail quietly. All three are created by
"ten numbers, one shared group". The fourth is the decision that makes the rest of
the design smaller.

### 3.1 The same group chat, seen from several numbers

If four Urban Aura staff sit in *Urban Aura — Project Team*, four linked
sessions each ingest the same messages and each produce their own follow-ups for
them. The group digest then shows every item three or four times, and "you owe"
is ambiguous — which *you*?

**Resolution: a chat is read through exactly one session.** `WhatsappChat` is
keyed `(companyId, waChatId)`, not `(sessionId, waChatId)`. The first session to
see a chat claims it. Messages from a non-claiming session for an already-claimed
chat are dropped at ingest with a counted reason, not silently. The transcript's
`from_me` is then unambiguous.

This is **de-duplication, not assignment**. It records which handset Divo read a
chat through; it never says whose job the resulting follow-up is. Nothing in this
system is assigned to a person (§3.4), and this constraint is required regardless
&mdash; without it the digest carries every item once per handset in the group.

This is the single highest-risk detail in the whole integration. Get it wrong
and the digest is unreadable on day one.

### 3.2 The stream can stop without anyone noticing

Message *arrival* in the imported tool is genuinely pushed, not polled:
`ensureWebhook()` (`src/openwa.js:85`) subscribes to `message.received` and
`message.sent` at startup, and `POST /webhook` (`src/server.js:13`) receives them,
HMAC-verified. Everything downstream is polled on a timer — the analysis sweep,
the nudge tick and the chat-name refresh, all `setInterval` in
`src/index.js:82-95`.

The problem is what happens when the push stops. `chatHistory` is called from
exactly one place, `backfill.js:35`, and backfill runs **once ever** — gated on a
`backfilled_at` marker (`src/index.js:74`). There is no reconcile, no gap
detection, and no re-attempt of the subscription beyond the single call at boot.
A lost webhook registration or a run of dropped deliveries stops messages
arriving, and nothing in the tool can tell that apart from a quiet week.

**Resolution: two additions the original does not have.**

1. **Periodic reconcile.** Per number, re-read recent history on a slow timer and
   upsert whatever is missing. Messages are idempotent by `waMessageId`, so this
   is safe to overlap with the live stream. It bounds data loss to one reconcile
   interval instead of "until somebody happens to notice".
2. **Staleness as an alarm.** A session that has delivered nothing for longer
   than its normal quiet period is *suspect*, not idle. It surfaces on the
   Numbers page and in the digest's health card (§8).

One person watching their own phone eventually notices the tool has gone quiet.
Ten numbers feeding a shared group will not — which is the same reason §8 emits a
health card when a number has nothing, rather than emitting nothing.

### 3.3 Personal DMs leaking into a team group

The imported agent analyses **every chat by default**, DMs included, and reports
to the account holder alone. Here the report goes to a shared Lark group. Ten
personal numbers analysed on the default settings means a staff member's private
DMs become team-visible summaries.

**Resolution: invert the default, and keep it blunt.** Groups are read; direct
messages are not read at all. `ANALYZE_DMS` defaults false. A DM becomes readable
only when the team switches on that named conversation in the web app &mdash; a
vendor thread, never a personal one.

Per-person opt-in was the obvious alternative and it does not apply here: there
is one shared pool with no per-member mapping (§3.4), so there is no private
audience for a DM to stay private to. Off by default is both simpler and safer.
Message bodies are stored for the analysis window and then pruned (§10).

Say this to the team before a single number is linked. It is a consent question,
not a config question.

### 3.4 One pool, nothing assigned — decided

Follow-ups are **not** mapped to Divo members. There is one team-wide pool: every
UA member sees every item across all ten numbers, and any of them can mark any
item done, snoozed or dismissed. No `assignedUserId`, no per-member filtering, no
"mine vs theirs" anywhere in the schema or the UI.

This is a deliberate simplification, and it survives contact with the design
because the analyzer's ownership was never per-person to begin with. `owner` is
binary — `me` or `them` — where `me` is *the account holder of the handset that
read the chat*. With ten handsets that is not a person, it is **the Urban Aura
side of the conversation**. So the field is kept as-is and only its label changes:

| Analyzer value | Rendered as |
| --- | --- |
| `owner: "me"` | **We owe** — somebody on the team committed to this |
| `owner: "them"` | **Waiting on \<counterparty\>** — we are blocked |

One consequence in the prompt: the imported system prompt writes in the second
person ("you committed to sending..."), which is right for one person reading
about their own phone and wrong for a room where nine of ten readers are not that
person. **It writes in the first person plural instead** — "we committed to
sending…", "Rahul asked us directly". That is one line of the prompt, and it is
the only edit the shared-pool decision forces on the analysis itself.

The team decides between themselves who picks an item up, exactly as they do now.
Divo's job is to make sure nothing is dropped, not to allocate it.

If assignment is ever wanted it is one nullable column and one action, added
without reshaping anything here — but it is not built now and the digest format
is fixed on the assumption that it does not exist.

## 4. Where this sits in Divo

Divo has four shapes of feature. This is the third, and the third currently has
exactly one member.

| Shape | Started by | What it is |
| --- | --- | --- |
| **Turns** | a member, now | Someone asks; a run executes and answers. `lark`, `web` |
| **Scheduled work** | a member, in advance | A described task, re-run on a cron as a full agent turn under the creator's authority, DM'd back. `ScheduledWorkflow` |
| **Watched sources** | nobody | Divo continuously reads a system the team already works in and reports what matters. Mail Ops — **and this** |
| **Capabilities** | the agent, mid-turn | Tools and skills used while answering |

### Why not Scheduled Work

It looks like scheduling — "twice a day, post the follow-ups" — but three things
block it, and two are deliberate design properties we should not weaken.

1. **It cannot post to a group.** `buildScheduledExecutionPrompt` rewrites the
   task prompt at run time to deliver to the creator's DM and to *"ignore any
   delivery destination named in the task above, including an originating
   conversation, group, or channel"* (`scheduled-workflow.service.ts:72`). The
   service comment is explicit: *"Only the creator's DM: a scheduled result is
   delivered nowhere else."* Our target is a group.
2. **There is no creator.** A `ScheduledWorkflow` belongs to the member who
   authored it and runs under their permissions. Follow-ups are a team pool with
   nobody assigned (§3.4); no member's authority should gate the group's card.
3. **Wrong machine.** Each firing is a full Pi container run. The digest needs
   *zero* model calls (§9) — it renders rows we already hold.

And the continuous half is not schedulable at all: quiet windows, per-chat
cooldowns and reconciliation are background-service timing, not a recurring
instruction a member could write down.

### Why not a runtime channel

`RUNTIME_CHANNELS` is the set of surfaces the backend drives a *Pi run* on. No
run ever happens on WhatsApp — Divo never answers a client, never takes an
instruction from there. A `ChannelAdapter` would have to stub `sendStatus`,
`sendFinalReply` and `parseIncoming`. WhatsApp is a data source, exactly as Gmail
is. `ChannelKey` is unchanged.

### Divo is a poster in the Lark group, not a participant

Posting into a room Divo is not conversing in is already a solved capability: a
mail rule can deliver into a Lark chat today, guarded by
`createLarkChatDestinationAuthorizer`, which grounds the `chatId` in a room Divo
has actually observed and refuses rooms belonging to another company on the same
Lark install. The digest reuses that path unchanged.

**Setup is therefore one step: add Divo to the UA group.** That is what writes
the room record which makes the group a legal destination.

Two consequences worth stating:

- Untagged group messages are ambient context; Divo does not reply to them
  (`lark-untagged-policy.ts`). In that room it posts and nothing else.
- But Divo is a normal Lark bot, so **if somebody @mentions it there they get a
  normal Divo turn.** That is existing behaviour rather than something this
  feature adds — likely useful, but it should be known rather than discovered.

The interaction model is therefore: **the group is output, the web app is where
you act.** That is why the card carries a button.

### Same shape as Mail Ops, part for part

| Piece | Mail Ops | WhatsApp follow-ups |
| --- | --- | --- |
| Source | Gmail push → `MailEvent` | Gateway webhook → `WhatsappMessage` |
| Per-account | `MailboxSubscription` | `WhatsappSession` ×10 |
| Worker | claims, batches, lanes | identical pattern |
| Schedule | `MailBrief` | `FollowUpDigest`, copied field for field |
| Runner | read → compose → send → advance | same four steps, same ordering rule |
| Delivery | Lark DM, one card | Lark **group**, one card per number |
| **Model call** | at **delivery** — composing the brief | at **ingestion** — analysing each chat; delivery is free |

That last row is the only real divergence. Mail arrives structured — sender,
subject, snippet — so the hard question is *which of these matters*, asked once
at delivery. A chat arrives as unstructured talk, so the hard question is *what
does this mean*, asked per chat as it happens.

**Do not extract a shared framework yet.** Two watched sources make the category
real where one was a hypothesis, so it is worth naming in `CONTEXT.md`. But the
two differ in exactly the ways a premature abstraction would flatten — where the
model call sits, DM versus group, rules versus none. Build in the same shape,
name the pattern, let a third source justify the extraction (AGENTS.md rule 4).

## 5. Shape of the thing

```txt
10 phones ──▶ divo-openwa (container, one session per number)
                   │  webhook (HMAC)
                   ▼
        POST /api/whatsapp/webhook  ──▶ IngressIdempotencyKey ──▶ BullMQ
                   │                     (channel='whatsapp')
                   ▼
        whatsapp-ingest.worker  ──▶ WhatsappChat / WhatsappMessage (Postgres)
                   │
                   ├─ follow-up analysis worker (claimed, batched)
                   │     chats quiet ≥ N min, past cooldown, owned session
                   │     └─▶ one LLM call per chat ──▶ FollowUp rows
                   │
                   └─ follow-up digest runner (claimed, scheduled)
                         └─▶ Lark group card + "Manage follow-ups" button
                                        │
                                        ▼
                          admin web app  /followups
                          numbers · follow-ups · chats · bulk send
```

## 6. Where the code goes

Follows `http -> application -> domain <- infrastructure` and the mail-ops
precedent exactly.

| Path | What it is |
| --- | --- |
| `src/domain/follow-ups/` | `FollowUp`, `FollowUpKind`, `FollowUpOwner`, the analysis result types and their invariants |
| `src/application/follow-ups/follow-up-analysis.ts` | The prompt, the zod schema, the incremental id contract. Ported from `analyzer.js`. Pure — takes a transcript and tracked items, returns a result |
| `src/application/follow-ups/follow-up-analysis.worker.ts` | Claim, batch, sweep. Mirrors `MailOpsWorker` |
| `src/application/follow-ups/follow-up-digest.ts` | Composes the digest markdown. Mirrors `mail-brief.ts` |
| `src/application/follow-ups/follow-up-digest.runner.ts` | Read window → compose → send → advance. Mirrors `mail-brief.runner.ts` |
| `src/application/follow-ups/follow-up-digest.schedule.ts` | Times/days/timezone. Reuses `zonedDateTimeToUtc` from `application/scheduling/schedule-calculator.ts` |
| `src/application/whatsapp/whatsapp-ingest.worker.ts` | Normalise + persist + claim the chat. Mirrors `lark-ingress.worker.ts` |
| `src/application/whatsapp/whatsapp-reconcile.worker.ts` | The safety net §3.2 asks for: periodic history re-read per number, plus session staleness |
| `src/application/whatsapp/whatsapp-session.service.ts` | Create/start/pair/status for the ten sessions |
| `src/infrastructure/whatsapp/openwa.client.ts` | The gateway client. Ported from `openwa.js` — keep its 429 backoff, it is correct |
| `src/infrastructure/whatsapp/whatsapp-webhook.security.ts` | HMAC verify. Port `verifySignature` as-is |
| `src/infrastructure/persistence/follow-ups.repository.ts` | Reads/writes, claim/release |
| `src/http/whatsapp/whatsapp.webhook.routes.ts` | The one public ingest route |
| `src/http/member/follow-ups.routes.ts` | What the web app calls |
| `admin/src/pages/workspace/followups/` | The new tab (§8) |

**No source-adapter interface.** There is one source today. `FollowUp.source`
is a column so mail can join later; a column is not an abstraction. Per
AGENTS.md rule 4, the seam gets built when the second adapter actually exists.

## 7. Data model

New Prisma models, all `companyId`-scoped:

- **`WhatsappSession`** — `companyId, label, openwaSessionId, phoneE164?, status, ownerUserId?, lastSeenAt`. Ten rows.
- **`WhatsappChat`** — `@@unique([companyId, waChatId])`, plus `owningSessionId, name, isGroup, analysisEnabled, lastMessageAt, lastAnalyzedAt, lastAnalyzedMessageAt, muted`. §3.1 lives in that unique key.
- **`WhatsappMessage`** — `@@unique([companyId, waMessageId])`, plus `chatId, senderName, fromMe, body, type, quotedText, occurredAt`. Pruned on a retention sweep.
- **`FollowUp`** — the agent's `followups` table, typed: `title, detail, kind, owner, counterparty, dueDate, urgency, confidence, evidenceJson, suggestedReply, status, resolvedReason, remindAt, remindCount, lastRemindedAt, source`. `owner` is the binary `me`/`them` from the analyzer — the UA *side*, not a member (§3.4). **There is no `assignedUserId`.**
- **`FollowUpDigest`** — one row per destination: `larkChatId, timesJson, daysJson, timeZone, status, nextRunAt, coveredThrough, claimToken, claimedAt`. Copied field-for-field from `MailBrief`, including the reasoning on `coveredThrough` — a run missed to an outage must widen the next digest, not drop the gap.
- **`FollowUpDigestCard`** — one row per number per delivered run: `digestId, sessionId, sentAt, itemCount, cardText`. The digest is N cards now (§8), so "what did Divo last tell the group" is per-number; a single `lastDigestText` on the parent would only ever hold whichever card was sent last.

**Reuse `IngressIdempotencyKey`.** It is already `@@unique([channel, tenantKey, messageId])`. WhatsApp fits with `channel='whatsapp'`, `tenantKey=<openwa session id>`, `messageId=<wa message id>`. No `seen_deliveries` equivalent gets built.

`ChannelKey` stays `'lark' | 'desktop' | 'airnote' | 'web'`. WhatsApp is **not** a runtime channel — no Pi turn ever runs on it, so it earns no `ChannelAdapter` and no entry in `RUNTIME_CHANNELS`. It is a data source, like Gmail.

## 8. The web app tab — built

Workspace route **`/me/follow-ups`**, under a new **Watching** nav group beside
Mail. Screen in `admin/src/pages/workspace/followups/`, hooks and pure logic in
`pages/workspace/data/`, per the Admin Standards in AGENTS.md.

Three tabs, not four — bulk send is wave 5 and may never happen (§11).

1. **Open** — every outstanding item, one shared pool. `Done` is an inline
   button; snooze (tomorrow / a week) and *"Not a follow-up"* sit behind the row
   menu. Dismiss is deliberately worded apart from Done: "we finished this" and
   "this was never a real commitment" are different facts, and only the second
   says the analysis was wrong. There is no assignee, by §3.4.

2. **Numbers** — each handset and whether Divo is actually reading it, across
   five states (§3.2). **Link a number** runs the pairing flow: name it, which
   creates the gateway session *and registers the webhook* before anything is
   scanned, then poll for the QR.

   **QR first, pairing code beside it — not the code alone**, which is what an
   earlier draft of this section said. The reason for the original preference
   still stands (the QR rotates about every twenty seconds), and the poll is what
   answers it: the dialog re-reads every three seconds and never caches one, so
   what is on screen is current. The code is offered in the same dialog rather
   than hidden as a fallback, because a camera that will not focus is the common
   failure and hunting for the alternative is where people give up.

   The gateway may return either a rendered image or the raw payload a QR
   encodes. The server labels which (`kind: 'image' | 'payload'`), so the screen
   never puts a `2@…` string into an `<img src>` — a broken image reads as
   "linking is broken" rather than "use the code instead".

3. **Chats** — every conversation seen, each with a switch. **On by default,
   including DMs** (Decided 6). Switching one off stops it being read from the
   next sweep.

A number that is not being read raises a banner **above the tabs**, not inside
Numbers: it makes every count on the Open tab an undercount, and somebody
looking at Open would otherwise never find out.

### Closing an item has to stay closed

The one non-obvious part of the actions. `trackedFor` sends the model recently
closed items as well as open ones, labelled, and the prompt says not to raise
them again; `applyPlan` separately refuses to reopen a non-open row by id.

Without the first half the failure is silent and total: the model cannot see a
dismissal, re-reads the same transcript, and files the same commitment as new
with a fresh id. The team sees a dismiss button that does not work, and nothing
connects the returning row to what they cleared. Bounded to fourteen days, which
covers the transcript window several times over.

### One card per number

The pool is unioned; the delivery is not. The digest runner groups everything
currently due **by owning number, then by chat**, and sends one card per number
that has something. A number with nothing due sends nothing — ten numbers twice a
day is twenty messages, and a group nobody reads is worth less than no group.

That creates one gap, and it has to be closed explicitly: once "no card" means
"nothing due", a disconnected handset disappears from the group at exactly the
moment somebody should be told about it. So **session health is its own card** —
red, emitted only when Divo has lost sight of a number. Same reasoning as §3.2:
a tool that has stopped seeing has to say so.

The button is a plain `open_url` action to
`${APP_BASE_URL}/me/follow-ups?number=<sessionId>` — deep-linked **filtered to that
number**, so tapping the Vendor Desk card does not land somebody in the whole
team's list. `InteractiveAction` in `domain/channel/outbound.ts` already carries a
`url` and the card builder already emits `open_url` behaviours, so this is
configuration, not new capability. Splitting one digest into N cards is a loop
around the send, not a second implementation.

## 9. Model usage and cost

**There is exactly one model call in the system**, in stage 05 of §5: read one
chat's window, reconcile against the items already tracked, return the
difference. The digest is string building over rows we already hold —
`reminders.js` in the imported tool makes zero model calls, unlike the mail
brief, which does summarise. Nudge timing, de-duplication and health checks are
all deterministic. So the bill is one number times how often one thing happens.

### The gates

A chat must pass all five before it costs anything (defaults from
`src/config.js`):

| Gate | Default | What it stops |
| --- | --- | --- |
| New messages only | — | Dormant chats cost zero, forever |
| Quiet window | 3 min | Reading mid-conversation — also the quality gate |
| Cooldown | 30 min | **The hard ceiling: ≤48 calls per chat per day** |
| Minimum messages | 2 | A one-message chat is stamped read and skipped *without* a call |
| Chats per sweep | 8 | Burst; a busy morning queues instead of spiking |

A sixth is structural: **the §3.1 union is a cost control.** Four UA handsets in
one client group would otherwise mean four calls for the same conversation. On
this team's groups that is close to a 4× reduction on shared chats.

### Estimates

~20 watched group chats, ~2.5k input / ~900 output per call (the imported tool's
README quotes ~2k/~900 for a typical window), Claude Opus 5 at $5/$25 per MTok:

| Scenario | Calls/day | Per day | Per month |
| --- | --- | --- | --- |
| Quiet week — 5 chats live | ~30 | ~$1 | ~$32 |
| Event week — 10 chats live, 10h day | ~200 | ~$7 | **~$210** |
| Hard ceiling — all 20 busy every 30 min, 24h | 960 | ~$34 | ~$1,010 |

The ceiling row is arithmetic, not a forecast — it needs twenty client groups
being typed in at 3am. Its value is that it *exists*: no burst of WhatsApp
activity can produce a surprise bill, because the cooldown caps spend per chat
independent of volume.

Divo already meters model spend per company in `AiTokenUsage`. Analysis calls are
written into it tagged by number and chat, so cost is a query, not a guess, and a
runaway chat is visible before it is a bill.

### Levers — decide in wave 2, with real transcripts

1. **`output_config.effort`.** The biggest safe lever. Output is 5× the price of
   input and ~two-thirds of the bill; effort defaults to `high`, and this is a
   bounded extraction against a strict schema — the profile where `medium` or
   `low` often holds. Measure it.
2. **Model.** Opus 5 is the default and the basis of the table. Sonnet 5 is ~40%
   cheaper per call, Haiku 4.5 ~80%. But the judgement is subtle — reading
   Hinglish as a deferred commitment rather than small talk, and holding
   confidence discipline. Wave 2 exists to judge quality; run two models over the
   same chats and let the team choose. Do not downgrade on price alone.
3. **Cooldown and window.** 30 → 60 min halves the ceiling; 5 → 3 days narrows
   input. For follow-ups measured in days, both are probably free.
4. **Batch API.** Half price, asynchronous. Analysis is not latency-critical, but
   worst-case turnaround can miss a digest slot. Evaluate once volume is real.

### What does not help: prompt caching

Caching needs a stable prefix of roughly 1,024 tokens. The system prompt here is
**~460 tokens** — under the floor — and everything after it is a different chat's
transcript on every call. There is no shared prefix to cache. This is worth
recording because caching is the first thing any reviewer will suggest, and this
workload is the shape it cannot help.

## 10. Retention and privacy

- Message bodies live only as long as the analysis window needs them. Mirror the
  `MAIL_EVENT_BODY_RETENTION_MS` / `MAIL_EVENT_RETENTION_MS` split already in
  `mail-ops.types.ts`: bodies pruned first, envelopes kept longer for counting.
- `FollowUp.evidenceJson` holds short verbatim quotes and outlives the messages
  by design — an item you cannot justify is an item nobody trusts. Cap quote
  length.
- Chat content goes to whichever model the company's catalog resolves, in
  windows of up to sixty messages per analysed chat. Nothing else leaves.
- The digest is group-visible. §3.2 is the control.

## 11. Bulk sending — built 2026-08-26

The team asked for bulk sending from the web page, and it is now the fourth tab
on `/me/follow-ups`. Two things made it the heaviest item here, and both shaped
what got built.

1. **It is a write with blast radius.** It is also the *only* write: there is no
   single-message send anywhere in the client, deliberately, because a
   convenient `sendText` beside a broadcast is how "the follow-up agent never
   replies" quietly stops being true. A broadcast of one goes through the same
   batch as a broadcast of eighty.
2. **It is the single best way to get a number banned.** OpenWA drives a
   reverse-engineered client, not Meta's Business API. Bulk outbound from a
   linked personal number is the exact pattern WhatsApp's anti-abuse systems
   look for.

### What the gateway turned out to provide

Read from `openwa-gateway/openapi.json` and the bulk service source, not the
README, which disagrees with the spec in two places.

| Endpoint | What it gives us |
| --- | --- |
| `POST /messages/send-bulk` | Async, **max 100 messages per request**, answers 202 |
| `GET /messages/batch/{id}` | Progress counters plus a per-recipient result array |
| `POST /messages/batch/{id}/cancel` | Stops the remainder; the guard lives inside the UPDATE |
| `GET /contacts/check/{number}` | The **only** way to know a number is on WhatsApp |

Three findings decided the design:

- **`batchId` is caller-supplied and unique per `(session, batchId)`.** A repeat
  is refused by name rather than sent again, so Divo mints it, writes it, and
  only then calls the gateway. That is the idempotency key — nothing needed
  building for it.
- **The gateway paces for us**, and jitters, which is both kinder to the account
  than a tight loop and the only way the send stays under the 10 req/s throttle
  without Divo modelling the throttle itself.
- **There is no `batch.*` webhook.** Twenty-three event types and not one about
  a batch, so progress is polled — by the screen while somebody watches, and by
  a worker so a send whose author closed the tab still reaches a terminal state.

And two limits worth stating plainly:

- **The gateway does not resume a batch across its own restart.** It marks
  in-flight batches `failed` on boot rather than risk double-sends. A broadcast
  can therefore end `failed` with some messages already delivered; the recipient
  rows are the only record of which. A poll that returns 404 is what detects it.
- **Group sizes are unknowable.** The group *list* carries an id and a subject
  and nothing else. So the review step reports recipients, groups and cold
  contacts — and deliberately **no "people reached" total**, because a plausible
  guess on that screen is worse than a stated absence.

### The cap is the gateway's, on purpose

100 recipients per broadcast, which is exactly the gateway's per-request
ceiling. One broadcast is one batch: one idempotency key, one cancel button, one
honest progress figure. Above that every one of those becomes plural, and a
progress bar assembled from several batches can report a healthy total while one
of its halves has quietly died.

### Ban risk, and the one env line

The gateway ships a `SendPacingService` nobody had switched on: a daily
allowance that grows with the session's age (`20,40,80,160,320,640,1000`), a
separate and far lower cap for **cold reachouts** (`5,10,20,…`), and a failure
circuit-breaker. It is `SEND_PACING_ENABLED=false` by default.

Turning it on is one line in the gateway's env and is the cheapest mitigation
available. The UI does its half regardless: recipients are sourced in ascending
order of risk (existing chats → a follow-up list → pasted numbers), cold
contacts are counted and called out, and every cold number is checked against
WhatsApp before the send — because the send itself answers 201 for a number
nobody ever registered.

### Sign-off — phase 1

Open to anyone in the department for now, by decision. Divo's existing
`ApprovalGateService` was **not** reused and could not have been: it requires a
`RunContext`, and `RuntimeApproval` is foreign-keyed to `RuntimeConversation`
and `RuntimeRun`, neither of which a web page has. Restricting the tab to Urban
Aura and the send to its managers is phase 2, tracked separately.

### Replies are tracked

Decided rather than defaulted. Broadcast recipients become tracked chats and are
analysed like any other, which buys the useful half — "sixty sent, twelve never
replied" becomes real follow-ups — at the cost of up to a hundred conversations
entering the nightly analysis. The review step states the number rather than
hiding it behind a toggle.

## 12. Deployment

Add one service to `docker-compose.yml`:

```yaml
divo-openwa:
  # from https://github.com/rmyndharis/OpenWA
  environment:
    API_MASTER_KEY:      ${DIVO_WHATSAPP_GATEWAY_KEY}
    SSRF_ALLOWED_HOSTS:  divo-backend,localhost
    AUTO_START_SESSIONS: "true"
  volumes:
    - divo-openwa-sessions:/app/sessions   # losing this re-links ten phones
```

Backend env, all validated in `config/env.ts` and logged at boot per the Fail
Loudly rules:

| Var | Note |
| --- | --- |
| `DIVO_WHATSAPP_ENABLED` | Gates the workers and the routes. Logs its effective state at startup; when it blocks work it says so |
| `DIVO_WHATSAPP_GATEWAY_URL` | `http://divo-openwa:2785` on the compose network |
| `DIVO_WHATSAPP_GATEWAY_KEY` | Same value as `API_MASTER_KEY` |
| `DIVO_WHATSAPP_WEBHOOK_SECRET` | Required when enabled. HMAC on every delivery |
| `DIVO_WHATSAPP_WEBHOOK_PUBLIC_URL` | `http://divo-backend:8000/api/whatsapp/webhook`. The host must appear in `SSRF_ALLOWED_HOSTS` or OpenWA refuses to register the webhook |
| `DIVO_FOLLOWUP_ANALYSIS_*` | quiet ms, cooldown ms, window days, max messages, min confidence, max chats per sweep — the agent's tuning knobs, same defaults |

The webhook is registered once per session at worker boot, idempotently — port
`ensureWebhook` from `openwa.js`, which already leaves a matching subscription
alone and replaces a stale one.

## 13. Waves

Each wave is a vertical slice that changes behaviour and can be stopped at.

| Wave | Delivers | Proves |
| --- | --- | --- |
| **1** | `divo-openwa` up, one number linked, webhook → idempotency → queue → `WhatsappMessage` rows, plus the reconcile sweep | Messages land, HMAC holds, dedupe holds — and a deliberately broken webhook is detected and recovered from (§3.2) |
| **2** | Analysis worker + `FollowUp` rows. No delivery yet — read the table by hand | **The risky assumption**: does the analysis produce items Urban Aura agrees with, on their real chats? |
| **3** | Digest runner → the Lark group, card + button, and the script that names the room (§13.1) | The thing the team actually asked for |
| **4** | `/me/follow-ups` tab: numbers, follow-ups, chats, and the link dialog | Self-service; nobody edits env to mute a chat |
| **5** | Broadcast tab: recipient picking, per-recipient personalisation, review, paced send, live progress, cancel, history | One broadcast is one gateway batch, and a send nobody is watching still reaches a terminal state |

**Built as of 2026-08-26: waves 1–5.** Code, schema and tests are in; what is not
done is *operational*, and none of it is code:

| Still needed | Why it is not a code task |
| --- | --- |
| A running `divo-openwa` gateway | An external container (§12). Nothing can be linked until it answers. |
| Ten handsets scanned | A person with each phone, paced across days (Decided 4). |
| One message sent in the Lark digest group | Supplied 2026-08-26 (§13.1). The bot is in the room, but Divo records a room only when it *observes a message* there — until one is sent the runner logs `follow_up_digest.unknown_chat` and delivers nothing. |
| Wave 2's judgement call | Needs real Urban Aura transcripts, which need the gateway. |

Wave 5 landed on 2026-08-26 (§11). What is still operational rather than code:
the gateway's `SEND_PACING_ENABLED` is off, and the tab is visible to every
department rather than only Urban Aura — both deliberate, both phase 2.

### 13.1 The digest writer — added 2026-08-26

Wave 3 shipped every reader of a `FollowUpDigest` and no writer, so the schedule
existed as a table nothing could put a row in. The runner woke, found nothing
due, and slept — which read as "Lark is broken" rather than "Lark was never
told where to post".

`scripts/configure-follow-up-digest.ts` (`pnpm digest:configure`) is that
writer. It validates the schedule through `recurringScheduleSchema` — the same
parser the runner uses, not a second copy — computes `nextRunAt` through
`nextRecurringRunAt`, and upserts on `[companyId, departmentId, larkChatId]`
leaving `coveredThrough` untouched, so changing the times cannot make the next
digest re-report what the last one already delivered.

It vets the room through the Mail Ops authoriser at creation, which is stricter
than delivery and deliberately so. `larkChatDeliveryAllowed` refuses only a room
owned by another company, because a member's own DM never has a directory row;
the digest runner additionally skips `unknown_chat` and reschedules. A row
created against an unseen room is therefore a digest that silently never
delivers, so the script refuses one unless `--allow-unknown-chat` is passed —
and says, when it is, exactly which log line to expect instead of a message.

When Urban Aura wants to change times without asking an engineer, this becomes
the API a settings panel calls. The vetting is the part that moves with it.

Wave 2 is the one to be honest about. Everything else is engineering with known
answers; wave 2 is a quality question, and the correct response to a bad result
is to tune the prompt and the confidence floor against real transcripts, not to
build wave 3 on top of it.

### 13.2 The gate — added 2026-08-26

Waves 1–5 shipped with `memberAuth` and department scoping and nothing else, so
every member of a department with a linked handset saw both tabs, broadcast
included. This is the gate.

**Where the grant comes from, and why not from the tool registry.** The obvious
move was to register `whatsappFollowUps` in `TOOL_CAPABILITY_DEFINITIONS`, list
it in `DEPARTMENT_GRANT_ONLY_TOOLS`, and inherit the department permission
matrix — the grant UI at `/team` renders any canonical tool for free, per role
*and* per member. It was built that way, and three parity tests refused it:
every canonical tool id must have a typed Pi tool behind it, in the Cloud Pi
allowlist and in the native catalogue. That invariant is deliberate — the
registry is the *agent's* capability taxonomy — and satisfying it would have put
`divo_whatsapp_follow_ups` in front of Divo as something it could be asked to
run, sending included. §11 says plainly that a broadcast is never something Divo
composes. The registration was reverted rather than the invariant bent.

So the grant is what was already true about this feature, and already audited:

| Standing | Holds |
| --- | --- |
| Company admin | `read`, `update`, `send` — before the first handset, too |
| Active member of a department with a linked number | `read`, `update` |
| …whose role slug is `MANAGER` | also `send` |
| Anyone else | nothing |

Linking the first handset is the grant, and a member cannot do it to themselves:
a department with no session is administered by a company admin, who holds
everything by the ordinary company-role ceiling. That is what breaks the circle
— otherwise `linkNumber` would need access only linking a number could produce.
Manager is read from `DepartmentRole.slug`, never `name`, which is editable.

**One decision, one module.** `application/follow-ups/follow-ups-permission.ts`
maps each of the fifteen operations to an action group and answers. Written as a
shared module on the day it had one caller, because Mail Ops shows what the
second costs: the agent tool and the browser each grew a copy, they disagreed,
and a member whose `update` was revoked was refused in Lark and allowed in a
browser.

**Three states, not two.** `createMemberScope` now resolves scope *and*
authorises, in that order, returning one value — a route cannot resolve a caller
and then forget to check them. Denied is 403 `not_permitted`; a permission
lookup that threw is 503 `permission_unavailable`, because telling somebody they
lack access when the database blinked sends them asking for what they already
hold. `authorize` is a required dependency, so a router cannot be mounted
ungated.

The operation is a typed argument at all fifteen call sites, so a new route
cannot be added without naming which action group it belongs to, and a typo does
not compile.

**Still open:** the browser does not yet hide what it may not use. A Finance
member sees the Broadcast tab and gets a 403 toast on send. Fail-safe, but wrong
— `/me` needs to carry the standing and the nav needs to read it.

## 14. Decisions and open questions

### Decided (2026-08-25)

1. **Analysis model — DeepSeek `deepseek-v4-flash`.** Not Claude. The imported
   agent defaults to `anthropic/claude-opus-5`, but `composition.ts` states the
   house rule plainly: *"Every backend-side model is DeepSeek."* Persona
   learning, knowledge learning and group summarisation are all
   `deepseek-v4-flash`. The analyser joins them, behind
   `WHATSAPP_ANALYSIS_MODEL_ID` so a future swap is one env var.

   This is roughly a tenfold cut against the Claude figures in the earlier cost
   note. Those figures should be read as an upper bound, not a forecast.

2. **Urban Aura is a department of the existing company, not a new company.**
   Their Lark tenant is separate, but their Divo `companyId` is ours.

3. **UA signs in with email and password, not Lark.** A separate Lark tenant
   cannot complete our OAuth. Nothing needs building: `User.email` is unique,
   `User.password` is required, `MemberSession.authProvider` already defaults to
   `"password"`, and `POST /admin/auth/signup/member-invite` already issues the
   invite. UA members are invited on their `@urbanaura.in` addresses and never
   touch Lark.

4. **Ban risk is accepted.** The numbers are most likely company SIMs. Linking
   is nonetheless staggered across days rather than done in one sitting — ten
   fresh device links from one address in one afternoon is the pattern that
   draws attention, and pacing costs nothing.

5. **No roles inside UA — but rows stay department-scoped.** Every UA member
   sees every follow-up; there are no permissions to configure. The tables still
   carry `departmentId`, which is one column and one `where` clause, because UA
   shares a company with other departments and their customer conversations
   should not be readable from those departments by default.

6. **Direct messages are analysed, like group chats.** An event business does
   most of its client work one to one, so a groups-only rule would miss the
   majority of what the team is actually chasing. §3.3's concern is answered
   per conversation instead of in advance: every chat carries a switch on the
   Chats tab, and switching one off stops it being read from the next sweep.
   A rule fixed ahead of time would have to be "all DMs" or "no DMs", and
   neither is right.

### Open

1. **~~Who the Lark digest group is for~~ — settled 2026-08-25.**

   The group is Urban Aura's, but it is created in **our** Lark tenant and Divo's
   bot is added to it directly; UA's people join it as external members. The bot
   is therefore native to the room, and the `LARK_APP_ID` problem never arises.

   That matters because it was the alternative that would have hurt: installing a
   second Divo app inside UA's own tenant means making Lark credentials
   per-company across roughly fifteen call sites in `composition.ts`, which are
   single global environment values today. **No code changes for this.**

   Setup is one step, and it is the same step as before: add Divo to the group.
   That is what writes the room record `createLarkChatDestinationAuthorizer`
   checks, and until it exists the authoriser answers `unknown_chat` — correctly,
   since it refuses rooms Divo has never been in rather than guessing.

   One behaviour to know rather than discover: Divo will still answer if somebody
   @mentions it in that group. Untagged messages stay ambient and unanswered, so
   the digest is one-way in practice, but the bot is a normal Lark bot and being
   addressed directly is a normal turn.

2. **The Lark group chat id**, once question 1 settles which group it is.

3. **Digest cadence** — the agent defaults to 09:00 and 18:00. Same for Urban
   Aura, or once a morning?

4. **Telling the ten handset owners that DMs are read.** Not a design question
   any more — see Decided 6 — but the one thing that still has to be said out
   loud before a personal number is linked. The per-chat switch is the answer to
   anybody who objects to a particular conversation.

5. **Retention** — how long message bodies are kept. Defaulting to a 90-day
   prune unless told otherwise.

*(Two earlier questions are now answered: follow-ups are not assignable to a
named member, see §3.4; and Urban Aura is a department, see Decided 2.)*
