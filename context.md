# Halo — Project Context

> **Audience**: Senior engineer joining the project on day one. Every section is written so you can understand and contribute without asking a single question.

---

## 1. Project Overview

**Halo** is a full-stack AI chat application — a self-hosted alternative to ChatGPT. Users register, log in, and hold multi-turn conversations with OpenAI LLMs (GPT-4o, GPT-4o-mini, GPT-4-turbo, GPT-3.5-turbo, o1-mini, o1). The backend runs an **agentic loop**: it can call built-in tools (e.g., calculator, current time) before streaming the final answer token-by-token to the browser via Server-Sent Events (SSE). The frontend is a purpose-built dark-theme chat UI with a persistent sidebar, per-conversation system prompts, model switching, and a live streaming view with animated tool-execution cards.

The project is split into two separate repos/directories under the same workspace:
- `backend/` — Rust binary (`halo-backend`), runs on port **8080**
- `frontend/` — Next.js application, runs on port **3000**

---

## 2. Tech Stack

### Backend

| Layer | Technology | Version |
|---|---|---|
| Language | Rust | 2021 edition |
| HTTP framework | Axum | 0.7 |
| Async runtime | Tokio (full features) | 1.x |
| CORS / tracing middleware | tower-http | 0.5 |
| Database driver | SQLx (PostgreSQL, async, compile-time checked) | 0.8 |
| Database | PostgreSQL | (any recent version) |
| AI / tool-calling | async-openai (direct OpenAI API calls) | 0.28 |
| AI model abstraction | rig-core (used for `RigMessage` types only) | 0.31.0 |
| Auth | jsonwebtoken (HS256) | 9.x |
| Password hashing | bcrypt (cost 12) | 0.15 |
| Serialization | serde + serde_json | 1.x |
| UUID generation | uuid v4 | 1.x |
| Timestamps | chrono (UTC) | 0.4 |
| Error handling | anyhow | 1.x |
| Env vars | dotenvy | 0.15 |
| Logging | tracing + tracing-subscriber with env-filter | 0.1/0.3 |
| Streaming utilities | futures, tokio-stream, async-stream | latest |
| URL encoding | urlencoding | 2.x |

### Frontend

| Layer | Technology | Version |
|---|---|---|
| Framework | **Next.js 16.1.6 — App Router** | 16.1.6 |
| Language | TypeScript | ^5 |
| UI runtime | React 19.2.3 | 19.2.3 |
| Package manager | pnpm | — |
| Styling | **Tailwind CSS v4** (via `@import "tailwindcss"`) | ^4 |
| Animation util | tw-animate-css | ^1.4.0 |
| Component library | **shadcn/ui** (Zinc default theme) | ^3.8.5 |
| Icons | lucide-react | ^0.575.0 |
| Markdown rendering | react-markdown + rehype-highlight + remark-gfm | ^10/^7/^4 |
| Syntax highlighting | highlight.js | ^11.11.1 |
| Toast notifications | sonner | ^2.0.7 |
| Class utilities | clsx + tailwind-merge + class-variance-authority | ^2/^3/^0.7 |
| Fonts | Inter (body), JetBrains Mono (code) — via next/font/google | — |

---

## 3. Project Structure

```
cursorr/
├── backend/                          # Rust binary (halo-backend)
│   ├── Cargo.toml                    # Rust package manifest + all dependencies
│   ├── Cargo.lock                    # Deterministic dependency lock
│   ├── .env                          # Local secrets (gitignored)
│   ├── .env.example                  # Template for required env vars
│   ├── migrations/
│   │   └── 0001_init.sql             # Single migration: creates users, conversations, messages tables + indices
│   └── src/
│       ├── main.rs                   # Entry point: router construction, CORS, migrations, startup
│       ├── config.rs                 # Config struct, reads from env vars at startup
│       ├── database.rs               # Creates PgPool
│       ├── error.rs                  # AppError enum → HTTP status codes (unified error handling)
│       ├── logging.rs                # Request logging middleware (method, path, status, ms, user ID)
│       ├── auth/
│       │   ├── mod.rs                # create_token() + verify_token() (JWT HS256, 7-day expiry)
│       │   ├── models.rs             # User, Claims, RegisterRequest, LoginRequest, AuthResponse, UserResponse
│       │   ├── handlers.rs           # register(), login(), me() HTTP handlers
│       │   └── middleware.rs         # AuthUser extractor — pulls JWT from Authorization header
│       ├── conversations/
│       │   ├── mod.rs
│       │   ├── models.rs             # Conversation, CreateConversationRequest, UpdateConversationSettingsRequest, UpdateTitleRequest, ConversationResponse
│       │   └── handlers.rs           # list, get, create, update_settings, update_title, delete
│       ├── messages/
│       │   ├── mod.rs
│       │   ├── models.rs             # Message, SendMessageRequest, MessageResponse, SseEvent
│       │   └── handlers.rs           # list, send (saves user message), stream_handler (SSE)
│       ├── ai/
│       │   ├── mod.rs
│       │   ├── tools.rs              # Tool trait + ToolDefinition + ToolRegistry
│       │   ├── builtin_tools.rs      # CurrentTimeTool (get_current_time), CalculatorTool (calculator)
│       │   └── agent.rs              # AgentRunner (agentic loop), AgentConfig, AgentEvent, build_context_window(),
│       │                             #   build_system_prompt(), build_chat_messages()
│       └── models_list/
│           ├── mod.rs
│           └── handlers.rs           # list_models() — returns hardcoded list of 6 supported models; is_supported_model()
│
├── frontend/                         # Next.js 16 app
│   ├── package.json                  # Dependencies + scripts (dev, build, start, lint)
│   ├── next.config.ts                # Minimal Next.js config
│   ├── middleware.ts                  # Route guard: redirects unauthenticated → /login, authenticated → / when on auth pages
│   ├── components.json               # shadcn/ui config (style: default, baseColor: zinc, aliases: @/components etc.)
│   ├── tsconfig.json                 # TypeScript config with @/* path alias for src/
│   ├── .env.local                    # NEXT_PUBLIC_API_URL=http://localhost:8080
│   └── src/
│       ├── app/
│       │   ├── layout.tsx            # Root layout: Google Fonts, AuthProvider, ChatProvider, Toaster, TooltipProvider
│       │   ├── globals.css           # Design system CSS variables, Tailwind v4 import, shimmer/blink/typing-cursor animations
│       │   ├── (auth)/               # Auth route group (no shared layout)
│       │   │   ├── login/page.tsx    # Login form — calls useAuth().login(), redirects to /
│       │   │   └── register/page.tsx # Register form — calls useAuth().register(), redirects to /
│       │   └── (chat)/               # Chat route group — wrapped by AuthGuard + AppShell
│       │       ├── layout.tsx        # Renders <AuthGuard><AppShell>{children}</AppShell></AuthGuard>
│       │       ├── page.tsx          # Empty state / new chat: greeting, 3 prompt cards, ChatInput with model selector
│       │       └── [id]/page.tsx     # Active conversation: loads messages, handles SSE streaming, model switching
│       ├── components/
│       │   ├── layout/
│       │   │   ├── AppShell.tsx      # Two-column layout: collapsible Sidebar + main content area + TopBar
│       │   │   ├── Sidebar.tsx       # Conversation list grouped by Today/Yesterday/This Week/Older; rename/delete menus; system prompt dialog; user menu
│       │   │   └── TopBar.tsx        # Hamburger to toggle sidebar, breadcrumb with conversation title
│       │   ├── chat/
│       │   │   ├── MessageList.tsx   # Renders message history + live agentic state (AgentProgress + StreamingMessage)
│       │   │   ├── MessageBubble.tsx # Renders a single message (user bubble right-aligned, assistant left-aligned with MarkdownRenderer)
│       │   │   ├── ChatInput.tsx     # Textarea with auto-resize, model selector dropdown, send/stop button
│       │   │   ├── StreamingMessage.tsx # Thin wrapper for streaming content display
│       │   │   ├── AgentProgress.tsx # Orchestrates ThinkingIndicator + ToolExecutionCard sequence
│       │   │   ├── ThinkingIndicator.tsx # Animated "Generating..." shimmer text with sparkle icon
│       │   │   ├── ThinkingLoader.tsx    # Legacy shimmer skeleton loader (pre-agentic)
│       │   │   ├── ToolExecutionCard.tsx # Collapsible card per tool call: spinner while executing, checkmark when done, expandable input/output
│       │   │   └── SystemPromptPanel.tsx # System prompt editing panel (used via Sidebar dialog)
│       │   ├── shared/
│       │   │   ├── MarkdownRenderer.tsx  # react-markdown + rehype-highlight + remark-gfm; custom renderers for code blocks
│       │   │   └── AuthGuard.tsx         # Client-side auth check: renders children only when token is loaded + valid
│       │   └── ui/                       # 14 shadcn/ui components (auto-generated, do not edit by hand)
│       │       # avatar, badge, button, card, dialog, dropdown-menu, input, label,
│       │       # scroll-area, separator, sheet, skeleton, textarea, tooltip
│       ├── context/
│       │   ├── AuthContext.tsx       # Provides user, token, login, register, logout, isLoading; persists token to localStorage + cookie
│       │   └── ChatContext.tsx       # Provides activeConversationId and setter (thin layer; mostly used for cross-component sync)
│       ├── hooks/
│       │   ├── useStream.ts          # Manages EventSource lifecycle for SSE streaming; saves user message via REST then opens SSE
│       │   ├── useConversations.ts   # Full conversations CRUD + optimistic local state
│       │   └── useMessages.ts        # Message list load + send (non-streaming path)
│       ├── lib/
│       │   ├── api.ts                # All fetch wrappers (apiFetch), ApiError class, structured api.* namespace + named exports
│       │   ├── auth.ts               # getStoredToken, setStoredToken, clearStoredToken — localStorage + cookie sync
│       │   ├── toast.ts              # uiToast helpers (sonner wrappers)
│       │   └── utils.ts              # cn() utility (clsx + tailwind-merge)
│       └── types/
│           └── index.ts              # User, Conversation, Message, ToolExecution, SSEEvent (union type), Model
│
├── tasks/
│   ├── guide.md                      # Orchestrator agent instructions — multi-agent build sequence, gate checks
│   ├── frontend-readme.md            # Frontend agent master instructions (stack, design system, API contract, folder structure)
│   ├── backend-readme.md             # Backend agent master instructions
│   ├── frontend/
│   │   └── task2-agentic-ui.md       # Task 2 spec: agentic loop UI components + acceptance criteria
│   └── backend/                      # Backend task files (task1-agentic-loop.md etc.)
│
├── src/                              # Root-level Rust stubs (app, components, context, hooks — not used by backend binary)
└── target/                           # Rust build artifacts (gitignored)
```

---

## 4. Architecture

### High-Level Data Flow

```
Browser (Next.js :3000)
    │
    │  REST (JSON)   ← auth, conversations CRUD, messages list/send, models list
    │  SSE stream    ← token-by-token AI response + tool events
    ▼
Axum Server (:8080)
    │
    ├── PostgreSQL   ← users, conversations, messages (3 tables)
    │
    └── async-openai → OpenAI API
            └── Streams tokens + handles tool calls (agentic loop)
```

### Request Lifecycle — Streaming Chat Message

1. **User types** a message and presses Enter in `ChatInput`.
2. **`[id]/page.tsx`** calls `handleSend(content)`.
3. **`useStream.streamMessage()`** first POSTs `content` to `POST /conversations/:id/messages` to save the user message (returns the saved `Message` object).
4. It then opens a native `EventSource` to `GET /conversations/:id/stream?message=<encoded>&token=<jwt>`.
5. **`stream_handler` (Axum)** authenticates via the `?token=` query param (because `EventSource` doesn't support custom headers), fetches the conversation and its last 10 messages, builds the system prompt from the conversation's `system_prompt` field + user info template.
6. It spawns a Tokio task that creates an `AgentRunner` and calls `agent.run(messages, event_tx)`.
7. **`AgentRunner.run()`** sends the initial messages to OpenAI (non-streaming). If the model returns tool calls, it:
   - Emits `AgentEvent::ToolCallsStarted`
   - For each tool call: emits `AgentEvent::ToolExecuting`, executes the tool, emits `AgentEvent::ToolResult`
   - Loops back for another OpenAI call (max 10 iterations)
8. When there are no more tool calls, `stream_final_response()` calls OpenAI with `stream: true` and emits `AgentEvent::Token` for each chunk, then `AgentEvent::Done`.
9. The completed assistant message is saved to the DB by the spawned task.
10. **On the frontend**, `useStream` handles each SSE event and calls the appropriate callbacks: `onStart`, `onToolStart`, `onToolResult`, `onToken`, `onDone`, `onError`.
11. `[id]/page.tsx` updates React state (`isThinking`, `toolExecutions`, `streamingContent`) which drives `AgentProgress`, `ThinkingIndicator`, `ToolExecutionCard`, and the streaming text with blinking cursor.
12. On `done`, the accumulated content becomes a final `Message` appended to `messages[]` and streaming state is reset.

### Auth Flow

1. User submits login/register form → `POST /auth/login` or `/auth/register`.
2. Backend validates, hashes password (bcrypt cost 12), creates HS256 JWT (`sub=user_id_uuid`, `exp=now+7days`).
3. `AuthContext` stores the token in **localStorage** (`halo_token`) AND as a **cookie** (`halo_token; path=/; max-age=30days; SameSite=Lax`).
4. **Cookie** is required because Next.js `middleware.ts` runs on the Edge — it reads the `halo_token` cookie to decide whether to redirect unauthenticated requests to `/login` or redirect authenticated users away from `/login`/`/register`.
5. **localStorage** is used for all API calls (injected as `Authorization: Bearer <token>`).
6. On app load, `AuthContext` reads the token from localStorage and calls `GET /auth/me` to validate it and restore the user object.
7. All conversation and message endpoints use the `AuthUser` extractor which reads from `Authorization: Bearer` header only (not query param). The stream endpoint accepts both header and `?token=` query param.

### CORS

The Axum CORS layer allows:
- Origins: `http://localhost:3000` and any `http://localhost:<port>` (dev only — no production CORS config)
- Methods: GET, POST, PATCH, DELETE, OPTIONS
- Headers: `Content-Type`, `Authorization`
- Credentials: allowed

---

## 5. Current State

### Fully Working
- ✅ User registration and login (JWT, bcrypt, email uniqueness)
- ✅ `GET /auth/me` — restores session on page load
- ✅ Full conversations CRUD (create, list, get, update settings, update title, delete)
- ✅ Messages list and send (non-streaming path)
- ✅ SSE streaming endpoint with agentic loop (tool-calling + streaming final response)
- ✅ Two built-in tools: `get_current_time` and `calculator`
- ✅ Rolling 10-message context window for every request
- ✅ Per-conversation system prompt (stored in DB, loaded per request)
- ✅ Per-conversation model selection (patched via `PATCH /conversations/:id/settings`)
- ✅ Per-conversion temperature setting (default 0.7, range 0.0–2.0)
- ✅ Frontend: Login/Register pages with form validation
- ✅ Frontend: Chat layout — collapsible sidebar, conversation list grouped by time
- ✅ Frontend: Empty state page with time-aware greeting and 3 starter prompts
- ✅ Frontend: Active conversation page with full message history
- ✅ Frontend: Agentic UI — `ThinkingIndicator`, `ToolExecutionCard`, `AgentProgress`
- ✅ Frontend: Typing cursor (blinking `|`) while streaming
- ✅ Frontend: Markdown rendering with syntax-highlighted code blocks
- ✅ Frontend: Auto-scroll to bottom while streaming, "Jump to bottom" button when scrolled up
- ✅ Frontend: System prompt editing via sidebar dialog
- ✅ Frontend: Conversation rename + delete via dropdown menu in sidebar
- ✅ Frontend: Model selector in `ChatInput`
- ✅ Frontend: Route guard middleware (cookie-based, Edge-compatible)
- ✅ Database migrations (sqlx migrate, runs automatically on backend startup)
- ✅ Request logging middleware (timestamp, method, path, status, duration, user ID)

### Partially Done / Stubs
- ⚠️ `ChatContext.tsx` — created but `activeConversationId` is not wired to any meaningful cross-component behavior; it appears to be scaffolding for future use.
- ⚠️ `src/` at the project root contains empty `app/`, `components/`, `context/`, `hooks/` directories — these are leftover scaffolding stubs and have no code.
- ⚠️ `ThinkingLoader.tsx` — legacy shimmer skeleton component, appears to be the original pre-agentic loader. It coexists with the newer `ThinkingIndicator.tsx`. Not clear if it is still used anywhere.

### Missing / Not Implemented
- ❌ No production CORS config — CORS only allows `localhost` origins
- ❌ No conversation auto-titling (AI-generated titles based on first message content)
- ❌ No message search
- ❌ No user profile editing (change email, password, name)
- ❌ No token refresh or silent re-auth (token expires after 7 days and user must re-login)
- ❌ No rate limiting on the backend
- ❌ No upload / file attachment support
- ❌ The `models` endpoint is hardcoded — not fetched from OpenAI
- ❌ Partial messages from aborted streams are saved to client state but **not** persisted to the DB (the backend only saves the assistant message after `AgentRunner.run()` completes successfully)
- ❌ `ToolExecutionCard` shows `"Using"` / `"Used"` labels only — no tool-specific icons beyond the spinner/checkmark

---

## 6. Key Design Decisions

### SSE over WebSockets
`EventSource` (SSE) was chosen because:
1. It is natively supported in the browser with automatic reconnect.
2. The chat interaction is inherently unidirectional for streaming (server pushes tokens to client).
3. Axum has first-class `Sse<>` response support.
4. Avoids the complexity of maintaining a stateful WebSocket connection layer.

### Token via Query Param for EventSource
`EventSource` does not support custom HTTP headers. To authenticate the SSE connection, the JWT is passed as `?token=<jwt>` in the stream URL. The backend extracts it in `authenticate_stream_request()` with a fallback to the `Authorization` header. The logging middleware also supports this dual extraction pattern.

### Rolling 10-Message Context Window
Rather than sending the entire conversation history to the LLM (which can become very long and expensive), `build_context_window()` takes the last 10 messages from the DB. This is a stateless, per-request design — no in-memory session state on the server.

### Stateless Backend Design
The backend holds no per-user in-memory state. Every request reads what it needs from PostgreSQL. The `AgentRunner` is constructed fresh per stream request. This makes horizontal scaling straightforward.

### async-openai Over rig-core for Streaming
The `rig-core` library is included and its `Message`/`RigMessage` types are used for the context window helper functions, but the actual API calls (both the non-streaming tool-call loop and the streaming final response) use `async-openai` directly. This was explicitly designed as a fallback because the rig-core streaming API had unclear/unstable behavior at the time of implementation (documented in `tasks/guide.md`).

### Token Stored in Both localStorage and Cookie
- **localStorage**: used for API calls (injected into `Authorization` headers by `lib/api.ts`)
- **Cookie**: required for Next.js `middleware.ts` which runs on the Edge runtime and cannot access `localStorage`

### Optimistic User Message
When a user sends a message, the frontend immediately adds a temporary `Message` object with a `temp-user-*` ID to the `messages[]` array before the REST save completes. Once the `POST /conversations/:id/messages` response returns, the temp message is replaced with the real saved message (with real UUID and `created_at`). If the stream errors, the temp message is filtered out.

### Custom Design System (Not shadcn Defaults)
The UI uses a warm dark-mode palette with CSS custom properties (`--bg-base`, `--accent: #d97757` — Anthropic orange, etc.) rather than the shadcn Zinc tokens. This is layered on top of Tailwind v4's `@theme inline {}` block so the custom colors are available as Tailwind classes.

---

## 7. Data Models

### Database Tables (PostgreSQL)

#### `users`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, default `uuid_generate_v4()` |
| `first_name` | VARCHAR(100) | NOT NULL |
| `last_name` | VARCHAR(100) | NOT NULL |
| `email` | VARCHAR(255) | UNIQUE NOT NULL |
| `password_hash` | VARCHAR(255) | NOT NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL, default NOW() |
| `updated_at` | TIMESTAMPTZ | NOT NULL, default NOW() |

#### `conversations`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, default `uuid_generate_v4()` |
| `user_id` | UUID | FK → users(id) ON DELETE CASCADE |
| `title` | VARCHAR(500) | NOT NULL, default `'New Conversation'` |
| `model` | VARCHAR(100) | NOT NULL, default `'gpt-4o'` |
| `system_prompt` | TEXT | nullable |
| `temperature` | FLOAT | NOT NULL, default `0.7` |
| `created_at` | TIMESTAMPTZ | NOT NULL, default NOW() |
| `updated_at` | TIMESTAMPTZ | NOT NULL, default NOW() |

Indices: `idx_conversations_user_id`, `idx_conversations_updated_at DESC`

#### `messages`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, default `uuid_generate_v4()` |
| `conversation_id` | UUID | FK → conversations(id) ON DELETE CASCADE |
| `role` | VARCHAR(20) | NOT NULL, CHECK (role IN ('user', 'assistant')) |
| `content` | TEXT | NOT NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL, default NOW() |

Index: `idx_messages_conversation_id`

### Rust Types (Backend)

```rust
// auth/models.rs
pub struct User { id, first_name, last_name, email, password_hash, created_at, updated_at }
pub struct Claims { sub: String, exp: usize, iat: usize }   // JWT claims
pub struct RegisterRequest { first_name, last_name, email, password }
pub struct LoginRequest { email, password }
pub struct UserResponse { id, first_name, last_name, email, created_at }  // no password_hash
pub struct AuthResponse { token: String, user: UserResponse }

// conversations/models.rs
pub struct Conversation { id, user_id, title, model, system_prompt: Option<String>, temperature, created_at, updated_at }
pub struct CreateConversationRequest { title: Option<String>, model: Option<String>, system_prompt: Option<String> }
pub struct UpdateConversationSettingsRequest { model: Option<String>, system_prompt: Option<Option<String>>, temperature: Option<f64> }
pub struct UpdateTitleRequest { title: String }
pub struct ConversationResponse { id, title, model, system_prompt, temperature, created_at, updated_at }

// messages/models.rs
pub struct Message { id, conversation_id, role: String, content, created_at }
pub struct SendMessageRequest { content: String }
pub struct MessageResponse { id, conversation_id, role, content, created_at }
pub struct SseEvent { event_type: String, data: String }

// ai/agent.rs
pub struct AgentConfig { model: String, temperature: f64, openai_api_key: String }
pub enum AgentEvent {
    ToolCallsStarted { calls: Vec<ChatCompletionMessageToolCall> },
    ToolExecuting { id, name, arguments: Value },
    ToolResult { id, name, result: String },
    Token(String),
    Done,
    Error(String),
}
```

### TypeScript Types (Frontend)

```typescript
// src/types/index.ts
interface User { id, first_name, last_name, email, created_at }
interface Conversation { id, title, model, system_prompt: string | null, temperature, created_at, updated_at }
interface Message { id, conversation_id, role: "user" | "assistant", content, created_at }
interface ToolExecution { id, name, arguments?: Record<string, unknown>, result?: string, status: "executing" | "completed" }
interface Model { id, name }
type SSEEvent =
  | { type: "start" }
  | { type: "tool_start"; id, name, arguments? }
  | { type: "tool_result"; id, name, result? }
  | { type: "token"; data: string }
  | { type: "done" }
  | { type: "error"; data?: string }
```

---

## 8. API Reference

All endpoints return JSON. All endpoints except `/health`, `/models`, `/auth/register`, and `/auth/login` require `Authorization: Bearer <jwt>`. Errors return `{ "error": "<message>" }`.

### Health

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | None | `{ "status": "ok", "version": "0.1.0" }` |

### Models

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/models` | Bearer | `Model[]` — id/name pairs for 6 supported models |

### Auth

| Method | Path | Auth | Request Body | Response |
|---|---|---|---|---|
| POST | `/auth/register` | None | `{ first_name, last_name, email, password }` | `{ token, user: UserResponse }` — 201 |
| POST | `/auth/login` | None | `{ email, password }` | `{ token, user: UserResponse }` — 200 |
| GET | `/auth/me` | Bearer | — | `UserResponse` — 200 |

**Validation**: `first_name`, `last_name` must be non-empty. Email must contain `@`. Password minimum 8 chars. Duplicate email → 409.

### Conversations

| Method | Path | Auth | Request Body | Response |
|---|---|---|---|---|
| GET | `/conversations` | Bearer | — | `ConversationResponse[]` ordered by `updated_at DESC` |
| POST | `/conversations` | Bearer | `{ title?, model?, system_prompt? }` | `ConversationResponse` — 201 |
| GET | `/conversations/:id` | Bearer | — | `ConversationResponse` |
| DELETE | `/conversations/:id` | Bearer | — | 204 No Content |
| PATCH | `/conversations/:id/settings` | Bearer | `{ model?, system_prompt?, temperature? }` | `ConversationResponse` |
| PATCH | `/conversations/:id/title` | Bearer | `{ title: string }` | `ConversationResponse` |

**Ownership**: All conversation endpoints verify `conversation.user_id == authenticated user`. Returns 403 if mismatched.

**Defaults**: `model` defaults to `"gpt-4o"`. `title` defaults to `"New Conversation"`. `temperature` defaults to `0.7`.

**Model validation**: Only the 6 models listed by `/models` are accepted. Invalid model → 400.

**Message limit**: Content max 32,000 characters. Title max 500 characters.

### Messages

| Method | Path | Auth | Request Body | Response |
|---|---|---|---|---|
| GET | `/conversations/:id/messages` | Bearer | — | `MessageResponse[]` ordered by `created_at ASC` |
| POST | `/conversations/:id/messages` | Bearer | `{ content: string }` | `MessageResponse` — 201 (saves user message only) |

### Streaming

| Method | Path | Auth | Query Params | Response |
|---|---|---|---|---|
| GET | `/conversations/:id/stream` | Bearer header OR `?token=<jwt>` | `message=<url-encoded-content>`, `token=<jwt>` (optional if header set) | `text/event-stream` SSE |

**SSE Event Sequence:**
```
data: {"type":"start","data":""}
data: {"type":"tool_start","id":"abc","name":"calculator","arguments":{"expression":"5*5"}}
data: {"type":"tool_result","id":"abc","name":"calculator","result":"25"}
data: {"type":"token","data":"The result is "}
data: {"type":"token","data":"25."}
data: {"type":"done"}
```

On error:
```
data: {"type":"error","data":"<error message>"}
```

Keep-alive pings are sent every 15 seconds as `text/event-stream` comments.

---

## 9. Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string, e.g. `postgresql://postgres:postgres@localhost:5432/halo` |
| `JWT_SECRET` | ✅ | — | Secret key for signing HS256 JWTs. Must be long and random in production. |
| `OPENAI_API_KEY` | ✅ | — | OpenAI API key (`sk-...`). Used for all model calls. |
| `SERVER_PORT` | ❌ | `8080` | Port the Axum server listens on. |

All variables are loaded via `dotenvy` from `.env` in the working directory. Missing required vars → panic at startup.

### Frontend (`frontend/.env.local`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | ❌ | `http://localhost:8080` | Base URL of the backend API. Prefix `NEXT_PUBLIC_` makes it available client-side. |

---

## 10. Known Issues / TODOs

### Hardcoded Values
- **Default model in frontend code** — `(chat)/page.tsx` and `[id]/page.tsx` default `selectedModel` to `"gpt-4.1-mini"` (line 19 and line 24 respectively) which is **not** in the supported model list (`"gpt-4o-mini"` is). This means if the `/models` API call fails, the fallback default is an invalid model ID. Should be `"gpt-4o-mini"`.
- **Supported models are hardcoded** in `models_list/handlers.rs` — they are not fetched from the OpenAI models API.

### Incomplete Features
- **Conversation `updated_at` not bumped on rename** — `update_title` sets `updated_at = NOW()` correctly, but the sidebar re-ordering relies on this. Seems fine but worth confirming.
- **No auto-titling** — conversations always start as "New Conversation" unless the user renames them manually. The title is never AI-generated from the first message.
- **Partial stream not persisted** — if the user aborts the stream (Stop button), the partial content is shown in the UI as a local `Message` but is never POSTed to the backend. On page refresh, the partial message disappears.
- **SSE error message format inconsistency** — for the 401 case, the error event data is `"401 Invalid or expired token"` (with the status code embedded as a string prefix) rather than a clean message string.
- **`ChatContext` not fully used** — `ChatContext` provides `activeConversationId`/setter but the conversation page (`[id]/page.tsx`) manages its own `conversation` state independently. The context appears to be placeholder scaffolding.
- **`ThinkingLoader.tsx`** — a second thinking loader component exists alongside `ThinkingIndicator.tsx`. The former appears to be the old implementation. It's unclear which one is active or if `ThinkingLoader` is used anywhere after the agentic UI was added.
- **No CORS for production** — the CORS predicate is hardcoded to `localhost` origins. Deploying the backend would require updating `cors_layer()` in `main.rs`.
- **No token expiry handling on frontend** — if the 7-day JWT expires mid-session, API calls will return 401 but the frontend shows generic "Unable to connect" errors. There's no automatic logout or token refresh flow.
- **`tasks/guide.md` references "Next.js 14"** but the package.json is `next@16.1.6` — the docs are slightly out of date.

### Open Tasks (from `tasks/`)
- **Task 2 — Agentic UI** (`tasks/frontend/task2-agentic-ui.md`): The core components (`AgentProgress`, `ThinkingIndicator`, `ToolExecutionCard`) are implemented, but the task's acceptance criteria checkboxes have not been formally checked off. Full testing of all 4 scenarios (no tools, one tool, multiple tools, tool error) against the live backend is pending.
