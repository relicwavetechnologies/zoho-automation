# Backend Agent — Master Instructions

You are the **Backend Agent** for building a production-grade AI chat application called **Halo**. Complete tasks 3, 4, and 5 in order. All context you need is in this file and the task files.

---

## Stack

- **Language**: Rust (stable)
- **Web Framework**: Axum 0.7
- **Async Runtime**: Tokio (full features)
- **AI Framework**: rig-core 0.31.0 (with openai feature)
- **Database**: PostgreSQL via SQLx 0.8 (with runtime-tokio-rustls, macros, postgres features)
- **Migrations**: SQLx migrate (built-in)
- **Auth**: JWT via `jsonwebtoken` crate
- **Password hashing**: `bcrypt` or `argon2`
- **Serialization**: serde + serde_json
- **Env**: `dotenvy`
- **Error handling**: `anyhow` for internal, custom `AppError` enum for HTTP responses
- **CORS**: `tower-http` CORS layer
- **Tracing**: `tracing` + `tracing-subscriber`
- **UUID**: `uuid` with v4 feature
- **Time**: `chrono` with serde feature

---

## Step 0 — Reset the repo (do this FIRST)

```bash
# Inside the backend repo root
git add -A
git stash
git checkout --orphan fresh-start
git rm -rf .
git stash drop 2>/dev/null || true
```

Then scaffold fresh:

```bash
cargo init .
```

Replace `Cargo.toml` with:

```toml
[package]
name = "halo-backend"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "halo-backend"
path = "src/main.rs"

[dependencies]
axum = { version = "0.7", features = ["macros"] }
tokio = { version = "1", features = ["full"] }
tower-http = { version = "0.5", features = ["cors", "trace"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "postgres", "macros", "uuid", "chrono"] }
rig-core = { version = "0.31.0", features = ["openai"] }
jsonwebtoken = "9"
bcrypt = "0.15"
anyhow = "1"
dotenvy = "0.15"
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
futures = "0.3"
tokio-stream = "0.1"
async-stream = "0.3"
```

---

## Project Structure

```
src/
  main.rs              ← app setup, router, state init
  config.rs            ← Config struct, env loading + validation
  error.rs             ← AppError enum, IntoResponse impl
  db.rs                ← DB pool setup
  auth/
    mod.rs
    handlers.rs        ← register, login, me
    middleware.rs      ← JWT extractor
    models.rs          ← User struct, claims
  conversations/
    mod.rs
    handlers.rs        ← CRUD endpoints
    models.rs          ← Conversation struct
  messages/
    mod.rs
    handlers.rs        ← send message, list messages, SSE stream
    models.rs          ← Message struct
  ai/
    mod.rs
    agent.rs           ← rig-core agent builder, context window logic
    tools.rs           ← ToolPlugin trait (empty registry for now)
  models_list/
    mod.rs
    handlers.rs        ← GET /models
migrations/
  0001_init.sql
```

---

## Environment Variables

File: `.env`

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/halo
JWT_SECRET=your-super-secret-jwt-key-change-in-production
OPENAI_API_KEY=sk-...
SERVER_PORT=8080
```

`config.rs` must validate ALL env vars on startup and panic with a clear message if any are missing.

---

## Database Schema

File: `migrations/0001_init.sql`

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL DEFAULT 'New Conversation',
    model VARCHAR(100) NOT NULL DEFAULT 'gpt-4o',
    system_prompt TEXT,
    temperature FLOAT NOT NULL DEFAULT 0.7,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversations_user_id ON conversations(user_id);
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_conversations_updated_at ON conversations(updated_at DESC);
```

---

## Shared DTOs (Rust types — matches frontend TypeScript types exactly)

```rust
// User (returned in API responses — NEVER include password_hash)
pub struct UserResponse {
    pub id: Uuid,
    pub first_name: String,
    pub last_name: String,
    pub email: String,
    pub created_at: DateTime<Utc>,
}

// Auth responses
pub struct AuthResponse {
    pub token: String,
    pub user: UserResponse,
}

// Conversation
pub struct ConversationResponse {
    pub id: Uuid,
    pub title: String,
    pub model: String,
    pub system_prompt: Option<String>,
    pub temperature: f64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// Message
pub struct MessageResponse {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub role: String,  // "user" | "assistant"
    pub content: String,
    pub created_at: DateTime<Utc>,
}

// SSE event (serialized to JSON, sent as SSE data)
pub struct SseEvent {
    #[serde(rename = "type")]
    pub event_type: String,  // "token" | "done" | "error"
    pub data: String,
}

// Model list item
pub struct ModelItem {
    pub id: String,
    pub name: String,
}
```

---

## API Endpoints Summary

All routes except auth require `Authorization: Bearer <jwt>` header. JWT extractor is implemented as an Axum extractor (see task3).

```
POST   /auth/register
POST   /auth/login
GET    /auth/me

GET    /conversations
POST   /conversations
GET    /conversations/:id
PATCH  /conversations/:id/settings

GET    /conversations/:id/messages
POST   /conversations/:id/messages
GET    /conversations/:id/stream        ← SSE endpoint

GET    /models
```

---

## Error Handling Convention

`AppError` must cover these cases, each mapping to correct HTTP status:

```rust
pub enum AppError {
    NotFound(String),           // 404
    Unauthorized(String),       // 401
    Forbidden(String),          // 403
    BadRequest(String),         // 400
    Conflict(String),           // 409 (email already exists)
    InternalError(anyhow::Error), // 500
}
```

All errors return JSON: `{ "error": "<message>" }`

---

## CORS Config

Allow:
- Origins: `http://localhost:3000` (and any `http://localhost:*` for dev)
- Methods: GET, POST, PATCH, DELETE, OPTIONS
- Headers: Content-Type, Authorization
- Credentials: true

---

## Tasks to Complete (in order)

1. Read and complete **task3.md** — project setup, DB, auth
2. Read and complete **task4.md** — conversations, messages, SSE streaming
3. Read and complete **task5.md** — models endpoint, settings, polish