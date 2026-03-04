# V1 LangGraph Direct Switch Task Index

## Program Goal
Implement LangGraph + LangChain OpenAI orchestration as default runtime while retaining a safe legacy rollback path.

## Execution Order
- `00 -> 01 -> 02 -> 03 -> 04 -> 05 -> 06 -> 07 -> 08 -> 09 -> 10 -> 11`

## Task List
| # | Folder | Purpose | Depends On |
|---|---|---|---|
| 00 | 00-v1-scope-and-guardrails | Lock V1 scope, rollback guardrails, compatibility rules | None |
| 01 | 01-engine-abstraction-and-feature-flags | Add orchestration engine abstraction and runtime selection flags | 00 |
| 02 | 02-langchain-openai-foundation | Add LangChain OpenAI model setup and prompt foundation | 01 |
| 03 | 03-langgraph-state-and-skeleton | Build typed LangGraph state and compiled graph skeleton | 02 |
| 04 | 04-route-and-plan-nodes | Implement route and plan nodes with deterministic fallback | 03 |
| 05 | 05-agent-bridge-node | Bridge LangGraph agent dispatch to existing agent registry | 03,04 |
| 06 | 06-hitl-gate-node-integration | Integrate existing HITL lifecycle into LangGraph flow | 05 |
| 07 | 07-checkpoint-bridge-and-recovery | Persist graph node checkpoints and recovery metadata | 06 |
| 08 | 08-synthesis-and-response-node | Add synthesis/response/finalize nodes in graph flow | 07 |
| 09 | 09-admin-runtime-observability-upgrade | Expose engine/graph metadata in admin runtime APIs and UI | 08 |
| 10 | 10-rollout-safe-switch-and-rollback-drill | Cutover defaults + rollback drill docs and validation | 09 |
| 11 | 11-e2e-langgraph-validation-and-release-gate | End-to-end validation and release go/no-go checklist | 10 |
