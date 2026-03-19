# Progress Log

- 2026-03-19 16:12 IST — Codex
  - Created a dedicated task folder for a detailed LangGraph runtime rebuild handoff.
  - Captured the requirement that desktop and Lark must both be handled, but with one core runtime and channel adapters.
  - Added a safe coexistence plan so the Vercel path can stay live while the rebuild is developed and evaluated.

- 2026-03-19 16:32 IST — Codex
  - Audited the current desktop engine, Lark engine, department runtime resolver, runtime task store, conversation memory store, and HITL persistence.
  - Expanded the handoff with implementation-ready contracts for runtime state, history, graph edges, adapters, tool policy, storage split, migration exits, and current-to-new module mapping.
  - Marked the design-definition TODOs complete so the next engineer can move directly into schema and repository implementation.
