# AGENTS.md
> Shared working rules for AI coding agents in this workspace.

## Prime Directive

Code quality is the priority. Do not rush wiring that creates dead code, unclear ownership, duplicated flows, conflicting comments, or hidden security gaps. Reason from the existing code structure before editing.

This workspace contains several structured codebases:

- `advance-backend/` — Divo backend and company capability gateway candidate.
- `jan/` — current desktop app target.
- `pi/` — vendored Pi agent harness source.
- `pi-bridge/` — local experiment; do not treat it as the target architecture unless explicitly asked.

## Current Architecture Direction

Divo should integrate with Pi through a backend-owned capability gateway:

```txt
Desktop: Jan auths with advance-backend -> bundled Pi runs locally
Lark: webhook admission -> LarkPiRuntimeService -> private controller
  -> isolated per-user Divo container -> Pi runtime
Both: Pi calls one Divo tool with op + payload
  -> advance-backend authenticates, resolves user/departments, enforces RBAC/HITL, executes tool
```

Do not move RBAC, SaaS credentials, OAuth ownership, or enterprise policy into Pi. Pi is the agent/runtime layer. `advance-backend` is the authority for identity, permissions, tools, approvals, auditing, and external integrations.

Lark agent turns use the isolated cloud-Pi path only. Never route them through
the Vercel AI SDK orchestration engine, and never hide a Pi failure by falling
back to that engine. User-facing Lark copy says **Divo**, not Pi.

## Non-Negotiable Engineering Rules

1. Inspect before editing.
   Read the relevant files and tests before changing code. Do not guess the shape of an API, service, route, or extension point.

2. Keep changes small and phase-based.
   Prefer a working vertical slice over a large rewrite. Each phase should have a clear behavior change and tests where practical.

3. No silent dead code.
   If a change makes old code unused, conflicting, or misleading, stop and ask: "This code is now dead; should we remove it?" Do not leave garbage behind silently.

4. No conflicting comments.
   Comments must describe current behavior. Remove or update comments that become stale.

5. No duplicate authority.
   There must not be two independent places deciding auth, RBAC, tool access, or approval policy. Backend owns these decisions.

6. Use existing patterns first.
   Match the local service, route, test, and type patterns before adding new abstractions.

7. Do not modify vendored Pi core unless explicitly necessary.
   Prefer a Divo-owned Pi extension and configuration. Core Pi source changes require a clear reason.

8. Do not expose admin APIs to Pi.
   Pi should call one constrained gateway surface, not internal admin routes.

9. Do not give Pi direct SaaS credentials.
   Zoho, Lark, Google, Meta Ads, and future integration tokens stay server-side.

10. Ask before destructive cleanup.
    Do not delete intentional legacy code, routes, or data paths without explicit confirmation.

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

## Pi Integration Standards

Pi integration should be additive:

- Add one Divo gateway tool extension.
- Tool input should be `{ op, departmentId?, payload }`.
- Skills/instructions may be loaded from backend responses, but enforcement remains backend-side.
- Pi should not know implementation details of Zoho/Lark/Google tools beyond what backend capabilities expose.

## Desktop Standards

Jan/Desktop should own local user experience:

- Start auth.
- Store the backend member session securely.
- Start or connect to bundled Pi.
- Provide the Divo gateway tool configuration/token path.
- Surface departments as user-selectable context, not as a complex policy engine in V1.

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
