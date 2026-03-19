# LangGraph Runtime Rebuild

## Why This Task Exists

The current runtime works, but it carries accumulated complexity across desktop, Lark, approvals, conversation memory, tool execution, and delivery. A clean LangGraph rebuild is being considered so the app can own state, approvals, history, and channel behavior more explicitly while keeping the current Vercel runtime safe during migration.

## In Scope

- Design a fresh LangGraph-based runtime core.
- Unify conversation state across desktop and Lark.
- Make approvals a first-class runtime state.
- Define channel adapters for desktop and Lark.
- Preserve department-scoped prompt, skills, RBAC, and tool action groups.
- Define persistence model for conversations, runs, and approvals.
- Define safe coexistence and migration alongside the current Vercel path.

## Out Of Scope

- Immediate full cutover away from Vercel.
- Rewriting every tool implementation in the first phase.
- Replacing existing UI surfaces before the runtime core exists.

## Dependencies

- Current desktop Vercel runtime:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/modules/desktop-chat/vercel-desktop.engine.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/modules/desktop-chat/vercel-desktop.engine.ts)
- Current Lark Vercel runtime:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/engine/vercel-orchestration.engine.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/engine/vercel-orchestration.engine.ts)
- Current department runtime resolution:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/departments/department.service.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/departments/department.service.ts)
- Current tool permission enforcement:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/vercel/tools.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/vercel/tools.ts)
- Current conversation memory store:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/state/conversation/conversation-memory.store.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/state/conversation/conversation-memory.store.ts)

## Acceptance Criteria

1. A new LangGraph runtime design exists with a single canonical state model.
2. Desktop and Lark are handled through adapters, not separate orchestration cores.
3. Conversation history is durable and normalized across both channels.
4. HITL is modeled as stored pending action state, not ad hoc UI logic.
5. The current Vercel path remains safe behind flags and can continue serving production traffic during the rebuild.
6. Another engineer can implement the rebuild from the handoff without re-discovering architecture decisions.
