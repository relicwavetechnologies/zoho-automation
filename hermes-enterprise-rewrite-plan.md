# Hermes Enterprise Rewrite — Plan

**Status:** in-progress
**Scope:** Rebuild `hermes` into the canonical Divo platform runtime with first-class company tenancy, RBAC, multi-channel support, and enterprise governance.

## Objective

Stop using `advance-backend` as the active runtime baseline. Build the production Divo-equivalent platform entirely inside `/hermes`.

Hermes will stop being a single-user local assistant and become a company platform where:

- one company can onboard many users
- permissions are enforced on every tool and agent action
- channels are pluggable and multi-tenant aware
- execution is auditable and approval-gated where needed
- admin controls are centralized and secure
- data and identity boundaries are tenant-scoped by design

## Design Commitments

1. **Tenant as first-class domain object**
   - All runtime paths require `companyId` and `userId` in execution context.
   - No implicit per-user filesystem state.

2. **Hermes-native implementation only**
   - Existing Divo code is reference and not runtime dependency for this feature.

3. **Authorization before execution**
   - Tool and agent selection must pass through policy engine before any outbound call.
   - No direct tool calls from LLM prompts.

4. **Channel abstraction from day one**
   - Normalize inbound events from Lark, desktop, and new channels into a common execution request.

5. **Operational visibility first**
   - Every action must produce structured logs for audit, troubleshooting, and compliance.

## What is in scope (new phase)

- Company/department/user tenancy model in Hermes persistence.
- RBAC engine (role + dept + user overrides) aligned with agent and tool scopes.
- Tool registry refactor to enforce permission checks centrally.
- Agent execution runtime that uses tenant-scoped context and policy decisions.
- Approval/HITL path for sensitive tools and escalations.
- Admin management APIs and dashboard flows in Hermes stack.
- Multi-channel routing and identity resolution (Hermes desktop, Lark, API channels).
- Execution tracing, audit events, and run-history views.
- Session/context store moved from local singleton behavior to company context.
- Deployment and rollout hardening (envs, observability, secrets, backups).

## Non-goals for this phase

- Full migration of any legacy `advance-backend` HTTP contract.
- UI redesigns unrelated to enterprise control plane.
- Rewriting external integrations that are already stable unless required by tenancy.

## Repository Targets (execution order)

1. `/hermes` core runtime
   - Introduce company-aware request/agent/context contracts.
   - Add tenant-bound execution services and persistence boundaries.

2. `/hermes/enterprise` (or equivalent new namespace)
   - New permission/rbac service, policy evaluators, role/department models.
   - Central audit event model and storage writer.

3. `/hermes/tools` integration layer
   - Wrap existing tool implementations in policy-aware adapters.
   - Add tool capability metadata required for enforcement.

4. `/hermes/apps` and gateway endpoints
   - Channel ingress normalization (chat/webhook/app channels).
   - Identity resolution into `{companyId,userId,departmentId,channelContext}`.

5. `/hermes/ui` and admin APIs
   - Role-gated admin pages for agents, departments, tool assignments, policies, logs.

6. `/hermes/deploy` / infra configs
   - Production runbooks, secrets rotation, rate-limit and timeout envelopes.

## Milestones

### Milestone 1 — Hardening Foundation (Week 1)

- Finalize tenant schema in Hermes persistence.
- Define canonical execution context object.
- Add feature flags and environment boundaries for multi-tenant mode.
- Create admin-only bootstrap for company onboarding.

### Milestone 2 — Policy and Enforcement (Week 2)

- Implement permission graph: company → department → user overrides.
- Implement tool/action allowlisting.
- Add policy check middleware to execution entrypoints.
- Introduce audit event sink with structured records.

### Milestone 3 — Tool/Agent Capability Refactor (Week 3)

- Build policy-aware tool registry API.
- Enforce permission intersections: `agentAllowedTools ∩ userAllowedTools`.
- Support deny-by-default for risky actions (write/delete/sensitive reads).
- Add explicit approval hooks for sensitive execution paths.

### Milestone 4 — Multi-Channel + Admin Surface (Week 4)

- Normalize inbound channel events and identity context.
- Add company/department filters in routing layer.
- Implement admin UI/API for policies, users, agents, and audit views.

### Milestone 5 — Scale Rollout (Week 5+)

- Migration strategy from existing Hermes users to company mode.
- Load/security tests and rate controls.
- Canary rollout and observability dashboard.
- Documentation freeze and on-call runbook.

## Key decisions to track

| Decision | Rationale |
|---|---|
| Use Hermes as source of truth | Directly satisfies user requirement; avoids dual runtimes |
| Do not preserve local, per-user behavior as runtime default | Prevents data leakage and non-deterministic permission boundaries |
| Introduce policy layer before full feature parity | Security correctness must precede parity |
| Keep RBAC and agent assignment data-driven | Configuration over hardcoded rules |
| Enforce audit-first operations | Supports compliance and incident debugging |

## Open decisions (owner to finalize)

- Whether to preserve Hermes local UI session persistence as transient cache only or as a first-class product feature.
- Whether RBAC requires temporal grants (time-bound approvals) in MVP.
- Whether departments can inherit tool policies from company-level defaults.

## Success Criteria

- One user from Company A cannot view/use Company B data.
- Every tool call has a denied/allowed policy decision and trace record.
- Multi-channel requests produce identical policy outcomes for the same normalized context.
- Admin can onboard one company and assign at least one role with restricted tool visibility and execution.
- End-to-end run produces traceable logs for execution and approval decisions.
