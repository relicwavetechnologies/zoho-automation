# Divo persona-learning research

This directory records evidence and decisions for Divo's manager-learning system. It is intentionally separate from implementation code.

## Current files

- [`browser-agent-open-source-memory-persona-prompt.md`](browser-agent-open-source-memory-persona-prompt.md) — research prompt for comparing strong open-source memory and personalization systems.
- [`hermes-memory-persona-architecture.md`](hermes-memory-persona-architecture.md) — code-level review of the local Hermes repository.
- [`divo-persona-research-decisions.md`](divo-persona-research-decisions.md) — provisional conclusions for Divo, clearly separated into decisions, recommendations, and unresolved questions.
- [`open-source-landscape-research-audit.md`](open-source-landscape-research-audit.md) — audit of the browser-agent landscape report, including accepted conclusions, unsupported claims, and missing reference implementations.

## Evidence status

- Local Hermes review: complete for the memory/profile/skill lifecycle at commit `8fa8aabbbbb1f5f65ad44d747527dfcd9b7a4866` (2026-07-15).
- Local Divo fit check: complete at the architecture level; no implementation has been changed.
- External repository comparison: first report received and audited; a targeted follow-up is still required for the omitted Codex, Gemini CLI, Memobase, and trust/candidate implementations.
- Final persona representation and promotion thresholds: deliberately not frozen until external research is compared with the local findings.

## Working vocabulary

- **Run evidence** — immutable facts from an execution: explicit corrections, selected actions, outcomes, tool/app usage, and relevant transcript excerpts.
- **Memory** — episodic or factual context useful for recalling what happened.
- **Persona preference** — a durable manager-specific expectation about style, decisions, or quality.
- **Skill** — reusable procedural instructions for performing a class of work.
- **Candidate** — a proposed preference or skill change that is not yet trusted for active use.
- **Active brief** — the compact, department-visible summary injected into an agent session.
