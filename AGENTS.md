# AGENTS.md
> Shared context for all AI coding assistants — Claude Code, Codex, Cursor, Gemini CLI, etc.
> This file is symlinked as CLAUDE.md. One source of truth.

---

## MANDATORY: How Every AI Session Must Work

These rules exist so that switching between Claude, Codex, Cursor, or any other tool mid-feature
causes zero context loss. The feature docs in `docs/features/` are the shared memory.

### At the START of every session
1. Read `docs/features/` — find the feature doc for what you are about to work on
2. Read its **Current State** section — this is where the last AI left off
3. If the user's request doesn't match any existing feature doc, ask before creating code

### During a session
- If you make an architectural decision that isn't obvious from the code, record it in the **Key Decisions** table
- If you hit a blocker, write it under **Blockers** in Current State immediately

### At the END of every session (before stopping)
1. **Overwrite** the **Current State** section with a fresh snapshot of RIGHT NOW
   - What is working
   - What is in progress (be specific: file + function level)
   - What is not started
   - The exact next action for whoever picks this up next
2. **Append** one entry to the **Progress Log** (date, tool name, what you did)
3. Update the `Status` badge at the top of the feature doc

**This is not optional.** If you skip this step, the next AI session starts blind.
Treat updating the feature doc as the last line of code you write in every session.

### When starting a brand-new feature
Copy `docs/features/TEMPLATE.md` to `docs/features/NN-feature-name.md` and fill it in
before writing any code. Plan first, then implement.

### Before writing any admin UI code
**Read `docs/UI-DESIGN-SYSTEM.md` end-to-end.** It is the canonical guide for the admin
visual language: floor/mat/card surface system, color tokens, typography scale, density
rules, component patterns, and anti-patterns. Every UI change in `admin/` must trace
back to a rule in that doc. If you need to break a rule, document why in the relevant
feature doc's Key Decisions table.

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

## Feature Docs (Living State of the Project)

> Always check here before starting work. These are the authoritative "where are we?" files.

| Feature | Status | Doc |
|---|---|---|
| Scheduled Workflows | in-progress | `docs/features/01-scheduled-workflows.md` |
| Admin UI Redesign | in-progress | `docs/features/02-admin-ui-redesign.md` |
| Backend Migration (backend → advance-backend) | in-progress | `docs/features/03-backend-migration.md` |
| Agent Builder Canvas (React Flow stub) | in-progress | `docs/features/04-agent-builder-canvas.md` |

**Template for new features:** `docs/features/TEMPLATE.md`

---

## Repository Structure

```
/backend            TypeScript + Express backend (main implementation)
/admin              React 18 + Vite admin dashboard
/desktop            Electron desktop client
/advance-backend    Experimental backend (Groq-based, not production)
/docs               Architecture docs + feature docs (source of truth)
/docs/features/     One file per feature — plan, current state, progress log
/tasks              Legacy task files (being migrated to docs/features/)
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

### Backend (`/backend`)
```bash
pnpm dev                          # start dev server
pnpm build                        # compile TypeScript
pnpm typecheck                    # type check — run before every commit
pnpm lint                         # lint
pnpm prisma:generate              # regenerate Prisma client after schema changes
pnpm prisma:push                  # push schema to DB (dev only)
pnpm prisma:migrate               # run migrations (production path)
pnpm seed:agents                  # seed agent registry
pnpm seed:divo-prompt             # seed supervisor prompt
```

### Harness scripts (local orchestration testing)
```bash
pnpm harness:lark:routing
pnpm harness:supervisor:structured
pnpm harness:provider-retry
pnpm harness:task-fsm
```

### Admin (`/admin`)
```bash
pnpm dev          # Vite dev server, port 5173
pnpm build
pnpm typecheck
```

---

## Architecture — Key Directories

```
backend/src/company/
├── agents/
│   ├── base/             # BaseAgent contract
│   ├── registry/         # AgentRegistry
│   ├── implementations/  # zoho-read, lark-response, search-read, etc.
│   └── dynamic/          # runtime-constructed agents
├── orchestration/
│   ├── engine/           # vercel-orchestration.engine.ts — main runtime loop
│   ├── supervisor/       # planner.ts, executor.ts
│   ├── vercel/           # tools.ts — Vercel AI SDK tool definitions
│   └── intent/           # intent classification
├── contracts/            # shared DTOs — import from here only
├── channels/             # Lark channel adapter
├── integrations/         # Zoho, Google adapters
├── queue/                # BullMQ workers
├── state/                # Redis checkpointing
├── memory/               # RAG + routing memory
├── departments/          # dept-aware prompt/skills/RBAC
└── tools/                # tool permission system
```

**Dependency direction (enforced — never break this):**
```
channels → orchestration → agents → integrations
```
- `contracts/` is imported by all layers
- Never import raw Lark payload types outside `channels/`
- `queue/`, `state/`, `security/`, `observability/` are cross-cutting

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

| Doc | Purpose |
|---|---|
| `docs/UI-DESIGN-SYSTEM.md` | **Mandatory** for any admin UI work — surface system, tokens, components, rules |
| `docs/Company-Architecture-Planning-v3.0.md` | Full 47-section architecture plan |
| `docs/ARCHITECTURE-REFERENCE-MAP.md` | Quick reference map |
| `docs/V0-DTO-SYNC-CONTRACT.md` | DTO contracts between layers |
| `docs/GENERIC-AGENT-PLATFORM-VISION.md` | Long-term platform vision |

Reference section numbers in commits when relevant (e.g., "Section 25 — BullMQ contract").

---

## Version Roadmap

| Version | Goal | Status |
|---|---|---|
| V0 | Core orchestration, queue, Redis, basic agents, HITL, admin dashboard | Done |
| V1 | Scheduled workflows, production hardening | In progress |
| V2 | Multi-tenant, enterprise security, proactive intelligence | Planned |

---

## Environment Variables (`backend/.env`)

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
