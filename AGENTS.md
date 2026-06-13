# AGENTS.md
> Shared context for all AI coding assistants — Claude Code, Codex, Cursor, Gemini CLI, etc.
> This file is symlinked as CLAUDE.md. One source of truth.

---

## MANDATORY: How Every AI Session Must Work

These rules exist so that switching between Claude, Codex, Cursor, or any other tool mid-feature
causes zero context loss. The **Lark Wiki** is the source of truth for all plans and progress.

### Lark Wiki — Source of Truth

All project documentation lives in the **Lark Wiki** under `Tech Hub > 02 — Internal Projects > Divo`.
Use the `lark-wiki` skill (via `lark-cli`) to read and write wiki pages. Do NOT maintain separate
local markdown files for plans or progress — the wiki is canonical.

**Wiki structure:**
```
Divo
├── Divo — Overview                    (project summary)
├── Divo — Architecture & Tech Stack   (stack, infra)
├── Divo — URLs & Access               (endpoints, credentials)
├── Divo — Reviews & MoMs              (meeting notes)
├── Divo — References/                 (stable reference docs)
│    ├── UI Design System              (mandatory for admin UI work)
│    ├── Architecture Vision           (long-term platform vision)
│    └── DTO Sync Contract             (layer contracts)
└── Divo — Updates/                    (active feature work)
     └── <Feature Name>/              (one folder per active feature)
          ├── Plan                     (phases, decisions, architecture)
          └── Updates                  (current state, progress log)
```

**Wiki page tokens (for lark-cli):**

| Page | obj_token |
|---|---|
| Divo — References (parent) | `UYPad3dGMoIh4kx4mOqleaaKg2f` |
| UI Design System | `JKjQds9SGoOT6oxlPYDlqQX6gIe` |
| Architecture Vision | `PyIId3wFyo7rpIx6hJwlQVjogRh` |
| DTO Sync Contract | `Oc4Wd9eJMoTs5AxudrSlfQhSgtd` |
| Divo — Updates (parent) | `UB95dbVBuotWHZx1VQYlZubRgT4` |
| Dynamic Agent Platform / Plan | `Na3EddgpMohPKFxaZovlkxUygkg` |
| Dynamic Agent Platform / Updates | `BfIdddnZwoqwzRxwIg8lt1JBgKh` |
| OpenAI Codex Integration / Plan | `EGYOdu14PoEFJTxgu6DlnwchgWc` |
| OpenAI Codex Integration / Progress | `EzokdcK6XoL3B4xmsyJlGKUggQg` |
| OpenAI Codex Integration / Updates | `F2grdvPBWovgtBx5N7ulC3i4gjf` |
| OpenAI Codex Integration / References | `Zi44dgZNPouB3BxUwTql1UWrg7b` |
| Zoho Books Finance Tools / Plan | `A4X2d9LCboW8Gdxn8jNlQglJgug` |
| Zoho Books Finance Tools / Progress | `NZ8PddLT7oJ5DcxttetltSs9gjh` |
| Zoho Books Finance Tools / Updates | `ZUD8ddSi5oCntrxazbuliSZ2gjh` |
| Zoho Books Finance Tools / References | `FhW2dP34coJhkix86qMlIq47g4e` |
| Performance Optimizations / Plan | `FnjadCDq9oYPJ6xx6bQl4AxYgch` |
| Performance Optimizations / Progress | `FEBEd8I57okKsFxjXhIl4uVBgGd` |
| Performance Optimizations / Updates | `GwGbdEmPsoJ5xixjRNali7n5gle` |
| Mailing UX & Attachment Pipeline / Plan | `ACt3dqCsQo5HC2x9eFflVYaRgHh` |
| Mailing UX & Attachment Pipeline / Progress | `KQyKdfAVwoVYLzxiJ7jleK5cg7g` |
| Mailing UX & Attachment Pipeline / Updates | `Rs4QdrZzNo9EUExFMhEl8YuhgZg` |
| Mailing UX & Attachment Pipeline / References | `ZJRmdc7QLovOqMxAExQltaR7gfc` |
| Live Progress UX / Plan | `VZIJdq9lnob79ExM3OklwaSbgHb` |
| Live Progress UX / Progress | `Rvp0dCwoWoowqpxBWgala72YgSc` |
| Live Progress UX / Updates | `LX18d9JZooBFoRxZOk2lRbljgOh` |
| Live Progress UX / References | `JkIXdgO4eogLpJxx7yBlmHsYgJf` |

**Wiki space ID:** `7635896570625396443` (Tech Hub)
**Divo node token:** `XzW1wZDlJirIx1kPB0VlE2gfg7b`

### How to read/write wiki pages

```bash
# Read a page
lark-cli docs +fetch --api-version v2 --doc <obj_token> --doc-format markdown

# Overwrite a page with new content
lark-cli docs +update --api-version v2 --doc <obj_token> --command overwrite --doc-format markdown --content @path/to/file.md

# Append to a page
lark-cli docs +update --api-version v2 --doc <obj_token> --command append --doc-format markdown --content "## New section\n\nContent here"

# Create a new sub-page under a parent node
lark-cli wiki +node-create --space-id 7635896570625396443 --parent-node-token <parent_node_token> --title "Page Title"
```

### At the START of every session
1. Fetch the **Updates** page for the feature you're working on from the wiki
2. Read its **Current State** section — this is where the last AI left off
3. If the user's request doesn't match any existing feature, ask before creating code

### During a session
- If you make an architectural decision that isn't obvious from the code, add it to the **Plan** page's Key Decisions table
- If you hit a blocker, note it in the **Updates** page immediately

### At the END of every session (before stopping)
1. **Overwrite** the **Updates** page with a fresh snapshot of RIGHT NOW
   - What is working
   - What is in progress (be specific: file + function level)
   - What is not started
   - The exact next action for whoever picks this up next
   - Append a progress log entry (date, tool name, what you did)
2. Push the updated content to the wiki using `lark-cli docs +update`

**This is not optional.** If you skip this step, the next AI session starts blind.
Treat updating the wiki as the last action you take in every session.

### When starting a brand-new feature
1. Create a new folder under `Divo — Updates` in the wiki with **Plan** and **Updates** sub-pages
2. Fill in the Plan page before writing any code

### Before writing any admin UI code
**Fetch and read the UI Design System page from the wiki** (`obj_token: JKjQds9SGoOT6oxlPYDlqQX6gIe`).
It is the canonical guide for the admin visual language. Every UI change in `admin/` must trace
back to a rule in that doc.

---

## What This Project Is

**Divo** is an agentic orchestration engine. Users describe work in natural language inside
Lark (a Slack-like messaging app). The system plans, delegates, and executes it across
connected tools: Zoho CRM, Zoho Books, Google Workspace, Lark Docs, web search, etc.

Core runtime — supervisor-delegation pattern:
1. Lark webhook receives a message
2. Supervisor plans a multi-step execution (`planner.ts`)
3. Steps are delegated to specialized agents via the agent registry
4. Results are synthesized and returned to the user in Lark

---

## Active Features (Living State)

> Source of truth is in the **Lark Wiki** under `Divo — Updates`. Each feature has a Plan + Updates page.
> Fetch the Updates page at session start to know where things stand.

| Feature | Status | Wiki Plan token | Wiki Updates token |
|---|---|---|---|
| Dynamic Agent Platform | in-progress | `Na3EddgpMohPKFxaZovlkxUygkg` | `BfIdddnZwoqwzRxwIg8lt1JBgKh` |
| Mem0 Memory Layer | planning | `EmyKdQYBKovdv9xNUFqlDffSgKg` | `ZJffdD473ozRCNxk5VMlzs4zgag` |
| OpenAI Codex Integration | planning | `EGYOdu14PoEFJTxgu6DlnwchgWc` | `F2grdvPBWovgtBx5N7ulC3i4gjf` |
| Zoho Books Finance Tools | planning | `A4X2d9LCboW8Gdxn8jNlQglJgug` | `ZUD8ddSi5oCntrxazbuliSZ2gjh` |
| Performance Optimizations | planning | `FnjadCDq9oYPJ6xx6bQl4AxYgch` | `GwGbdEmPsoJ5xixjRNali7n5gle` |
| Mailing UX & Attachment Pipeline | planning | `ACt3dqCsQo5HC2x9eFflVYaRgHh` | `Rs4QdrZzNo9EUExFMhEl8YuhgZg` |
| Live Progress UX for Dynamic Agents | planning | `VZIJdq9lnob79ExM3OklwaSbgHb` | `LX18d9JZooBFoRxZOk2lRbljgOh` |

**Legacy local docs** in `docs/features/` are stale — wiki is authoritative. To add a new feature,
create a folder under `Divo — Updates` in the wiki with Plan + Updates sub-pages.

---

## Repository Structure

> **⚠ `backend/` is DEPRECATED.** It is the legacy V0 codebase and is NOT in active use.
> All current development happens in `advance-backend/`. Never reference `backend/` paths
> in plans, tasks, or wiki pages. If an AI session produced plans referencing `backend/`,
> those plans are wrong and must be corrected against `advance-backend/`.

```
/advance-backend    TypeScript + Express + LangGraph backend (ACTIVE — all dev happens here)
/backend            DEPRECATED legacy backend — do NOT use for new work
/admin              React 18 + Vite admin dashboard
/desktop            Electron desktop client
/docs               Architecture docs (local copies may be stale — wiki is authoritative)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend runtime | TypeScript + Express + tsx |
| ORM | Prisma 6 (PostgreSQL) |
| Queue | BullMQ + Redis (IORedis) |
| AI SDK | Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/groq`) |
| Embeddings/RAG | LangChain + Qdrant vector store |
| Admin UI | React 18 + Vite + Tailwind + Radix UI |
| Package manager | **pnpm** — never use npm or yarn |

---

## Commands

### Backend (`/advance-backend`) — ACTIVE
```bash
pnpm dev                          # start dev server (tsx watch)
pnpm start                        # production start
pnpm build                        # generate Prisma client
pnpm typecheck                    # type check — run before every commit
pnpm prisma:generate              # regenerate Prisma client after schema changes
pnpm prisma:push                  # push schema to DB (dev only)
pnpm prisma:migrate               # run migrations (production path)
pnpm test                         # run all tests (node:test runner)
pnpm test:unit                    # unit tests only (tests/tools/**)
pnpm test:integration             # integration tests only
pnpm seed:dynamic-agents          # seed demo agents
```

### Admin (`/admin`)
```bash
pnpm dev          # Vite dev server, port 5173
pnpm build
pnpm typecheck
```

---

## Architecture — Key Directories (`advance-backend`)

```
advance-backend/src/
├── application/                    # Business logic layer
│   ├── orchestration/
│   │   ├── engine/                 # OrchestrationEngine (core.ts), StatusChannel
│   │   ├── graphs/                 # LangGraph supervisor (dynamic-supervisor.graph.ts)
│   │   │   └── nodes/              # Graph nodes (supervisor-think.ts, format-response.ts)
│   │   ├── agents/                 # SupervisorAgent, agent-resolver, tool-labels
│   │   ├── agent-runners/          # Dynamic, Lark, Google, Zoho, Context runners
│   │   │   └── dynamic/            # Dynamic agent runner + hooks
│   │   └── tools/                  # Tool framework (22 families), tool-registry, ai-sdk-adapter
│   │       └── families/           # Lark, Google, Zoho, orchestration, web-search tools
│   ├── observability/              # OrchestrationTracer, execution-query, token-usage, audit
│   ├── agents/                     # Agent catalog, admin service
│   ├── approval/                   # Approval gates, HITL workflows
│   ├── email/                      # Email composer, attachment pipeline
│   ├── memory/                     # Mem0 integration
│   ├── permissions/                # RBAC, tool access control
│   ├── retrieval/                  # RAG pipeline (query rewriter, reranker)
│   └── ingestion/                  # Document processing, vector ingestion
├── domain/                         # Domain types (channel, conversation, orchestration, permissions)
├── infrastructure/                 # External integrations
│   ├── channels/lark/              # Lark adapter, webhook, card builder, status coordinator
│   ├── persistence/                # Prisma repositories (23 repos)
│   ├── google/                     # Google OAuth + clients
│   ├── zoho/                       # Zoho OAuth + clients
│   └── ai/                         # Embedding, search, vector DB
├── http/                           # Express routes (admin, executions, agents, files, auth)
└── shared/                         # Logger, errors, Result<T,E>, IDs, circuit-breaker
```

**Dependency direction (enforced — never break this):**
```
http → application → domain ← infrastructure
```
- `domain/` is imported by all layers
- Never import Lark payload types outside `infrastructure/channels/lark/`
- `shared/` is cross-cutting

---

## Design Rules (Non-Negotiable)

1. Channel logic stays in `channels/` — Lark payload shapes never leak outward
2. Integration logic stays in `integrations/` — always behind adapter interfaces
3. Agent logic is behind `BaseAgent` + `AgentRegistry` — no direct instantiation
4. Orchestration is channel-agnostic — receives normalized input only
5. Shared types live in `contracts/` — never define them inside feature modules
6. `pnpm typecheck` must pass before committing
7. Vercel AI SDK for all LLM calls — never import raw provider SDKs (`@anthropic-ai/sdk`, `openai`) directly
8. **advance-backend uses test-driven development** — every new route file gets a matching test file in `tests/http/`. Use Node's built-in `node:test` runner (no Jest/Vitest). Run a single file with `node --import tsx --test tests/http/your.routes.test.ts`. See `tests/http/execution.routes.test.ts` for the established pattern: mock req/res objects, extract handlers from the Router stack, no real Express server or DB needed.

---

## Architecture Reference Docs

> Canonical versions live in the **Lark Wiki** under `Divo — References`.
> Local copies in `docs/` may be stale — always fetch from wiki for the latest.

| Doc | Wiki token | Purpose |
|---|---|---|
| UI Design System | `JKjQds9SGoOT6oxlPYDlqQX6gIe` | **Mandatory** for any admin UI work — surface system, tokens, components, rules |
| Architecture Vision | `PyIId3wFyo7rpIx6hJwlQVjogRh` | Long-term platform vision (dynamic agents, RBAC, channels) |
| DTO Sync Contract | `Oc4Wd9eJMoTs5AxudrSlfQhSgtd` | DTO contracts between layers |
| `docs/Company-Architecture-Planning-v3.0.md` | — | Full 47-section architecture plan (local only, not yet in wiki) |
| `docs/ARCHITECTURE-REFERENCE-MAP.md` | — | Quick reference map (local only) |

---

## Version Roadmap

| Version | Goal | Status |
|---|---|---|
| V0 | Core orchestration, queue, Redis, basic agents, HITL, admin dashboard | Done |
| V1 | Scheduled workflows, production hardening | In progress |
| V2 | Multi-tenant, enterprise security, proactive intelligence | Planned |

---

## Environment Variables (`advance-backend/.env`)

```
DATABASE_URL=
REDIS_URL=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
GROQ_API_KEY=
LARK_APP_ID=
LARK_APP_SECRET=
LARK_VERIFICATION_TOKEN=
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
CLOUDINARY_URL=
```

---

## Code Conventions

- TypeScript strict mode — no `any` without an explanatory comment
- ES modules (`import/export`) — never CommonJS
- Zod for all external input validation and structured LLM outputs
- Vercel AI SDK (`generateText`, `streamText`) for all LLM calls
- Arrow functions for callbacks, named functions for top-level declarations
- No default exports except Express router files
