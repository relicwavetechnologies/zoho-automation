# Guide — Orchestrator Agent Instructions

You are the **Orchestrator Agent** for building the Halo AI chat application. You coordinate two sub-agents: the **Frontend Agent** and the **Backend Agent**. Your job is to sequence their work correctly, verify each stage before proceeding, and unblock agents when they're stuck.

---

## Project Overview

**Halo** is a full-stack AI chat app with:
- Rust/Axum backend using rig-core for OpenAI streaming
- Next.js 14 frontend with shadcn/ui, SSE streaming, markdown rendering
- PostgreSQL database
- JWT authentication

Two separate repos. Backend runs on port `8080`. Frontend runs on port `3000`.

---

## Agent Files

- Frontend agent reads: `frontend-readme.md`, `task1.md`, `task2.md`
- Backend agent reads: `backend-readme.md`, `task3.md`, `task4.md`, `task5.md`

---

## Execution Order (CRITICAL — do not deviate)

Dependencies exist between tasks. Wrong order causes agents to block.

```
Phase 1: Parallel start (both agents can work simultaneously)
  Backend Agent  → Task 3 (auth + DB)
  Frontend Agent → Task 1 (layout + auth UI — uses placeholder/mock API if backend not ready)

Phase 2: Backend must finish Task 3 before Frontend can wire auth
  GATE: Verify backend Task 3 acceptance criteria before proceeding

Phase 3: Backend Task 4 (streaming) + Frontend Task 2 (chat UI) — partial parallel
  Backend Agent → Task 4
  Frontend Agent → Task 2 (can build UI before backend streaming is ready, mock SSE if needed)

Phase 4: Integration
  GATE: Both Task 2 and Task 4 must pass before integration testing

Phase 5: Polish
  Backend Agent → Task 5
  Integration test full flow end-to-end
```

---

## Gate Checks

After each phase, run these checks before proceeding:

### Gate 1 — After Backend Task 3

```bash
# Health check
curl http://localhost:8080/health
# Expected: { "status": "ok" }

# Register
curl -X POST http://localhost:8080/auth/register \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Test","last_name":"User","email":"test@test.com","password":"password123"}'
# Expected: { "token": "...", "user": { "id": "...", "first_name": "Test", ... } }

# Login
curl -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123"}'
# Expected: { "token": "...", "user": { ... } }

# Me (use token from above)
curl http://localhost:8080/auth/me \
  -H "Authorization: Bearer <token>"
# Expected: user object

# Duplicate email
curl -X POST http://localhost:8080/auth/register \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Test","last_name":"User","email":"test@test.com","password":"password123"}'
# Expected: 409 { "error": "..." }
```

All must pass before Frontend Agent wires auth.

### Gate 2 — After Frontend Task 1

Open browser at `http://localhost:3000`:
- [ ] Login page renders cleanly, no console errors
- [ ] Can navigate to register page
- [ ] Register creates account (if backend is running), redirects to app shell
- [ ] App shell: sidebar visible, topbar visible, layout correct
- [ ] No white flash on load
- [ ] No TypeScript errors in console

### Gate 3 — After Backend Task 4

```bash
# Create conversation
TOKEN="<get from login>"
CONV=$(curl -X POST http://localhost:8080/conversations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test Chat","model":"gpt-4o"}')
CONV_ID=$(echo $CONV | jq -r '.id')

# Send message
curl -X POST http://localhost:8080/conversations/$CONV_ID/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Hello, say just the word test"}'

# Test SSE stream
curl -N "http://localhost:8080/conversations/$CONV_ID/stream?message=Hello%20say%20just%20the%20word%20test&token=$TOKEN"
# Expected: stream of SSE events:
# data: {"type":"start","data":""}
# data: {"type":"token","data":"test"}
# ...
# data: {"type":"done","data":""}

# Verify message was saved
curl http://localhost:8080/conversations/$CONV_ID/messages \
  -H "Authorization: Bearer $TOKEN"
# Expected: array with user message AND assistant message
```

### Gate 4 — Full Integration

Open browser at `http://localhost:3000`:
- [ ] Login works end-to-end
- [ ] New conversation creates and navigates to chat
- [ ] Typing a message and hitting Enter sends it
- [ ] ThinkingLoader appears (shimmer lines)
- [ ] Tokens stream in real-time, text builds up
- [ ] Streaming stops with blinking cursor then cursor disappears
- [ ] Markdown renders correctly in assistant response
- [ ] Conversation appears in sidebar
- [ ] Refreshing page loads conversation history
- [ ] Model selector changes model
- [ ] System prompt panel saves and takes effect on next message

---

## Common Issues + How to Unblock Agents

### Backend won't compile

Check these in order:
1. `cargo check` — is it a type error or missing import?
2. rig-core API changes — the rig API evolves quickly. If a method doesn't exist, check `docs.rs/rig-core/0.31.0` for exact method names
3. SQLx compile-time query checking — requires `DATABASE_URL` in environment at compile time. Set it: `export DATABASE_URL=postgresql://...` or use `sqlx::query!` with offline mode

### rig streaming not working

If `rig-core` streaming API is unclear or broken, fall back to `async-openai` crate directly for the stream endpoint only. Add to Cargo.toml:
```toml
async-openai = "0.28"
```
The rig agent can still be used for non-streaming work. Just implement the SSE stream endpoint with async-openai directly.

### SSE not reaching frontend

1. Check CORS — SSE needs CORS headers too, including on streaming responses
2. EventSource doesn't support custom headers — ensure `?token=` query param auth works
3. Check browser Network tab: is the SSE connection established? Does it show `text/event-stream` content type?

### Frontend hydration errors

Usually caused by accessing `localStorage` during SSR. Fix: wrap any localStorage access in `useEffect` or add `'use client'` directive.

### Prisma / SQLx migration issues

Run manually: `cargo sqlx migrate run` with `DATABASE_URL` set.

---

## Final Verification Checklist

Before declaring the project complete:

**Backend:**
- [ ] `cargo build --release` succeeds
- [ ] `cargo clippy -- -D warnings` passes
- [ ] All Gate 1 + Gate 3 checks pass
- [ ] `.env.example` exists

**Frontend:**
- [ ] `pnpm build` succeeds (no TypeScript errors)
- [ ] `pnpm tsc --noEmit` passes
- [ ] All Gate 2 checks pass

**Integration:**
- [ ] All Gate 4 checks pass
- [ ] Works on 1280px and 1440px viewport
- [ ] No console errors in browser during normal usage
- [ ] Network tab shows SSE streaming token-by-token (not buffered)

---

## Architecture Summary (for context)

```
Browser (Next.js :3000)
    │
    │  REST (JSON)     ← auth, conversations, messages CRUD
    │  SSE stream      ← token-by-token AI response
    ▼
Axum Server (:8080)
    │
    ├── PostgreSQL    ← users, conversations, messages
    │
    └── rig-core → OpenAI API
            └── gpt-4o (streaming)
```

The context window: last 10 messages from DB are loaded per request and passed to rig. No session state on the server — stateless design.

The system prompt per conversation is stored in DB, loaded per request, combined with user info template, and passed as `preamble` to the rig agent.