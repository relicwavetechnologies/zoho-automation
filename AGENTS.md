# AGENTS.md

> Shared working rules for AI coding agents in this workspace.

## Local operational context

If `AGENTS.local.md` exists at the repository root, read it before starting local infrastructure, using local credentials, or running cloud-Pi/Lark E2E tests. It is intentionally ignored and contains local-only operational context; never copy its secrets into tracked files or output. New teammates: copy `AGENTS.local.example.md` to `AGENTS.local.md`, then fill secrets from a team lead and `advance-backend/.env.example`.

For local backend + controller + Dockerized Cloud-Pi runs delivered to Lark, follow `advance-backend/docs/cloud-pi-testing/07-local-runtime-harness-framework.md`. It defines the executable Development path, inspection-only Main boundary, prompt disclosure, evidence, rerun, and Divo-only cleanup rules.

## Local runbook

The whole local stack is one command from the repository root, and it is safe to re-run:

```bash
scripts/dev-stack.sh          # start everything, wait for health, print URLs
scripts/dev-stack.sh status   # what is up right now
scripts/dev-stack.sh stop     # stop it
```

Operational procedure lives in `docs/LOCAL-RUNBOOK.md`, not here. Load it only when you actually need to run something locally:

- Starting or stopping the local stack (backend, Pi controller, admin UI, tunnel, Redis), or debugging why a local service is down.
- Running the Agent Seat harness: testing skills, tool graphs, and RBAC as the runtime agent without cloud Pi. Prefer Agent Seat over improvised tool calls when validating skill or tool behavior; it cannot prove terminal/file workflows (those need the Cloud-Pi harness).

Do not load it for pure code reading, planning, or edits that you will verify with unit tests alone.

## Prime Directive

Code quality is the priority. Do not rush wiring that creates dead code, unclear ownership, duplicated flows, conflicting comments, or hidden security gaps. Reason from the existing code structure before editing.

This workspace contains several structured codebases:

- `advance-backend/` — Divo backend and company capability gateway candidate.
- `admin/` — admin control dashboard (`pnpm dev` on port 5173).
- `jan/` — current desktop app target.
- `pi/` — vendored Pi agent harness source.
- `pi-bridge/` — local experiment; do not treat it as the target architecture unless explicitly asked.

## Current Architecture Direction

Divo should integrate with Pi through a backend-owned capability gateway:

```txt
Desktop: Jan auths with advance-backend -> bundled Pi runs locally
Lark: webhook admission -> LarkPiRuntimeService -> private controller
  -> isolated per-user Divo container -> Pi runtime
Both: the Divo extension registers typed Pi tools from backend contracts
  -> every call crosses one backend capability gateway
  -> advance-backend authenticates, resolves user/departments, enforces RBAC/HITL, executes tool
```

Do not move RBAC, SaaS credentials, OAuth ownership, or enterprise policy into Pi. Pi is the agent/runtime layer. `advance-backend` is the authority for identity, permissions, tools, approvals, auditing, and external integrations.

Lark agent turns use the isolated cloud-Pi path only. Never route them through the Vercel AI SDK orchestration engine, and never hide a Pi failure by falling back to that engine. User-facing Lark copy says **Divo**, not Pi.

## Non-Negotiable Engineering Rules

 1. Inspect before editing. Read the relevant files and tests before changing code. Do not guess the shape of an API, service, route, or extension point.

 2. Keep changes small and phase-based. Prefer a working vertical slice over a large rewrite. Each phase should have a clear behavior change and tests where practical.

 3. No silent dead code. If a change makes old code unused, conflicting, or misleading, stop and ask: "This code is now dead; should we remove it?" Do not leave garbage behind silently.

 4. No conflicting comments. Comments must describe current behavior. Remove or update comments that become stale.

 5. No duplicate authority. There must not be two independent places deciding auth, RBAC, tool access, or approval policy. Backend owns these decisions.

 6. Use existing patterns first. Match the local service, route, test, and type patterns before adding new abstractions.

 7. Do not modify vendored Pi core unless explicitly necessary. Prefer a Divo-owned Pi extension and configuration. Core Pi source changes require a clear reason.

 8. Do not expose admin APIs to Pi. Pi should call one constrained gateway surface, not internal admin routes.

 9. Do not give Pi direct SaaS credentials. Zoho, Lark, Google, Meta Ads, and future integration tokens stay server-side.

10. Ask before destructive cleanup. Do not delete intentional legacy code, routes, or data paths without explicit confirmation.

## Fail Loudly

Silent degradation is the most expensive failure mode in this codebase. A feature that is off must say it is off; a call that failed must say it failed.

1. A flag or env var that gates behavior logs its effective state at boot. When it blocks work at runtime, the skip is reported ("disabled by DIVO_AUTONOMOUS_WORKERS_ENABLED"), never a silent no-op the operator mistakes for a bug.

2. Missing or invalid required config fails at startup with the variable name. Do not let it surface later as a confusing failure deep inside a request.

3. No catch-and-continue that hides a failure. Do not swallow an error and return a default the caller cannot tell apart from success. Catch only where you can handle, report, or enrich; otherwise let it propagate.

4. No silent fallbacks between paths or engines. If the intended path fails, surface the failure; do not quietly route through an alternative that behaves differently (the Lark Pi-to-Vercel rule is one instance of this).

5. Errors cross module seams as structured results (typed error, code, context), not prose strings. The seam's error modes are part of its interface; callers and tests should be able to branch on them.

6. Never present partial data as complete. If a provider page, batch cap, or timeout truncated the result, the response says so.

## Feature, change, and fix design

Use this design vocabulary when reasoning about architecture: **module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, and **locality**. Keep established code names when renaming would only add churn.

1. Scope from evidence. Start with the behavior or pain named in the task. Trace the relevant call path, tests, and recent changes before proposing a design. Read `CONTEXT.md`and applicable ADRs when they exist. For broad work, use commit history to find hot spots instead of restructuring cold code for completeness. Do not reopen an ADR without concrete evidence that its decision now causes friction.

2. Put the seam at the domain owner. Use domain terms for modules and place each invariant in the module that owns it. If a durable concept is missing or fuzzy, update or create `CONTEXT.md`. For a bug, fix the owning module once and add a regression test there instead of patching the same symptom in several callers.

3. Prefer deep modules. A module should hide substantial behavior behind a small interface. The interface includes methods and types as well as invariants, ordering rules, error modes, required configuration, and performance constraints. Keep coordination and policy inside the implementation rather than making every caller learn them.

4. Earn each seam. One adapter means a hypothetical seam; two adapters mean a real one. Do not add pass-through wrappers, speculative extension points, or abstractions for variation the task does not require. Internal seams may support a module's implementation and tests without becoming part of its external interface.

5. Optimize for leverage and locality. Prefer a design where one implementation serves many callers and tests, and where changes, bugs, knowledge, and verification stay together. Keep tightly coupled behavior together. Do not extract pure functions only to make unit tests easy when the real risk is how callers coordinate them.

6. Treat the interface as the test surface. Callers and tests should cross the same seam. Accept dependencies instead of constructing them inside the module, and return explicit results instead of hiding important work in side effects where practical. Test invariants and error modes through the interface. If a test must reach past it, reconsider the module's shape.

7. Apply the deletion test before adding a module. Imagine removing it. If its complexity would spread across callers, the module has useful depth. If the complexity would disappear, the module is shallow; simplify the design instead of adding another layer. For existing code, still follow the no-silent-dead-code and destructive-cleanup rules before removal.

## Backend Standards

All new backend work should stay inside `advance-backend/` unless the task explicitly touches desktop or Pi.

Follow the existing layering:

```txt
http -> application -> domain <- infrastructure
```

Gateway work should prefer:

- `application/gateway/*` for dispatch/execution services.
- `http/gateway/*` for Express routes.
- Existing `PermissionService` for RBAC.
- Existing `ToolRegistry` and tool contracts for execution.
- Existing member auth/session concepts for user identity.

Do not flatten tool results into LLM string envelopes for the external gateway. Return structured JSON.

## Admin Standards

`admin/` follows a small set of placement rules; match them instead of inventing new spots:

- Route-level pages live in `admin/src/pages/`. The workspace surface is `pages/workspace/` with `routes.tsx` as the entry and per-domain folders (`chat/`, `data/`, `approvals/`, `decisions/`, `home/`, ...). New workspace behavior goes in the domain folder that owns it.
- Server state and business logic live in `pages/workspace/data/`: one `use-*.ts` hook per resource, and pure logic extracted into plain `.ts` modules with a colocated `.test.ts`. Components render; they do not fetch inline or hold policy.
- Shared shells and primitives live in `admin/src/components/admin/` (`workspace-shell`, `page-header`, `metric-card`, ...); cross-page utilities in `admin/src/lib/`. Check both before writing a new one.
- Styling comes from the token files in `admin/src/styles/` (`palette.css`, `cursor.css`, `workspace.css`). No hardcoded one-off colors or fonts in components.
- Test pure logic precisely through the module's interface. Reserve DOM tests for behavior only rendering can prove; do not add render-and-snapshot tests for logic a plain function test covers.

## Pi Integration Standards

Pi integration should be additive:

- Use one Divo gateway extension that registers one typed Pi tool per reachable backend contract.
- Generate tool inputs from the backend `argsSchema`; do not recreate the removed mega-tool `{ op, payload }` envelope.
- Skills/instructions may be loaded from backend responses, but enforcement remains backend-side.
- Pi should not know implementation details of Zoho/Lark/Google tools beyond what backend capabilities expose.

## Desktop Standards

Jan/Desktop should own local user experience:

- Start auth.
- Store the backend member session securely.
- Start or connect to bundled Pi.
- Provide the Divo gateway tool configuration/token path.
- Surface departments as user-selectable context, not as a complex policy engine in V1.

## Database Environment Rules

Development and Main use separate PostgreSQL containers, databases, users, networks, and Docker volumes. Never treat them as a shared database.

- Local `advance-backend/.env` and `scripts/db-tunnel.sh` target the live Development database only (`localhost:15432` -&gt; VPS `127.0.0.1:15433` -&gt; `divo_dev`). A local `prisma db push` never promotes schema or data to Main.
- Main's schema source of truth is the `schema.prisma` committed on the `main`branch. Main deployment's `divo-schema-sync` applies that checked-in schema to `divo_main` before the backend starts.
- A successful Main schema sync means Main matches the Main branch schema; it does not mean Main matches Development. Schema changes must be committed and merged to `main` before deploying Main.
- Deployments synchronize schema only. They do not copy application rows, Hindsight memory, Redis state, or files. Development-to-Main data cloning is a separate, explicit, destructive, manual operation that requires a verified Main backup and rollback path.

## Testing Expectations

Backend gateway work needs focused tests:

- Missing/invalid auth.
- Unknown `op`.
- Unknown `toolId`.
- Invalid tool args.
- Permission denied.
- Allowed invocation.
- Skills/tools filtered by RBAC.
- HITL pending response when approval is required.

Run the narrowest relevant tests first. Broaden only when the blast radius warrants it.

## When In Doubt

Pause and ask before:

- Removing old runtime code.
- Changing auth/session shape.
- Changing permission semantics.
- Modifying Pi core.
- Exposing new backend routes to the desktop or agent.
- Creating a second way to invoke company tools.